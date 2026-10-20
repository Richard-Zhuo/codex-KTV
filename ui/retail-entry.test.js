import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../rules.js';

const originalWindow = globalThis.window;
globalThis.window ??= { addEventListener() {} };
const { ctx } = await import('./context.js');
const { roomsPage } = await import('./pages/rooms.js');
const { retailDialog } = await import('./dialogs/retail.js');
if (originalWindow === undefined) delete globalThis.window;

const employeeId = '10000000-0000-4000-8000-000000000001';
function setup(permissions = ['retail.sale', 'staff.record']) {
  ctx.state = initialState();
  ctx.state.employees = [{ employeeId, displayName: 'Synthetic employee' }];
  ctx.state.retailBusinessSession = { pricePlanId: 'night-existing-v1' };
  ctx.formalEnabled = true;
  ctx.formal = { session: { principalId: 'synthetic-actor', permissionIds: permissions },
    workspace: { sections: { orders: true } } };
}
function withContext(work) {
  const saved = { ...ctx }, document = globalThis.document;
  try { return work(); }
  finally {
    Object.assign(ctx, saved);
    if (document === undefined) delete globalThis.document;
    else globalThis.document = document;
  }
}
// Only the DOM methods consumed by the existing sale/payment bindings are stubbed.
// Pricing, markup construction and the event callbacks are the production functions.
function dialogFixture() {
  const listeners = {}, total = {}, summary = {}, line = {};
  const category = { value: ctx.state.catalog.products.find(p => p.id === 'water').category };
  const product = { value: 'water' }, spec = { value: 'single' }, count = { value: '2' };
  const payment = { value: '0' };
  const row = { querySelector: selector => ({
    '[name="saleCategory"]': category, '[name="saleProduct"]': product,
    '[name="saleSpec"]': spec, '[name="saleCount"]': count,
    '.sale-line-total': line
  })[selector] };
  const form = { dataset: { form: 'retailSale' }, elements: { paymentAmount: payment },
    querySelectorAll: selector => selector === '.sale-item' ? [row] :
      selector === '[name="paymentAmount"]' ? [payment] : [],
    addEventListener(type, listener) { (listeners[type] ??= []).push(listener); } };
  const modal = { open: false, innerHTML: '', showModal() { this.open = true; },
    close() { this.open = false; }, querySelector: selector => selector === 'form' ? form : null };
  ctx.modal = modal;
  globalThis.document = { querySelector: selector => ({ '#sale-total': total, '#pay-sum': summary })[selector] ?? null };
  return { modal, count, payment, total, summary, line,
    input() { for (const listener of listeners.input ?? []) listener(); } };
}

test('room overview offers a direct retail action only with the existing formal grants', () => withContext(() => {
  setup();
  const before = structuredClone(ctx.state);
  const html = roomsPage();
  assert.match(html, /class="primary full" data-action="startRetail"[^>]*>独立零售<\/button>/);
  assert.ok(html.indexOf('data-action="startRetail"') < html.indexOf('全部包间'));
  assert.deepEqual(ctx.state, before);
  for (const grants of [[], ['retail.sale'], ['staff.record']]) {
    ctx.formal.session.permissionIds = grants;
    assert.doesNotMatch(roomsPage(), /data-action="startRetail"/);
  }
}));

test('formal retail uses explicit server employee IDs, no room, and existing live totals/payment confirmation', () => withContext(() => {
  setup();
  const before = structuredClone(ctx.state), f = dialogFixture();
  retailDialog();
  assert.equal(f.modal.open, true);
  assert.match(f.modal.innerHTML, /name="creditedEmployeeId" required/);
  assert.match(f.modal.innerHTML, /value="">请选择归属员工/);
  assert.ok(f.modal.innerHTML.includes(employeeId));
  assert.doesNotMatch(f.modal.innerHTML, /name="(?:room|order|employee)"|演示确认|当前登记人/);
  assert.match(f.modal.innerHTML, /确认收款并完成零售/);
  assert.match(f.modal.innerHTML, /type="checkbox" required/);
  assert.match(f.modal.innerHTML, /此处不会自动扣款/);
  assert.equal(ctx.salePricePlanId, 'night-existing-v1');
  assert.equal(f.total.textContent, '本次商品合计 ¥4');
  assert.equal(f.payment.value, '4.00');
  assert.match(f.summary.textContent, /金额一致/);
  f.count.value = '3'; f.input();
  assert.equal(f.total.textContent, '本次商品合计 ¥6');
  assert.equal(f.summary.textContent, '已填写 ¥4 · 还差 ¥2');
  f.payment.value = '6.00'; f.input();
  assert.match(f.summary.textContent, /金额一致/);
  assert.deepEqual(ctx.state, before);
}));

test('formal retail refuses missing grants before opening a form', () => withContext(() => {
  for (const grants of [[], ['staff.record'], ['retail.sale']]) {
    setup(grants);
    const f = dialogFixture(), before = structuredClone(ctx.state);
    assert.throws(() => retailDialog(), /权限/);
    assert.equal(f.modal.open, false);
    assert.deepEqual(ctx.state, before);
  }
}));

test('empty formal roster never falls back to a demo identity', () => withContext(() => {
  setup(); ctx.state.employees = [];
  const f = dialogFixture(); retailDialog();
  assert.match(f.modal.innerHTML, /name="creditedEmployeeId" required><option value="">请选择归属员工<\/option><\/select>/);
  assert.doesNotMatch(f.modal.innerHTML, /当前登记人|name="employee"/);
}));

test('demo retail keeps its existing employee choice and demo confirmation', () => withContext(() => {
  setup(); ctx.formalEnabled = false; ctx.formal = null; ctx.state.user = 'shaoBoss';
  const f = dialogFixture(); retailDialog();
  assert.match(f.modal.innerHTML, /name="employee"/);
  assert.match(f.modal.innerHTML, /演示确认/);
  assert.doesNotMatch(f.modal.innerHTML, /creditedEmployeeId/);
  assert.match(roomsPage(), /data-action="startRetail"/);
}));
