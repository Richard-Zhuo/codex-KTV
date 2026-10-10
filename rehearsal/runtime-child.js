// Fake composition only; production/start.js never imports this module.
// It uses the accepted package's production config, TLS, HTTP, auth, ledger and recovery guards.
import {readFile,writeFile,appendFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createInterface} from 'node:readline';
import {assertOwnedRoot,scopeNames} from './scope.js';
const control=JSON.parse(await readFile(process.argv[2],'utf8')),names=scopeNames(control.id),root=await assertOwnedRoot(control.root,control.id);
if(resolve(control.application)!==join(root,'current-application')||control.database!=='jbhh_ktv_test'&&!/^jbhh_ktv_restore_s5e_[a-z0-9_]+$/.test(control.database)||!control.database.endsWith('_'+names.id)&&control.database!=='jbhh_ktv_test')throw Error('REHEARSAL_CHILD_SCOPE_REQUIRED');
const importApp=path=>import(pathToFileURL(join(control.application,path)).href);
const {loadRuntimeConfig}=await importApp('production/runtime-config.js'),{createProductionRuntime}=await importApp('production/runtime.js'),{createSafeLogger}=await importApp('production/runtime-log.js');
const {createOperationalRuntime}=await importApp('operations/runtime.js'),{FakeAlertTransport}=await importApp('operations/alerts.js'),{FakeKtvRoomControlGateway}=await importApp('devices/fake-gateway.js');
const {createMySqlAuthStore}=await importApp('auth/mysql-store.js'),{createAuthService}=await importApp('auth/service.js'),{createMemoryLoginRateLimiter}=await importApp('auth/rate-limit.js');
const {createMySqlEmployeeStore}=await importApp('employees/mysql-store.js'),{createMySqlLedgerStore}=await importApp('ledger/mysql-store.js'),{createTrustedLedgerApplication}=await importApp('ledger/application.js');
const {createHttpApi}=await importApp('http/api.js'),{createCurrentSessionReader}=await importApp('http/query.js'),{readDeviceHead}=await importApp('devices/mysql-port.js');
const {createRoomControlRuntime}=await importApp('devices/runtime.js'),{recoveryApiGate,bindRecoveryWriteGuard,recoveryMode}=await importApp('recovery/gate.js'),{readProductionReadiness}=await importApp('production/readiness.js');
const {default:mysql}=await importApp('node_modules/mysql2/promise.js');
const env={NODE_ENV:'production',KTV_HTTP_ENV:'production',KTV_DEPLOYMENT_ENV:'production'},loaded=await loadRuntimeConfig(control.configPath,env);
const secret=JSON.parse(await readFile(loaded.config.secretsFile,'utf8')),db=secret.database;
if(db.name!==control.database||db.host!=='127.0.0.1'||![33314,33315].includes(db.port)||loaded.config.storeId!==names.storeId||loaded.config.ledgerId!==names.ledgerId||loaded.config.liveControlEnabled!==false)throw Error('REHEARSAL_CHILD_TARGET_MISMATCH');
const rawPool=mysql.createPool({host:db.host,port:db.port,user:db.user,password:db.password,database:db.name,connectionLimit:8,connectTimeout:1500});
const guard=await rawPool.getConnection();try{const [[r]]=await guard.query('SELECT @@datadir AS datadir,@@server_uuid AS uuid');if(resolve(r.datadir)!==join(root,'data')||r.uuid!==control.serverUuid)throw Error('REHEARSAL_CHILD_SERVER_REQUIRED');}finally{guard.release();}
const settings=async()=>JSON.parse(await readFile(join(root,'controls.json'),'utf8'));
const pool={async getConnection(){const c=await rawPool.getConnection();try{const s=await settings();if(s.clock){const t=(Date.parse(s.clock)+Date.now()-(s.clockSetAt??Date.now()))/1000;if(!Number.isFinite(t))throw Error('REHEARSAL_CLOCK_INVALID');await c.query('SET timestamp=?',[t]);}else await c.query('SET timestamp=DEFAULT');return c;}catch(e){c.release();throw e;}},
 async query(...args){const c=await this.getConnection();try{return await c.query(...args);}finally{c.release();}},
 async execute(...args){const c=await this.getConnection();try{return await c.execute(...args);}finally{c.release();}}};
