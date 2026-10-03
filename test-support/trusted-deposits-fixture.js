// Synthetic customer/storage facts only; never real employees or auth principals.
export const DEPOSIT_TEST_ACTIONS = ['deposit', 'withdraw'];
export function seedStoredDeposits(state) {
  state.serial = 103;
  state.deposits = [
    { id: 101, group: 'historical-storage', phone: '13800001234', name: 'Historic Guest', room: 'V01',
      product: 'retired-product', productId: 'retired-product', productNameSnapshot: null, baseUnitSnapshot: '瓶',
      count: 6, initial: 8, time: 'unknown historical time', person: 'unknown historical recorder' },
    { id: 102, group: 'other-storage', phone: '13911115678', name: 'Other Guest', room: 'V02',
      product: 'bw', productId: 'bw', productNameSnapshot: 'historical beer name', baseUnitSnapshot: '支',
      count: 3, initial: 3, time: null, person: 'another historical recorder' }
  ];
  state.withdrawals = [{ id: 103, deposit: 101, count: 2, person: 'unknown recorder', time: null }];
}
export function depositTestPayload(action) {
  if (action === 'deposit') return { room: 'V01', phone: ' 13800001234 ', name: ' Synthetic Guest ',
    items: [{ product: 'bw', count: 6 }, { productId: 'lm', count: 3 }] };
  if (action === 'withdraw') return { id: 101, identity: ' 1234 ', count: 2 };
  throw Error('Unknown storage fixture action');
}
export function invalidDepositPayloads(action) {
  const payload = depositTestPayload(action);
  if (action === 'deposit') return [
    { ...payload, phone: '', name: '' }, { ...payload, phone: '1380000' }, { ...payload, room: 'missing' },
    { ...payload, items: [] }, { ...payload, items: [{ product: 'bw', count: 0 }] },
    { ...payload, items: [{ product: 'bw', count: 1.5 }] },
    { ...payload, items: [{ product: 'bw', count: '2' }] },
    { ...payload, items: [{ product: 'bw', count: 1 }, { product: 'missing', count: 1 }] },
    { ...payload, items: [{ product: 'bw', count: 1 }, { product: 'drink', count: 1 }] }
  ];
  return [
    { ...payload, id: 999 }, { ...payload, id: '101' }, { ...payload, identity: '' },
    { ...payload, identity: '234' }, { ...payload, identity: '9999' },
    { ...payload, identity: 'historic guest' }, { ...payload, identity: 'synthetic-actor' },
    { ...payload, count: 0 }, { ...payload, count: 1.5 }, { ...payload, count: '2' }, { ...payload, count: 7 }
  ];
}
