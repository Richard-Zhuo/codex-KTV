// 共同基础：营业时段判断。纯函数，使用本地设备时间。
// 语义冻结（Phase 2）：14-18 点为 day，18-02 点为 night，其余 closed，与原 rules.js 逐字节一致。
export function slot(time) { const h = new Date(time).getHours(); return h >= 14 && h < 18 ? 'day' : h >= 18 || h < 2 ? 'night' : 'closed'; }
