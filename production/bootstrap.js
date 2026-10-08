import { createHash } from 'node:crypto';
import { derivePassword, assertPasswordInput } from '../auth/password.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { validatePlan, validateTarget, text, refused } from './plan.js';
import { validateSchema } from './schema.js';
function validPassword(value) {try{assertPasswordInput(value);return true;}catch{return false;}}
const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
export async function bootstrapIdentities({pool,plan:input,databaseUrl,confirmation,initiatedBy,dryRun=true,passwords={},env=process.env}) {
  const plan=validatePlan(input);
  const target=validateTarget(plan,databaseUrl,confirmation,env); text(initiatedBy);
  if(typeof dryRun!=='boolean' || (!dryRun&&!plan.approved)) throw refused('BOOTSTRAP_NOT_APPROVED');
  let connection;
  let locked=false,begun=false,committing=false,destroy=false;
  try {
    connection=await pool.getConnection();
    await validateSchema(connection,plan.database);
    if(!dryRun) {
      const [[lock]]=await connection.execute('SELECT GET_LOCK(?, 10) AS acquired',[plan.database+'.production-bootstrap']);
      if(Number(lock.acquired)!==1) throw refused('BOOTSTRAP_BUSY');
      locked=true;
    }
    if(dryRun) await connection.query('START TRANSACTION READ ONLY');
    else await connection.beginTransaction();
    begun=true;
    const auth=await createMySqlAuthStore({pool,database:plan.database}).bindManagementTransaction(connection);
    const [previous]=await connection.execute('SELECT store_id, ledger_id, environment, facts FROM production_bootstrap_events');
    if(previous.some(row=>row.store_id!==plan.storeId||row.ledger_id!==plan.ledgerId||row.environment!==plan.environment)) throw refused('BOOTSTRAP_STORE_MISMATCH');
    const receipts=previous.flatMap(row=>(typeof row.facts==='string'?JSON.parse(row.facts):row.facts).identities??[]);
    const [[start]]=await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS timestamp");
    const actions=[];
    if(!dryRun) for(const p of plan.people) await connection.execute('SELECT principal_id FROM auth_accounts WHERE principal_id=? FOR UPDATE',[p.principalId]);
    // Inspect every row before deriving a credential or writing anything.
    for(const person of plan.people) {
      const recorded=receipts.filter(r=>r.principalId===person.principalId||r.employeeId===person.employeeId);
      for(const r of recorded) {
        if(['principalId','employeeId','enabled','displayName','loginIdentifier','template'].some(key=>Object.hasOwn(r,key)&&r[key]!==person[key]))throw refused('BOOTSTRAP_IDENTITY_CONFLICT');
        if(!same(r.permissions,person.permissions)||!same(r.policyAttributes,person.policyAttributes))throw refused('BOOTSTRAP_CAPABILITY_CONFLICT');
      }
      const [[account]]=await connection.execute('SELECT a.enabled, a.policy_attributes_configured, c.login_identifier FROM auth_accounts a LEFT JOIN auth_credentials c ON c.principal_id=a.principal_id WHERE a.principal_id=?'+(dryRun?'':' FOR UPDATE'),[person.principalId]);
      const [[login]]=await connection.execute('SELECT principal_id FROM auth_credentials WHERE login_identifier=?',[person.loginIdentifier]);
      const [[employee]]=await connection.execute('SELECT employee_id,display_name,enabled,principal_id FROM employees WHERE employee_id=?'+(dryRun?'':' FOR UPDATE'),[person.employeeId]);
      const [[bound]]=await connection.execute('SELECT employee_id FROM employees WHERE principal_id=?',[person.principalId]);
      if((account&&(Boolean(account.enabled)!==person.enabled||account.login_identifier!==person.loginIdentifier)) || (login&&login.principal_id!==person.principalId) || (employee&&(employee.display_name!==person.displayName||Boolean(employee.enabled)!==person.enabled||(employee.principal_id&&employee.principal_id!==person.principalId))) || (bound&&bound.employee_id!==person.employeeId)) throw refused('BOOTSTRAP_IDENTITY_CONFLICT');
      if(recorded.length&&(!account||!employee?.principal_id))throw refused('BOOTSTRAP_IDENTITY_CONFLICT');
      const [grants]=await connection.execute('SELECT permission_id FROM auth_grants WHERE principal_id=?'+(dryRun?'':' FOR UPDATE'),[person.principalId]);
      const [attributes]=await connection.execute('SELECT attribute_id FROM auth_policy_attributes WHERE principal_id=?'+(dryRun?'':' FOR UPDATE'),[person.principalId]);
      if((recorded.length&&!same(grants.map(r=>r.permission_id),person.permissions)) || grants.some(row=>!person.permissions.includes(row.permission_id)) || (account&&account.policy_attributes_configured&&!same(attributes.map(row=>row.attribute_id),person.policyAttributes)) || (account&&!account.policy_attributes_configured&&attributes.length)) throw refused('BOOTSTRAP_CAPABILITY_CONFLICT');
      actions.push({person,createAccount:!account,createEmployee:!employee,link:!employee?.principal_id,
        grants:person.permissions.filter(id=>!grants.some(row=>row.permission_id===id)),configure:!account || !account.policy_attributes_configured});
    }
    const summary={environment:plan.environment,database:plan.database,databaseHost:target.hostname,databasePort:target.port||'3306',storeId:plan.storeId,ledgerId:plan.ledgerId,configVersion:plan.configVersion,dryRun,source:'identity-bootstrap',startedAt:start.timestamp,
      accountsCreated:actions.filter(a=>a.createAccount).length,employeesCreated:actions.filter(a=>a.createEmployee).length,
      bindingsCreated:actions.filter(a=>a.link).length,grantsAssigned:actions.reduce((n,a)=>n+a.grants.length,0),
      identities:actions.map(a=>({principalId:a.person.principalId,employeeId:a.person.employeeId,enabled:a.person.enabled,displayName:a.person.displayName,loginIdentifier:a.person.loginIdentifier,template:a.person.template,permissions:a.person.permissions,policyAttributes:a.person.policyAttributes}))};
    summary.status=dryRun?'planned':actions.some(a=>a.createAccount||a.createEmployee||a.link||a.grants.length||a.configure)?'applied':'already_satisfied';
    summary.credentialsRequired=actions.filter(a=>a.createAccount&&!validPassword(passwords[a.person.principalId])).map(a=>a.person.principalId);
    summary.readyToApply=plan.approved&&summary.credentialsRequired.length===0;
    if(!dryRun&&summary.credentialsRequired.length)throw refused('BOOTSTRAP_CREDENTIAL_REQUIRED');
    if(!dryRun) {
      for(const action of actions) {
        const p=action.person;
        if(action.createAccount) {
          const credential=await derivePassword(passwords[p.principalId]);
          await auth.insertAccount({principalId:p.principalId,loginIdentifier:p.loginIdentifier,credential});
          await auth.appendEvent({principalId:p.principalId,eventType:'account-created'});
          if(!p.enabled) {
            await auth.disableAccount(p.principalId);
            await auth.appendEvent({principalId:p.principalId,eventType:'account-disabled'});
          }
        }
        if(action.configure) {
          await auth.configurePolicyAttributes(p.principalId);
          for(const id of p.policyAttributes) await auth.addPolicyAttribute(p.principalId,id);
        }
        for(const id of action.grants) {
          await auth.addGrant(p.principalId,id);
          await auth.appendEvent({principalId:p.principalId,eventType:'grant-added'});
        }
        if(action.createEmployee) await connection.execute('INSERT INTO employees(employee_id,display_name,enabled,principal_id) VALUES(?,?,?,?)',[p.employeeId,p.displayName,p.enabled?1:0,p.principalId]);
        else if(action.link) await connection.execute('UPDATE employees SET principal_id=?,updated_at=UTC_TIMESTAMP(6) WHERE employee_id=?',[p.principalId,p.employeeId]);
      }
      const [[end]]=await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS timestamp");
      summary.completedAt=end.timestamp;
      await connection.execute('INSERT INTO production_bootstrap_events(store_id,ledger_id,environment,initiated_by,config_version,plan_digest,facts) VALUES(?,?,?,?,?,?,?)',
        [plan.storeId,plan.ledgerId,plan.environment,initiatedBy,plan.configVersion,createHash('sha256').update(JSON.stringify(plan)).digest('hex'),JSON.stringify(summary)]);
    }
    if(dryRun) await connection.rollback();
    else { committing=true; await connection.commit(); }
    begun=false; return summary;
  } catch(error) {
    if(committing) {destroy=true;throw refused('BOOTSTRAP_COMMIT_UNKNOWN');}
    if(begun) try{await connection.rollback();}catch{destroy=true;}
    // Never forward database messages, input values, driver causes or passwords.
    throw refused(/^BOOTSTRAP_[A-Z_]+$/.test(error?.code??'')?error.code:'BOOTSTRAP_FAILED');
  } finally {
    if(locked&&!destroy) try{await connection.execute('SELECT RELEASE_LOCK(?)',[plan.database+'.production-bootstrap']);}catch{destroy=true;}
    if(connection){if(destroy) connection.destroy(); else connection.release();}
  }
}

