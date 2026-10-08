import { rowsOf } from '../backup/mysql-backup.js';
import { decodeLedgerSnapshot,decodeLedgerJson } from '../ledger/mysql-snapshot.js';
import { PERMISSION_IDS } from '../shared/identity.js';
import { POLICY_ATTRIBUTE_IDS } from '../ledger/command-policy.js';
import { total,outstanding } from '../sales.js';
export function checkRecoveryInvariants(data,manifest) {
 const blockers=[],add=code=>blockers.push({code});
 const accounts=rowsOf(data,'auth_accounts'),accountIds=new Set(accounts.map(r=>r.principal_id));
 const employees=rowsOf(data,'employees'),bindings=employees.filter(e=>e.principal_id).map(e=>e.principal_id);
 if(new Set(bindings).size!==bindings.length||bindings.some(id=>!accountIds.has(id)))add('RECOVERY_EMPLOYEE_BINDING');
 if(rowsOf(data,'auth_grants').some(r=>!accountIds.has(r.principal_id)||!PERMISSION_IDS.includes(r.permission_id)))add('RECOVERY_AUTH_GRANT');
 if(rowsOf(data,'auth_policy_attributes').some(r=>!accountIds.has(r.principal_id)||!POLICY_ATTRIBUTE_IDS.includes(r.attribute_id)))add('RECOVERY_AUTH_ATTRIBUTE');
 if(accounts.some(r=>!Number.isSafeInteger(Number(r.credential_version))||Number(r.credential_version)<1))add('RECOVERY_CREDENTIAL_VERSION');
 const credentials=rowsOf(data,'auth_credentials');
 if(credentials.length!==accounts.length||credentials.some(r=>!accountIds.has(r.principal_id)||r.password_algorithm!=='scrypt'||Number(r.password_params_version)!==1||r.salt.length!==32||r.derived_key.length!==32))add('RECOVERY_CREDENTIAL_FORMAT');
 const receipts=rowsOf(data,'production_bootstrap_events');if(!receipts.length||receipts.some(r=>r.store_id!==manifest.storeId||r.ledger_id!==manifest.ledgerId||r.environment!==manifest.source.environment))add('RECOVERY_STORE_IDENTITY');
 const heads=rowsOf(data,'ledger_heads'),operations=rowsOf(data,'ledger_operations'),audits=rowsOf(data,'ledger_success_audit'),workflows=rowsOf(data,'room_control_workflows');
 const paymentIds=new Set();let orders=0,payments=0,effects=0;
 for(const h of heads) {
  let state;try{state=decodeLedgerSnapshot(h.state_json,h.state_checksum);}catch{add('RECOVERY_HEAD_CHECKSUM');continue;}
  const revision=Number(h.revision),expected=manifest.ledgerHeads.find(r=>r.ledgerId===h.ledger_id);
  if(!expected||revision!==expected.revision||h.state_checksum!==expected.checksum||Number(h.state_schema_version)!==state.version)add('RECOVERY_LEDGER_HEAD');
  const ops=operations.filter(r=>r.ledger_id===h.ledger_id),committed=ops.filter(r=>r.terminal_status==='committed').sort((a,b)=>Number(a.committed_revision)-Number(b.committed_revision));
  if(committed.length!==revision||committed.some((r,i)=>Number(r.committed_revision)!==i+1||Number(r.observed_revision)!==i))add('RECOVERY_REVISION_CHAIN');
  for(const op of ops){const result=decodeLedgerJson(op.terminal_result);if(result.operationKey!==op.operation_key||result.actorId!==op.actor_principal_id||result.ledgerId!==h.ledger_id||result.status!==op.terminal_status)add('RECOVERY_OPERATION_RESULT');}
  const success=audits.filter(r=>r.ledger_id===h.ledger_id);if(success.length!==committed.length||committed.some(op=>!success.some(a=>a.operation_key===op.operation_key&&a.actor_principal_id===op.actor_principal_id&&a.fingerprint===op.fingerprint&&Number(a.after_revision)===Number(op.committed_revision))))add('RECOVERY_OPERATION_AUDIT');
  const ids=new Set(state.orders.map(o=>o.id));if(ids.size!==state.orders.length)add('RECOVERY_DUPLICATE_ORDER');orders+=state.orders.length;
  const busy=new Set();
  for(const room of state.rooms){if(room.order){if(!ids.has(room.order)||busy.has(room.order))add('RECOVERY_ROOM_REFERENCE');busy.add(room.order);}}
  for(const order of state.orders){
   if(order.status===String.fromCodePoint(0x8425,0x4e1a,0x4e2d)&&order.kind!=='retail'&&!state.rooms.some(r=>r.id===order.room&&r.order===order.id))add('RECOVERY_ROOM_EXCLUSIVITY');
   if(order.status===String.fromCodePoint(0x5df2,0x7ed3,0x8d26)&&outstanding(order)!==0)add('RECOVERY_SETTLED_BALANCE');
   let paid=0;for(const p of order.payments??[]){payments++;paid+=p.amount;if(!Number.isSafeInteger(p.amount)||p.amount<0)add('RECOVERY_PAYMENT_AMOUNT');if(p.paymentId){if(paymentIds.has(p.paymentId)||!p.occurredAt||!p.recordedByPrincipalId)add('RECOVERY_PAYMENT_IDENTITY');paymentIds.add(p.paymentId);}}
   if(!Number.isSafeInteger(total(order))||paid>total(order))add('RECOVERY_PAYMENT_TOTAL');
   if(order.deviceControl?.mode==='required'&&!workflows.some(w=>w.ledger_id===h.ledger_id&&w.workflow_id===order.deviceWorkflowId&&w.order_id===order.id))add('RECOVERY_ORDER_WORKFLOW');
  }
  for(const stock of [...Object.values(state.inventory),...Object.values(state.consumables)])if(stock.count!==null&&(!Number.isSafeInteger(stock.count)||stock.count<0))add('RECOVERY_INVENTORY_COUNT');
  const effectIds=new Set();for(const e of state.ledger??[]){effects++;if(effectIds.has(e.id)||!Number.isSafeInteger(e.baseQuantityDelta??e.delta))add('RECOVERY_INVENTORY_EFFECT');effectIds.add(e.id);if(e.orderId&&!ids.has(e.orderId))add('RECOVERY_INVENTORY_ORDER');}
  const activeRooms=new Set();for(const o of state.orders.filter(o=>o.kind!=='retail'&&o.status===String.fromCodePoint(0x8425,0x4e1a,0x4e2d))){if(activeRooms.has(o.room))add('RECOVERY_ROOM_EXCLUSIVITY');activeRooms.add(o.room);}
  for(const w of workflows.filter(w=>w.ledger_id===h.ledger_id)){
   let r;try{r=decodeLedgerSnapshot(w.state_json,w.state_checksum);}catch{add('RECOVERY_WORKFLOW_CHECKSUM');continue;}
   const order=state.orders.find(o=>o.id===r.orderId);
   if(!order||order.room!==r.internalRoomId||r.ledgerId!==h.ledger_id||r.id!==w.workflow_id||r.orderId!==w.order_id||r.actorId!==w.actor_principal_id||r.operationKey!==w.operation_key||r.fingerprint!==w.fingerprint||r.version!==Number(w.version)||!accountIds.has(r.actorId))add('RECOVERY_WORKFLOW_REFERENCE');
   if(!['ACTIVE','DEVICE_FAILED'].includes(r.status)&&!state.rooms.some(room=>room.id===r.internalRoomId&&room.order===r.orderId))add('RECOVERY_WORKFLOW_RESERVATION');
  }
 }
 if(workflows.some(w=>!heads.some(h=>h.ledger_id===w.ledger_id)))add('RECOVERY_ORPHAN_WORKFLOW');
 if(heads.length!==manifest.ledgerHeads.length)add('RECOVERY_HEAD_SET');
 return {ready:blockers.length===0,blockers,counts:{accounts:accounts.length,employees:employees.length,orders,payments,inventoryEffects:effects,operations:operations.length,workflows:workflows.length}};
}
