import test from 'node:test';
import assert from 'node:assert/strict';
import { MeituanSkillDtoMapper } from './gateway.js';
import { protectVoucherCode } from './security.js';
import { FakePlatformVoucherGateway, MeituanSkillGateway } from './gateways.js';

test('voucher codes keep leading zeroes and length, and only HMAC/masked forms are persisted', () => {
  const key = Buffer.alloc(32, 9);
  const a = protectVoucherCode(' 0012345678901 ', key);
  assert.equal(a.normalized, '0012345678901');
  assert.equal(a.masked, '*********8901');
  assert.equal(a.hash.length, 64);
  assert.notEqual(a.hash, protectVoucherCode('12345678901', key).hash);
  assert.throws(() => protectVoucherCode(123456, key));
});
test('Fake gateway has all four domain methods; Meituan production boundary cannot call transport', async () => {
  const fake = new FakePlatformVoucherGateway();
  const input = { provider: 'meituan', storeId: 'synthetic-store', voucherCode: '0012345678901', providerRequestId: 'attempt-1' };
  const inspected = await fake.inspectVoucher(input);
  assert.equal(inspected.storeId, input.storeId);
  assert.equal((await fake.redeemVoucher(input)).status, 'REDEEMED');
  assert.equal((await fake.queryRedemption(input)).status, 'REDEEMED');
  assert.equal((await fake.reverseRedemption(input)).status, 'REVERSED');
  assert.deepEqual(fake.calls, { inspectVoucher: 1, redeemVoucher: 1, queryRedemption: 1, reverseRedemption: 1 });
  let calls = 0;
  const real = new MeituanSkillGateway({ transport: () => { calls++; }, credentialProvider: () => { calls++; } });
  for (const method of Object.keys(fake.calls)) await assert.rejects(real[method](input), { code: 'MEITUAN_PRODUCTION_NOT_ENABLED' });
  assert.equal(calls, 0);
});

test('short voucher codes are never persisted completely and unverified DTO mapping fails closed', () => {
  for (const code of ['0','01','001','0001']) assert.notEqual(protectVoucherCode(code, Buffer.alloc(32,9)).masked, code);
  const mapper = new MeituanSkillDtoMapper();
  assert.throws(() => mapper.encode('redeemVoucher', {}), { code: 'MEITUAN_DTO_CONTRACT_UNVERIFIED' });
  assert.throws(() => mapper.decode('redeemVoucher', { redeemed:true }), { code: 'MEITUAN_DTO_CONTRACT_UNVERIFIED' });
});
