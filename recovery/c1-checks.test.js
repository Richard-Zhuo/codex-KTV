import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../rules.js';
import {encodeLedgerSnapshot} from '../ledger/mysql-snapshot.js';
import {checkCutoverCandidate} from './c1-checks.js';
import {c1EvidenceFresh} from './c1-evidence.js';

const table=rows=>({columns:rows[0]?Object.keys(rows[0]):['unused'],
 rows:rows.map(row=>Object.values(row))});
function fixture(){
 const state=initialState();
 for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])
  stock.count=1000;
 const encoded=encodeLedgerSnapshot(state);
 const tables={};
 for(const name of ['auth_accounts','employees','auth_grants','auth_policy_attributes',
  'auth_credentials','auth_sessions','ledger_operations','ledger_success_audit',
  'room_control_workflows','voucher_redemptions','voucher_exceptions'])
  tables[name]=table([]);
 tables.production_bootstrap_events=table([{store_id:'s',ledger_id:'l',environment:'production'}]);
 tables.ledger_heads=table([{ledger_id:'l',revision:0,state_schema_version:state.version,
  state_json:encoded.json,state_checksum:encoded.checksum}]);
 const manifest={storeId:'s',ledgerId:'l',source:{environment:'production'},
  ledgerHeads:[{ledgerId:'l',revision:0,checksum:encoded.checksum}]};
 const update=()=>{const e=encodeLedgerSnapshot(state),h=tables.ledger_heads.rows[0];
  h[2]=state.version;h[3]=e.json;h[4]=e.checksum;
  manifest.ledgerHeads[0].checksum=e.checksum;};
 return {data:{tables},manifest,state,update};
}
const codes=r=>r.blocking.map(v=>v.code);
test('C1 healthy persisted facts remain eligible',()=>{
 const f=fixture(),r=checkCutoverCandidate(f.data,f.manifest);
 assert.deepEqual(r.blocking,[]);
 assert.equal(r.external.voucher,'SAFE');assert.equal(r.external.device,'SAFE');
});
test('C1 blocks ledger drift, impossible money and inventory',()=>{
 const f=fixture();
 f.data.tables.ledger_heads.rows[0][1]=1;
 assert.ok(codes(checkCutoverCandidate(f.data,f.manifest)).includes('RECOVERY_LEDGER_HEAD'));
 f.data.tables.ledger_heads.rows[0][1]=0;
 f.state.orders.push({id:1,kind:'retail',room:null,status:'open',payments:[{amount:10}],
  packageBaseCents:0,sales:[],otherCharges:[]});f.update();
 assert.ok(codes(checkCutoverCandidate(f.data,f.manifest)).includes('C1_MONEY_MISMATCH'));
 f.state.orders=[];f.state.inventory.qd.count=-1;f.update();
 assert.ok(codes(checkCutoverCandidate(f.data,f.manifest)).includes('RECOVERY_INVENTORY_COUNT'));
});
test('C1 blocks credit, rounding and critical attribution contradictions',()=>{
 const f=fixture(),order={id:1,kind:'retail',room:null,status:'open',payments:[],
  packageBaseCents:0,sales:[],otherCharges:[],credit:{amount:10,remaining:11},
  rounding:10,roundingReview:{amount:9,status:'pending'},creditedEmployeeId:'missing'};
 f.state.orders.push(order);f.update();
 const found=codes(checkCutoverCandidate(f.data,f.manifest));
 for(const code of ['C1_CREDIT_MISMATCH','C1_ROUNDING_MISMATCH','C1_ATTRIBUTION_REFERENCE'])
  assert.ok(found.includes(code),code);
});
test('C1 blocks a restored live session and uncertain voucher or device',()=>{
 const f=fixture();
 f.data.tables.auth_sessions=table([{revoked_at:null}]);
 f.data.tables.voucher_redemptions=table([{status:'UNKNOWN',linked_order_id:null}]);
 f.data.tables.room_control_workflows=table([{ledger_id:'l',workflow_id:'w',
  state_json:encodeLedgerSnapshot({status:'DEVICE_UNKNOWN'}).json,
  state_checksum:encodeLedgerSnapshot({status:'DEVICE_UNKNOWN'}).checksum}]);
 const r=checkCutoverCandidate(f.data,f.manifest);
 assert.ok(codes(r).includes('C1_RESTORED_SESSION_ACTIVE'));
 assert.equal(r.external.voucher,'BLOCKING_UNKNOWN');
 assert.equal(r.external.device,'BLOCKING_UNKNOWN');
});
test('C1 preserves noncritical manual followup without inventing provider success',()=>{
 const f=fixture();
 f.data.tables.voucher_redemptions=table([{status:'PENDING',linked_order_id:null}]);
 const r=checkCutoverCandidate(f.data,f.manifest);
 assert.deepEqual(r.blocking,[]);
 assert.equal(r.external.voucher,'NON_BLOCKING_MANUAL_FOLLOWUP');
 assert.ok(r.manualFollowups.some(v=>v.code==='C1_VOUCHER_PENDING'));
});
test('C1 evidence PASS is bound to current plan, candidate and old database digests',()=>{
 const plan={recoveryOperationId:'op',planDigest:'plan',backupSha256:'backup',
  targetDatabase:'candidate',currentDatabase:'old',targetServerUuid:'server'};
 const evidence={version:1,...plan,sourceDatabase:'old',serverUuid:'server',
  cutoverEligible:true,journalState:'VERIFYING',candidateDigest:'candidate-digest',
  oldDigest:'old-digest',alertDigest:'alerts',blockingFindings:[],
  external:{voucher:'SAFE',device:'SAFE',payment:'SAFE',alerts:'SAFE'}};
 const current={candidateDigest:'candidate-digest',oldDigest:'old-digest',alertDigest:'alerts',
  journalState:'VERIFYING'};
 assert.equal(c1EvidenceFresh(evidence,plan,current),true);
 assert.equal(c1EvidenceFresh(evidence,plan,{...current,candidateDigest:'changed'}),false);
 assert.equal(c1EvidenceFresh(evidence,plan,{...current,oldDigest:'changed'}),false);
 assert.equal(c1EvidenceFresh(evidence,{...plan,planDigest:'changed'},current),false);
 assert.equal(c1EvidenceFresh(evidence,plan,{...current,journalState:'FAILED_AMBIGUOUS'}),false);
 assert.equal(c1EvidenceFresh(evidence,plan,{...current,alertDigest:'changed'}),false);
 assert.equal(c1EvidenceFresh({...evidence,external:{...evidence.external,device:'BLOCKING_UNKNOWN'}},plan,current),false);
 assert.equal(c1EvidenceFresh({...evidence,blockingFindings:[{code:'C1_MONEY_MISMATCH'}]},plan,current),false);
});


test('C1 credit remaining must equal approved repayment total',()=>{
 const f=fixture();f.state.orders.push({id:1,kind:'retail',room:null,status:'open',
  payments:[],packageBaseCents:0,sales:[],otherCharges:[],
  credit:{amount:100,remaining:90,repayments:[{amount:20}]}});f.update();
 assert.ok(codes(checkCutoverCandidate(f.data,f.manifest)).includes('C1_CREDIT_MISMATCH'));
});
test('C1 treats every unfinished device workflow as blocking',()=>{
 const f=fixture();
 for(const status of ['DEVICE_OPENING','DEVICE_CLOSING','DEVICE_PENDING','DEVICE_VERIFYING','DEVICE_OFFLINE_WAIT','DEVICE_UNKNOWN']){
  const encoded=encodeLedgerSnapshot({status});
  f.data.tables.room_control_workflows=table([{ledger_id:'l',workflow_id:'w',
   state_json:encoded.json,state_checksum:encoded.checksum}]);
  assert.equal(checkCutoverCandidate(f.data,f.manifest).external.device,'BLOCKING_UNKNOWN',status);
 }
});
