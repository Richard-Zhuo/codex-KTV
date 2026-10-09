// Isolated drill entry only; the formal production/start.js never chooses FakeAlertTransport.
import {readFile,appendFile,writeFile,lstat} from 'node:fs/promises';import {join} from 'node:path';
import mysql from 'mysql2/promise';
import {loadRuntimeConfig} from '../production/runtime-config.js';import {createSafeLogger} from '../production/runtime-log.js';
import {createProductionRuntime} from '../production/runtime.js';import {createOperationalRuntime} from '../operations/runtime.js';import {FakeAlertTransport} from '../operations/alerts.js';
import {createInterface} from 'node:readline';
const path=process.argv[process.argv.indexOf('--config-file')+1],loaded=await loadRuntimeConfig(path);
const secrets=JSON.parse(await readFile(loaded.config.secretsFile,'utf8')),db=secrets.database;
if(db.host!=='127.0.0.1'||db.port!==33313||!/^jbhh_ktv_restore_stage5c_[a-z0-9]+$/.test(db.name)||loaded.config.storeId!=='synthetic-recovery-store'||loaded.config.ledgerId!=='synthetic-recovery-ledger')throw Error('SYNTHETIC_DRILL_SCOPE_REQUIRED');
const marker=join(loaded.logDirectory,'synthetic-server-confirmed.json');
try{const stat=await lstat(marker);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024||JSON.parse(await readFile(marker,'utf8')).database!==db.name)throw Error('SYNTHETIC_DRILL_MARKER_INVALID');}
catch(e){if(e.code!=='ENOENT')throw e;const guard=await mysql.createConnection({host:db.host,port:db.port,user:db.user,password:db.password,database:db.name});
 try{if(process.env.STAGE5E_FIXTURE_ID){const {assertRegressionFixture}=await import('../rehearsal/regression-guard.js');await assertRegressionFixture(guard,process.env,{database:db.name});}
 else{const [[identity]]=await guard.query('SELECT @@port AS port,@@datadir AS datadir');if(Number(identity.port)!==33313||!identity.datadir.includes('ktv-stage4b-mysql-ExY9Do'))throw Error('SYNTHETIC_DRILL_SERVER_REQUIRED');}}finally{await guard.end();}
 await writeFile(marker,JSON.stringify({database:db.name}),{flag:'wx',mode:0o600});}
const logger=createSafeLogger({secrets:loaded.redactionSecrets,write:line=>process.stdout.write(line)});
const transport=new FakeAlertTransport(),send=transport.send.bind(transport);
transport.send=async payload=>{const result=await send(payload);await appendFile(join(loaded.logDirectory,'synthetic-alerts.jsonl'),JSON.stringify(payload)+'\n',{mode:0o600});return result;};
const operations=await createOperationalRuntime({loaded,logger,transport}),runtime=createProductionRuntime(loaded,{logger,operations});
let stopping=false;async function stop(){if(stopping)return;stopping=true;await runtime.shutdown();process.exit(0);}
process.on('SIGTERM',()=>void stop());const input=createInterface({input:process.stdin});input.on('line',s=>{if(s==='STOP')void stop();});input.on('close',()=>void stop());
await runtime.start();
