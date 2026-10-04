// 共同基础：演示身份、岗位与具体权限的选择器（纯函数）。
// 语义冻结（Phase 2）：身份清单、默认岗位、权限角色表、backend.view／review.self 语义与原 rules.js 逐字节一致。
// 演示身份按门店确认的岗位配置。legacy 身份只为兼容已有练习数据和规则测试，界面不再展示。
export const USERS = {
  administrator: { name: '管理员', title: '后台总管理', roles: ['管理员'] },
  zhuBoss: { name: '卓老板', title: '老板', roles: ['老板', '财务'] },
  xiongBoss: { name: '雄老板', title: '外联经理', roles: ['店长', '财务', '采购', '开单员', '服务员', '收银员'] },
  shaoBoss: { name: '邵老板', title: '大堂经理', roles: ['店长', '财务', '采购', '开单员', '服务员', '收银员'] },
  wife: { name: '老板娘', title: '店长', roles: ['店长', '采购', '开单员', '服务员', '收银员'] },
  zhuYi: { name: '卓益', title: '订房服务专员', roles: ['开单员', '服务员'] },
  meiJiao: { name: '美娇', title: '订房专员', roles: ['开单员'] },
  staff: { name: '陈姐', title: '店员', roles: ['开单员', '收银员', '服务员'], legacy: true },
  keeper: { name: '林哥', title: '库管', roles: ['库管', '服务员'], legacy: true },
  boss: { name: '老板', title: '老板', roles: ['老板', '店长', '财务'], legacy: true }
};
export const USER_ALIASES = { staff: 'shaoBoss', keeper: 'wife', boss: 'zhuBoss' };
// 管理员可为其他演示身份分配的具体操作权限。管理员本身固定保留总管理权限。
export const PERMISSION_ROLES = ['老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'];
export const PERMISSION_DEFINITIONS = [
  { id: 'identity.manage', label: '调整身份权限', group: '系统管理', roles: ['管理员'] },
  { id: 'catalog.manage', label: '维护商品、套餐与当前价格', group: '系统管理', roles: ['管理员'] },
  { id: 'staff.record', label: '代员工登记订房与增购', group: '营业补录', roles: ['管理员', '老板', '店长', '财务'] },
  { id: 'room.open', label: '开房', group: '房间与订单', roles: ['开单员', '老板'] },
  { id: 'room.reserve', label: '预订与取消预订', group: '房间与订单', roles: ['开单员', '老板'] },
  { id: 'room.clean', label: '完成清洁', group: '房间与订单', roles: ['服务员', '老板'] },
  { id: 'room.issue', label: '标记房间故障／维护及提交恢复申请', group: '房间与订单', roles: ['管理员', '老板', '店长'] },
  { id: 'room.issue.approve', label: '审核房间恢复申请', group: '营业审核', roles: ['管理员', '老板', '店长'] },
  { id: 'order.sale', label: '加酒水／其他消费', group: '房间与订单', roles: ['开单员', '服务员', '老板'] },
  { id: 'retail.sale', label: '独立零售成交', group: '房间与订单', roles: ['收银员', '老板'] },
  { id: 'order.exchange', label: '换酒水', group: '房间与订单', roles: ['开单员', '服务员', '老板'] },
  { id: 'order.gift', label: '登记赠酒水', group: '房间与订单', roles: ['开单员', '服务员', '店长', '老板'] },
  { id: 'order.serveExtra', label: '标记小吃／果盘已上', group: '房间与订单', roles: ['开单员', '服务员', '老板'] },
  { id: 'payment.collect', label: '收钱', group: '收款与挂账', roles: ['收银员', '老板'] },
  { id: 'payment.settle', label: '结账', group: '收款与挂账', roles: ['收银员', '老板'] },
  { id: 'credit.apply', label: '申请挂账', group: '收款与挂账', roles: ['开单员', '收银员', '服务员', '库管', '店长', '老板'] },
  { id: 'credit.approve', label: '审批挂账', group: '收款与挂账', roles: ['店长', '老板'] },
  { id: 'credit.repay', label: '登记挂账回款', group: '收款与挂账', roles: ['收银员', '财务', '老板'] },
  { id: 'credit.repay.approve', label: '审核挂账回款', group: '营业审核', roles: ['财务', '店长', '老板'] },
  { id: 'gift.approve', label: '审批超额赠酒水', group: '营业审核', roles: ['店长', '老板'] },
  { id: 'rounding.approve', label: '审核特殊差额', group: '营业审核', roles: ['店长'] },
  { id: 'inventory.opening', label: '库存期初建账', group: '库存与交班', roles: ['店长', '老板', '采购'] },
  { id: 'inventory.adjust', label: '库存盘点与调整', group: '库存与交班', roles: ['店长', '老板', '库管', '采购'] },
  { id: 'inventory.approve', label: '审核库存盘点', group: '营业审核', roles: ['店长', '老板', '采购'] },
  { id: 'deposit.manage', label: '登记与取酒', group: '库存与交班', roles: ['服务员', '老板'] },
  { id: 'handover', label: '交班核对', group: '库存与交班', roles: ['收银员', '财务', '店长', '老板'] },
  { id: 'expense.view', label: '查看支出与报销', group: '经营后台', roles: ['管理员', '老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'] },
  { id: 'expense.create', label: '新增支出与报销', group: '经营后台', roles: ['管理员', '老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'] },
  { id: 'expense.viewAll', label: '查看他人支出与报销', group: '经营后台', roles: ['老板', '店长', '财务'] },
  { id: 'expense.approve', label: '审批大额报销', group: '营业审核', roles: ['老板'] },
  { id: 'procurement.create', label: '登记采购并关联支出／报销', group: '采购与库存', roles: ['管理员', '老板', '店长', '财务', '采购'] },
  { id: 'procurement.viewAll', label: '查看全部采购记录', group: '采购与库存', roles: ['管理员', '老板', '店长', '财务'] },
  { id: 'incident.create', label: '登记客诉／异常', group: '现场管理', roles: ['管理员', '老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'] },
  { id: 'incident.viewAll', label: '查看全部客诉／异常', group: '现场管理', roles: ['管理员', '老板', '店长', '财务'] },
  { id: 'incident.resolve', label: '填写客诉／异常处理结果', group: '现场管理', roles: ['管理员', '老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'] },
  { id: 'incident.resolve.approve', label: '审核客诉／异常恢复', group: '营业审核', roles: ['管理员', '老板', '店长', '财务'] },
  { id: 'review.self', label: '允许审核本人申请', group: '营业审核', roles: ['管理员'] },
  { id: 'report.view', label: '查看经营报表', group: '经营数据', roles: ['管理员', '老板', '财务', '店长', '收银员'] },
  { id: 'backend.view', label: '进入系统管理后台', group: '系统管理', roles: ['管理员', '老板', '店长', '财务', '采购', '库管'] }
];
export const PERMISSION_IDS = PERMISSION_DEFINITIONS.map(permission => permission.id);
export const BUSINESS_REVIEW_SECTIONS = [
  { id: 'creditApproval', permission: 'credit.approve' },
  { id: 'creditRepayment', permission: 'credit.repay.approve' },
  { id: 'rounding', permission: 'rounding.approve' },
  { id: 'gift', permission: 'gift.approve' },
  { id: 'roomRecovery', permission: 'room.issue.approve' },
  { id: 'inventory', permission: 'inventory.approve' },
  { id: 'incident', permission: 'incident.resolve.approve' },
  { id: 'expense', permission: 'expense.approve' }
];
export function businessReviewSections(user) {
  return BUSINESS_REVIEW_SECTIONS.filter(section => hasPermission(user, section.permission)).map(section => section.id);
}
export function permissionsForRoles(roles = []) {
  return PERMISSION_DEFINITIONS.filter(permission => permission.roles.some(role => roles.includes(role))).map(permission => permission.id);
}
export function defaultPermissions() {
  return Object.fromEntries(Object.entries(USERS).filter(([, user]) => !user.legacy).map(([id, user]) => [id, [...user.roles]]));
}
export function defaultCapabilities() {
  return Object.fromEntries(Object.entries(USERS).filter(([, user]) => !user.legacy).map(([id, user]) => [id, id === 'administrator' ? [...PERMISSION_IDS] : permissionsForRoles(user.roles)]));
}
export function effectiveUser(state, userId = state?.user) {
  const base = USERS[userId];
  if (!base) return base;
  if (userId === 'administrator') return { ...base, roles: ['管理员'], permissions: [...PERMISSION_IDS] };
  const configured = state?.permissions?.[userId];
  const roles = Array.isArray(configured) ? [...new Set(configured.filter(role => PERMISSION_ROLES.includes(role)))] : [...base.roles];
  const configuredCapabilities = state?.capabilities?.[userId];
  const permissions = Array.isArray(configuredCapabilities) ? [...new Set(configuredCapabilities.filter(permission => PERMISSION_IDS.includes(permission)))] : permissionsForRoles(roles);
  return { ...base, roles, permissions };
}
export function hasPermission(user, permission) { return Boolean(user?.roles?.includes('管理员') || (user?.permissions || permissionsForRoles(user?.roles || [])).includes(permission)); }
export function hasRole(user, roles) { return Boolean(user?.roles?.includes('管理员') || user?.roles?.some(role => roles.includes(role))); }

