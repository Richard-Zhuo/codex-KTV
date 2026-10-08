import { isProductionEnvironment } from '../shared/deployment-environment.js';
import { PERMISSION_IDS } from '../shared/identity.js';
import { POLICY_ATTRIBUTE_IDS } from '../ledger/command-policy.js';
export const TEMPLATES = Object.freeze({
  NIGHT_OPERATOR: Object.freeze(['room.open','room.reserve','room.clean','room.issue','staff.record','order.sale','retail.sale','payment.collect','payment.settle','handover']),
  SALES_BOOKING: Object.freeze(['order.sale','staff.record','room.reserve']),
  BOOKING_STAFF: Object.freeze(['staff.record','room.reserve'])
});
export function refused(code) { return Object.assign(Error(code), { code }); }
export function text(value, max = 191) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw refused('BOOTSTRAP_INVALID_INPUT');
  return value;
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw refused('BOOTSTRAP_INVALID_UUID');
  return value;
}
export function exact(input, allowed, required = allowed) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(input,k))) throw refused('BOOTSTRAP_INVALID_FIELDS');
}
function ids(values, known) {
  if (!Array.isArray(values) || values.some(id => !known.includes(id)) || new Set(values).size !== values.length) throw refused('BOOTSTRAP_UNKNOWN_CAPABILITY');
  return [...values].sort();
}
export function validatePlan(input) {
  // Copy before any await; config is data, never an auth principal.
  const plan = JSON.parse(JSON.stringify(input));
  exact(plan, ['configVersion','environment','database','storeId','ledgerId','approved','people']);
  text(plan.configVersion,64); text(plan.storeId); text(plan.ledgerId,64);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(plan.database) || !['production','test'].includes(plan.environment) || typeof plan.approved !== 'boolean' || !Array.isArray(plan.people) || !plan.people.length) throw refused('BOOTSTRAP_INVALID_INPUT');
  const principals=new Set(), employees=new Set(), logins=new Set();
  plan.people=plan.people.map(person => {
    exact(person,['principalId','employeeId','displayName','loginIdentifier','enabled','template','permissions','policyAttributes']);
    uuid(person.principalId); uuid(person.employeeId); text(person.displayName,80); text(person.loginIdentifier);
    if (principals.has(person.principalId) || employees.has(person.employeeId) || logins.has(person.loginIdentifier) || person.principalId === person.employeeId) throw refused('BOOTSTRAP_DUPLICATE_BINDING');
    principals.add(person.principalId); employees.add(person.employeeId); logins.add(person.loginIdentifier);
    if (typeof person.enabled !== 'boolean' || !Object.hasOwn(TEMPLATES,person.template)) throw refused('BOOTSTRAP_INVALID_INPUT');
    person.permissions=[...new Set([...TEMPLATES[person.template],...ids(person.permissions,PERMISSION_IDS)])].sort();
    person.policyAttributes=ids(person.policyAttributes,POLICY_ATTRIBUTE_IDS);
    return person;
  }).sort((a,b)=>a.principalId.localeCompare(b.principalId));
  return plan;
}
export function validateTarget(plan, raw, confirmation, env=process.env) {
  if(!['production','test'].includes(plan.environment)||!/^[a-z][a-z0-9_]{0,63}$/.test(plan.database))throw refused('BOOTSTRAP_INVALID_DATABASE');
  let url; try { url=new URL(raw); } catch { throw refused('BOOTSTRAP_INVALID_DATABASE'); }
  if(url.protocol!=='mysql:' || !url.hostname || decodeURIComponent(url.pathname.slice(1))!==plan.database || confirmation!==plan.database+'/'+plan.storeId+'/'+plan.ledgerId) throw refused('BOOTSTRAP_TARGET_MISMATCH');
  if(plan.environment==='production' && /(?:^|_)test(?:_|$)/i.test(plan.database)) throw refused('BOOTSTRAP_PRODUCTION_TEST_DATABASE');
  let production;
  try { production=isProductionEnvironment(env); } catch { throw refused('BOOTSTRAP_ENVIRONMENT_INVALID'); }
  if(plan.environment==='test' && (plan.database!=='jbhh_ktv_test' || raw!==env.LEDGER_MYSQL_TEST_URL || production)) throw refused('BOOTSTRAP_TEST_TARGET_DENIED');
  return url;
}
