const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 191;
export function createRoomDeviceMappings(rows) {
  if (!Array.isArray(rows)) throw TypeError('Explicit server room/device mappings required');
  const rooms = new Map(), targets = new Set();
  for (const row of rows) {
    if (!row || Object.keys(row).some(k => !['internalRoomId','provider','externalDeviceId','enabled'].includes(k)) ||
        !text(row.internalRoomId) || !text(row.provider) || !text(row.externalDeviceId) || typeof row.enabled !== 'boolean' ||
        rooms.has(row.internalRoomId)) throw TypeError('Invalid or duplicate room/device mapping');
    const target = JSON.stringify([row.provider, row.externalDeviceId]);
    if (targets.has(target)) throw TypeError('A device cannot be mapped to multiple rooms');
    targets.add(target); rooms.set(row.internalRoomId, Object.freeze({ ...row }));
  }
  return Object.freeze({ get(internalRoomId) { return rooms.get(internalRoomId) ?? null; } });
}
