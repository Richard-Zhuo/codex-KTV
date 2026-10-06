import { FORMAL_COMMAND_ACTIONS, DEMO_ONLY_ACTIONS } from '../ledger/command-policy.js';
import { TRUSTED_ENABLED_ACTIONS } from '../ledger/trusted-execution.js';

// Deliberate HTTP exposure. New trusted actions do not become public automatically.
export const HTTP_COMMAND_ACTIONS = Object.freeze([
  'clean', 'markRoomIssue', 'clearRoomIssue',
  'createCatalogProduct', 'updateCatalogProduct', 'updateCatalogPackage',
  'cancelReservation', 'deposit', 'withdraw', 'reserve', 'sale', 'retailSale',
  'serveExtra', 'otherCharge', 'exchange', 'approveRoomIssue', 'rejectRoomIssue',
  'stock', 'consumableStock', 'approveInventory', 'rejectInventory',
  'gift', 'approveGift', 'rejectGift', 'expense', 'approveExpense', 'rejectExpense',
  'credit', 'approve', 'reject', 'repay', 'approveRepayment', 'rejectRepayment',
  'incident', 'resolveIncident', 'approveIncidentResolution', 'rejectIncidentResolution',
  'procurement', 'collect', 'pay', 'settle', 'approveRounding', 'rejectRounding',
  'handover', 'open'
]);

const policy = new Set(FORMAL_COMMAND_ACTIONS);
const trusted = new Set(TRUSTED_ENABLED_ACTIONS);
const forbidden = new Set(DEMO_ONLY_ACTIONS);
if (new Set(HTTP_COMMAND_ACTIONS).size !== HTTP_COMMAND_ACTIONS.length ||
    HTTP_COMMAND_ACTIONS.some(action =>
      !policy.has(action) || !trusted.has(action) || forbidden.has(action))) {
  throw new Error('HTTP command registry violates trusted policy');
}
const exposed = new Set(HTTP_COMMAND_ACTIONS);
export function isHttpCommand(action) { return exposed.has(action); }
