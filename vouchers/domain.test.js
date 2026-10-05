import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionRedemption } from './domain.js';

test('voucher intent transitions centrally and cannot skip claiming an attempt', () => {
  const intent = { status: 'PENDING', version: 0 };
  assert.deepEqual(transitionRedemption(intent, 'REDEEMING'), { status: 'REDEEMING', version: 1 });
  assert.throws(() => transitionRedemption(intent, 'REDEEMED'), { code: 'VOUCHER_INVALID_TRANSITION' });
  assert.deepEqual(intent, { status: 'PENDING', version: 0 });
});

import { REDEMPTION_TRANSITIONS } from './domain.js';
test('all frozen lifecycle edges are explicit; terminal provider facts cannot regress', () => {
  const expected={PENDING:['REDEEMING'],REDEEMING:['REDEEMED','FAILED','UNKNOWN'],
    UNKNOWN:['REDEEMED','FAILED','REVERSED','REFUNDED'],REDEEMED:['REVERSED','REFUNDED'],
    FAILED:[],REVERSED:[],REFUNDED:[]};
  assert.deepEqual(REDEMPTION_TRANSITIONS,expected);
  for(const [from,targets]of Object.entries(expected))for(const target of Object.keys(expected)){
    const current={status:from,version:7};
    if(targets.includes(target))assert.equal(transitionRedemption(current,target).version,8);
    else assert.throws(()=>transitionRedemption(current,target),{code:'VOUCHER_INVALID_TRANSITION'});
  }
});
