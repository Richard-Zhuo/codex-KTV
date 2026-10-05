// 共同营业时段：14-18 为 day，18-02 为 night，其余 closed。
// Demo 保留设备本地时间；trusted open 必须显式传入服务器门店时区。
export function slot(time, timeZone) {
  const instant = new Date(time);
  const hour = timeZone === undefined ? instant.getHours() : Number(new Intl.DateTimeFormat('en-US',
    { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(instant));
  return hour >= 14 && hour < 18 ? 'day' : hour >= 18 || hour < 2 ? 'night' : 'closed';
}
