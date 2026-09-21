import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { validateOrder, telegramText, OrderDelivery } from '../server/worker.mjs';
import { catalog, catalogVersion } from '../scripts/catalog.js';

const origin = 'https://mim-kulinariya.com';
const body = () => ({ id: crypto.randomUUID(), catalogVersion, phone: '+79990000000', comment: '', items: [{ id: catalog[0].id, variant: 'Пшеничные', quantity: 2 }] });
const makeRequest = (data = body(), headers = {}) => new Request('https://orders.test/orders', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers }, body: JSON.stringify(data) });
function memoryState() {
  const store = new Map();
  return { store, storage: { get: async key => store.get(key), put: async (key, value) => store.set(key, structuredClone(value)), setAlarm: async () => {}, deleteAll: async () => store.clear() } };
}
function environment() {
  const instances = new Map();
  const env = { TELEGRAM_BOT_TOKEN: 'TEST_ONLY', TELEGRAM_CHAT_ID: '-1000000000000', ALLOWED_ORIGINS: origin, ORDER_LIMITER: { limit: async () => ({ success: true }) } };
  env.ORDER_DELIVERY = { idFromName: id => id, get: id => { if (!instances.has(id)) instances.set(id, new OrderDelivery(memoryState(), env)); return instances.get(id); } };
  return env;
}

test('server catalog matches all 75 visible menu items and prices', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(catalog.length, 75); assert.equal(new Set(catalog.map(p => p.id)).size, 75);
  const blocks = [...html.matchAll(/<li class="dish [^"]+" data-product-id="([^"]+)"[\s\S]*?<\/li>/g)];
  assert.equal(blocks.length, catalog.length);
  for (const [block, id] of blocks) {
    const p = catalog.find(p => p.id === id); assert.ok(p);
    assert.equal(Number(block.match(/<span class="price">(.*?)<\/span>/)[1].replace(/\D/g, '')), p.price);
    assert.equal(block.match(/data-name="([^"]+)"/)[1], p.name);
  }
});

test('prices and Telegram text come from trusted catalog, not browser payload', () => {
  const b = body(); b.items[0].price = 1; b.items[0].name = 'fake'; b.total = 1;
  const order = validateOrder(b); assert.equal(order.total, 2500);
  assert.match(telegramText(order), /Галушки с отварной говядиной/); assert.doesNotMatch(telegramText(order), /fake/);
  assert.equal(order.phone, '+79990000000');
});

test('reject malformed phones, quantities, missing variants, stale catalog and oversized baskets', () => {
  for (const change of [b => b.phone = 'bad', b => b.id = 'bad', b => b.items = [], b => b.items[0].quantity = -1, b => b.items[0].quantity = 1.5, b => b.items[0].quantity = 21, b => b.items[0].id = 'unknown', b => b.items[0].variant = '', b => b.items.push({ ...b.items[0] }), b => b.comment = 'x'.repeat(301), b => b.catalogVersion = 'old', b => b.items = Array.from({length: 6}, (_,i) => ({id:catalog[i].id,variant:'Пшеничные',quantity:20}))]) {
    const b = body(); change(b); assert.throws(() => validateOrder(b));
  }
});

test('only allowed origins, JSON, configured server and rate-limited requests reach delivery', async () => {
  const env = environment();
  assert.equal((await worker.fetch(makeRequest(body(), { Origin: 'https://other.test' }), env)).status, 403);
  assert.equal((await worker.fetch(makeRequest(body(), { 'Content-Type': 'text/plain' }), env)).status, 415);
  assert.equal((await worker.fetch(makeRequest(), {})).status, 403);
  assert.equal((await worker.fetch(makeRequest(), { ALLOWED_ORIGINS: origin })).status, 503);
  env.ORDER_LIMITER.limit = async () => ({ success: false });
  assert.equal((await worker.fetch(makeRequest(), env)).status, 429);
  const preflight = await worker.fetch(new Request('https://orders.test/orders', { method: 'OPTIONS', headers: { Origin: origin } }), env);
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  const large = body(); large.comment = 'x'.repeat(13000);
  assert.equal((await worker.fetch(makeRequest(large), environment())).status, 400);
});

test('concurrent submissions and persisted retries send Telegram once', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.match(url, /^https:\/\/api.telegram.org\/botTEST_ONLY\/sendMessage$/);
    const sent = JSON.parse(options.body); assert.equal(sent.chat_id, '-1000000000000'); assert.match(sent.text, /Телефон: \+79990000000/); assert.equal(sent.parse_mode, undefined);
    await new Promise(r => setTimeout(r, 5)); return Response.json({ ok: true, result: { message_id: 100 } });
  });
  const env = environment(), b = body();
  const responses = await Promise.all([worker.fetch(makeRequest(b), env), worker.fetch(makeRequest(b), env)]);
  for (const r of responses) { assert.equal(r.status, 200); assert.equal((await r.json()).orderId, b.id); }
  assert.equal(calls, 1);
  const state = memoryState(); const order = validateOrder(body());
  await new OrderDelivery(state, env).fetch(new Request('https://internal', { method: 'POST', body: JSON.stringify(order) }));
  await new OrderDelivery(state, env).fetch(new Request('https://internal', { method: 'POST', body: JSON.stringify(order) }));
  assert.equal(calls, 2); assert.ok(!JSON.stringify([...state.store]).includes(order.phone));
  const changed = { ...b, phone: '+79990000001' };
  assert.equal((await worker.fetch(makeRequest(changed), env)).status, 409); assert.equal(calls, 2);
});

test('Telegram timeout remains uncertain and cannot produce an automatic duplicate', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('timeout'); });
  const env = environment(), b = body();
  for (let i = 0; i < 2; i++) { const r = await worker.fetch(makeRequest(b), env); assert.equal(r.status, 409); assert.equal((await r.json()).code, 'UNKNOWN_DELIVERY'); }
  assert.equal(calls, 1);
});

test('definite Telegram rejection preserves a retry and never reports success', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? Response.json({ ok: false }, { status: 429 }) : Response.json({ ok: true, result: { message_id: 101 } }));
  const env = environment(), b = body();
  assert.equal((await worker.fetch(makeRequest(b), env)).status, 502);
  assert.equal((await worker.fetch(makeRequest(b), env)).status, 200); assert.equal(calls, 2);
});
