// 存取酒领域：客人存酒登记、余额与取酒核对。
// Phase 5 自 rules.js 迁出：searchDeposits 查询与 deposit／withdraw 命令。
// 函数体逐字节保留，一次多酒共用 group、名称快照、尾号/姓名核对行为不变；
// 存取酒不扣商品库存；失败不提交由 transact 的克隆-校验-提交边界继续保证。
// quantity／phone 为模块私有副本（Phase 4 sales.js 同先例）。
import { BusinessRejection } from './shared/business-error.js';
import { product, saleOptions } from './catalog.js';
import { need } from './inventory.js';

function quantity(n) { if (!Number.isSafeInteger(n) || n <= 0) throw new BusinessRejection('数量必须是大于零的整数'); }
function phone(value) { if (!/^1\d{10}$/.test(value || '')) throw new BusinessRejection('请填写11位手机号'); }

export function searchDeposits(deposits, query) {
  const term = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!term) return [];
  return deposits.filter(d => String(d.phone || '').includes(term) || String(d.name || '').toLocaleLowerCase('zh-CN').includes(term));
}

// —— 命令层：由 rules.js 的 transact 分支委托调用，参数与原分支一致 ——

export function submitDeposit(s, data, person, time) {
  need(s, ['服务员','老板'], 'deposit.manage');
  const phoneValue = String(data.phone || '').trim();
  const name = String(data.name || '').trim().slice(0,30);
  if (!phoneValue && !name) throw new BusinessRejection('手机号和姓名至少填写一个');
  if (phoneValue) phone(phoneValue);
  if (!s.rooms.some(r => r.id === data.room)) throw new BusinessRejection('请选择房间');
  const items = Array.isArray(data.items) ? data.items : [{ product: data.product, count: data.count }];
  if (!items.length) throw new BusinessRejection('请至少添加一种酒');
  const group = `CJ${++s.serial}`;
  for (const item of items) {
    quantity(item.count);
    const depositProduct = product(item.productId || item.product, s.catalog);
    if (!depositProduct.openingGiftEligible || depositProduct.selectionOnly || !saleOptions(depositProduct).length) throw new BusinessRejection('请选择可存放的酒水');
    s.deposits.push({ id: ++s.serial, group, phone: phoneValue, name, room: data.room, product: depositProduct.id, productId: depositProduct.id, productNameSnapshot: depositProduct.name, baseUnitSnapshot: depositProduct.baseUnit, count: item.count, initial: item.count, time, person });
  }
}
export function withdrawDeposit(s, data, person, time) {
  need(s, ['服务员','老板'], 'deposit.manage'); quantity(data.count);
  const d = s.deposits.find(d => d.id === data.id);
  const identity = String(data.identity || '').trim();
  const phoneMatch = /^\d{4,11}$/.test(identity) && d?.phone && d.phone.endsWith(identity);
  const nameMatch = Boolean(d?.name && identity === d.name);
  if (!d || !identity || (!phoneMatch && !nameMatch)) throw new BusinessRejection('请输入登记手机号尾号（至少4位）或姓名核对'); if (data.count > d.count) throw new BusinessRejection('取酒不能超过剩余数量');
  d.count -= data.count; s.withdrawals.push({ id: ++s.serial, deposit: d.id, count: data.count, time, person });
}
