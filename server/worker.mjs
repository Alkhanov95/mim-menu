import { catalog, catalogVersion } from '../scripts/catalog.js';

const products = new Map(catalog.map(product => [product.id, product]));
const MAX_BODY = 12000;
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const failure = (code, status = 400) => json({ ok: false, code }, status);

export function validateOrder(body) {
  if (!body || typeof body !== 'object' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id || '')) throw new Error('INVALID_ORDER');
  if (body.catalogVersion !== catalogVersion) throw new Error('CATALOG_CHANGED');
  if (typeof body.phone !== 'string' || !/^\+7\d{10}$/.test(body.phone)) throw new Error('INVALID_ORDER');
  if (typeof body.comment !== 'string' || body.comment.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.comment)) throw new Error('INVALID_ORDER');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) throw new Error('INVALID_ORDER');
  const seen = new Set(); let count = 0;
  const items = body.items.map(line => {
    const product = products.get(line?.id);
    if (!product || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) throw new Error('INVALID_ORDER');
    if (product.variants.length ? !product.variants.includes(line.variant) : line.variant !== '') throw new Error('INVALID_ORDER');
    const key = JSON.stringify([line.id, line.variant]);
    if (seen.has(key)) throw new Error('INVALID_ORDER');
    seen.add(key); count += line.quantity;
    return { id: product.id, name: product.name, portion: product.portion, price: product.price, quantity: line.quantity, variant: line.variant };
  });
  if (count > 100) throw new Error('INVALID_ORDER');
  items.sort((a, b) => JSON.stringify([a.id, a.variant]).localeCompare(JSON.stringify([b.id, b.variant])));
  return { id: body.id.toLowerCase(), phone: body.phone, comment: body.comment.trim(), items, total: items.reduce((sum, line) => sum + line.price * line.quantity, 0) };
}

export function telegramText(order) {
  const money = number => new Intl.NumberFormat('ru-RU').format(number) + ' ₽';
  return [
    'Новый заказ МИМ', '№ ' + order.id, '', 'Телефон: ' + order.phone, '',
    ...order.items.map((line, index) => `${index + 1}. ${line.name}${line.portion ? ' (' + line.portion + ')' : ''}${line.variant ? ' — ' + line.variant : ''}\n${line.quantity} × ${money(line.price)} = ${money(line.price * line.quantity)}`),
    '', 'Сумма: ' + money(order.total),
    ...(order.comment ? ['', 'Комментарий клиента:', order.comment] : []),
    '', 'Свяжитесь с клиентом для подтверждения состава и способа получения.',
  ].join('\n');
}

async function readBody(request) {
  if (!request.body) throw new Error('INVALID_ORDER');
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('INVALID_ORDER'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim());
    if (!origin || !allowed.includes(origin)) return failure('FORBIDDEN', 403);
    const headers = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' };
    const respond = response => new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
    if (new URL(request.url).pathname !== '/orders') return respond(failure('NOT_FOUND', 404));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return respond(failure('METHOD_NOT_ALLOWED', 405));
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return respond(failure('INVALID_ORDER', 415));
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.ORDER_DELIVERY || !env.ORDER_LIMITER) return respond(failure('UNAVAILABLE', 503));
    try {
      // Origin checks are not authentication. Limit traffic independently by client IP.
      const { success } = await env.ORDER_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
      if (!success) return respond(failure('RATE_LIMIT', 429));
      let order;
      try { order = validateOrder(await readBody(request)); } catch (error) { return respond(failure(error.message === 'CATALOG_CHANGED' ? 'CATALOG_CHANGED' : 'INVALID_ORDER', error.message === 'CATALOG_CHANGED' ? 409 : 400)); }
      if (telegramText(order).length > 4000) return respond(failure('INVALID_ORDER'));
      const stub = env.ORDER_DELIVERY.get(env.ORDER_DELIVERY.idFromName(order.id));
      return respond(await stub.fetch(new Request('https://delivery.internal/', { method: 'POST', body: JSON.stringify(order) })));
    } catch { return respond(failure('UNAVAILABLE', 503)); }
  },
};

// Each request UUID has durable delivery state, so retries do not send duplicates.
export class OrderDelivery {
  constructor(state, env) { this.state = state; this.env = env; this.queue = Promise.resolve(); }
  fetch(request) {
    const result = this.queue.then(() => this.deliver(request));
    this.queue = result.catch(() => {});
    return result;
  }
  async deliver(request) {
    const order = await request.json();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(order)));
    const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const previous = await this.state.storage.get('delivery');
    if (previous && previous.fingerprint !== fingerprint) return failure('INVALID_ORDER', 409);
    if (previous?.status === 'sent') return json({ ok: true, orderId: order.id });
    // Telegram may have accepted a timed-out request. Never resend an uncertain delivery automatically.
    if (previous?.status === 'sending' || previous?.status === 'unknown') return failure('UNKNOWN_DELIVERY', 409);
    await this.state.storage.put('delivery', { fingerprint, status: 'sending' });
    await this.state.storage.setAlarm(Date.now() + 2 * 86400000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.env.TELEGRAM_CHAT_ID, text: telegramText(order), link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (data.ok === false) {
        await this.state.storage.put('delivery', { fingerprint, status: 'failed' });
        return failure('TELEGRAM_UNAVAILABLE', 502);
      }
      if (!response.ok || data.ok !== true || !Number.isInteger(data.result?.message_id)) throw new Error('Unconfirmed delivery');
      await this.state.storage.put('delivery', { fingerprint, status: 'sent' });
      return json({ ok: true, orderId: order.id });
    } catch {
      await this.state.storage.put('delivery', { fingerprint, status: 'unknown' });
      return failure('UNKNOWN_DELIVERY', 409);
    }
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
