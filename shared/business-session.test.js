import test from 'node:test';
import assert from 'node:assert/strict';
import { businessSessionFor, countdownFor } from './business-session.js';
import { businessDateFor } from './business-day.js';
const timeZone = 'Asia/Shanghai';
for (const [at, type, date, target] of [
  ['2026-10-08T14:00:00+08:00','DAY','2026-10-08','2026-10-08T10:00:00.000Z'],
  ['2026-10-08T17:59:59+08:00','DAY','2026-10-08','2026-10-08T10:00:00.000Z'],
  ['2026-10-08T18:00:00+08:00','NIGHT','2026-10-08','2026-10-08T18:00:00.000Z'],
  ['2026-10-08T22:10:00+08:00','NIGHT','2026-10-08','2026-10-08T18:00:00.000Z'],
  ['2026-10-09T01:59:59+08:00','NIGHT','2026-10-08','2026-10-08T18:00:00.000Z']
]) test('formal session boundary ' + at, () => {
  const session = businessSessionFor(at, {timeZone});
  assert.equal(session.sessionType,type);assert.equal(session.sessionDate,date);
  assert.equal(session.targetEndAt,target);assert.equal(Object.isFrozen(session),true);
  assert.ok(countdownFor(session,at).durationMinutes > 0);
});
test('02:00 through 13:59 remain closed; timezone and offset must be explicit',()=>{
  for(const hour of ['02:00','12:00','13:59']) assert.equal(businessSessionFor('2026-10-08T'+hour+':00+08:00',{timeZone}),null);
  assert.equal(businessSessionFor('2026-10-08T13:59:59+08:00',{timeZone}),null);
  assert.throws(()=>businessSessionFor('2026-10-08T14:00:00+08:00'),/timeZone/);
  assert.throws(()=>businessSessionFor('2026-10-08T14:00:00',{timeZone}),/offset/);
  assert.throws(()=>businessSessionFor('2026-10-08T14:00:00Z',{timeZone:'invalid'}));
});
test('countdown uses actual zone and server now, rejects forged/expired target',()=>{
  const at='2026-10-08T22:10:00+08:00',s=businessSessionFor(at,{timeZone});
  assert.deepEqual(countdownFor(s,at),{targetEndAt:'2026-10-08T18:00:00.000Z',durationMinutes:230});
  assert.throws(()=>countdownFor({...s,targetEndAt:'2099-01-01T00:00:00Z'},at));
  assert.throws(()=>countdownFor(s,'2026-10-09T02:00:00+08:00'));
  assert.equal(businessSessionFor('2026-12-31T22:00:00Z',{timeZone:'UTC'}).targetEndAt,'2027-01-01T02:00:00.000Z');
});
test('DST nonexistent session closing time is rejected, not silently shifted',()=>{
  assert.throws(()=>businessSessionFor('2026-03-07T22:00:00-05:00',{timeZone:'America/New_York'}),/nonexistent/);
});

test('session date and noon business date are independently computed from trusted time',()=>{
 const at='2026-10-09T01:00:00+08:00',session=businessSessionFor(at,{timeZone});
 assert.equal(session.sessionType,'NIGHT');assert.equal(session.sessionDate,'2026-10-08');
 assert.equal(session.targetEndAt,'2026-10-08T18:00:00.000Z');
 assert.equal(businessDateFor(at,{timeZone}),'2026-10-08');
 assert.equal(businessSessionFor('2026-10-09T12:00:00+08:00',{timeZone}),null);
 assert.equal(businessDateFor('2026-10-09T11:59:59+08:00',{timeZone}),'2026-10-08');
 assert.equal(businessDateFor('2026-10-09T12:00:00+08:00',{timeZone}),'2026-10-09');
});
