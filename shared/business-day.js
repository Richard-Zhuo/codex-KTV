// 营业日是日期归属，不改写开单或付款的真实时间戳。
// 门店时区尚待正式配置；调用方必须显式提供，不能依赖设备默认时区。
export const BUSINESS_DAY_POLICY = Object.freeze({ version: 'noon-v1', cutoff: '12:00' });

export function businessDateFor(occurredAt, { timeZone } = {}) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    throw new TypeError('business date requires an explicit store timeZone');
  }
  if (typeof occurredAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(occurredAt)) {
    throw new TypeError('business date requires an ISO timestamp with an explicit offset');
  }
  const instant = new Date(occurredAt);
  const calendarDate = new Date(occurredAt.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(instant.getTime()) || !Number.isFinite(calendarDate.getTime()) ||
      calendarDate.toISOString().slice(0, 10) !== occurredAt.slice(0, 10)) {
    throw new TypeError('business date requires a valid timestamp');
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant).map(part => [part.type, part.value]));
  const date = parts.year + '-' + parts.month + '-' + parts.day;
  if (Number(parts.hour) >= Number(BUSINESS_DAY_POLICY.cutoff.slice(0, 2))) return date;
  const previous = new Date(date + 'T00:00:00Z');
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}
