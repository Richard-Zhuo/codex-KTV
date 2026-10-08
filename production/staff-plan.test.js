import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validatePlan} from './plan.js';
test('real staff proposal is explicit, disabled, one-account-per-person and minimally scoped',async()=>{
  const p=validatePlan(JSON.parse(await readFile(new URL('./staff-plan.proposed.json',import.meta.url),'utf8')));
  assert.equal(p.approved,false);assert.equal(p.people.length,6);assert.ok(p.people.every(person=>!person.enabled));
  for(const person of p.people) {
    assert.equal(person.permissions.includes('backend.view'),false);assert.equal(person.permissions.includes('review.self'),false);
    assert.equal(person.policyAttributes.length,0);
    if(['卓益','美娇'].includes(person.displayName))assert.equal(person.permissions.includes('payment.settle'),false);
    else {assert.ok(person.permissions.includes('payment.settle'));assert.ok(person.permissions.includes('retail.sale'));assert.ok(person.permissions.includes('handover'));}
  }
});
