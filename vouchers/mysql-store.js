import { randomUUID } from 'node:crypto';
import { createTransactionBoundVoucherBinding } from './binding.js';
import { decodeLedgerJson } from '../ledger/mysql-snapshot.js';

const fields = [
  ['id','id'], ['ledgerId','ledger_id'], ['provider','provider'], ['storeId','store_id'],
  ['externalOrderId','external_order_id'], ['externalVoucherId','external_voucher_id'],
  ['voucherCodeHash','voucher_code_hash'], ['voucherCodeMasked','voucher_code_masked'],
  ['productId','product_id'], ['productNameSnapshot','product_name_snapshot'], ['status','status'], ['version','version'],
  ['requestedByPrincipalId','requested_by_principal_id'], ['operationKey','operation_key'],
  ['providerRequestId','provider_request_id'], ['providerFlowId','provider_flow_id'], ['providerTraceId','provider_trace_id'],
  ['requestedAt','requested_at'], ['redeemedAt','redeemed_at'], ['reversedAt','reversed_at'],
  ['refundedAt','refunded_at'], ['linkedOrderId','linked_order_id']
];
const timeColumns = new Set(['requested_at','redeemed_at','reversed_at','refunded_at']);
const utcFormat = "'%Y-%m-%dT%H:%i:%s.%fZ'";
function sqlTime(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw TypeError('Provider DTO times must be UTC with microseconds');
  return value.replace('T',' ').slice(0,-1);
}
function safeRevision(value) {
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid ledger revision'); return n;
}
export class VoucherCommitOutcomeUnknown extends Error {
  constructor(cause) { super('Voucher database commit outcome unknown; query the original key, never repeat consume', { cause });
    this.code = 'VOUCHER_COMMIT_OUTCOME_UNKNOWN'; }
}
export function createMySqlVoucherStore({ pool, database, ledgerId, provider, storeId, bindSessionRevalidation, packageMappings = [] }) {
  if (typeof pool?.getConnection !== 'function' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(database || '') ||
      typeof ledgerId !== 'string' || !ledgerId || ledgerId.length > 64 ||
      !['meituan','douyin'].includes(provider) || typeof storeId !== 'string' || !storeId || storeId.length > 191 ||
      (bindSessionRevalidation !== undefined && typeof bindSessionRevalidation !== 'function')) throw TypeError('Invalid explicit MySQL voucher scope');
  const q = String.fromCharCode(96), table = name => q+database+q+'.'+q+name+q;
  const redemptions = table('voucher_redemptions'), operations = table('voucher_operations'), events = table('provider_events');
  const select = 'SELECT ' + fields.map(([,column]) => timeColumns.has(column) ?
    'DATE_FORMAT('+column+', '+utcFormat+') AS '+column : column).join(',') + ' FROM ' + redemptions;
  const decode = row => row ? Object.fromEntries(fields.map(([key,column]) => [key, key === 'version' ? safeRevision(row[column]) : row[column]])) : null;
  const lockRedemption = async (connection, id) => {
    const [[row]] = await connection.execute(select + ' WHERE ledger_id=? AND id=? FOR UPDATE', [ledgerId,id]); return decode(row);
  };
  function port(connection) {
    return {
      async findOperation(key) {
        const [[row]] = await connection.execute('SELECT * FROM '+operations+' WHERE ledger_id=? AND operation_key=? FOR UPDATE',[ledgerId,key]);
        if (!row) return null;
        if (row.fingerprint_version !== 1 || !/^[0-9a-f]{64}$/.test(row.fingerprint)) throw Error('Corrupt voucher operation');
        return { operationKey:key, actorId:row.actor_principal_id, action:row.action, fingerprint:row.fingerprint,
          expectedRevision:safeRevision(row.expected_revision), redemptionId:row.redemption_id,
          completed:row.completed === 1, result:decodeLedgerJson(row.result_json) };
      },
      async findVoucher(hash) {
        const [[row]] = await connection.execute(select+' WHERE provider=? AND store_id=? AND ledger_id=? AND voucher_code_hash=? FOR UPDATE',
          [provider,storeId,ledgerId,hash]); return decode(row);
      },
      getRedemption: id => lockRedemption(connection,id),
      async writeRedemption(record, expectedVersion) {
        if (record.ledgerId !== ledgerId || record.provider !== provider || record.storeId !== storeId) throw Error('Voucher scope mismatch');
        const values = fields.map(([key,column]) => timeColumns.has(column) ? sqlTime(record[key]) : record[key] ?? null);
        let updated;
        if (expectedVersion === undefined) {
          [updated] = await connection.execute('INSERT INTO '+redemptions+' ('+fields.map(([,c])=>c).join(',')+') VALUES ('+fields.map(()=>'?').join(',')+')',values);
        } else {
          [updated] = await connection.execute('UPDATE '+redemptions+' SET '+fields.map(([,c])=>c+'=?').join(',')+
            ', updated_at=UTC_TIMESTAMP(6) WHERE ledger_id=? AND id=? AND version=?',[...values,ledgerId,record.id,expectedVersion]);
        }
        if (updated.affectedRows !== 1) throw Error('Voucher optimistic version conflict');
      },
      async putOperation(op) {
        await connection.execute('INSERT INTO '+operations+' (ledger_id,operation_key,actor_principal_id,action,fingerprint,expected_revision,redemption_id,completed,result_json,completed_at) VALUES (?,?,?,?,?,?,?,?,?,IF(?=1,UTC_TIMESTAMP(6),NULL))',
          [ledgerId,op.operationKey,op.actorId,op.action,op.fingerprint,op.expectedRevision,op.redemptionId,
            op.completed ? 1 : 0,JSON.stringify(op.result),op.completed ? 1 : 0]);
      },
      async completeOperation(key,result) {
        const [updated] = await connection.execute('UPDATE '+operations+' SET completed=1,result_json=?,completed_at=UTC_TIMESTAMP(6) WHERE ledger_id=? AND operation_key=? AND completed=0',
          [JSON.stringify(result),ledgerId,key]);
        if (updated.affectedRows !== 1) throw Error('Voucher terminal already completed');
      },
      async findEvent(messageId) {
        const [[row]] = await connection.execute('SELECT ledger_id,store_id,payload_hash,result_json FROM '+events+' WHERE provider=? AND external_message_id=? FOR UPDATE',[provider,messageId]);
        if (!row) return null;
        if (row.ledger_id !== ledgerId || row.store_id !== storeId) throw Error('Provider event scope conflict');
        return { payloadHash:row.payload_hash, result:decodeLedgerJson(row.result_json) };
      },
      async findEventRedemptions(event) {
        const [rows] = await connection.execute(select+' WHERE ledger_id=? AND provider=? AND store_id=? AND external_order_id=?'+
          (event.externalVoucherId ? ' AND external_voucher_id=?' : '')+' ORDER BY id FOR UPDATE',
          [ledgerId,provider,storeId,event.externalOrderId,...(event.externalVoucherId ? [event.externalVoucherId] : [])]);
        return rows.map(decode);
      },
      async putEvent(event) {
        await connection.execute('INSERT INTO '+events+' (provider,external_message_id,store_id,ledger_id,provider_envelope_message_id,event_type,external_order_id,payload_hash,event_time,result_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [provider,event.externalMessageId,storeId,ledgerId,event.providerEnvelopeMessageId ?? null,
            event.eventType,event.externalOrderId,event.payloadHash,sqlTime(event.eventTime),JSON.stringify(event.result)]);
      },
      async appendException(id,source,reason) {
        const [[existing]] = await connection.execute('SELECT exception_id FROM '+table('voucher_exceptions')+' WHERE redemption_id=? AND source_key=? FOR UPDATE',[id,source]);
        if (!existing) await connection.execute('INSERT INTO '+table('voucher_exceptions')+' (exception_id,redemption_id,source_key,reason) VALUES (?,?,?,?)',
          [randomUUID(),id,source,reason]);
      }
    };
  }
  return { testOnly: database === 'jbhh_ktv_test', ledgerId, provider, storeId,
    bindVoucherRedemptions(connection) {
      if (typeof connection?.execute !== 'function') throw TypeError('Caller MySQL connection required');
      const tx = port(connection);
      return createTransactionBoundVoucherBinding({ ledgerId, provider, storeId, packageMappings,
        port: { lockRedemption: tx.getRedemption, writeRedemption: tx.writeRedemption } });
    },
    async runAtomic(work) {
      const connection = await pool.getConnection(); let begun = false, committing = false, destroy = false;
      try {
        const [[target]] = await connection.query('SELECT DATABASE() AS db');
        if (target.db !== database) throw Error('Voucher database mismatch');
        await connection.beginTransaction(); begun = true;
        const [[head]] = await connection.execute('SELECT revision FROM '+table('ledger_heads')+' WHERE ledger_id=? FOR UPDATE',[ledgerId]);
        if (!head) throw Error('Explicit existing ledger required');
        const tx = port(connection); tx.revision = safeRevision(head.revision);
        if (bindSessionRevalidation) tx.sessionRevalidation = bindSessionRevalidation(connection);
        const result = await work(tx);
        committing = true; await connection.commit(); begun = false; return structuredClone(result);
      } catch (error) {
        if (committing) { destroy = true; throw new VoucherCommitOutcomeUnknown(error); }
        if (begun) try { await connection.rollback(); } catch { destroy = true; }
        throw error;
      } finally { if (destroy) connection.destroy(); else connection.release(); }
    }
  };
}
