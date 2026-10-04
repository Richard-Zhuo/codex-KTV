export const incidentEmployeeId = '10000000-0000-4000-8000-000000000001';
export const otherIncidentEmployeeId = '10000000-0000-4000-8000-000000000002';
export const incidentDbNow = '2026-10-05T12:00:00.123456Z';
export function incidentCommand(key = 'incident-1', employeeId = incidentEmployeeId, revision = 0, changes = {}) {
  return { operationKey: key, expectedRevision: revision, action: 'incident', payload: {
    room: 'V01', date: '2026-10-03', type: '设备异常', description: '  Synthetic incident  ',
    assignee: employeeId, ...changes
  } };
}
