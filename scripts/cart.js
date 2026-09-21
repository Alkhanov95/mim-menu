import { catalog, catalogVersion } from './catalog.js?v=20260921-cart';
import { orderConfig } from './order-config.js?v=20260921-cart';

const money = value => new Intl.NumberFormat('ru-RU').format(value) + ' ₽';
const products = new Map(catalog.map(product => [product.id, product]));
const storageKey = 'mim-cart-v1';
const maxLines = 20;
const maxQuantity = 20;
const maxItems = 100;

function startCart() {
  const cart = new Map();
  let pending = null;
  let busy = false;
  let announcementTimer;
  const shell = document.createElement('div');
  shell.innerHTML = `
    <button class="cart-toggle" type="button" aria-haspopup="dialog" aria-controls="order-dialog"><span>Корзина <span id="cart-count">0</span></span><span id="cart-amount">0 ₽</span></button>
    <p class="cart-announcement" role="status" aria-live="polite"></p>
    <dialog id="order-dialog" class="order-dialog" aria-labelledby="cart-title">
      <div class="dialog-heading"><h2 id="cart-title" tabindex="-1">Ваш заказ</h2><button class="icon-button" type="button" aria-label="Закрыть корзину">×</button></div>
      <div id="cart-success" role="status" hidden><h3>Заказ отправлен</h3><p>Сотрудник кафе свяжется с вами по указанному номеру и подтвердит заказ.</p><p id="confirmed-order"></p><button type="button" class="new-order-button">Вернуться к меню</button></div>
      <form id="order-form">
        <fieldset id="order-fields">
          <p id="cart-empty">В корзине пока пусто. Выберите блюда в меню.</p>
          <ul class="cart-items"></ul>
          <div class="cart-total"><span>Сумма заказа</span><strong id="order-total">0 ₽</strong></div>
          <label class="phone-label" for="order-phone">Номер телефона</label>
          <input id="order-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 999 123-45-67" required maxlength="24" aria-describedby="phone-hint">
          <p class="order-hint" id="phone-hint">Номер нужен, чтобы кафе связалось с вами и подтвердило заказ.</p>
          <label class="phone-label" for="order-comment">Комментарий — по желанию</label>
          <textarea id="order-comment" name="comment" rows="3" maxlength="300" placeholder="Например, пожелания к блюдам"></textarea>
          <p class="order-hint">Состав, наличие блюд и способ получения подтвердит сотрудник кафе.</p>
          <button class="order-submit" type="submit">Отправить заказ</button>
        </fieldset>
        <p class="order-error" id="order-error" role="alert" hidden></p>
        <p class="order-hint">Связаться с кафе: <a href="tel:+79264009599">+7 926 400-95-99</a></p>
      </form>
    </dialog>`;
  document.body.append(shell);
  document.body.classList.add('has-cart');
  const dialog = shell.querySelector('dialog');
  const form = shell.querySelector('form');
  const fields = shell.querySelector('fieldset');
  const list = shell.querySelector('.cart-items');
  const phone = shell.querySelector('#order-phone');
  const comment = shell.querySelector('#order-comment');
  const error = shell.querySelector('#order-error');
  const submit = shell.querySelector('.order-submit');
  const success = shell.querySelector('#cart-success');
  const lineKey = (id, variant) => JSON.stringify([id, variant]);
  const count = () => [...cart.values()].reduce((sum, line) => sum + line.quantity, 0);
  const total = () => [...cart.values()].reduce((sum, line) => sum + products.get(line.id).price * line.quantity, 0);

  function announce(text) {
    const node = shell.querySelector('.cart-announcement');
    clearTimeout(announcementTimer);
    node.textContent = text;
    node.classList.add('visible');
    announcementTimer = setTimeout(() => node.classList.remove('visible'), 2200);
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify({ savedAt: Date.now(), items: [...cart.values()] })); } catch { /* Cart also works without storage. */ }
  }
  function showError(message) { error.textContent = message; error.hidden = false; }
  function resetResult() { error.hidden = true; success.hidden = true; form.hidden = false; }
  function updateSummary() {
    shell.querySelector('#cart-count').textContent = count();
    shell.querySelector('#cart-amount').textContent = money(total());
    shell.querySelector('#order-total').textContent = money(total());
    shell.querySelector('#cart-empty').hidden = cart.size !== 0;
    submit.disabled = cart.size === 0;
    for (const button of document.querySelectorAll('.add-dish')) {
      const quantity = [...cart.values()].filter(line => line.id === button.dataset.productId).reduce((sum, line) => sum + line.quantity, 0);
      button.textContent = quantity ? `Добавить ещё · ${quantity} в корзине` : 'В корзину';
    }
  }
  function makeButton(text, label, action) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', label);
    button.addEventListener('click', action); return button;
  }
  function renderLines() {
    list.replaceChildren();
    for (const [key, line] of cart) {
      const product = products.get(line.id);
      const row = document.createElement('li');
      const description = document.createElement('div');
      const name = document.createElement('h3'); name.textContent = product.name;
      const detail = document.createElement('p'); detail.textContent = [product.portion, line.variant, money(product.price) + ' за шт.'].filter(Boolean).join(' · ');
      description.append(name, detail);
      const actions = document.createElement('div'); actions.className = 'cart-line-actions';
      const subtotal = document.createElement('strong'); subtotal.textContent = money(product.price * line.quantity);
      const quantity = document.createElement('div'); quantity.className = 'quantity';
      const label = product.name + (line.variant ? ', ' + line.variant : '');
      const value = document.createElement('span'); value.textContent = line.quantity;
      const minus = makeButton('−', 'Уменьшить количество: ' + label, () => change(-1));
      const plus = makeButton('+', 'Увеличить количество: ' + label, () => change(1));
      plus.disabled = line.quantity >= maxQuantity || count() >= maxItems;
      const remove = makeButton('Убрать', 'Убрать из корзины: ' + label, () => { cart.delete(key); changed(); submit.focus(); });
      remove.className = 'remove-item';
      function change(delta) {
        if (busy) return;
        if (delta > 0 && (line.quantity >= maxQuantity || count() >= maxItems)) return;
        line.quantity += delta;
        if (line.quantity === 0) { cart.delete(key); changed(); dialog.querySelector('#cart-title').focus(); return; }
        pending = null; error.hidden = true;
        value.textContent = line.quantity; subtotal.textContent = money(product.price * line.quantity);
        // Refresh limits on every row without replacing the focused button.
        for (const item of list.children) {
          const itemLine = cart.get(item.dataset.lineKey);
          item.querySelector('.quantity button:last-child').disabled = itemLine.quantity >= maxQuantity || count() >= maxItems;
        }
        updateSummary(); save();
      }
      row.dataset.lineKey = key;
      quantity.append(minus, value, plus); actions.append(subtotal, quantity, remove); row.append(description, actions); list.append(row);
    }
    updateSummary();
  }
  function changed() { pending = null; resetResult(); renderLines(); save(); }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && Date.now() - saved.savedAt < 7 * 86400000 && Array.isArray(saved.items)) {
      for (const line of saved.items.slice(0, maxLines)) {
        const product = products.get(line.id);
        if (!product || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > maxQuantity || count() + line.quantity > maxItems) continue;
        if (product.variants.length ? !product.variants.includes(line.variant) : line.variant !== '') continue;
        cart.set(lineKey(line.id, line.variant), { id: line.id, variant: line.variant, quantity: line.quantity });
      }
    }
  } catch { /* Ignore unavailable or damaged browser storage. */ }

  for (const dish of document.querySelectorAll('[data-product-id]')) {
    const product = products.get(dish.dataset.productId);
    if (!product) continue;
    let variantSelect;
    if (product.variants.length) {
      const label = document.createElement('label'); label.className = 'dish-variant'; label.textContent = 'Галушки';
      variantSelect = document.createElement('select'); variantSelect.setAttribute('aria-label', 'Вид галушек: ' + product.name);
      for (const variant of product.variants) { const option = document.createElement('option'); option.value = variant; option.textContent = variant; variantSelect.append(option); }
      label.append(variantSelect); dish.append(label);
    }
    const button = makeButton('В корзину', 'Добавить в корзину: ' + product.name, () => {
      if (busy) return;
      const variant = variantSelect?.value || ''; const key = lineKey(product.id, variant); const line = cart.get(key);
      if ((!line && cart.size >= maxLines) || count() >= maxItems || (line && line.quantity >= maxQuantity)) { announce('Для большого заказа позвоните в кафе: +7 926 400-95-99'); return; }
      cart.set(key, { id: product.id, variant, quantity: (line?.quantity || 0) + 1 });
      changed(); announce('Добавлено: ' + product.name);
    });
    button.className = 'add-dish'; button.dataset.productId = product.id; dish.append(button);
  }
  renderLines();
  shell.querySelector('.cart-toggle').addEventListener('click', () => { renderLines(); dialog.showModal(); dialog.querySelector('#cart-title').focus(); });
  shell.querySelector('.icon-button').addEventListener('click', () => dialog.close());
  shell.querySelector('.new-order-button').addEventListener('click', () => { resetResult(); dialog.close(); });
  phone.addEventListener('input', () => { phone.setCustomValidity(''); error.hidden = true; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !cart.size) return;
    let digits = phone.value.replace(/\D/g, '');
    if (digits.length === 10) digits = '7' + digits;
    if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
    if (!/^7\d{10}$/.test(digits)) { phone.setCustomValidity('Введите номер из 11 цифр, начиная с +7 или 8.'); phone.reportValidity(); return; }
    if (!orderConfig.endpoint) { showError('Онлайн-заказ пока недоступен. Позвоните в кафе: +7 926 400-95-99.'); return; }
    busy = true; fields.disabled = true; error.hidden = true; submit.textContent = 'Отправляем…';
    const payload = { catalogVersion, phone: '+' + digits, comment: comment.value.trim(), items: [...cart.values()].map(line => ({ ...line })) };
    const signature = JSON.stringify(payload);
    if (!pending || pending.signature !== signature) pending = { signature, id: crypto.randomUUID() };
    try {
      const response = await fetch(orderConfig.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, id: pending.id }), signal: AbortSignal.timeout(20000), credentials: 'omit', referrerPolicy: 'no-referrer' });
      const result = await response.json();
      if (!response.ok || result.ok !== true || typeof result.orderId !== 'string') {
        const messages = { RATE_LIMIT: 'Слишком много попыток. Подождите минуту или позвоните в кафе.', UNKNOWN_DELIVERY: 'Не удалось проверить доставку заказа. Чтобы не отправить его дважды, уточните в кафе по телефону.', INVALID_ORDER: 'Проверьте номер телефона и состав заказа.', CATALOG_CHANGED: 'Меню обновилось. Обновите страницу и проверьте корзину.' };
        throw new Error(messages[result.code] || 'Не удалось отправить заказ. Корзина сохранена — попробуйте ещё раз или позвоните в кафе.');
      }
      cart.clear(); save(); renderLines(); phone.value = ''; comment.value = ''; pending = null;
      form.hidden = true; success.hidden = false;
      shell.querySelector('#confirmed-order').textContent = 'Номер заказа: ' + result.orderId;
    } catch (failure) {
      showError(failure.name === 'TimeoutError' || failure.name === 'TypeError' ? 'Не удалось получить подтверждение. Корзина сохранена. Повторите отправку или уточните заказ по телефону.' : failure.message);
    } finally { busy = false; fields.disabled = false; submit.textContent = 'Отправить заказ'; updateSummary(); }
  });
}
if (orderConfig.enabled) startCart();
