// Phase 4 前测：orders/sales/payments 金额矩阵 characterization。
// 目的：在拆分 sales.js 之前冻结 room/retail 共管道的成交、收款、抹零、
// 挂账回款与失败不提交行为。测试从 './rules.js' 导入（抽取前源），
// 抽取后同文件应改为从 './sales.js' 验证同一绑定（见文件尾部后测段）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transact } from './rules.js';
import { total, outstanding, collected, nextCollectCharge } from './sales.js';

let sequence = 0;
const apply = (state, action, data) => transact(state, action, data, `sales-front-${++sequence}`);
const at = hour => `2026-09-28T${hour}:00:00+08:00`;
function stocked(s) { for (const balance of Object.values(s.inventory)) if (balance.count === null) balance.count = 1000; return s; }
function opened(beer = 'bw', room = '333') { let s = initialState(); s.clock = at('20'); return stocked(apply(s, 'open', { room, beer })); }
const signature = 'data:image/png;base64,' + 'A'.repeat(120);

test('前测·金额矩阵：单支/半打/整打混买，快照与金额逐项正确', () => {
  let s = opened();
  const id = s.orders[0].id;
  s = apply(s, 'sale', { order: id, items: [
    { product: 'bw', spec: 'single', count: 1 },
    { product: 'bw', spec: 'half', count: 1 },
    { product: 'bw', spec: 'dozen', count: 2 },
    { product: 'water', spec: 'single', count: 3 }
  ]});
  const lines = s.orders[0].sales;
  assert.equal(lines.length, 4);
  // 单支 ¥10、半打 ¥59、整打 ¥118×2、瓶装水 ¥2×3
  assert.deepEqual(lines.map(l => [l.saleOptionId, l.saleQuantity, l.totalBaseQuantity, l.pricePerSaleUnitCents, l.amountCents]), [
    ['single', 1, 1, 1000, 1000],
    ['half', 1, 6, 5900, 5900],
    ['dozen', 2, 24, 11800, 23600],
    ['single', 3, 3, 200, 600]
  ]);
  assert.equal(total(s.orders[0]), 29000 + 1000 + 5900 + 23600 + 600);
  // 同批 batch 相同、person/employeeId 归属一致
  assert.equal(new Set(lines.map(l => l.batch)).size, 1);
  assert.equal(lines[0].person, '陈姐');
  assert.equal(lines[0].employeeId, 'staff');
  assert.equal(lines[0].recordedBy, '陈姐');
});

test('前测·多笔付款分次收款：收费组顺序、剩余款、失败不提交', () => {
  let s = opened();
  const id = s.orders[0].id;
  s = apply(s, 'sale', { order: id, items: [{ product: 'bw', spec: 'half', count: 1 }] });
  const charge = nextCollectCharge(s.orders[0]);
  assert.equal(charge.kind, 'sale');
  assert.equal(charge.amount, 5900);
  // 金额不足被拒，状态不变（失败不提交）
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'collect', { order: id, charge: charge.id, payments: [{ method: '微信', amount: 5899 }] }), /之和必须等于/);
  assert.deepEqual(s, before);
  // 多笔付款一次收齐该组（key 幂等：同一操作编号重复提交返回原状态）
  const collectData = { order: id, charge: charge.id, payments: [{ method: '微信', amount: 2000 }, { method: '现金', amount: 3900 }] };
  s = transact(s, 'collect', collectData, 'collect-once');
  assert.equal(outstanding(s.orders[0]), 29000);
  assert.deepEqual(s.orders[0].payments.map(p => [p.method, p.amount, p.chargeId]), [['微信', 2000, charge.id], ['现金', 3900, charge.id]]);
  // 收款后组内 remaining 归零，下一组回到开房费用
  const next = nextCollectCharge(s.orders[0]);
  assert.equal(next.kind, 'open');
  assert.equal(next.remaining, 29000);
  const snapshot = structuredClone(s);
  assert.strictEqual(transact(s, 'collect', collectData, 'collect-once'), s);
  assert.deepEqual(s, snapshot);
});

