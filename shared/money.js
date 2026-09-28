// 共同基础：整数分金额的解析与格式化。纯函数，不依赖业务状态。
// 语义冻结（Phase 2）：取整规则、正则校验与错误文案均与原 rules.js 逐字节一致。
export const money = cents => `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
export function cents(value) { if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw Error('金额请填写正数，最多两位小数'); const [a,b=''] = String(value).split('.'); const n = Number(a)*100 + Number(b.padEnd(2,'0')); if (!Number.isSafeInteger(n)) throw Error('金额过大'); return n; }
