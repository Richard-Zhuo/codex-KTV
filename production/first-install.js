import { createHash } from 'node:crypto';
import { initialState } from '../rules.js';
import { decodeLedgerJson, decodeLedgerSnapshot, encodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { digestSessionToken } from '../auth/session-token.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { validateSchema } from './schema.js';
import { validateTarget, exact, text, refused } from './plan.js';
import { catalogReadiness } from './readiness.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const databasePattern = /^[a-z][a-z0-9_]{0,63}$/;
const serverPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const nonIdentityTables = [
  'ledger_operations','ledger_success_audit','voucher_redemptions','voucher_operations',
  'provider_events','voucher_exceptions','room_control_workflows','room_device_mappings',
  'recovery_control','recovery_events'
];
const fields = ['version','environment','database','serverUuid','storeId','ledgerId','applicationCommit','kind'];
const stockFields = ['stockKind','productId','count','reason','opened'];
const commandFields = ['operationKey','expectedRevision','actorPrincipalId'];
const approvedFields = ['requestId','decisionNote'];
const cleanError = error => refused(error?.code==='LEDGER_COMMIT_OUTCOME_UNKNOWN' ? 'S1_COMMIT_OUTCOME_UNKNOWN' : /^S1_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'S1_FAILED');

function parseFacts(value) {
  try { const facts=decodeLedgerJson(value); if(!facts || typeof facts!=='object' || Array.isArray(facts)) throw Error(); return facts; }
  catch { throw refused('S1_AUDIT_INVALID'); }
}
function sorted(values) { return [...values].sort(); }
function same(a,b) { return JSON.stringify(sorted(a))===JSON.stringify(sorted(b)); }
function planDigest(plan) { return sha(JSON.stringify(plan)); }

export function validateFirstInstallPlan(input) {
  const p=structuredClone(input);
  if(!p || typeof p!=='object' || Array.isArray(p)) throw refused('S1_PLAN_INVALID');
  const extra=p.kind==='stock' ? [...commandFields,...stockFields] : p.kind==='approve' ? [...commandFields,...approvedFields] : [];
  exact(p,[...fields,...extra],p.kind==='stock' ? [...fields,...commandFields,'stockKind','productId','count','reason'] : [...fields,...extra]);
  if(p.version!==1 || !['production','test'].includes(p.environment) || !databasePattern.test(p.database) ||
     !serverPattern.test(p.serverUuid) || !commitPattern.test(p.applicationCommit) ||
     !['ledger','stock','approve'].includes(p.kind)) throw refused('S1_PLAN_INVALID');
  text(p.storeId); text(p.ledgerId,64);
  if(p.kind!=='ledger') {
    text(p.operationKey,120); text(p.actorPrincipalId);
    if(!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0) throw refused('S1_PLAN_INVALID');
  }
  if(p.kind==='stock') {
    if(!['drink','consumable'].includes(p.stockKind) || !Number.isSafeInteger(p.count) || p.count<0 ||
       !Number.isSafeInteger(p.opened ?? 0) || (p.opened ?? 0)<0 ||
       (p.stockKind==='drink' && Object.hasOwn(p,'opened'))) throw refused('S1_PLAN_INVALID');
    text(p.productId); text(p.reason,300);
    if(p.stockKind==='consumable'&&!Object.hasOwn(p,'opened')) throw refused('S1_PLAN_INVALID');
  }
  if(p.kind==='approve') {
    if(!Number.isSafeInteger(p.requestId)||p.requestId<1) throw refused('S1_PLAN_INVALID');
    text(p.decisionNote,300);
  }
  return Object.freeze(Object.fromEntries([...fields,...extra].filter(k=>Object.hasOwn(p,k)).map(k=>[k,p[k]])));
}
function ledgerPlan(plan) {
  return Object.fromEntries(fields.map(k=>[k,k==='kind'?'ledger':plan[k]]));
}
export function firstInstallConfirmation(plan) {
  return ['S1',plan.serverUuid,plan.database,plan.storeId,plan.ledgerId,planDigest(plan).slice(0,24)].join('/');
}
function checkTarget(plan,{databaseUrl,config,env}) {
  if(!config || plan.environment!==config.environment || plan.database!==config.database ||
     plan.storeId!==config.storeId || plan.ledgerId!==config.ledgerId ||
     plan.applicationCommit!==config.applicationCommit) throw refused('S1_TARGET_MISMATCH');
  if(plan.environment==='production' && ['NODE_ENV','KTV_HTTP_ENV','KTV_DEPLOYMENT_ENV'].some(k=>env?.[k]!=='production')) throw refused('S1_ENVIRONMENT_INVALID');
  validateTarget(plan,databaseUrl,plan.database+'/'+plan.storeId+'/'+plan.ledgerId,env);
}
async function serverIdentity(connection,plan) {
  const [[row]]=await connection.query('SELECT DATABASE() AS db, @@server_uuid AS server_uuid, VERSION() AS version');
  if(row?.db!==plan.database || row.server_uuid!==plan.serverUuid || !/^8\.4\./.test(row.version)) throw refused('S1_DATABASE_MISMATCH');
  return row;
}
async function identityFacts(connection,plan,events) {
  const receipts=events.filter(e=>e.facts.source==='identity-bootstrap').flatMap(e=>e.facts.identities??[]);
  const [accounts]=await connection.execute('SELECT a.principal_id, e.employee_id, e.enabled AS employee_enabled FROM auth_accounts a LEFT JOIN employees e ON e.principal_id=a.principal_id WHERE a.enabled=1');
  const [grants]=await connection.execute('SELECT principal_id, permission_id FROM auth_grants');
  const [attributes]=await connection.execute('SELECT principal_id, attribute_id FROM auth_policy_attributes');
  const reviewed=accounts.length>0 && accounts.every(a=>{
    const matching=receipts.filter(r=>r.principalId===a.principal_id && r.employeeId===a.employee_id && r.enabled===true);
    if(a.employee_enabled!==1 || matching.length===0) return false;
    const actual=grants.filter(g=>g.principal_id===a.principal_id).map(g=>g.permission_id);
    const actualAttributes=attributes.filter(g=>g.principal_id===a.principal_id).map(g=>g.attribute_id);
    return matching.some(r=>same(r.permissions??[],actual)&&same(r.policyAttributes??[],actualAttributes));
  });
  const opening=accounts.some(a=>grants.some(g=>g.principal_id===a.principal_id&&g.permission_id==='inventory.opening'));
  const approval=accounts.some(a=>grants.some(g=>g.principal_id===a.principal_id&&g.permission_id==='inventory.approve'));
  return {ready:reviewed&&opening&&approval,activeAccounts:accounts.length,reviewedAccounts:reviewed?accounts.length:0,
    openingPrincipalAvailable:opening,approvalPrincipalAvailable:approval};
}
async function rowsExist(connection,table) {
  const [rows]=await connection.query('SELECT 1 AS present FROM '+table+' LIMIT 1');
  return rows.length>0;
}
async function readFacts(connection,plan,lock=false) {
  const schema=await validateSchema(connection,plan.database);
  await serverIdentity(connection,plan);
  const [eventRows]=await connection.execute('SELECT store_id,ledger_id,environment,plan_digest,facts FROM production_bootstrap_events'+(lock?' FOR UPDATE':''));
  const events=eventRows.map(e=>({...e,facts:parseFacts(e.facts)}));
  if(events.some(e=>e.store_id!==plan.storeId||e.ledger_id!==plan.ledgerId||e.environment!==plan.environment)) throw refused('S1_STORE_MISMATCH');
  const [heads]=await connection.execute('SELECT ledger_id,revision,state_schema_version,state_json,state_checksum FROM ledger_heads'+(lock?' FOR UPDATE':''));
  const receipts=events.filter(e=>e.facts.source==='first-install-ledger');
  if(heads.length>1 || receipts.length>1 || (heads.length===0)!==(receipts.length===0) ||
     (heads.length===1 && heads[0].ledger_id!==plan.ledgerId)) throw refused('S1_EXISTING_LEDGER_CONFLICT');
  let state=null,revision=null,matchingReceipt=false;
  if(heads.length) {
    state=decodeLedgerSnapshot(heads[0].state_json,String(heads[0].state_checksum));
    revision=Number(heads[0].revision);
    if(!Number.isSafeInteger(revision)||revision<0||state.version!==heads[0].state_schema_version) throw refused('S1_LEDGER_INVALID');
    const receipt=receipts[0];
    matchingReceipt=receipt.facts.serverUuid===plan.serverUuid &&
      receipt.facts.database===plan.database && receipt.facts.storeId===plan.storeId &&
      receipt.facts.ledgerId===plan.ledgerId && receipt.facts.applicationCommit===plan.applicationCommit &&
      receipt.facts.initialRevision===0 && receipt.facts.stateSchemaVersion===state.version &&
      receipt.facts.schemaMigration===schema.migrations.at(-1) &&
      receipt.plan_digest===planDigest(ledgerPlan(plan));
    if(!matchingReceipt) throw refused('S1_EXISTING_LEDGER_CONFLICT');
  }
  const identity=await identityFacts(connection,plan,events);
  const businessRows=[];
  if(!heads.length) for(const table of nonIdentityTables) if(await rowsExist(connection,table)) businessRows.push(table);
  return {schema,identity,head:heads[0]??null,state,revision,matchingReceipt,businessRows};
}
function stateHasBusiness(state) {
  if(['orders','reservations','deposits','withdrawals','expenses','procurements','incidents','handovers']
    .some(key=>Array.isArray(state?.[key])&&state[key].length>0))return true;
  if((state?.inventoryReviews??[]).some(r=>r.before!==null || !['期初建账','消耗品期初建账'].includes(r.source)))return true;
  return (state?.ledger??[]).some(r=>r.before!==null || !['期初建账','消耗品期初建账'].includes(r.source));
}
function report(plan,facts,url) {
  const state=facts.state??initialState(),catalog=catalogReadiness(state);
  const uninitialized=catalog.products.filter(p=>p.inventoryManaged&&p.count===null).map(p=>p.productId);
  const blockers=[];
  if(!facts.head)blockers.push('LEDGER_NOT_INITIALIZED');
  if(uninitialized.length)blockers.push('INVENTORY_NOT_INITIALIZED');
  if(!facts.identity.ready)blockers.push('PRODUCTION_IDENTITIES_REQUIRED');
  if(facts.businessRows.length)blockers.push('S1_EXISTING_BUSINESS_DATA');
  return {dryRun:true,target:{database:plan.database,serverUuid:plan.serverUuid,host:url.hostname,port:url.port||'3306',
      storeId:plan.storeId,ledgerId:plan.ledgerId},applicationCommit:plan.applicationCommit,
    schemaMigration:facts.schema.migrations.at(-1),ledgerInitialized:Boolean(facts.head),revision:facts.revision,
    identity:facts.identity,inventoryItemsStillNull:uninitialized,
    plannedAction:Object.fromEntries(['kind','actorPrincipalId','stockKind','productId','count','opened','reason','requestId','decisionNote']
      .filter(k=>Object.hasOwn(plan,k)).map(k=>[k,plan[k]])),
    operationKey:plan.operationKey??null,expectedRevision:plan.expectedRevision??null,
    blockers,confirmation:firstInstallConfirmation(plan)};
}
export async function inspectFirstInstall({pool,plan:input,databaseUrl,config,env=process.env}) {
  const plan=validateFirstInstallPlan(input);
  checkTarget(plan,{databaseUrl,config,env});
  const url=new URL(databaseUrl),connection=await pool.getConnection();
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const facts=await readFacts(connection,plan);
    const result=report(plan,facts,url);
    await connection.rollback();
    return result;
  } catch(error) {
    try { await connection.rollback(); } catch { connection.destroy(); }
    throw cleanError(error);
  } finally { connection.release(); }
}
export async function applyInitialLedger({pool,plan:input,databaseUrl,config,confirmation,initiatedBy,env=process.env}) {
  const plan=validateFirstInstallPlan(input);
  if(plan.kind!=='ledger')throw refused('S1_PLAN_INVALID');
  checkTarget(plan,{databaseUrl,config,env});text(initiatedBy);
  if(confirmation!==firstInstallConfirmation(plan))throw refused('S1_CONFIRMATION_REQUIRED');
  const connection=await pool.getConnection();
  let locked=false,begun=false,commitAttempted=false,destroy=false;
  try {
    const [[lock]]=await connection.execute('SELECT GET_LOCK(?,10) AS acquired',[plan.database+'.s1-first-install']);
    if(Number(lock.acquired)!==1)throw refused('S1_BUSY');
    locked=true;
    await connection.beginTransaction();begun=true;
    const facts=await readFacts(connection,plan,true);
    if(facts.head) { await connection.rollback();begun=false;return {status:'already_initialized',ledgerId:plan.ledgerId,revision:facts.revision}; }
    if(!facts.identity.ready)throw refused('S1_IDENTITY_NOT_READY');
    if(facts.businessRows.length)throw refused('S1_EXISTING_BUSINESS_DATA');
    const state=initialState();
    if(stateHasBusiness(state)||Object.values(state.inventory).some(i=>i.count!==null)||
       Object.values(state.consumables).some(i=>i.count!==null))throw refused('S1_INITIAL_STATE_INVALID');
    const encoded=encodeLedgerSnapshot(state);
    const [[clock]]=await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS at");
    const [inserted]=await connection.execute(
      'INSERT INTO ledger_heads(ledger_id,revision,state_schema_version,state_json,state_checksum) VALUES(?,0,?,?,?)',
      [plan.ledgerId,state.version,encoded.json,encoded.checksum]);
    if(inserted.affectedRows!==1)throw refused('S1_LEDGER_WRITE_FAILED');
    const audit={source:'first-install-ledger',database:plan.database,serverUuid:plan.serverUuid,storeId:plan.storeId,
      ledgerId:plan.ledgerId,initialRevision:0,stateSchemaVersion:state.version,
      schemaMigration:facts.schema.migrations.at(-1),applicationCommit:plan.applicationCommit,
      createdAt:clock.at,createdBy:initiatedBy,result:'applied'};
    const [recorded]=await connection.execute(
      'INSERT INTO production_bootstrap_events(store_id,ledger_id,environment,initiated_by,config_version,plan_digest,facts,occurred_at) VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP(6))',
      [plan.storeId,plan.ledgerId,plan.environment,initiatedBy,'S1-v1',planDigest(plan),JSON.stringify(audit)]);
    if(recorded.affectedRows!==1)throw refused('S1_AUDIT_WRITE_FAILED');
    commitAttempted=true;await connection.commit();begun=false;
    return {status:'initialized',ledgerId:plan.ledgerId,revision:0,createdAt:clock.at};
  }catch(error){
    if(commitAttempted){destroy=true;throw refused('S1_COMMIT_OUTCOME_UNKNOWN');}
    if(begun)try{await connection.rollback();}catch{destroy=true;}
    throw cleanError(error);
  }finally{
    if(locked&&!destroy)try{await connection.execute('SELECT RELEASE_LOCK(?)',[plan.database+'.s1-first-install']);}catch{destroy=true;}
    if(destroy)connection.destroy();else connection.release();
  }
}
export async function applyOpeningInventory({pool,plan:input,databaseUrl,config,confirmation,credential,env=process.env}) {
  const plan=validateFirstInstallPlan(input);
  if(!['stock','approve'].includes(plan.kind))throw refused('S1_PLAN_INVALID');
  checkTarget(plan,{databaseUrl,config,env});
  if(confirmation!==firstInstallConfirmation(plan))throw refused('S1_CONFIRMATION_REQUIRED');
  if(!credential || typeof credential.loginIdentifier!=='string' || typeof credential.password!=='string' ||
     Object.keys(credential).some(k=>!['loginIdentifier','password'].includes(k))) throw refused('S1_CREDENTIAL_INVALID');
  const preview=await inspectFirstInstall({pool,plan,databaseUrl,config,env});
  if(!preview.ledgerInitialized || !preview.identity.ready)throw refused('S1_NOT_READY');
  const authStore=createMySqlAuthStore({pool,database:plan.database});
  const auth=createAuthService({store:authStore,rateLimiter:createMemoryLoginRateLimiter()});
  let login;
  try {
    login=await auth.login(credential);
    if(!login.ok || login.principalId!==plan.actorPrincipalId)throw refused('S1_ACTOR_MISMATCH');
    const store=createMySqlLedgerStore({pool,database:plan.database,ledgerId:plan.ledgerId,
      bindSessionRevalidation:authStore.bindSessionRevalidation});
    const head=await store.read(),state=head.state;
    if(stateHasBusiness(state))throw refused('S1_EXISTING_BUSINESS_DATA');
    const replay=state.processed.includes(plan.operationKey);
    let action,payload;
    if(plan.kind==='stock') {
      const bucket=plan.stockKind==='consumable'?state.consumables:state.inventory;
      const item=bucket?.[plan.productId];
      if(!item || (!replay && item.count!==null))throw refused('S1_STOCK_NOT_OPENING');
      action=plan.stockKind==='consumable'?'consumableStock':'stock';
      payload={product:plan.productId,count:plan.count,reason:plan.reason};
      if(plan.stockKind==='consumable')payload.opened=plan.opened;
    } else {
      const request=state.inventoryReviews?.find(r=>r.id===plan.requestId);
      if(!request || request.before!==null || (!replay && request.status!=='待审核'))throw refused('S1_REVIEW_NOT_OPENING');
      action='approveInventory';payload={request:plan.requestId,decisionNote:plan.decisionNote};
    }
    const app=createTrustedLedgerApplication({store,businessTimeZone:config.timeZone});
    const result=await app.execute({operationKey:plan.operationKey,expectedRevision:plan.expectedRevision,action,payload},
      {tokenDigest:digestSessionToken(login.token)});
    const after=await store.read();
    const matchingReviews=result.status==='committed' && plan.kind==='stock' ?
      after.state.inventoryReviews?.filter(r=>
        r.kind===plan.stockKind && r.product===plan.productId &&
        r.submittedByPrincipalId===plan.actorPrincipalId && r.after===plan.count &&
        r.before===null && r.reason===plan.reason &&
        (plan.stockKind!=='consumable'||r.openedAfter===plan.opened))??[] : [];
    // An older replay with multiple identical reviews cannot identify one request safely.
    const review=matchingReviews.length===1 ? matchingReviews[0] :
      after.revision===result.revision ? matchingReviews.at(-1) : null;
    return {status:result.status,operationKey:plan.operationKey,revision:after.revision,
      requestId:result.status==='committed' ? review?.id??(plan.kind==='approve'?plan.requestId:null) : null,
      remaining:catalogReadiness(after.state).products.filter(p=>p.inventoryManaged&&p.count===null).map(p=>p.productId)};
  }catch(error){throw cleanError(error);}
  finally { if(login?.ok)await auth.logout(login.token).catch(()=>{}); }
}
