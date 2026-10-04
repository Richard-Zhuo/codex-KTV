import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyAttributeService } from './policy-attributes.js';

const actor = '00000000-0000-4000-8000-000000000002';
const target = '00000000-0000-4000-8000-000000000001';
const attributeId = 'rounding.self.excess';
const context = { actorPrincipalId: actor };
function fixture() {
  let state = { accounts: new Map([actor, target].map(principalId => [principalId,
    { principalId, enabled: true, policyAttributesConfigured: false }])), attributes: new Map(), events: [] };
  const calls = []; let fault = false;
  const store = { async runTransaction(work) {
    const next = structuredClone(state);
    const result = await work({
      async lockAccount(id) { calls.push(id); return next.accounts.get(id) ?? null; },
      async listPolicyAttributes(id) { return [...(next.attributes.get(id) ?? [])].sort(); },
      async configurePolicyAttributes(id) { next.accounts.get(id).policyAttributesConfigured = true; },
      async addPolicyAttribute(id, attr) {
        const ids = next.attributes.get(id) ?? new Set();
        if (ids.has(attr)) return false;
        ids.add(attr); next.attributes.set(id, ids); return true;
      },
      async removePolicyAttribute(id, attr) { return next.attributes.get(id)?.delete(attr) ?? false; },
      async appendPolicyAttributeEvent(event) {
        if (fault) throw Error('synthetic audit failure');
        next.events.push(structuredClone(event));
      }
    });
    state = next; return result;
  } };
  return { api: createPolicyAttributeService({ store }), calls, read: () => structuredClone(state),
    injectUnconfiguredAttribute: () => { state.attributes.set(target, new Set([attributeId])); },
    disable: id => { state.accounts.get(id).enabled = false; }, failAudit: () => { fault = true; } };
}

test('policy attributes: configuration is explicit; empty configured account differs from default', async () => {
  const f = fixture();
  assert.equal(f.read().accounts.get(target).policyAttributesConfigured, false);
  assert.equal(await f.api.configurePolicyAttributes({ principalId: target }, context), true);
  assert.equal(f.read().accounts.get(target).policyAttributesConfigured, true);
  assert.equal(f.read().attributes.size, 0);
  assert.equal(await f.api.configurePolicyAttributes({ principalId: target }, context), false);
  assert.equal(f.read().events.length, 1);
  const inconsistent = fixture(); inconsistent.injectUnconfiguredAttribute();
  const before = inconsistent.read();
  await assert.rejects(inconsistent.api.configurePolicyAttributes({ principalId: target }, context),
    error => error.code === 'AUTH_POLICY_ATTRIBUTES_INCONSISTENT');
  assert.deepEqual(inconsistent.read(), before);
});

test('policy attributes: grant requires configuration; duplicate grant/revoke do not duplicate audit', async () => {
  const f = fixture();
  await assert.rejects(f.api.grantPolicyAttribute({ principalId: target, attributeId }, context),
    error => error.code === 'AUTH_POLICY_ATTRIBUTES_UNCONFIGURED');
  assert.equal(f.read().events.length, 0);
  await f.api.configurePolicyAttributes({ principalId: target }, context);
  assert.equal(await f.api.grantPolicyAttribute({ principalId: target, attributeId }, context), true);
  assert.equal(await f.api.grantPolicyAttribute({ principalId: target, attributeId }, context), false);
  assert.deepEqual([...f.read().attributes.get(target)], [attributeId]);
  assert.equal(await f.api.configurePolicyAttributes({ principalId: target }, context), false);
  assert.deepEqual([...f.read().attributes.get(target)], [attributeId]);
  assert.equal(await f.api.revokePolicyAttribute({ principalId: target, attributeId }, context), true);
  assert.equal(await f.api.revokePolicyAttribute({ principalId: target, attributeId }, context), false);
  assert.equal(f.read().accounts.get(target).policyAttributesConfigured, true);
  assert.equal(f.read().events.length, 3);
});

test('policy attributes: audit actor is separate from target; account locks follow stable ID order', async () => {
  const f = fixture();
  await f.api.configurePolicyAttributes({ principalId: target }, context);
  await f.api.grantPolicyAttribute({ principalId: target, attributeId }, context);
  await f.api.revokePolicyAttribute({ principalId: target, attributeId }, context);
  assert.deepEqual(f.calls, [target, actor, target, actor, target, actor]);
  assert.deepEqual(f.read().events, [
    { actorPrincipalId: actor, principalId: target, eventType: 'policy-attributes-configured', attributeId: null },
    { actorPrincipalId: actor, principalId: target, eventType: 'policy-attribute-granted', attributeId },
    { actorPrincipalId: actor, principalId: target, eventType: 'policy-attribute-revoked', attributeId }
  ]);
  const own = fixture();
  await own.api.configurePolicyAttributes({ principalId: actor }, context);
  assert.deepEqual(own.calls, [actor]);
});

test('policy attributes: disabled actor/target and unknown accounts fail without changes', async () => {
  for (const id of [actor, target]) {
    const f = fixture(); f.disable(id);
    const before = f.read();
    await assert.rejects(f.api.configurePolicyAttributes({ principalId: target }, context),
      error => error.code === 'AUTH_POLICY_ACCOUNT_DISABLED');
    assert.deepEqual(f.read(), before);
  }
  const f = fixture();
  await assert.rejects(f.api.configurePolicyAttributes({ principalId: '00000000-0000-4000-8000-000000000099' }, context),
    error => error.code === 'AUTH_POLICY_ACCOUNT_NOT_FOUND');
  assert.equal(f.read().events.length, 0);
});

test('policy attributes: only supported IDs and explicit trusted actor context; no payload role inference', async () => {
  const f = fixture();
  for (const invalid of ['administrator', '*', 'rounding.*', 'unknown.attribute', 'rounding.self.excess ']) {
    await assert.rejects(f.api.grantPolicyAttribute({ principalId: target, attributeId: invalid }, context), TypeError);
  }
  await assert.rejects(f.api.configurePolicyAttributes({ principalId: target }, null), TypeError);
  await assert.rejects(f.api.configurePolicyAttributes({ principalId: target, actorPrincipalId: actor }, context), TypeError);
  await assert.rejects(f.api.configurePolicyAttributes({ principalId: target }, { actorPrincipalId: actor, role: 'administrator' }), TypeError);
  assert.deepEqual(f.calls, []);
});

test('policy attributes: audit failure rolls back configured flag and attribute changes', async () => {
  const f = fixture(); f.failAudit();
  await assert.rejects(f.api.configurePolicyAttributes({ principalId: target }, context), /audit failure/);
  assert.equal(f.read().accounts.get(target).policyAttributesConfigured, false);
  const g = fixture();
  await g.api.configurePolicyAttributes({ principalId: target }, context);
  g.failAudit(); const before = g.read();
  await assert.rejects(g.api.grantPolicyAttribute({ principalId: target, attributeId }, context), /audit failure/);
  assert.deepEqual(g.read(), before);
});