const logger=createSafeLogger({secrets:loaded.redactionSecrets,write:line=>process.stdout.write(line)}),transport=new FakeAlertTransport();
const originalSend=transport.send.bind(transport);transport.send=async payload=>{const s=await settings();if(['timeout','fail'].includes(s.alert))await appendFile(join(loaded.logDirectory,'fake-alert-attempts.jsonl'),JSON.stringify({outcome:s.alert,incidentId:payload.incidentId,code:payload.code})+'\n');if(s.alert==='timeout')return new Promise(()=>{});if(s.alert==='fail')throw Error('SYNTHETIC_ALERT_FAILED');const r=await originalSend(payload);await appendFile(join(loaded.logDirectory,'fake-alerts.jsonl'),JSON.stringify(payload)+'\n');return r;};
const operations=await createOperationalRuntime({loaded,logger,transport});
const authStore=createMySqlAuthStore({pool,database:db.name,bindRecoveryGuard:bindRecoveryWriteGuard}),auth=createAuthService({store:authStore,rateLimiter:createMemoryLoginRateLimiter()}),employeeStore=createMySqlEmployeeStore({pool,database:db.name,bindRecoveryGuard:bindRecoveryWriteGuard});
const store=createMySqlLedgerStore({pool,database:db.name,ledgerId:names.ledgerId,deviceControlMode:'required',bindRecoveryGuard:bindRecoveryWriteGuard,bindSessionRevalidation:authStore.bindSessionRevalidation,bindEmployeeResolver:employeeStore.bindEmployeeResolver});
const gateway=new FakeKtvRoomControlGateway();let saved={room:gateway.room,steps:[]};
try{saved=JSON.parse(await readFile(join(root,'fake-device.json'),'utf8'));gateway.room=saved.room;gateway.steps=new Map(saved.steps);}catch(e){if(e.code!=='ENOENT')throw e;}
const invoke=gateway.invoke.bind(gateway);
gateway.invoke=async(method,input,normal)=>{
 const s=await settings();gateway.room.online=s.online!==false;
 const result=method==='queryRoomState'&&s.queryUnknown?gateway.evidence(input,{kind:'UNKNOWN',room:{online:true,open:null,countdownTargetEndAt:null},stepResult:'UNKNOWN',settled:false}):await invoke(method,input,normal);
 await writeFile(join(root,'fake-device.json'),JSON.stringify({room:gateway.room,steps:[...gateway.steps]}));
 await appendFile(join(root,'fake-device-calls.jsonl'),JSON.stringify({method,workflowId:input.workflowId,stepId:input.stepId,targetEndAt:input.targetEndAt,countdownSeconds:input.countdownSeconds})+'\n');
 if(method==='queryRoomState'&&s.holdQuery){
  await writeFile(join(root,'query-held.json'),JSON.stringify({workflowId:input.workflowId,stepId:input.stepId}));
  if(!input.signal.aborted)await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));
 }
 if(method==='openRoom'&&s.openUnknown){await writeFile(join(root,'controls.json'),JSON.stringify({...s,openUnknown:false}));throw Error('SYNTHETIC_RESPONSE_LOST');}return result;
};
const devices=createRoomControlRuntime({pool,database:db.name,ledgerId:names.ledgerId,authStore,gateway,testOnly:true,recoveryGuard:true,intervalMs:300});
const trustedApplication=createTrustedLedgerApplication({store,businessTimeZone:'Asia/Shanghai'});
const application={async execute(...args){const result=await trustedApplication.execute(...args),s=await settings();if(result.status==='committed'&&s.alertDrill){await operations.fatal('PROCESS_FAILURE');await operations.dispatcher.tick();await writeFile(join(root,'controls.json'),JSON.stringify({...s,alertDrill:false}));}return result;}};
const api=createHttpApi({authService:auth,application,store,employeeStore,sessionReader:createCurrentSessionReader({pool,authStore}),deviceSnapshot:(c,h)=>readDeviceHead(c,db.name,h),businessTimeZone:'Asia/Shanghai',origin:loaded.config.publicOrigin,environment:'production',logger,operationalSnapshot:()=>operations.snapshot(),onLoginOutcome:e=>operations.login(e)});
const services={...recoveryApiGate(api,{pool}),async readiness(){const report=await readProductionReadiness({pool,config:{...loaded.productionConfig,environment:'test',deviceControlMode:'disabled'}});const c=await pool.getConnection();try{const mode=await recoveryMode(c);return {...report,ready:report.ready&&mode==='NORMAL',blockers:[...report.blockers,...(mode==='NORMAL'?[]:[{code:'RECOVERY_PAUSED'}])]};}finally{c.release();}},
 async operationalFacts(){const c=await pool.getConnection();try{const [rows]=await c.execute('SELECT state_json,state_checksum FROM room_control_workflows WHERE ledger_id=?',[names.ledgerId]);const {decodeLedgerSnapshot}=await importApp('ledger/mysql-snapshot.js');return {recoveryMode:await recoveryMode(c),worker:'ENABLED',workflows:rows.map(r=>decodeLedgerSnapshot(r.state_json,r.state_checksum))};}finally{c.release();}},
 startWorker:()=>devices.start(),stopWorker:()=>devices.stop(),close:()=>rawPool.end()};
const runtime=createProductionRuntime(loaded,{logger,services,operations});let stopping=false;
async function stop(){if(stopping)return;stopping=true;await runtime.shutdown();process.exit(0);}
process.once('SIGTERM',()=>void stop());const stdin=createInterface({input:process.stdin});stdin.on('line',s=>{if(s==='STOP')void stop();});stdin.on('close',()=>void stop());
await runtime.start();process.stdout.write(JSON.stringify({event:'REHEARSAL_READY',id:names.id})+'\n');
