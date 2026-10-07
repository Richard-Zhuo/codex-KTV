const definitions = Object.freeze({
  roomRecovery: { approve: 'approveRoomIssue', reject: 'rejectRoomIssue',
    keys: item => ({ request: item.id }), note: true },
  inventory: { approve: 'approveInventory', reject: 'rejectInventory',
    keys: item => ({ request: item.id }), note: true },
  gift: { approve: 'approveGift', reject: 'rejectGift',
    keys: item => ({ order: item.orderId, request: item.id }), note: true },
  rounding: { approve: 'approveRounding', reject: 'rejectRounding',
    keys: item => ({ order: item.orderId }), note: true },
  credit: { approve: 'approve', reject: 'reject',
    keys: item => ({ order: item.orderId }), note: false },
  repayment: { approve: 'approveRepayment', reject: 'rejectRepayment',
    keys: item => ({ order: item.orderId, request: item.id }), note: true },
  incidentResolution: {
    approve: 'approveIncidentResolution', reject: 'rejectIncidentResolution',
    keys: item => ({ id: item.incidentId, request: item.id }), note: true
  },
  expense: { approve: 'approveExpense', reject: 'rejectExpense',
    keys: item => ({ id: item.id }), note: false }
});

const validId = value => typeof value === 'string' ?
  value.length > 0 && value.length <= 191 :
  Number.isSafeInteger(value) && value >= 0;

export function prepareAdminDecision(item, direction, note = '') {
  const definition = definitions[item?.type];
  if (!definition || item.canDecide !== true ||
      (direction !== 'approve' && direction !== 'reject') ||
      typeof note !== 'string' || note.length > 300) {
    throw new TypeError('Invalid admin decision');
  }
  const payload = definition.keys(item);
  if (Object.values(payload).some(value => !validId(value))) {
    throw new TypeError('Invalid review identifier');
  }
  if (definition.note) {
    if (direction === 'reject' && !note.trim()) {
      throw new TypeError('Rejection reason required');
    }
    if (note.trim()) payload.decisionNote = note.trim();
  }
  return Object.freeze({ action: definition[direction],
    payload: Object.freeze(payload) });
}

export function isAdminReviewType(type) {
  return Object.hasOwn(definitions, type);
}

export function adminDecisionNeedsNote(item, direction) {
  return !!definitions[item?.type]?.note && direction === 'reject';
}