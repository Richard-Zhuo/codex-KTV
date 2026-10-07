import { slot } from './time.js';
import { businessDateFor } from './business-day.js';

export const SESSION_RULE_VERSION = 'opening-hours-v1';
export const DAY_PRICE_PLAN = 'day-v1';
export const EXISTING_PRICE_PLAN = 'night-existing-v1';
const partsAt = (instant, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).formatToParts(instant).map(p => [p.type, p.value]));
const dateOf = p => p.year + '-' + p.month + '-' + p.day;
function shiftDate(date, days) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
// Resolve an IANA-zone wall time with a round-trip check. Ambiguous/nonexistent
// closing instants fail closed instead of adopting the machine's local zone.
function closingInstant(date, hour, timeZone) {
  const wall = Date.parse(date + 'T' + String(hour).padStart(2, '0') + ':00:00Z');
  const offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = wall + hours * 3600000, p = partsAt(sample, timeZone);
    offsets.add(Date.parse(dateOf(p) + 'T' + p.hour + ':' + p.minute + ':' + p.second + 'Z') - sample);
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(value => {
    const p = partsAt(value, timeZone);
    return dateOf(p) === date && Number(p.hour) === hour && p.minute === '00' && p.second === '00';
  });
  if (candidates.length !== 1) throw TypeError('Store session closing time is ambiguous or nonexistent');
  return new Date(candidates[0]).toISOString();
}

// Called only with a server clock by trusted application paths. Closed hours
// remain closed for room opening; retail retains its existing all-hours policy.
export function businessSessionFor(serverNow, { timeZone } = {}) {
  businessDateFor(serverNow, { timeZone }); // validates explicit offset and zone
  const period = slot(serverNow, timeZone);
  if (period === 'closed') return null;
  const p = partsAt(Date.parse(serverNow), timeZone);
  const sessionDate = period === 'night' && Number(p.hour) < 2 ? shiftDate(dateOf(p), -1) : dateOf(p);
  const sessionType = period === 'day' ? 'DAY' : 'NIGHT';
  return Object.freeze({ sessionType, sessionDate, timeZone, ruleVersion: SESSION_RULE_VERSION,
    pricePlanId: sessionType === 'DAY' ? DAY_PRICE_PLAN : EXISTING_PRICE_PLAN,
    targetEndAt: closingInstant(sessionType === 'DAY' ? sessionDate : shiftDate(sessionDate, 1),
      sessionType === 'DAY' ? 18 : 2, timeZone) });
}

export function countdownFor(session, serverNow) {
  if (!session || !['DAY', 'NIGHT'].includes(session.sessionType)) throw TypeError('A formal session is required');
  const expected = businessSessionFor(serverNow, { timeZone: session.timeZone });
  if (!expected || expected.sessionType !== session.sessionType ||
      expected.sessionDate !== session.sessionDate || expected.targetEndAt !== session.targetEndAt ||
      expected.ruleVersion !== session.ruleVersion) throw TypeError('Session has ended or does not match the server clock');
  return Object.freeze({ targetEndAt: expected.targetEndAt,
    durationMinutes: Math.ceil((Date.parse(expected.targetEndAt) - Date.parse(serverNow)) / 60000) });
}
