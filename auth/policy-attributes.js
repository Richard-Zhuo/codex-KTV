import { EXCESS_ROUNDING_SELF } from '../ledger/command-policy.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fields(input, names) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).length !== names.length || names.some(name =>
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, name) ?? {}, 'value'))) {
    throw TypeError('policy attributes 参数字段无效');
  }
}
function principalId(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw TypeError('必须提供规范 principal UUID');
}
function failure(code) { return Object.assign(Error('policy attributes 配置被拒绝'), { code }); }

// Internal configuration capability, separate from business command dispatch.
// Caller supplies a trusted audit actor, never fields copied from request JSON.
export function createPolicyAttributeService({ store }) {
  if (typeof store?.runTransaction !== 'function') throw TypeError('policy attributes store 无效');

  async function change(input, context, kind) {
    fields(input, kind === 'configure' ? ['principalId'] : ['principalId', 'attributeId']);
    fields(context, ['actorPrincipalId']);
    principalId(input.principalId); principalId(context.actorPrincipalId);
    if (kind !== 'configure' && input.attributeId !== EXCESS_ROUNDING_SELF) {
      throw TypeError('必须提供受支持的具体 policy attribute');
    }
    // Freeze primitive inputs before awaiting; neither audit nor target can change in flight.
    const targetPrincipalId = input.principalId, actorPrincipalId = context.actorPrincipalId;
    const attributeId = kind === 'configure' ? null : input.attributeId;
    return store.runTransaction(async tx => {
      let target;
      // Multiple account FK locks use the same stable order as the employee boundary.
      for (const id of [...new Set([actorPrincipalId, targetPrincipalId])].sort()) {
        const account = await tx.lockAccount(id);
        if (!account) throw failure('AUTH_POLICY_ACCOUNT_NOT_FOUND');
        if (!account.enabled) throw failure('AUTH_POLICY_ACCOUNT_DISABLED');
        if (id === targetPrincipalId) target = account;
      }
      if (typeof target.policyAttributesConfigured !== 'boolean') throw Error('policy attributes 配置事实无效');
      if (kind !== 'configure' && !target.policyAttributesConfigured) {
        throw failure('AUTH_POLICY_ATTRIBUTES_UNCONFIGURED');
      }
      let changed;
      if (kind === 'configure') {
        if (target.policyAttributesConfigured) return false; // Never clears an existing set.
        const existing = await tx.listPolicyAttributes(targetPrincipalId);
        if (!Array.isArray(existing) || existing.length) throw failure('AUTH_POLICY_ATTRIBUTES_INCONSISTENT');
        await tx.configurePolicyAttributes(targetPrincipalId);
        changed = true;
      } else {
        changed = await tx[kind === 'grant' ? 'addPolicyAttribute' : 'removePolicyAttribute'](targetPrincipalId, attributeId);
      }
      if (changed) await tx.appendPolicyAttributeEvent({
        actorPrincipalId, principalId: targetPrincipalId, attributeId,
        eventType: kind === 'configure' ? 'policy-attributes-configured' :
          kind === 'grant' ? 'policy-attribute-granted' : 'policy-attribute-revoked'
      });
      return changed;
    });
  }

  return Object.freeze({
    configurePolicyAttributes: (input, context) => change(input, context, 'configure'),
    grantPolicyAttribute: (input, context) => change(input, context, 'grant'),
    revokePolicyAttribute: (input, context) => change(input, context, 'revoke')
  });
}
