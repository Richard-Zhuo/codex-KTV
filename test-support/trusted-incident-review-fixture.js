import { seedIncidentResolution } from './trusted-incident-resolution-fixture.js';

export const INCIDENT_REVIEW_ACTIONS = Object.freeze(['approveIncidentResolution', 'rejectIncidentResolution']);
export const APPLICANT_PRINCIPAL = '20000000-0000-4000-8000-000000000001';
export const REVIEWER_PRINCIPAL = '20000000-0000-4000-8000-000000000002';
export const reviewDbNow = '2026-10-05T12:00:00.123456Z';
export function seedIncidentReview(state, applicant = APPLICANT_PRINCIPAL) {
  seedIncidentResolution(state);
  state.serial = Math.max(state.serial, 42);
  const incident = state.incidents[0];
  incident.status = '待审核'; incident.result = 'Historical prior result'; incident.note = 'Historical prior note';
  incident.resolutionReviews = [{ id: 42, result: 'Synthetic repaired result', note: 'Synthetic verified note',
    status: '待审核', submittedBy: 'Historical applicant display', submittedById: null,
    submittedByPrincipalId: applicant, submittedByEmployeeId: incident.assigneeEmployeeId,
    submittedAt: '2026-10-04T12:00:00.000000Z', decidedBy: '', decidedAt: '', decisionNote: '' }];
}
export const incidentReviewCommand = (action, key = 'review-1', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action,
  payload: { id: 41, request: 42, decisionNote: 'Synthetic decision note', ...changes }
});
export const incidentReviewRequest = state => state.incidents.find(row => row.id === 41)?.resolutionReviews.find(row => row.id === 42);
