import { randomUUID } from 'node:crypto';
import { requireTrustedPermission } from '../shared/identity.js';
import { prepareSessionCredential, revalidateCommandSession } from '../ledger/trusted-execution.js';
import { createRedemptionIntent, transitionRedemption, VoucherError } from './domain.js';
import { protectVoucherCode, voucherFingerprint, canonicalVoucherJson } from './security.js';

const operations = new Set(['redeemVoucher', 'queryRedemption']);
const providerContexts = new WeakSet();
// Internal capability for a future verified webhook adapter; never construct from browser JSON.
export function createTrustedProviderContext({ provider, storeId }) {
  if (typeof provider !== 'string' || typeof storeId !== 'string' || !provider || !storeId) throw TypeError('Invalid verified provider scope');
  const value = Object.freeze({ provider, storeId }); providerContexts.add(value); return value;
}
function result(record, actorId, operationKey) {
  return { status: record.status, redemptionId: record.id, actorId, operationKey, version: record.version };
}
function evidenceStatus(record, evidence) {
  if (!evidence || evidence.provider !== record.provider || evidence.storeId !== record.storeId ||
      evidence.providerRequestId !== record.providerRequestId) return 'UNKNOWN';
  if (evidence.status === 'FAILED') return evidence.definitive === true ? 'FAILED' : 'UNKNOWN';
  if (evidence.status === 'REDEEMED' && typeof evidence.providerFlowId === 'string' && evidence.providerFlowId) return 'REDEEMED';
  return ['REVERSED', 'REFUNDED'].includes(evidence.status) ? evidence.status : 'UNKNOWN';
}
const evidenceFields = ['externalOrderId', 'externalVoucherId', 'productId', 'productNameSnapshot',
  'providerFlowId', 'providerTraceId', 'redeemedAt', 'reversedAt', 'refundedAt'];
