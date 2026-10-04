// 客诉／异常领域：登记、处理结果提交与恢复审核，及按权限查看和提醒。
// Phase 5 自 rules.js 迁出：visibleIncidents／pendingIncidentReminders 查询、
// incident／resolveIncident 命令、approveIncidentResolution+rejectIncidentResolution 审批命令。
// 函数体逐字节保留，负责人提交、授权审核、驳回回流待处理行为不变。
import { BusinessRejection } from './shared/business-error.js';
import { need } from './inventory.js';
import { USERS, effectiveUser, hasPermission, assertTrustedExecutionContext, requireTrustedPermission } from './shared/identity.js';

export const INCIDENT_TYPES = ['客诉', '设备异常', '卫生异常', '库存异常', '员工交接', '其他'];

export function visibleIncidents(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.incidents) ? state.incidents : [];
  if (hasPermission(user, 'incident.viewAll') || hasPermission(user, 'incident.resolve.approve')) return rows;
  return rows.filter(row => row.person === user?.name || row.assignee === user?.name);
}
export function pendingIncidentReminders(stateOrRows, now = new Date().toISOString()) {
  const rows = Array.isArray(stateOrRows) ? stateOrRows : (stateOrRows?.incidents || []);
  const current = new Date(now), hour = current.getHours();
  if (!Number.isFinite(current.getTime()) || hour < 14) return [];
  const today = `${current.getFullYear()}-${String(current.getMonth()+1).padStart(2,'0')}-${String(current.getDate()).padStart(2,'0')}`;
  return rows.filter(row => row?.status !== '已完成' && row?.date && row.date <= today && row?.lastReminderDate !== today);
}

// —— 命令层：由 rules.js 的 transact 分支委托调用，参数与原分支一致 ——

export function submitIncident(s, data, person, time, execution = { mode: 'demo' }) {
  if (!execution || !['demo', 'trusted'].includes(execution.mode)) throw TypeError('异常登记执行模式无效');
  const context = execution.mode === 'trusted' ? assertTrustedExecutionContext(execution.context) : null;
  if (context) {
    requireTrustedPermission(context, 'incident.create');
    person = context.actorSnapshot?.displayName ?? null; time = context.dbNow;
  } else need(s, [], 'incident.create');
  const incidentDate = String(data.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate) || !Number.isFinite(Date.parse(`${incidentDate}T00:00:00`))) throw new BusinessRejection('请选择有效异常日期');
  if (!s.rooms.some(item => item.id === data.room)) throw new BusinessRejection('请选择房号');
  const type = String(data.type || '').trim(); if (!INCIDENT_TYPES.includes(type)) throw new BusinessRejection('请选择问题类型');
  const description = String(data.description || '').trim().slice(0, 300); if (!description) throw new BusinessRejection('请填写问题描述');
  let assigneeId, assigneeName;
  if (context) {
    assigneeId = context.assigneeEmployeeId;
    if (!assigneeId || typeof context.assigneeEmployeeNameSnapshot !== 'string' ||
        (data.assigneeEmployeeId ?? data.assignee) !== assigneeId ||
        (data.assignee !== undefined && data.assignee !== assigneeId)) throw TypeError('缺少事务内可信负责人快照');
    assigneeName = context.assigneeEmployeeNameSnapshot;
  } else {
    assigneeId = String(data.assignee || '').trim(); const assignee = USERS[assigneeId];
    if (!assignee || assignee.legacy || assigneeId === 'administrator') throw new BusinessRejection('请选择处理负责人');
    assigneeName = assignee.name;
  }
  s.incidents ??= [];
  s.incidents.push({ id: ++s.serial, date: incidentDate, room: data.room, type, description, assigneeId, assignee: assigneeName, result: '', note: '', status: '待处理', person, createdAt: time, lastReminderDate: '', resolutionReviews: [],
    ...(context ? { submittedByPrincipalId: context.principalId, actualActorPrincipalId: context.principalId,
      assigneeEmployeeId: context.assigneeEmployeeId, assigneeEmployeeNameSnapshot: context.assigneeEmployeeNameSnapshot } : {}) });
}
export function submitIncidentResolution(s, data, person, time) {
  need(s, [], 'incident.resolve');
  const incident = (s.incidents || []).find(item => item.id === Number(data.id));
  if (!incident || incident.status === '已完成') throw new BusinessRejection('该客诉／异常已经处理');
  if (incident.assignee !== person && !hasPermission(effectiveUser(s), 'incident.viewAll')) throw new BusinessRejection('只有负责人或管理人员可以填写处理结果');
  incident.resolutionReviews ??= [];
  if (incident.resolutionReviews.some(request => request.status === '待审核')) throw new BusinessRejection('处理结果已经提交审核，请等待有权限的员工处理');
  const result = String(data.result || '').trim().slice(0, 300); if (!result) throw new BusinessRejection('请填写处理结果');
  const note = String(data.note || '').trim().slice(0, 300); if (!note) throw new BusinessRejection('请填写处理备注');
  incident.resolutionReviews.push({ id: ++s.serial, result, note, status: '待审核', submittedBy: person, submittedById: s.user, submittedAt: time, decidedBy: '', decidedAt: '', decisionNote: '' });
  incident.status = '待审核'; incident.lastReminderDate = '';
}
export function decideIncidentResolution(s, action, data, person, time, authorizeReviewer) {
  need(s, [], 'incident.resolve.approve');
  const incident = (s.incidents || []).find(item => item.id === Number(data.id));
  const request = (incident?.resolutionReviews || []).find(item => item.id === Number(data.request));
  if (!incident || !request || request.status !== '待审核') throw new BusinessRejection('这项客诉／异常恢复申请已经处理');
  const selfReview = authorizeReviewer(request.submittedById);
  const decisionNote = String(data.decisionNote || '').trim().slice(0, 300);
  if (action === 'rejectIncidentResolution' && !decisionNote) throw new BusinessRejection('请填写驳回原因');
  if (action === 'approveIncidentResolution') {
    incident.result = request.result; incident.note = request.note; incident.status = '已完成'; incident.resolvedBy = request.submittedBy; incident.resolvedAt = time; incident.reviewedBy = person; incident.lastReminderDate = '';
  } else incident.status = '待处理';
  request.status = action === 'approveIncidentResolution' ? '已批准' : '已驳回'; request.decidedBy = person; request.decidedAt = time; request.decisionNote = decisionNote; request.selfReviewAuthorized = selfReview;
}
