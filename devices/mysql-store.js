import { decodeLedgerSnapshot, encodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
export class DeviceCommitOutcomeUnknown extends Error {
  constructor(cause){super('Device commit outcome unknown; query original workflow before dispatch',{cause});this.code='DEVICE_COMMIT_OUTCOME_UNKNOWN';}
}
export function createMySqlRoomControlStore({pool,database,ledgerId,bindSessionRevalidation,testOnly=false}) {
  if(typeof pool?.getConnection!=='function' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(database??'') ||
      typeof ledgerId!=='string' || !ledgerId || ledgerId.length>64 || typeof bindSessionRevalidation!=='function' ||
      (testOnly && database!=='jbhh_ktv_test'))throw TypeError('Explicit room-control store scope required');
  const q=String.fromCharCode(96),table=name=>q+database+q+'.'+q+name+q,workflows=table('room_control_workflows');
  function decode(row){
    if(!row)return null;const record=decodeLedgerSnapshot(row.state_json,row.state_checksum);
    if(record.ledgerId!==ledgerId || record.id!==row.workflow_id || record.operationKey!==row.operation_key ||
        record.orderId!==row.order_id || record.actorId!==row.actor_principal_id || record.fingerprint!==row.fingerprint ||
        record.version!==Number(row.version))throw Error('Device workflow metadata mismatch');
    return record;
  }
  return Object.freeze({ledgerId,testOnly,
    async runAtomic(work){
      const connection=await pool.getConnection();let begun=false,commitSent=false;
      try{
        await connection.beginTransaction();begun=true;
        const [[head]]=await connection.execute('SELECT revision,state_json,state_checksum FROM '+table('ledger_heads')+' WHERE ledger_id=? FOR UPDATE',[ledgerId]);
        if(!head || !Number.isSafeInteger(Number(head.revision)))throw Error('Missing confirmed device ledger');
        const readDbNow=async()=>{const [[row]]=await connection.execute("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%dT%H:%i:%s.%fZ') AS db_now");return row.db_now;};
        const select=async(column,value)=>{const [[row]]=await connection.execute('SELECT * FROM '+workflows+' WHERE ledger_id=? AND '+column+'=? FOR UPDATE',[ledgerId,value]);return decode(row);};
        const result=await work({sessionRevalidation:bindSessionRevalidation(connection),
          readHead:async()=>({revision:Number(head.revision),state:decodeLedgerSnapshot(head.state_json,head.state_checksum)}),readDbNow,
          get:id=>select('workflow_id',id),findByOperation:key=>select('operation_key',key),findByOrder:id=>select('order_id',id),
          async write(record,expectedVersion){
            if(record.ledgerId!==ledgerId || !Number.isSafeInteger(record.version) || (expectedVersion!==undefined && record.version!==expectedVersion+1))throw Error('Invalid device workflow version');
            const encoded=encodeLedgerSnapshot(record);let result;
            if(expectedVersion===undefined)[result]=await connection.execute('INSERT INTO '+workflows+' (ledger_id,workflow_id,operation_key,order_id,actor_principal_id,fingerprint,version,state_json,state_checksum) VALUES (?,?,?,?,?,?,?,?,?)',
              [ledgerId,record.id,record.operationKey,record.orderId,record.actorId,record.fingerprint,record.version,encoded.json,encoded.checksum]);
            else [result]=await connection.execute('UPDATE '+workflows+' SET version=?,state_json=?,state_checksum=?,updated_at=UTC_TIMESTAMP(6) WHERE ledger_id=? AND workflow_id=? AND version=?',
              [record.version,encoded.json,encoded.checksum,ledgerId,record.id,expectedVersion]);
            if(result.affectedRows!==1)throw Error('Device workflow optimistic conflict');
          }});
        commitSent=true;await connection.commit();begun=false;return result;
      }catch(error){if(begun)await connection.rollback().catch(()=>{});if(commitSent)throw new DeviceCommitOutcomeUnknown(error);throw error;}
      finally{connection.release();}
    }
  });
}