test('前测·结账抹零：免零差额入 rounding，特殊情况触发店长审核', () => {
  let s = opened();
  const id = s.orders[0].id;
  // 半打 5900：先分两笔收齐 5900，结账时收 28900，余 29000 免零 100
  s = apply(s, 'sale', { order: id, items: [{ product: 'bw', spec: 'half', count: 1 }] });
  s = apply(s, 'collect', { order: id, charge: `sale:${s.orders[0].sales[0].batch}`, payments: [{ method: '微信', amount: 2000 }, { method: '现金', amount: 3900 }] });
  s = apply(s, 'settle', { order: id, payments: [{ method: '微信', amount: 16000 }, { method: '支付宝', amount: 12900 }], differenceType: '免零' });
  const o = s.orders[0];
  assert.equal(o.status, '已结账');
  assert.equal(o.rounding, 100);
  assert.equal(o.roundingType, '免零');
  assert.equal(o.roundingNote, '');
  assert.equal(o.roundingReview, null);
  assert.equal(collected(s), 2000 + 3900 + 16000 + 12900);
  assert.equal(s.rooms.find(r => r.id === '333').status, '待清洁');
  // 特殊情况需要备注：有差额但备注为空被拒
  let s2 = opened('bw', 'V01');
  const id2 = s2.orders[0].id;
  assert.throws(() => apply(s2, 'settle', { order: id2, payments: [{ method: '现金', amount: 10000 }], differenceType: '特殊情况', differenceNote: '' }), /说明/);
  s2 = apply(s2, 'settle', { order: id2, payments: [{ method: '现金', amount: 14000 }], differenceType: '特殊情况', differenceNote: '客人醉酒闹事减免' });
  assert.equal(s2.orders[0].rounding, 2800);
  assert.equal(s2.orders[0].roundingReview.status, '待审核');
  assert.equal(s2.orders[0].roundingReview.approver, '店长');
  // 超收被拒（用未结账的新订单验证）
  let s3 = opened('bw', 'V05');
  const id3 = s3.orders[0].id;
  const before3 = structuredClone(s3);
  assert.throws(() => apply(s3, 'settle', { order: id3, payments: [{ method: '现金', amount: 29001 }] }), /不能超过/);
  assert.deepEqual(s3, before3);
});

test('前测·pay 与 settle 同口径：无差额直收全额并结账', () => {
  let s = opened();
  s = apply(s, 'pay', { order: s.orders[0].id, payments: [{ method: '现金', amount: 29000 }] });
  assert.equal(s.orders[0].status, '已结账');
  assert.equal(s.orders[0].rounding, 0);
  assert.equal(collected(s), 29000);
  assert.equal(s.rooms.find(r => r.id === '333').status, '待清洁');
});

test('前测·独立零售成交快照与归属：无房、多笔付款、原子失败', () => {
  let s = opened();
  s.user = 'shaoBoss';
  const before = structuredClone(s);
  // 付款不等于成交金额被拒，不落任何账
  assert.throws(() => apply(s, 'retailSale', { items: [{ product: 'bw', spec: 'single', count: 2 }], payments: [{ method: '微信', amount: 1999 }] }), /之和必须等于/);
  assert.deepEqual(s, before);
  assert.throws(() => apply(s, 'retailSale', { items: [{ product: 'bw', spec: 'single', count: 0 }] }, ), /数量/);
  // 成交金额 0 被拒
  assert.throws(() => apply(s, 'retailSale', { items: [{ product: 'water', spec: 'single', count: 0 }] }), /数量|金额/);
  assert.deepEqual(s, before);
  s = apply(s, 'retailSale', { items: [{ product: 'bw', spec: 'single', count: 2 }, { product: 'water', spec: 'single', count: 1 }], payments: [{ method: '微信', amount: 1500 }, { method: '支付宝', amount: 700 }] });
  const order = s.orders.at(-1);
  assert.equal(order.kind, 'retail');
  assert.equal(order.room, null);
  assert.equal(order.status, '已结账');
  assert.equal(order.employeeId, 'shaoBoss');
  assert.equal(order.sales[0].source, undefined); // source 只在流水上，销售行没有
  assert.equal(total(order), 2200);
  assert.deepEqual(order.payments.map(p => [p.method, p.amount, p.chargeId, p.person]), [['微信', 1500, 'retail', '邵老板'], ['支付宝', 700, 'retail', '邵老板']]);
  assert.equal(s.rooms.some(r => r.order === order.id), false);
  // opened() 先开房后建账，开房赠饮只写流水不动 count；这里验证销售扣减本身
  assert.equal(s.inventory.bw.count, 1000 - 2);
  assert.equal(s.inventory.water.count, 1000 - 1);
  // 库存不足：整笔拒绝，不落账不扣库
  assert.throws(() => apply(s, 'retailSale', { items: [{ product: 'bw', spec: 'single', count: 100000 }], payments: [{ method: '现金', amount: 1000000 }] }), /库存不足/);
  assert.equal(s.orders.length, 2);
});

