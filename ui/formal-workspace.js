import { HttpApiError } from './api-client.js';

function required(value, kind) {
  if (kind === 'array' ? !Array.isArray(value) :
      kind === 'object' ? !value || typeof value !== 'object' || Array.isArray(value) :
      typeof value !== kind) {
    throw new HttpApiError('internal_error', 200);
  }
  return value;
}
function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export function stateFromServerSnapshot(snapshot, session) {
  if (!Number.isSafeInteger(snapshot?.revision) || snapshot.revision < 0 ||
      typeof session?.principalId !== 'string' || !session.principalId) {
    throw new HttpApiError('internal_error', 200);
  }
  const workspace = snapshot.view?.workspace;
  if (!workspace) return null;
  const sections = required(workspace.sections, 'object');
  const serverNow = required(workspace.serverNow, 'string');
  if (!Number.isFinite(Date.parse(serverNow))) {
    throw new HttpApiError('internal_error', 200);
  }
  const array = (section, key) => sections[section] ?
    required(workspace[key], 'array') : [];
  const object = (section, key) => sections[section] ?
    required(workspace[key], 'object') : {};
  const catalog = sections.catalog ? required(workspace.catalog, 'object') :
    { products: [], packages: [] };
  if (sections.catalog) {
    required(catalog.products, 'array');
    required(catalog.packages, 'array');
  }
  const view = {
    clock: serverNow,
    user: session.principalId,
    rooms: array('rooms', 'rooms'),
    orders: array('orders', 'orders'),
    catalog,
    retailBusinessSession: workspace.retailBusinessSession ?? null,
    reservations: array('reservations', 'reservations'),
    deposits: array('deposits', 'deposits'),
    withdrawals: array('deposits', 'withdrawals'),
    inventory: object('stock', 'inventory'),
    consumables: object('stock', 'consumables'),
    expenses: array('expenses', 'expenses'),
    procurements: array('procurements', 'procurements'),
    incidents: array('incidents', 'incidents'),
    roomIssueReviews: array('roomIssueReviews', 'roomIssueReviews'),
    inventoryReviews: array('inventoryReviews', 'inventoryReviews'),
    handovers: array('handovers', 'handovers'),
    employees: workspace.employees === undefined ? [] :
      required(workspace.employees, 'array'),
    actorEmployee: workspace.actorEmployee ?? null
  };
  return freezeDeep(view);
}
