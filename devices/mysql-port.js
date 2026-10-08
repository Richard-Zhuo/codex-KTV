import { randomUUID } from 'node:crypto';
import { encodeLedgerSnapshot, decodeLedgerSnapshot } from '../ledger/mysql-snapshot.js';
import { BusinessRejection } from '../shared/business-error.js';
import { createRoomDeviceMappings } from './mapping.js';

// Inert connection-bound port: caller owns the head lock, transaction and commit.
export function bindRoomControl(connection, database, ledgerId) {
  const q = String.fromCharCode(96), table = n => q + database + q + '.' + q + n + q;
  const workflows = table('room_control_workflows');
  const decode = row => {
    if (!row) return null;
    const r = decodeLedgerSnapshot(row.state_json, row.state_checksum);
    if (r.ledgerId !== ledgerId || r.id !== row.workflow_id || r.orderId !== row.order_id ||
        r.operationKey !== row.operation_key || r.actorId !== row.actor_principal_id ||
        r.fingerprint !== row.fingerprint || r.version !== Number(row.version)) throw Error('Device metadata mismatch');
    return r;
  };
  const select = async (column, value) => {
    const [[row]] = await connection.execute('SELECT * FROM ' + workflows + ' WHERE ledger_id=? AND ' + column + '=? FOR UPDATE', [ledgerId, value]);
    return decode(row);
  };
  const port = {
    get: id => select('workflow_id', id),
    findByOrder: id => select('order_id', id),
    findByOperation: key => select('operation_key', key),
    async readMapping(id) {
      const [[row]] = await connection.execute('SELECT internal_room_id,provider,external_device_id,enabled FROM ' + table('room_device_mappings') + ' WHERE ledger_id=? AND internal_room_id=? FOR UPDATE', [ledgerId,id]);
      if (!row) return null;
      return createRoomDeviceMappings([{internalRoomId:row.internal_room_id,provider:row.provider,
        externalDeviceId:row.external_device_id,enabled:Number(row.enabled)===1}]).get(id);
    },
    async write(r, version) {
      if (r.ledgerId!==ledgerId || !Number.isSafeInteger(r.version) || (version!==undefined && r.version!==version+1)) throw Error('Invalid device version');
      const e=encodeLedgerSnapshot(r);let result;
      if(version===undefined) [result]=await connection.execute('INSERT INTO '+workflows+' (ledger_id,workflow_id,operation_key,order_id,actor_principal_id,fingerprint,version,state_json,state_checksum) VALUES (?,?,?,?,?,?,?,?,?)',
        [ledgerId,r.id,r.operationKey,r.orderId,r.actorId,r.fingerprint,r.version,e.json,e.checksum]);
      else [result]=await connection.execute('UPDATE '+workflows+' SET version=?,state_json=?,state_checksum=?,updated_at=UTC_TIMESTAMP(6) WHERE ledger_id=? AND workflow_id=? AND version=?',
        [r.version,e.json,e.checksum,ledgerId,r.id,version]);
      if(result.affectedRows!==1) throw Error('Device optimistic conflict');
    },
    async enroll(order, request, context) {
      const target=await port.readMapping(order.room);
      if(!target?.enabled) {const error=new BusinessRejection('该房间设备尚未完成系统绑定');error.reasonCode='device_mapping_required';throw error;}
      if(!order.businessSession) throw new BusinessRejection('当前场次不可开房');
      const record={id:randomUUID(),ledgerId,operationKey:request.operationKey,fingerprint:request.requestFingerprint,
        actorId:context.principalId,orderId:order.id,...target,businessSession:structuredClone(order.businessSession),
        version:0,status:'DEVICE_PENDING',roomReadiness:'OPENING',step:'STATUS',uncertain:false,inFlight:null,
        createdAt:context.dbNow,updatedAt:context.dbNow,events:[{at:context.dbNow,step:'STATUS',status:'DEVICE_PENDING',outcome:'created-with-order'}]};
      await port.write(record);return record;
    }
  };
  return port;
}

// Read workflow evidence in the same snapshot transaction, before permission projection.
export async function readDeviceHead(connection, database, head) {
  const state=structuredClone(head.state);
  for(const order of state.orders) {
    if(order.deviceControl?.mode!=='required') continue;
    const q=String.fromCharCode(96);
    const [[row]]=await connection.execute('SELECT * FROM '+q+database+q+'.'+q+'room_control_workflows'+q+' WHERE ledger_id=? AND workflow_id=?', [head.ledgerId,order.deviceWorkflowId]);
    if(!row) throw Error('Missing required workflow');
    const r=decodeLedgerSnapshot(row.state_json,row.state_checksum);
    if(r.ledgerId!==head.ledgerId || r.orderId!==order.id || r.id!==order.deviceWorkflowId) throw Error('Workflow binding mismatch');
    order.businessState=r.roomReadiness;
    order.deviceControl={mode:'required',status:r.status,version:r.version,
      mutationUnknown:r.uncertain===true,verificationPending:r.status==='DEVICE_VERIFYING'};
    const room=state.rooms.find(v=>v.order===order.id);
    if(room) {room.businessState=r.roomReadiness;room.deviceControl=order.deviceControl;room.deviceWorkflowId=r.id;
      if(r.roomReadiness!=='ACTIVE') room.status={OPENING:'正在开房',WAITING_DEVICE:'等待设备上线',FAILED:'设备异常'}[r.roomReadiness];}
  }
  return {...head,state};
}
