// Synthetic ledger facts; no name, demo ID or employee-to-principal inference.
export const ROOM_ISSUE_REVIEW_ACTIONS = Object.freeze(['approveRoomIssue', 'rejectRoomIssue']);
export const REVIEWER_PRINCIPAL = '10000000-0000-4000-8000-000000000001';
export const APPLICANT_PRINCIPAL = '10000000-0000-4000-8000-000000000002';
export function seedRoomIssueReview(state, submittedByPrincipalId = APPLICANT_PRINCIPAL) {
  state.serial = 800;
  Object.assign(state.rooms[0], { status: '故障/维护中', issueType: '维护中', issueNote: 'historical evidence',
    issueAt: '2026-01-01T00:00:00Z', issueBy: 'historical actor display', issueApprovedBy: '',
    issueEvidencePhoto: 'data:image/png;base64,AA==', issueEvidencePhotoName: 'historical-evidence.png' });
  state.roomIssueReviews.push({ id: 701, room: state.rooms[0].id, change: '恢复空房', fromStatus: '故障/维护中',
    requestedStatus: '空闲', issueType: '维护中', evidenceText: 'synthetic repaired', evidencePhoto: '',
    status: '待审核', submittedByPrincipalId, submittedBy: 'historical applicant display', submittedById: '',
    submittedAt: '2026-01-02T00:00:00Z', decidedBy: '', decidedAt: '', decisionNote: '' });
}
export const roomIssueReviewCommand = (action, key = 'decision', revision = 0, changes = {}) => ({
  operationKey: key, expectedRevision: revision, action,
  payload: { request: 701, decisionNote: 'synthetic decision reason', ...changes }
});
export const pendingRoomIssueReview = state => state.roomIssueReviews.find(request => request.id === 701);