test('前测·挂账与回款：审批人分级、回款审核后入实收、失败不提交', () => {
  let s = opened();
  const id = s.orders[0].id;
  s = apply(s, 'credit', { order: id, phone: '13800000000', note: '宴请挂账', signature });
  const credit = s.orders[0].credit;
  assert.equal(credit.amount, 29000);
  assert.equal(credit.approver, '店长'); // ≤¥1000 挂账走店长
  assert.equal(s.orders[0].status, '待审批挂账');
  assert.equal(s.rooms.find(r => r.id === '333').status, '待清洁'); // 挂账释放房间
  s.user = 'boss';
  s = apply(s, 'approve', { order: id });
  assert.equal(s.orders[0].status, '已挂账');
  // 回款超额被拒
  const before = structuredClone(s);
  assert.throws(() => apply(s, 'repay', { order: id, amount: 29001, method: '现金' }), /不超过/);
  assert.deepEqual(s, before);
  s = apply(s, 'repay', { order: id, amount: 10000, method: '现金' });
  const request = s.orders[0].credit.repaymentRequests[0];
  assert.equal(request.status, '待审核');
  assert.equal(collected(s), 0);
  s.user = 'xiongBoss';
  s = apply(s, 'approveRepayment', { order: id, request: request.id });
  assert.equal(collected(s), 10000);
  assert.equal(s.orders[0].credit.remaining, 19000);
  assert.equal(s.orders[0].status, '已挂账');
  // 部分回款后剩余继续回款结清
  s.user = 'boss';
  s = apply(s, 'repay', { order: id, amount: 19000, method: '微信' });
  s.user = 'xiongBoss';
  s = apply(s, 'approveRepayment', { order: id, request: s.orders[0].credit.repaymentRequests.at(-1).id });
  assert.equal(s.orders[0].status, '已回款');
  assert.equal(collected(s), 29000);
});

// —— Phase 4 后测：sales.js 为销售域唯一 owner；Phase 8 起 rules.js 不再 re-export ——

test('后测·sales.js 为销售域唯一 owner（total/outstanding/PAYMENT_METHODS 直连）', async () => {
  const rules = await import('./rules.js');
  const domain = await import('./sales.js');
  assert.strictEqual(rules.total, undefined);
  assert.strictEqual(rules.PAYMENT_METHODS, undefined);
  assert.strictEqual(total, domain.total);
  assert.strictEqual(outstanding, domain.outstanding);
  // 金额查询与命令入口为纯销售域职责
  for (const name of ['submitSale', 'submitRetailSale', 'collectPayment', 'settleOrder', 'payOrder', 'decideRounding', 'applyCredit', 'decideCredit', 'submitRepay', 'decideRepayment']) {
    assert.equal(typeof domain[name], 'function', name);
  }
});

test('后测·两种销售共用同一成交规则：房间增购与独立零售的快照结构一致', () => {
  let s = initialState();
  s.clock = at('20');
  for (const b of Object.values(s.inventory)) if (b.count === null) b.count = 1000;
  s.user = 'shaoBoss';
  s = apply(s, 'open', { room: '333', beer: 'bw' });
  const roomId = s.orders[0].id;
  s = apply(s, 'sale', { order: roomId, items: [{ product: 'bw', spec: 'single', count: 2 }] });
  s = apply(s, 'retailSale', { items: [{ product: 'bw', spec: 'single', count: 2 }], payments: [{ method: '微信', amount: 2000 }] });
  const roomLine = s.orders[0].sales[0];
  const retailLine = s.orders[1].sales[0];
  // 同一 prepareSaleRows/appendSaleRows 管道：快照键结构完全一致
  assert.deepEqual(Object.keys(roomLine).sort(), Object.keys(retailLine).sort());
  assert.deepEqual(
    [roomLine.saleOptionId, roomLine.saleQuantity, roomLine.totalBaseQuantity, roomLine.pricePerSaleUnitCents, roomLine.amountCents, roomLine.snapshotStatus],
    [retailLine.saleOptionId, retailLine.saleQuantity, retailLine.totalBaseQuantity, retailLine.pricePerSaleUnitCents, retailLine.amountCents, retailLine.snapshotStatus]
  );
  // 流水 source 区分场景但结构一致
  const roomLedger = s.ledger.find(l => l.source === '加购销售');
  const retailLedger = s.ledger.find(l => l.source === '零售销售');
  assert.deepEqual([roomLedger.orderId, roomLedger.saleLineId, roomLedger.productId], [roomId, roomLine.id, 'bw']);
  assert.deepEqual([retailLedger.orderId, retailLedger.saleLineId, retailLedger.productId], [s.orders[1].id, retailLine.id, 'bw']);
});