function trustedFields(source, forbiddenCode) {
  const values = {};
  for (const key of evidenceFields) {
    const value = source?.[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value || value.length > 191 ||
        (forbiddenCode && value.includes(forbiddenCode)) ||
        (key.endsWith('At') && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) || !Number.isFinite(Date.parse(value))))) {
      throw new VoucherError('VOUCHER_INVALID_EVIDENCE');
    }
    values[key] = value;
  }
  return values;
}
export function createPlatformVoucherApplication({ store, gateway, voucherCodeSecret, allowTestGateway = false }) {
  if (!store?.ledgerId || !store?.storeId || !store?.provider || typeof store.runAtomic !== 'function' ||
      !Buffer.isBuffer(voucherCodeSecret) || voucherCodeSecret.length < 32 ||
      ['inspectVoucher', 'redeemVoucher', 'queryRedemption', 'reverseRedemption'].some(k => typeof gateway?.[k] !== 'function')) {
    throw TypeError('Explicit voucher store, gateway and server key required');
  }
  if (gateway.testOnly && (!allowTestGateway || store.testOnly !== true)) throw TypeError('Fake gateway requires explicit test mode and an isolated test store');
  const key = Buffer.from(voucherCodeSecret);
  function prepare(command) {
    if (!command || Object.getPrototypeOf(command) !== Object.prototype ||
        Object.keys(command).some(k => !['operationKey', 'expectedRevision', 'action', 'payload'].includes(k)) ||
        typeof command.operationKey !== 'string' || !command.operationKey || command.operationKey.length > 120 ||
        command.operationKey.trim() !== command.operationKey ||
        !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
        !operations.has(command.action) || !command.payload || Object.getPrototypeOf(command.payload) !== Object.prototype) throw TypeError('Invalid voucher command');
    const immutablePayload = JSON.parse(canonicalVoucherJson(command.payload));
    const code = command.action === 'redeemVoucher' ? protectVoucherCode(immutablePayload.voucherCode, key) : null;
    if (!code && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(immutablePayload.redemptionId || '')) throw TypeError('Explicit redemption UUID required');
    const payload = { ...immutablePayload };
    if (code) { delete payload.voucherCode; payload.voucherCodeHash = code.hash; }
    return { ...command, payload: immutablePayload, code, fingerprint: voucherFingerprint({ action: command.action, expectedRevision: command.expectedRevision, payload }) };
  }
  async function applyOutcome(claim, evidence, inspection, code) {
    return store.runAtomic(async tx => {
      const operation = await tx.findOperation(claim.operationKey);
      if (!operation || operation.redemptionId !== claim.redemptionId || operation.fingerprint !== claim.fingerprint) throw Error('Voucher attempt is missing or changed');
      if (operation.completed) return operation.result;
      const current = await tx.getRedemption(claim.redemptionId);
      let target = evidenceStatus(current, evidence), fields = {};
      try {
        fields = { ...trustedFields(inspection, code), ...trustedFields(evidence, code) };
      } catch { target = 'UNKNOWN'; }
      let next = current;
      if (target !== current.status) {
        try { next = transitionRedemption(current, target); }
        catch (error) {
          if (!(error instanceof VoucherError)) throw error;
          await tx.appendException(current.id, 'operation:' + claim.operationKey, 'reconciliation-required');
        }
      }
      if (next !== current) {
        next = { ...next, ...fields };
        await tx.writeRedemption(next, current.version);
      }
      if (['REVERSED', 'REFUNDED'].includes(next.status) && next.linkedOrderId) {
        await tx.appendException(next.id, 'operation:' + claim.operationKey, 'linked-order-provider-' + next.status.toLowerCase());
      }
      const saved = result(next, operation.actorId, claim.operationKey);
      await tx.completeOperation(claim.operationKey, saved);
      // Reconciliation may finish a crashed, unfinished consume, but never rewrites its terminal UNKNOWN.
      if (next.operationKey !== claim.operationKey && next.status !== 'REDEEMING') {
        const origin = await tx.findOperation(next.operationKey);
        if (origin && !origin.completed) await tx.completeOperation(origin.operationKey, result(next, origin.actorId, origin.operationKey));
      }
      return saved;
    });
  }
  return {
    // Claim A and evidence B are separate transactions. No provider promise is ever awaited inside either.
    async execute(command, sessionCredential) {
      const request = prepare(command), credential = prepareSessionCredential(sessionCredential);
      if (gateway.productionEnabled === false) {
        const error = Error('Meituan production redemption = NOT ENABLED'); error.code = 'MEITUAN_PRODUCTION_NOT_ENABLED'; throw error;
      }
      const claim = await store.runAtomic(async tx => {
        const context = await revalidateCommandSession(tx, credential);
        const saved = await tx.findOperation(request.operationKey);
        if (saved) {
          if (saved.actorId !== context.principalId || saved.fingerprint !== request.fingerprint) {
            return { immediate: { status: 'idempotency-conflict', reason: saved.actorId !== context.principalId ? 'actor-mismatch' : 'request-mismatch' } };
          }
          return { immediate: saved.result }; // Includes an already claimed, unfinished attempt.
        }
        requireTrustedPermission(context, 'room.open');
        const revision = tx.revision;
        const common = { operationKey: request.operationKey, actorId: context.principalId, action: request.action,
          fingerprint: request.fingerprint, expectedRevision: request.expectedRevision };
        if (revision !== request.expectedRevision) {
          const denied = { status: 'revision-conflict', currentRevision: revision, expectedRevision: request.expectedRevision };
          await tx.putOperation({ ...common, redemptionId: null, completed: true, result: denied }); return { immediate: denied };
        }
        let record;
        if (request.code) {
          record = await tx.findVoucher(request.code.hash);
          if (record) {
            const original = result(record, context.principalId, request.operationKey);
            await tx.putOperation({ ...common, redemptionId: record.id, completed: true, result: original });
            return { immediate: original };
          }
          record = transitionRedemption(createRedemptionIntent({
            id: randomUUID(), ledgerId: store.ledgerId, provider: store.provider, storeId: store.storeId,
            voucherCodeHash: request.code.hash, voucherCodeMasked: request.code.masked,
            requestedByPrincipalId: context.principalId, operationKey: request.operationKey,
            providerRequestId: randomUUID(), requestedAt: context.dbNow, linkedOrderId: null
          }), 'REDEEMING');
          await tx.writeRedemption(record);
        } else {
          record = await tx.getRedemption(request.payload.redemptionId);
          if (!record) throw new VoucherError('VOUCHER_NOT_FOUND');
        }
        await tx.putOperation({ ...common, redemptionId: record.id, completed: false,
          result: { ...result(record, context.principalId, request.operationKey), pending: true } });
        return { operationKey: request.operationKey, fingerprint: request.fingerprint, redemptionId: record.id,
          providerInput: { provider: record.provider, storeId: record.storeId, providerRequestId: record.providerRequestId,
            ...(record.externalOrderId ? { externalOrderId: record.externalOrderId } : {}),
            ...(record.externalVoucherId ? { externalVoucherId: record.externalVoucherId } : {}) } };
      });
      if (claim.immediate) return claim.immediate;
      let evidence, inspection;
      // Local transaction A has committed and released every lock and connection.
      try {
        if (request.code) {
          const input = { ...claim.providerInput, voucherCode: request.code.normalized };
          inspection = await gateway.inspectVoucher(input);
          if (typeof inspection?.provider !== 'string' || !inspection.provider || typeof inspection?.storeId !== 'string' || !inspection.storeId) throw new VoucherError('VOUCHER_UNKNOWN_INSPECTION');
          if (inspection.provider !== store.provider || inspection.storeId !== store.storeId) {
            evidence = { ...claim.providerInput, status: 'FAILED', definitive: true };
            inspection = null; // Never consume a voucher identified as another store's.
          } else {
            trustedFields(inspection, request.code.normalized);
            evidence = await gateway.redeemVoucher(input);
          }
        } else evidence = await gateway.queryRedemption(claim.providerInput);
      } catch {
        evidence = { ...claim.providerInput, status: 'UNKNOWN' }; // Timeout/disconnect/program failure is never proof of provider rejection.
      }
      return applyOutcome(claim, evidence, inspection, request.code?.normalized);
    },
    async inspectVoucher({ voucherCode }, sessionCredential) {
      const code = protectVoucherCode(voucherCode, key), credential = prepareSessionCredential(sessionCredential);
      await store.runAtomic(async tx => {
        const context = await revalidateCommandSession(tx, credential); requireTrustedPermission(context, 'room.open');
      });
      if (gateway.productionEnabled === false) { const e = Error('Meituan production redemption = NOT ENABLED'); e.code = 'MEITUAN_PRODUCTION_NOT_ENABLED'; throw e; }
      const dto = await gateway.inspectVoucher({ provider: store.provider, storeId: store.storeId, voucherCode: code.normalized });
      if (dto?.provider !== store.provider || dto?.storeId !== store.storeId) throw new VoucherError('VOUCHER_STORE_MISMATCH');
      return { provider: dto.provider, storeId: dto.storeId, ...trustedFields(dto, code.normalized) };
    },
    async receiveProviderEvent(event, providerContext) {
      event = JSON.parse(canonicalVoucherJson(event));
      if (!providerContexts.has(providerContext) || providerContext.provider !== store.provider || providerContext.storeId !== store.storeId) throw TypeError('Verified provider context required');
      if (!event || typeof event.externalMessageId !== 'string' || !event.externalMessageId || event.externalMessageId.length > 191 ||
          !['REDEEMED', 'REVERSED', 'REFUNDED'].includes(event.eventType) ||
          typeof event.externalOrderId !== 'string' || !event.externalOrderId ||
          event.externalOrderId.length > 191 || (event.providerEnvelopeMessageId !== undefined &&
            (typeof event.providerEnvelopeMessageId !== 'string' || event.providerEnvelopeMessageId.length > 191))) throw TypeError('Invalid provider event DTO');
      const payloadHash = voucherFingerprint(event);
      return store.runAtomic(async tx => {
        const saved = await tx.findEvent(event.externalMessageId);
        if (saved) {
          if (saved.payloadHash !== payloadHash) throw new VoucherError('PROVIDER_EVENT_ID_CONFLICT');
          return saved.result;
        }
        const records = await tx.findEventRedemptions(event);
        let processingStatus = 'reconciliation-required', redemptionId = null;
        if (records.length === 1) {
          const current = records[0]; redemptionId = current.id;
          // Verified event order/voucher correlation replaces a requestId; never a browser flag.
          const evidence = { ...event, provider: store.provider, storeId: store.storeId,
            providerRequestId: current.providerRequestId, status: event.eventType };
          const target = evidenceStatus(current, evidence);
          if (target === current.status) processingStatus = 'processed';
          else if (target === event.eventType) try {
            const next = { ...transitionRedemption(current, target), ...trustedFields(evidence) };
            await tx.writeRedemption(next, current.version); processingStatus = 'processed';
          } catch (error) {
            if (!(error instanceof VoucherError)) throw error;
          }
          if (processingStatus !== 'processed' || (current.linkedOrderId && ['REVERSED', 'REFUNDED'].includes(target))) {
            await tx.appendException(current.id, 'event:' + payloadHash, processingStatus !== 'processed' ?
              'reconciliation-required' : 'linked-order-provider-' + target.toLowerCase());
          }
        }
        const output = { externalMessageId: event.externalMessageId, processingStatus, redemptionId };
        await tx.putEvent({ ...event, provider: store.provider, storeId: store.storeId, payloadHash, result: output });
        return output;
      });
    }
  };
}
