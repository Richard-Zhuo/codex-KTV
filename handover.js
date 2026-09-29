// 交班领域：按实际收款核对并单独记录前台现金。
// Phase 5 自 rules.js 迁出：handover 命令；expected 口径继续取 payments 汇总
// （collected 选择器在 sales.js）。函数体逐字节保留，差异计算与金额校验行为不变。
import { BusinessRejection } from './shared/business-error.js';
import { need } from './inventory.js';
import { collected } from './sales.js';

// —— 命令层：由 rules.js 的 transact 分支委托调用，参数与原分支一致 ——

export function submitHandover(s, data, person, time) {
  need(s, ['收银员','财务','店长','老板'], 'handover');
  if (!Number.isSafeInteger(data.actual) || data.actual < 0) throw new BusinessRejection('请输入有效实点金额');
  if (!Number.isSafeInteger(data.drawerCash) || data.drawerCash < 0) throw new BusinessRejection('请输入有效的前台现金');
  const expected = collected(s); s.handovers.push({ id: ++s.serial, expected, actual: data.actual, drawerCash: data.drawerCash, difference: data.actual-expected, person, time });
}
