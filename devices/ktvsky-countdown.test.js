import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRemainingCountdown,KTVSKY_COUNTDOWN_TOLERANCE_SECONDS} from './ktvsky-countdown.js';
const base=Date.parse('2026-10-08T06:33:05.560Z');
const sample=(elapsed,remaining)=>({requestedCountdownSeconds:300,sentAt:new Date(base).toISOString(),
  observedAt:new Date(base+elapsed*1000).toISOString(),remainingCountdownSeconds:remaining});
for(const [elapsed,remaining,valid] of [[46,254,true],[156.23,144,true],[1,20,false],
  [1,289,true],[1,288,false],[11,300,false],[0,301,false],[300,0,false],[46,254.5,false],[-1,300,false]])
 test('countdown elapsed '+elapsed+' remaining '+remaining+' valid='+valid,()=>{
  assert.equal(verifyRemainingCountdown(sample(elapsed,remaining)),valid);
 });
test('countdown observation sequence accepts the recorded 254 to 144 over 110.23 seconds',()=>{
 assert.equal(KTVSKY_COUNTDOWN_TOLERANCE_SECONDS,10);
 assert.equal(verifyRemainingCountdown({...sample(156.23,144),previousObservation:sample(46,254)}),true);
});
for(const [name,previous,current] of [
 ['increase',sample(46,254),sample(47,255)],
 ['stale',sample(46,254),sample(46,254)],
 ['excessive pair drift',sample(46,260),sample(156,139)],
 ['invalid previous',sample(1,20),sample(46,254)]
])test('countdown sequence rejects '+name,()=>{
 assert.equal(verifyRemainingCountdown({...current,previousObservation:previous}),false);
});
test('countdown requires explicit valid timing and positive requested duration',()=>{
 for(const change of [{sentAt:undefined},{observedAt:'invalid'},{requestedCountdownSeconds:0},
  {remainingCountdownSeconds:null}])assert.equal(verifyRemainingCountdown({...sample(46,254),...change}),false);
});