// Browser-safe context guard shared with the Node auth boundary. Registration is
// internal server code after session revalidation, never a request JSON field.
const trustedExecutionContexts = new WeakSet();
export function registerTrustedExecutionContext(context) {
  if (!Object.isFrozen(context) || context?.mode !== 'trusted' ||
      !Object.isFrozen(context.principal) || !Array.isArray(context.permissionIds) ||
      !Object.isFrozen(context.permissionIds) || typeof context.principalId !== 'string' || !context.principalId ||
      context.principalId !== context.principal?.id ||
      context.permissionIds !== context.principal?.permissionIds ||
      typeof context.policyAttributesConfigured !== 'boolean' ||
      !Array.isArray(context.principal?.policyAttributeIds) || !Object.isFrozen(context.principal.policyAttributeIds) ||
      (context.policyAttributesConfigured ? context.policyAttributeIds !== context.principal.policyAttributeIds :
        context.policyAttributeIds !== null || context.principal.policyAttributeIds.length !== 0) ||
      typeof context.sessionId !== 'string' || !context.sessionId ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(context.dbNow) ||
      !Number.isFinite(Date.parse(context.dbNow))) throw TypeError('事务内可信认证上下文无效');
  trustedExecutionContexts.add(context);
  return context;
}
export function assertTrustedExecutionContext(context) {
  if (!context || !trustedExecutionContexts.has(context)) throw TypeError('缺少事务内可信认证上下文');
  return context;
}
// Internal attribution capability, constructed only from the transaction-bound resolver.
// Copies no request identity, permissions or clock into the authenticated context.
export function withTrustedCreditedEmployee(context, employee) {
  assertTrustedExecutionContext(context);
  if (!Object.isFrozen(employee) || typeof employee?.employeeId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(employee.employeeId) ||
      typeof employee.displayName !== 'string' || !employee.displayName.trim()) throw TypeError('事务内员工快照无效');
  return registerTrustedExecutionContext(Object.freeze({ ...context,
    creditedEmployeeId: employee.employeeId, creditedEmployeeNameSnapshot: employee.displayName }));
}
// Separate from sales credit: only a resolved incident assignee snapshot.
export function withTrustedAssigneeEmployee(context, employee) {
  assertTrustedExecutionContext(context);
  if (!Object.isFrozen(employee) || typeof employee?.employeeId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(employee.employeeId) ||
      typeof employee.displayName !== 'string' || !employee.displayName.trim()) throw TypeError('事务内员工快照无效');
  return registerTrustedExecutionContext(Object.freeze({ ...context,
    assigneeEmployeeId: employee.employeeId, assigneeEmployeeNameSnapshot: employee.displayName }));
}
// Actor linkage is separate from credited sales staff and an incident's assignee.
export function withTrustedActorEmployee(context, employee) {
  assertTrustedExecutionContext(context);
  if (!Object.isFrozen(employee) || typeof employee?.employeeId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(employee.employeeId) ||
      typeof employee.displayName !== 'string' || !employee.displayName.trim()) throw TypeError('事务内操作者员工快照无效');
  return registerTrustedExecutionContext(Object.freeze({ ...context,
    actorEmployeeId: employee.employeeId, actorEmployeeNameSnapshot: employee.displayName }));
}
export class AuthorizationDenied extends Error {
  constructor(reason) {
    super('正式命令未获授权');
    this.name = 'AuthorizationDenied';
    this.code = 'AUTHORIZATION_DENIED';
    this.status = 'authorization-denied';
    this.reason = reason;
  }
}
export function requireTrustedPermission(context, permission) {
  assertTrustedExecutionContext(context);
  if (!context.permissionIds.includes(permission)) throw new AuthorizationDenied('missing-permission');
}
