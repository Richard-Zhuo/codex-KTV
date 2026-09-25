// 只承载演示业务：整数分计价、事务式状态变更，不依赖 DOM。
export const PRODUCTS = [
  { id: 'bw', name: '百威', category: '普通啤酒', level: 2, price: 1000, dozen: 11800, saleDozen: true, giftEligible: true },
  { id: 'xl', name: '喜力', category: '普通啤酒', level: 2, price: 1000, dozen: 11800, saleDozen: true, giftEligible: true },
  { id: 'qd', name: '青岛', category: '普通啤酒', level: 2, price: 1000, dozen: 11800, saleDozen: true, giftEligible: true },
  { id: 'redqd', name: '红青岛', category: '普通啤酒', level: 2, price: 1000, dozen: 11800, saleDozen: true, giftEligible: true },
  { id: 'lm', name: '蓝妹', category: '高端啤酒', level: 1, price: 1150, dozen: 13800, saleDozen: true, giftEligible: true },
  { id: 'lm_can', name: '蓝妹（罐装）', category: '高端啤酒', level: 1, price: 1150, dozen: 13800, saleDozen: true, giftEligible: true },
  { id: 'jbw', name: '黑金百威', category: '高端啤酒', level: 1, price: 1150, dozen: 13800, saleDozen: true, giftEligible: true },
  { id: 'drink', name: '饮料', category: '饮料', level: 2, price: 1000, giftEligible: true },
  ...['王老吉', '马蹄爽', '椰汁', '柠檬茶'].map((name, i) => ({ id: `drink${i}`, name, category: '饮料', level: 2, price: 1000 })),
  ...['可口可乐', '百事可乐', '雪碧', '芬达'].map((name, i) => ({ id: `soda${i}`, name, category: '汽水', level: 3, price: 600 })),
  { id: 'water', name: '瓶装水', category: '瓶装水', level: 4, price: 200 },
  { id: 'fruit', name: '果盘', category: '套餐配品', level: null, price: 0, managed: false },
  { id: 'nuts', name: '花生瓜子', category: '套餐配品', level: null, price: 0, managed: false }
];
export const OTHER_CHARGE_CATEGORIES = ['小吃', '热食', '烧鸡烤肉', '代驾', '其他'];
export const ROOM_TYPES = { 小房: { day: 6800, night: 5000, gifts: 1, fruit: 1, nuts: 1 }, 中房: { day: 6800, night: 5000, gifts: 1, fruit: 1, nuts: 1 }, 大房: { day: 8800, night: 5400, gifts: 2, fruit: 1, nuts: 2 }, VIP房: { day: 10800, night: 8400, gifts: 2, fruit: 2, nuts: 2 } };
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
  { id: 'identity.manage', label: '调整身份权限', group: '身份与员工', roles: ['管理员'] },
  { id: 'staff.record', label: '代员工登记订房与增购', group: '身份与员工', roles: ['管理员', '老板', '店长', '财务'] },
  { id: 'room.open', label: '开房', group: '房间与订单', roles: ['开单员', '老板'] },
  { id: 'room.reserve', label: '预订与取消预订', group: '房间与订单', roles: ['开单员', '老板'] },
  { id: 'room.clean', label: '完成清洁', group: '房间与订单', roles: ['服务员', '老板'] },
  { id: 'room.issue', label: '设置房间故障／维护状态', group: '房间与订单', roles: ['管理员', '老板', '店长'] },
  { id: 'order.sale', label: '加酒水／其他消费', group: '房间与订单', roles: ['开单员', '服务员', '老板'] },
  { id: 'order.exchange', label: '换酒水', group: '房间与订单', roles: ['开单员', '服务员', '老板'] },
  { id: 'order.gift', label: '登记赠酒水', group: '房间与订单', roles: ['开单员', '服务员', '店长', '老板'] },
  { id: 'order.serveExtra', label: '标记小吃／果盘已上', group: '房间与订单', roles: ['开单员', '服务员', '老板'] },
  { id: 'payment.collect', label: '收钱', group: '收款与挂账', roles: ['收银员', '老板'] },
  { id: 'payment.settle', label: '结账', group: '收款与挂账', roles: ['收银员', '老板'] },
  { id: 'credit.apply', label: '申请挂账', group: '收款与挂账', roles: ['开单员', '收银员', '服务员', '库管', '店长', '老板'] },
  { id: 'credit.approve', label: '审批挂账', group: '收款与挂账', roles: ['店长', '老板'] },
  { id: 'credit.repay', label: '登记挂账回款', group: '收款与挂账', roles: ['收银员', '财务', '老板'] },
  { id: 'gift.approve', label: '审批超额赠酒水', group: '审核与后台', roles: ['店长', '老板'] },
  { id: 'rounding.approve', label: '审核特殊差额', group: '审核与后台', roles: ['店长'] },
  { id: 'inventory.opening', label: '库存期初建账', group: '库存与交班', roles: ['店长', '老板', '采购'] },
  { id: 'inventory.adjust', label: '库存盘点与调整', group: '库存与交班', roles: ['店长', '老板', '库管', '采购'] },
  { id: 'deposit.manage', label: '登记与取酒', group: '库存与交班', roles: ['服务员', '老板'] },
  { id: 'handover', label: '交班核对', group: '库存与交班', roles: ['收银员', '财务', '店长', '老板'] },
  { id: 'expense.view', label: '查看支出与报销', group: '经营后台', roles: ['管理员', '老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'] },
  { id: 'expense.create', label: '新增支出与报销', group: '经营后台', roles: ['管理员', '老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'] },
  { id: 'expense.viewAll', label: '查看他人支出与报销', group: '经营后台', roles: ['老板', '店长', '财务'] },
  { id: 'expense.approve', label: '审批大额报销', group: '经营后台', roles: ['老板'] },
  { id: 'procurement.create', label: '登记采购并关联支出／报销', group: '采购与库存', roles: ['管理员', '老板', '店长', '财务', '采购'] },
  { id: 'procurement.viewAll', label: '查看全部采购记录', group: '采购与库存', roles: ['管理员', '老板', '店长', '财务'] },
  { id: 'incident.create', label: '登记客诉／异常', group: '现场管理', roles: ['管理员', '老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'] },
  { id: 'incident.viewAll', label: '查看全部客诉／异常', group: '现场管理', roles: ['管理员', '老板', '店长', '财务'] },
  { id: 'incident.resolve', label: '填写客诉／异常处理结果', group: '现场管理', roles: ['管理员', '老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管'] },
  { id: 'report.view', label: '查看经营报表', group: '审核与后台', roles: ['管理员', '老板', '财务', '店长', '收银员'] },
  { id: 'backend.view', label: '进入管理后台', group: '审核与后台', roles: ['管理员', '老板', '店长', '财务', '采购', '库管'] }
];
export const PERMISSION_IDS = PERMISSION_DEFINITIONS.map(permission => permission.id);
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
export const RESERVATION_SOURCES = ['线下', '手机', '座机', '美团', '抖音'];
export const OPENING_SOURCES = ['', '美团', '抖音'];
export const PLATFORM_OPENING_SOURCES = ['美团', '抖音'];
export const PAYMENT_METHODS = ['微信', '支付宝', '现金', '美团', '抖音'];
export const EXPENSE_NATURES = ['一次性支出', '固定支出', '资金周转'];
export const EXPENSE_TYPES = ['支出', '报销'];
export const EXPENSE_APPROVAL_THRESHOLD = 50000;
export const ROOM_ISSUE_TYPES = ['故障', '维护中'];
export const CONSUMABLES = [
  { id: 'nuts', name: '瓜子', unit: '包', threshold: 2 },
  { id: 'ice', name: '冰块', unit: '袋', threshold: 2 },
  { id: 'tissue', name: '纸巾', unit: '包', threshold: 5 },
  { id: 'straw', name: '吸管', unit: '包', threshold: 2 }
];
export const INCIDENT_TYPES = ['客诉', '设备异常', '卫生异常', '库存异常', '员工交接', '其他'];
export const money = cents => `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
export const product = id => { const p = PRODUCTS.find(p => p.id === id); if (!p) throw Error('商品不存在'); return p; };
export function slot(time) { const h = new Date(time).getHours(); return h >= 14 && h < 18 ? 'day' : h >= 18 || h < 2 ? 'night' : 'closed'; }
export function cents(value) { if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw Error('金额请填写正数，最多两位小数'); const [a,b=''] = String(value).split('.'); const n = Number(a)*100 + Number(b.padEnd(2,'0')); if (!Number.isSafeInteger(n)) throw Error('金额过大'); return n; }
function quantity(n) { if (!Number.isSafeInteger(n) || n <= 0) throw Error('数量必须是大于零的整数'); }
export function platformVoucher(source, amount) {
  const provider = String(source || '').trim();
  return PLATFORM_OPENING_SOURCES.includes(provider) ? { provider, status: '待验券', covered: amount, interface: 'platform-voucher-scan' } : null;
}
export function quote(type, time, beer = 'bw', openSource = '') {
  const config = ROOM_TYPES[type]; if (!config) throw Error('房型不存在');
  const period = slot(time); if (period === 'closed') throw Error('现在仅接受预订，请选择营业时段到店');
  if (period === 'day') {
    const voucher = platformVoucher(openSource, config.day);
    return { period, base: voucher ? 0 : config.day, gift: 0, total: voucher ? 0 : config.day, bottles: 0, dozen: 0, extras: [], voucher };
  }
  const p = product(beer); if (!p.giftEligible) throw Error('请选择可用于开房赠饮的酒水');
  const dozen = config.gifts;
  const gift = dozen * 11800;
  const voucher = platformVoucher(openSource, config.night + gift);
  return { period, base: voucher ? 0 : config.night, gift: voucher ? 0 : gift, total: voucher ? 0 : config.night + gift, dozen, bottles: dozen * (p.level === 1 ? 10 : 12), extras: [{ product: 'fruit', count: config.fruit }, { product: 'nuts', count: config.nuts }], voucher };
}
export function canExchange(from, to) { const a = product(from), b = product(to); return a.id !== b.id && a.level && b.level && a.level !== 4 && b.level >= a.level; }
export function reservationTarget(baseTime, dayOffset, session) {
  const offset = Number(dayOffset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 30) throw Error('预订日期只能选择今天至30天后');
  if (!['afternoon', 'night'].includes(session)) throw Error('请选择下午场或夜间场');
  const target = new Date(baseTime);
  target.setDate(target.getDate() + offset);
  target.setHours(session === 'afternoon' ? 14 : 20, 0, 0, 0);
  if (target <= new Date(baseTime)) throw Error('该场次已经开始，请选择后面的场次或日期');
  return target.toISOString();
}
export function reservationReminder(reservation, now) {
  if (!reservation || reservation.status !== '已预订') return null;
  const elapsed = Date.parse(now) - Date.parse(reservation.at);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const number = Math.floor(elapsed / 3600000) + 1;
  return { number, person: reservation.person, room: reservation.room, at: reservation.at, sessionLabel: reservation.sessionLabel || '' };
}
export function reservationActiveAt(reservation, now) {
  if (!reservation || reservation.status !== '已预订') return false;
  const start = Date.parse(reservation.at), current = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return false;
  const duration = reservation.session === 'afternoon' ? 4 : 6;
  return current >= start && current < start + duration * 3600000;
}
export function searchDeposits(deposits, query) {
  const term = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!term) return [];
  return deposits.filter(d => String(d.phone || '').includes(term) || String(d.name || '').toLocaleLowerCase('zh-CN').includes(term));
}
export function bonusAllowance(order, productId) {
  const purchased = (order?.sales || []).filter(line => line.product === productId).reduce((sum, line) => sum + (line.bottles || 0), 0);
  const entitledHalves = Math.floor(purchased / 24);
  const grantedHalves = (order?.bonusGifts || []).filter(line => line.product === productId).reduce((sum, line) => sum + line.halves, 0);
  const pendingHalves = (order?.giftRequests || []).filter(line => line.product === productId && line.status === '待确认').reduce((sum, line) => sum + line.halves, 0);
  return { purchased, entitledHalves, grantedHalves, pendingHalves, availableHalves: Math.max(0, entitledHalves - grantedHalves - pendingHalves) };
}
export function initialState() {
  const today = new Date(); today.setHours(20,0,0,0);
  const roomType = id => id === '888' ? 'VIP房' : ['V05', 'V06'].includes(id) ? '中房' : id.startsWith('V') ? '小房' : '大房';
  return { version: 1, clock: today.toISOString(), user: 'staff', permissions: defaultPermissions(), capabilities: defaultCapabilities(), rooms: ['V01','V02','V03','V05','V06','333','666','999','888'].map(id => ({ id, type: roomType(id), status: '空闲', order: null, issueType: '', issueNote: '', issueAt: '', issueBy: '' })), orders: [], reservations: [], deposits: [], withdrawals: [], expenses: [], procurements: [], incidents: [], inventory: Object.fromEntries(PRODUCTS.filter(p => p.managed !== false).map(p => [p.id, { count: null, threshold: p.dozen ? 250 : 10 }])), consumables: Object.fromEntries(CONSUMABLES.map(item => [item.id, { count: null, opened: 0, unit: item.unit, threshold: item.threshold }])), ledger: [], notices: [], handovers: [], processed: [], serial: 0 };
}
export const total = order => order.base + order.gift + (order.sales || []).reduce((sum, line) => sum + line.amount, 0) + (order.otherCharges || []).reduce((sum, line) => sum + line.amount, 0);
export const outstanding = order => Math.max(0, total(order) - (order.payments || []).reduce((sum, payment) => sum + payment.amount, 0));
export function collectableCharges(order) {
  const paidFor = chargeId => (order.payments || []).filter(payment => payment.chargeId === chargeId).reduce((sum, payment) => sum + payment.amount, 0);
  const opening = { id: 'open', kind: 'open', label: '开房费用（含套餐赠饮）', amount: order.base + order.gift };
  const groups = new Map();
  for (const line of (order.sales || [])) {
    const batch = line.batch ?? line.id;
    const id = `sale:${batch}`;
    const label = `${product(line.product).name} ${line.count}${line.spec === 'dozen' ? '打' : line.spec === 'half' ? '个半打' : '支'}`;
    const current = groups.get(id);
    if (current) { current.amount += line.amount; current.labels.push(label); }
    else groups.set(id, { id, batch, kind: 'sale', labels: [label], amount: line.amount });
  }
  for (const line of (order.otherCharges || [])) {
    const batch = line.batch ?? line.id;
    const id = `other:${batch}`;
    const label = line.category === '其他' ? line.item : line.category;
    const current = groups.get(id);
    if (current) { current.amount += line.amount; current.labels.push(label); }
    else groups.set(id, { id, batch, kind: 'other', labels: [label], amount: line.amount });
  }
  const additions = [...groups.values()].sort((a, b) => Number(a.batch) - Number(b.batch)).map(group => ({ id: group.id, kind: group.kind, label: `${group.kind === 'sale' ? '上一笔增购' : '上一笔其他消费'} · ${group.labels.join('、')}`, amount: group.amount }));
  return [opening, ...additions].map(charge => ({ ...charge, remaining: charge.amount - paidFor(charge.id) })).filter(charge => charge.remaining > 0);
}
export function nextCollectCharge(order) {
  const charges = collectableCharges(order), additions = charges.filter(charge => charge.kind !== 'open');
  return additions.at(-1) || charges.find(charge => charge.kind === 'open') || null;
}
export const collected = state => state.orders.reduce((sum, o) => sum + (o.payments || []).reduce((n,p) => n+p.amount, 0), 0);
export function hasRole(user, roles) { return Boolean(user?.roles?.includes('管理员') || user?.roles?.some(role => roles.includes(role))); }
export function visibleExpenses(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.expenses) ? state.expenses : [];
  return hasPermission(user, 'expense.viewAll') ? rows : rows.filter(row => row.person === user?.name);
}
export function visibleProcurements(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.procurements) ? state.procurements : [];
  return hasPermission(user, 'procurement.viewAll') ? rows : rows.filter(row => row.person === user?.name);
}
export function visibleIncidents(state, user = effectiveUser(state)) {
  const rows = Array.isArray(state?.incidents) ? state.incidents : [];
  if (hasPermission(user, 'incident.viewAll')) return rows;
  return rows.filter(row => row.person === user?.name || row.assignee === user?.name);
}
export function pendingIncidentReminders(stateOrRows, now = new Date().toISOString()) {
  const rows = Array.isArray(stateOrRows) ? stateOrRows : (stateOrRows?.incidents || []);
  const current = new Date(now), hour = current.getHours();
  if (!Number.isFinite(current.getTime()) || hour < 14) return [];
  const today = `${current.getFullYear()}-${String(current.getMonth()+1).padStart(2,'0')}-${String(current.getDate()).padStart(2,'0')}`;
  return rows.filter(row => row?.status !== '已完成' && row?.date && row.date <= today && row?.lastReminderDate !== today);
}
function need(state, roles, permission = '') { const user = effectiveUser(state); if (permission ? !hasPermission(user, permission) : !hasRole(user, roles)) throw Error('当前身份没有操作权限，请切换到对应演示身份'); }
function delegatedEmployee(state, data) {
  const id = String(data.employee || '').trim();
  if (!id) return null;
  need(state, [], 'staff.record');
  const employee = USERS[id];
  if (!employee || employee.legacy || id === 'administrator') throw Error('请选择有效的演示员工');
  return { id, name: employee.name, recordedBy: effectiveUser(state).name };
}
function inventory(state, id, delta, source, time) {
  if (product(id).managed === false) return;
  const item = state.inventory[id];
  if (item.count !== null && item.count + delta < 0) throw Error(`${product(id).name}库存不足，请减少数量或先核对库存`);
  state.ledger.push({ id: ++state.serial, product: id, delta, source, counted: item.count !== null, time, person: effectiveUser(state).name });
  if (item.count !== null) item.count += delta;
}
function grantBonus(state, order, productId, halves, source, time, requestedBy) {
  const bottles = halves * 6;
  inventory(state, productId, -bottles, source, time);
  order.bonusGifts ??= [];
  const giftId = ++state.serial;
  order.bonusGifts.push({ id: giftId, product: productId, halves, bottles, drinks: [{ id: ++state.serial, product: productId, count: bottles }], source, person: effectiveUser(state).name, requestedBy: requestedBy || effectiveUser(state).name, time });
}
function validatePayments(payments, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw Error('待收金额无效');
  if (amount === 0) { if (Array.isArray(payments) && payments.length) throw Error('本次无需再收款'); return []; }
  if (!Array.isArray(payments) || !payments.length || payments.some(payment => !PAYMENT_METHODS.includes(payment.method) || !Number.isSafeInteger(payment.amount) || payment.amount <= 0)) throw Error('请填写有效的收款方式和金额');
  if (payments.reduce((sum, payment) => sum + payment.amount, 0) !== amount) throw Error('各项收款之和必须等于本次待收金额');
  return payments;
}
function validateSettlementPayments(payments, amount, differenceType = '免零', differenceNote = '') {
  if (!Number.isSafeInteger(amount) || amount < 0) throw Error('待收金额无效');
  if (amount === 0) return { payments: [], rounding: 0, differenceType: '', differenceNote: '', needsReview: false };
  if (!Array.isArray(payments) || !payments.length || payments.some(payment => !PAYMENT_METHODS.includes(payment.method) || !Number.isSafeInteger(payment.amount) || payment.amount <= 0)) throw Error('请填写有效的收款方式和金额');
  const received = payments.reduce((sum, payment) => sum + payment.amount, 0);
  if (received > amount) throw Error('各项收款之和不能超过本次待收金额');
  const rounding = amount - received;
  if (!rounding) return { payments, rounding: 0, differenceType: '', differenceNote: '', needsReview: false };
  const type = String(differenceType || '免零').trim();
  if (!['免零', '特殊情况'].includes(type)) throw Error('请选择有效的差额处理方式');
  const note = String(differenceNote || '').trim().slice(0, 200);
  if (type === '特殊情况' && !note) throw Error('请填写特殊情况说明，提交后由店长审核');
  return { payments, rounding, differenceType: type, differenceNote: type === '特殊情况' ? note : '', needsReview: type === '特殊情况' };
}
// 先修改克隆，全部校验成功才返回；失败不产生部分扣库或半张账单。
export function transact(original, action, data = {}, key) {
  if (!key) throw Error('缺少操作编号');
  if (original.processed.includes(key)) return original;
  const s = structuredClone(original), time = s.clock, operator = effectiveUser(s).name;
  let person = operator;
  const room = s.rooms.find(r => r.id === data.room);
  const order = s.orders.find(o => o.id === data.order);
  const active = () => { if (!order || order.status !== '营业中') throw Error('账单已变化，请返回房间重新查看'); };
  if (action === 'setPermissions') {
    need(s, ['管理员']);
    const target = String(data.user || '');
    if (!USERS[target] || USERS[target].legacy || target === 'administrator') throw Error('只能调整其他演示身份的权限');
    if (data.permissions !== undefined) {
      if (!Array.isArray(data.permissions) || data.permissions.some(permission => !PERMISSION_IDS.includes(permission))) throw Error('具体权限选项无效');
      s.capabilities ??= defaultCapabilities();
      s.capabilities[target] = [...new Set(data.permissions)];
    } else {
      if (!Array.isArray(data.roles) || data.roles.some(role => !PERMISSION_ROLES.includes(role))) throw Error('岗位权限选项无效');
      s.permissions ??= defaultPermissions();
      s.capabilities ??= defaultCapabilities();
      s.permissions[target] = [...new Set(data.roles)];
      s.capabilities[target] = permissionsForRoles(s.permissions[target]);
    }
  } else if (action === 'markRoomIssue') {
    need(s, [], 'room.issue');
    if (!room) throw Error('请选择有效房间');
    if (!['空闲', '待清洁'].includes(room.status)) throw Error('营业中的房间不能直接标记为故障或维护中');
    const issueType = String(data.issueType || '').trim();
    if (!ROOM_ISSUE_TYPES.includes(issueType)) throw Error('请选择故障或维护中状态');
    const issueNote = String(data.issueNote || '').trim().slice(0, 200);
    if (!issueNote) throw Error('请填写故障或维护说明');
    room.status = '故障/维护中';
    room.issueType = issueType;
    room.issueNote = issueNote;
    room.issueAt = time;
    room.issueBy = person;
  } else if (action === 'clearRoomIssue') {
    need(s, [], 'room.issue');
    if (!room || room.status !== '故障/维护中') throw Error('房间异常状态已经变化');
    room.status = '空闲';
    room.issueType = '';
    room.issueNote = '';
    room.issueAt = '';
    room.issueBy = '';
  } else if (action === 'open') {
    const delegated = delegatedEmployee(s, data);
    if (delegated) person = delegated.name; else need(s, ['开单员','老板'], 'room.open');
    if (!room || !['空闲','待清洁','已预订'].includes(room.status)) throw Error('房间已在使用');
    if (room.status === '待清洁' && !data.acceptDirty) throw Error('请先确认房间可以接待客人');
    const openSource = String(data.openSource ?? '').trim();
    if (!OPENING_SOURCES.includes(openSource)) throw Error('请选择有效的开房渠道');
    const q = quote(room.type, time, data.beer, openSource);
    const booking = s.reservations.find(r => r.room === room.id && reservationActiveAt(r, time));
    const id = `D${++s.serial}`;
    let drinks = [];
    if (q.bottles && data.beer === 'drink') {
      if (!Array.isArray(data.initialMix) || !data.initialMix.length) throw Error('请选择首次配给客人的酒水种类和支数');
      const merged = new Map();
      for (const item of data.initialMix) {
        quantity(item.count);
        if (!canExchange('drink', item.product)) throw Error('首次配酒水只能选择同级或更低级商品');
        merged.set(item.product, (merged.get(item.product) || 0) + item.count);
      }
      if ([...merged.values()].reduce((sum, count) => sum + count, 0) !== q.bottles) throw Error(`首次配酒水合计必须是${q.bottles}支`);
      drinks = [...merged].map(([productId, count]) => ({ id: ++s.serial, product: productId, count }));
      for (const line of drinks) inventory(s, line.product, -line.count, '开房首次配酒水', time);
    } else if (q.bottles) {
      drinks = [{ id: ++s.serial, product: data.beer, count: q.bottles }];
      inventory(s, data.beer, -q.bottles, '开房赠饮', time);
    }
    s.orders.push({ id, room: room.id, time, person, recordedBy: operator, employeeId: delegated?.id || '', openedBy: person, openSource: openSource || '线下', voucher: q.voucher, reservedBy: booking?.person || '', reservationSource: booking?.source || '', status: '营业中', base: q.base, gift: q.gift, period: q.period, drinks, extras: q.extras.map(extra => ({ ...extra, served: false })), sales: [], otherCharges: [], bonusGifts: [], giftRequests: [], payments: [], rounding: 0, roundingType: '', roundingNote: '', roundingReview: null, credit: null, exchanges: [] });
    room.status = '营业中'; room.order = id;
    if (booking) booking.status = '已到店';
  } else if (action === 'reserve') {
    const delegated = delegatedEmployee(s, data);
    if (delegated) person = delegated.name; else need(s, ['开单员','老板'], 'room.reserve');
    if (!room || !['空闲','营业中','待清洁','已预订'].includes(room.status)) throw Error('当前房间状态不能预订');
    if (!RESERVATION_SOURCES.includes(data.source)) throw Error('请选择预订方式');
    const at = reservationTarget(time, data.dayOffset, data.session);
    if (s.reservations.some(r => r.room === room.id && r.status === '已预订' && Date.parse(r.at) === Date.parse(at))) throw Error('该房间该场次已经有预订');
    const sessionLabel = data.session === 'afternoon' ? '下午场（14:00—18:00）' : '夜间场（20:00—次日02:00）';
    s.reservations.push({ id: ++s.serial, room: room.id, at, dayOffset: Number(data.dayOffset), session: data.session, sessionLabel, source: data.source, note: String(data.note || '').slice(0,100), status: '已预订', person, employeeId: delegated?.id || '', recordedBy: operator });
  } else if (action === 'cancelReservation') {
    need(s, ['开单员','老板'], 'room.reserve'); if (!room) throw Error('房间状态已变化');
    const pending = s.reservations.filter(r => r.room === room.id && r.status === '已预订');
    const reservationId = data.id === undefined || data.id === '' ? null : Number(data.id);
    const booking = reservationId === null ? (pending.length === 1 ? pending[0] : null) : pending.find(r => r.id === reservationId);
    if (!booking) throw Error('预订状态已变化，请重新查看房间');
    booking.status = '已取消';
    if (room.status === '已预订' && !pending.some(r => r.id !== booking.id && reservationActiveAt(r, time))) room.status = '空闲';
  } else if (action === 'sale') {
    const delegated = delegatedEmployee(s, data);
    if (delegated) person = delegated.name; else need(s, ['开单员','服务员','老板'], 'order.sale');
    active();
    const items = Array.isArray(data.items) ? data.items : [{ product: data.product, spec: data.spec, count: data.count }];
    if (!items.length) throw Error('请至少添加一种酒水');
    const prepared = items.map(item => {
      quantity(item.count);
      const p = product(item.product); if (!p.price) throw Error('套餐配品不在演示加购范围');
      if (!['single','half','dozen'].includes(item.spec) || (item.spec !== 'single' && !p.saleDozen)) throw Error('该商品只按单支销售');
      const multiplier = item.spec === 'dozen' ? 12 : item.spec === 'half' ? 6 : 1;
      const unitPrice = item.spec === 'dozen' ? p.dozen : item.spec === 'half' ? p.dozen / 2 : p.price;
      return { p, item, bottles: item.count * multiplier, amount: item.count * unitPrice };
    });
    prepared.forEach(row => inventory(s, row.p.id, -row.bottles, '加购销售', time));
    const batch = ++s.serial;
    prepared.forEach(row => {
      const saleId = ++s.serial;
      order.sales.push({ id: saleId, batch, product: row.p.id, count: row.item.count, spec: row.item.spec, bottles: row.bottles, amount: row.amount, drinks: [{ id: ++s.serial, product: row.p.id, count: row.bottles }], person, recordedBy: operator, employeeId: delegated?.id || '' });
    });
  } else if (action === 'otherCharge') {
    need(s, ['开单员','服务员','老板'], 'order.sale'); active();
    const category = String(data.category || '').trim();
    if (!OTHER_CHARGE_CATEGORIES.includes(category)) throw Error('请选择有效的其他消费类别');
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw Error('金额应为大于零的金额');
    const customItem = String(data.item || '').trim().slice(0, 50);
    if (category === '其他' && !customItem) throw Error('请填写其他消费项目');
    const batch = ++s.serial;
    order.otherCharges ??= [];
    order.otherCharges.push({ id: ++s.serial, batch, category, item: category === '其他' ? customItem : category, amount: data.amount, person, time });
  } else if (action === 'gift') {
    need(s, ['开单员','服务员','店长','老板'], 'order.gift'); active(); quantity(data.halves);
    const p = product(data.product);
    if (!p.saleDozen) throw Error('赠酒水只适用于可按打销售的酒水');
    const allowance = bonusAllowance(order, p.id);
    if (!allowance.purchased) throw Error('请先增购对应酒水');
    order.giftRequests ??= [];
    if (hasRole(effectiveUser(s), ['店长','老板']) || data.halves <= allowance.availableHalves) {
      grantBonus(s, order, p.id, data.halves, data.halves <= allowance.availableHalves ? '每增购2打赠半打' : '老板／店长确认赠送', time);
    } else {
      const directHalves = allowance.availableHalves, excessHalves = data.halves - directHalves;
      if (directHalves) grantBonus(s, order, p.id, directHalves, '每增购2打赠半打', time);
      order.giftRequests.push({ id: ++s.serial, product: p.id, halves: excessHalves, bottles: excessHalves * 6, allowanceAtRequest: directHalves, status: '待确认', requestedBy: person, time });
    }
  } else if (action === 'approveGift' || action === 'rejectGift') {
    need(s, ['店长','老板'], 'gift.approve'); active();
    const request = (order.giftRequests || []).find(item => item.id === data.request);
    if (!request || request.status !== '待确认') throw Error('赠酒水申请已处理');
    request.status = action === 'approveGift' ? '已批准' : '已驳回'; request.decidedBy = person; request.decidedAt = time;
    if (action === 'approveGift') grantBonus(s, order, request.product, request.halves, '老板／店长确认赠送', time, request.requestedBy);
  } else if (action === 'exchange') {
    need(s, ['开单员','服务员','老板'], 'order.exchange'); active(); quantity(data.count);
    const source = String(data.line || '');
    let lines, line, scope;
    if (source.startsWith('sale:')) {
      const id = Number(source.slice(5));
      const sale = order.sales.find(item => (item.drinks || []).some(drink => drink.id === id));
      lines = sale?.drinks; line = lines?.find(drink => drink.id === id); scope = '增购';
    } else if (source.startsWith('bonus:')) {
      const id = Number(source.slice(6));
      const gift = (order.bonusGifts || []).find(item => (item.drinks || []).some(drink => drink.id === id));
      lines = gift?.drinks; line = lines?.find(drink => drink.id === id); scope = '赠送';
    } else {
      const id = Number(source.startsWith('gift:') ? source.slice(5) : source);
      lines = order.drinks; line = lines.find(drink => drink.id === id); scope = '套餐';
    }
    if (!line || line.count < data.count) throw Error('超过可换数量');
    if (!canExchange(line.product, data.product)) throw Error('只能换同级或更低级商品，瓶装水不能换出');
    inventory(s, line.product, data.count, '换购退回', time); inventory(s, data.product, -data.count, '换购领取', time);
    line.count -= data.count;
    const target = lines.find(drink => drink.product === data.product);
    if (target) target.count += data.count; else lines.push({ id: ++s.serial, product: data.product, count: data.count });
    order.exchanges.push({ from: line.product, to: data.product, count: data.count, scope, time, person });
  } else if (action === 'serveExtra') {
    need(s, ['开单员','服务员','老板'], 'order.serveExtra'); active();
    const extra = (order.extras || []).find(item => item.product === data.product);
    if (!extra) throw Error('该账单没有这项配品');
    if (extra.served) throw Error('这项配品已经标记已上');
    extra.served = true; extra.servedAt = time; extra.servedBy = person;
  } else if (action === 'collect') {
    need(s, ['收银员','老板'], 'payment.collect'); active();
    const charge = nextCollectCharge(order);
    if (!charge) throw Error('本单没有待收费用');
    if (data.charge !== charge.id) throw Error('账单已变化，请重新打开收钱页面');
    const payments = validatePayments(data.payments, charge.remaining);
    order.payments.push(...payments.map(payment => ({ ...payment, chargeId: charge.id, time, person })));
  } else if (action === 'settle' || action === 'pay') {
    need(s, ['收银员','老板'], 'payment.settle'); active();
    if ((order.giftRequests || []).some(item => item.status === '待确认')) throw Error('还有待确认的赠酒水申请，请先处理');
    const due = outstanding(order), settlement = action === 'settle' ? validateSettlementPayments(data.payments, due, data.differenceType, data.differenceNote) : { payments: validatePayments(data.payments, due), rounding: 0, differenceType: '', differenceNote: '', needsReview: false };
    order.payments.push(...settlement.payments.map(payment => ({ ...payment, chargeId: 'settlement', time, person })));
    order.rounding = settlement.rounding;
    order.roundingType = settlement.differenceType;
    order.roundingNote = settlement.differenceNote;
    order.roundingReview = settlement.needsReview ? { status: '待审核', amount: settlement.rounding, note: settlement.differenceNote, submittedBy: person, submittedAt: time, approver: '店长' } : null;
    order.status = '已结账'; order.closedAt = time; release(s, order);
  } else if (action === 'approveRounding') {
    need(s, ['店长'], 'rounding.approve');
    if (!order?.roundingReview || order.roundingReview.status !== '待审核') throw Error('特殊差额审核状态已变化');
    order.roundingReview.status = '已审核'; order.roundingReview.decidedBy = person; order.roundingReview.decidedAt = time;
  } else if (action === 'credit') {
    need(s, ['开单员','收银员','服务员','库管','店长','老板'], 'credit.apply'); active();
    if ((order.giftRequests || []).some(item => item.status === '待确认')) throw Error('还有待确认的赠酒水申请，请先处理');
    const phoneValue = String(data.phone || '').trim(), name = String(data.name || '').trim().slice(0,30);
    if (!phoneValue && !name) throw Error('手机号和顾客姓名至少填写一个');
    if (phoneValue) phone(phoneValue);
    const note = String(data.note || '').trim().slice(0,200); if (!note) throw Error('请填写挂账备注');
    if (typeof data.signature !== 'string' || !data.signature.startsWith('data:image/png;base64,') || data.signature.length < 100) throw Error('请由经办员工本人手写签字');
    const amount = outstanding(order); if (!amount) throw Error('本单已经收清，无需挂账');
    order.credit = { amount, remaining: amount, phone: phoneValue, name, note, person, openedBy: order.openedBy || order.person || '未记录', openSource: order.openSource || '线下', reservedBy: order.reservedBy || '', reservationSource: order.reservationSource || '', signature: data.signature, submittedAt: time, due: new Date(Date.parse(time)+86400000).toISOString(), approver: amount>100000 ? '老板' : '店长', repayments: [] };
    order.status = '待审批挂账'; release(s, order);
  } else if (action === 'approve' || action === 'reject') {
    if (!order || order.status !== '待审批挂账') throw Error('审批已处理'); need(s, [order.credit.approver], 'credit.approve');
    order.credit.decisionAt = time; order.credit.decisionBy = person; order.status = action === 'approve' ? '已挂账' : '营业中';
    // 驳回只恢复账单，不重新占用已经释放或被新客使用的房间。
    if (action === 'reject') order.credit = null;
  } else if (action === 'repay') {
    need(s, ['收银员','财务','老板'], 'credit.repay');
    if (!order || order.status !== '已挂账') throw Error('请选择已审批的挂账');
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0 || data.amount > order.credit.remaining) throw Error('回款金额应大于零且不超过欠款');
    if (!PAYMENT_METHODS.includes(data.method)) throw Error('请选择收款方式');
    const p = { amount: data.amount, method: data.method, time, person };
    order.credit.repayments.push(p); order.payments.push(p); order.credit.remaining -= data.amount;
    if (!order.credit.remaining) order.status = '已回款';
  } else if (action === 'clean') {
    need(s, ['服务员','老板'], 'room.clean'); if (!room || room.status !== '待清洁') throw Error('房间状态已变化'); room.status = '空闲';
  } else if (action === 'deposit') {
    need(s, ['服务员','老板'], 'deposit.manage');
    const phoneValue = String(data.phone || '').trim();
    const name = String(data.name || '').trim().slice(0,30);
    if (!phoneValue && !name) throw Error('手机号和姓名至少填写一个');
    if (phoneValue) phone(phoneValue);
    if (!s.rooms.some(r => r.id === data.room)) throw Error('请选择房间');
    const items = Array.isArray(data.items) ? data.items : [{ product: data.product, count: data.count }];
    if (!items.length) throw Error('请至少添加一种酒');
    const group = `CJ${++s.serial}`;
    for (const item of items) {
      quantity(item.count);
      if (!product(item.product).giftEligible) throw Error('请选择可存放的酒水');
      s.deposits.push({ id: ++s.serial, group, phone: phoneValue, name, room: data.room, product: item.product, count: item.count, initial: item.count, time, person });
    }
  } else if (action === 'withdraw') {
    need(s, ['服务员','老板'], 'deposit.manage'); quantity(data.count);
    const d = s.deposits.find(d => d.id === data.id);
    const identity = String(data.identity || '').trim();
    const phoneMatch = /^\d{4,11}$/.test(identity) && d?.phone && d.phone.endsWith(identity);
    const nameMatch = Boolean(d?.name && identity === d.name);
    if (!d || !identity || (!phoneMatch && !nameMatch)) throw Error('请输入登记手机号尾号（至少4位）或姓名核对'); if (data.count > d.count) throw Error('取酒不能超过剩余数量');
    d.count -= data.count; s.withdrawals.push({ id: ++s.serial, deposit: d.id, count: data.count, time, person });
  } else if (action === 'stock') {
    const item = s.inventory[data.product]; if (!item) throw Error('该商品不管理库存');
    need(s, item.count === null ? ['店长','老板','采购'] : ['店长','老板','库管','采购'], item.count === null ? 'inventory.opening' : 'inventory.adjust');
    if (!Number.isSafeInteger(data.count) || data.count < 0) throw Error('实际库存应为非负整数');
    if (!String(data.reason || '').trim()) throw Error('请填写调整原因');
    const before = item.count;
    s.ledger.push({ id: ++s.serial, product: data.product, delta: data.count-(before ?? 0), before, after: data.count, reason: data.reason, source: before === null ? '期初建账' : '盘点调整', counted: true, person, time });
    item.count = data.count; if (before === null) item.openedAt = time;
    if (hasRole(effectiveUser(s), ['库管'])) s.notices.push({ id: ++s.serial, product: data.product, before, after: data.count, reason: data.reason, person, time });
  } else if (action === 'consumableStock') {
    const item = s.consumables?.[data.product]; if (!item) throw Error('该消耗品不在库存管理中');
    const permission = item.count === null ? 'inventory.opening' : 'inventory.adjust';
    need(s, [], permission);
    if (!Number.isSafeInteger(data.count) || data.count < 0 || !Number.isSafeInteger(data.opened) || data.opened < 0) throw Error('消耗品数量应为非负整数');
    if (!String(data.reason || '').trim()) throw Error('请填写调整原因');
    const before = item.count, beforeOpened = item.opened || 0;
    s.ledger.push({ id: ++s.serial, kind: 'consumable', product: data.product, delta: data.count-(before ?? 0), before, after: data.count, openedBefore: beforeOpened, openedAfter: data.opened, reason: data.reason, source: before === null ? '消耗品期初建账' : '消耗品盘点调整', counted: true, person, time });
    item.count = data.count; item.opened = data.opened; if (before === null) item.openedAt = time;
    if (hasRole(effectiveUser(s), ['库管'])) s.notices.push({ id: ++s.serial, kind: 'consumable', product: data.product, before, after: data.count, openedBefore: beforeOpened, openedAfter: data.opened, reason: data.reason, person, time });
  } else if (action === 'handover') {
    need(s, ['收银员','财务','店长','老板'], 'handover');
    if (!Number.isSafeInteger(data.actual) || data.actual < 0) throw Error('请输入有效实点金额');
    if (!Number.isSafeInteger(data.drawerCash) || data.drawerCash < 0) throw Error('请输入有效的前台现金');
    const expected = collected(s); s.handovers.push({ id: ++s.serial, expected, actual: data.actual, drawerCash: data.drawerCash, difference: data.actual-expected, person, time });
  } else if (action === 'expense') {
    need(s, ['管理员','老板','店长','财务','采购','开单员','服务员','收银员','库管'], 'expense.create');
    const expenseDate = String(data.date || '').trim();
    const parsedDate = Date.parse(`${expenseDate}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate) || !Number.isFinite(parsedDate)) throw Error('请选择有效支出日期');
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw Error('支出金额应为大于零的金额');
    if (!PAYMENT_METHODS.includes(data.method)) throw Error('请选择付款方式');
    const type = String(data.type || '支出').trim();
    if (!EXPENSE_TYPES.includes(type)) throw Error('请选择记录类型');
    if (!EXPENSE_NATURES.includes(data.nature)) throw Error('请选择支出性质');
    const description = String(data.description || '').trim().slice(0, 200);
    if (!description) throw Error('请填写支出说明');
    const proof = String(data.proof || '').trim();
    if (proof && (!proof.startsWith('data:image/') || proof.length > 800000)) throw Error('图片凭证格式或大小无效');
    s.expenses ??= [];
    const needsApproval = type === '报销' && data.amount > EXPENSE_APPROVAL_THRESHOLD;
    s.expenses.push({ id: ++s.serial, date: expenseDate, type, amount: data.amount, method: data.method, nature: data.nature, description, proof, proofName: String(data.proofName || '').trim().slice(0, 120), status: needsApproval ? '待老板审批' : '已记录', approver: '', approvedAt: '', person, time });
  } else if (action === 'procurement') {
    need(s, [], 'procurement.create');
    const procurementDate = String(data.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(procurementDate) || !Number.isFinite(Date.parse(`${procurementDate}T00:00:00`))) throw Error('请选择有效采购日期');
    const item = String(data.item || '').trim().slice(0, 80); if (!item) throw Error('请填写采购项目');
    if (!Number.isSafeInteger(data.quantity) || data.quantity <= 0) throw Error('采购数量应为大于零的整数');
    const unit = String(data.unit || '').trim().slice(0, 20); if (!unit) throw Error('请填写采购单位');
    if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw Error('采购金额应为大于零的金额');
    if (!PAYMENT_METHODS.includes(data.method)) throw Error('请选择付款方式');
    const type = String(data.type || '支出').trim(); if (!EXPENSE_TYPES.includes(type)) throw Error('请选择记录类型');
    if (!EXPENSE_NATURES.includes(data.nature)) throw Error('请选择支出性质');
    const description = String(data.description || '').trim().slice(0, 200) || `采购${item}`;
    s.expenses ??= [];
    const needsApproval = type === '报销' && data.amount > EXPENSE_APPROVAL_THRESHOLD;
    const expenseId = ++s.serial;
    s.expenses.push({ id: expenseId, date: procurementDate, type, amount: data.amount, method: data.method, nature: data.nature, description, proof: '', proofName: '', status: needsApproval ? '待老板审批' : '已记录', approver: '', approvedAt: '', person, time, source: '采购' });
    s.procurements ??= [];
    s.procurements.push({ id: ++s.serial, date: procurementDate, item, quantity: data.quantity, unit, amount: data.amount, method: data.method, type, nature: data.nature, description, expenseId, status: needsApproval ? '报销待老板审批' : '已关联支出', person, time });
  } else if (action === 'incident') {
    need(s, [], 'incident.create');
    const incidentDate = String(data.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate) || !Number.isFinite(Date.parse(`${incidentDate}T00:00:00`))) throw Error('请选择有效异常日期');
    if (!s.rooms.some(item => item.id === data.room)) throw Error('请选择房号');
    const type = String(data.type || '').trim(); if (!INCIDENT_TYPES.includes(type)) throw Error('请选择问题类型');
    const description = String(data.description || '').trim().slice(0, 300); if (!description) throw Error('请填写问题描述');
    const assigneeId = String(data.assignee || '').trim(); const assignee = USERS[assigneeId];
    if (!assignee || assignee.legacy || assigneeId === 'administrator') throw Error('请选择处理负责人');
    s.incidents ??= [];
    s.incidents.push({ id: ++s.serial, date: incidentDate, room: data.room, type, description, assigneeId, assignee: assignee.name, result: '', note: '', status: '待处理', person, createdAt: time, lastReminderDate: '' });
  } else if (action === 'resolveIncident') {
    need(s, [], 'incident.resolve');
    const incident = (s.incidents || []).find(item => item.id === Number(data.id));
    if (!incident || incident.status === '已完成') throw Error('该客诉／异常已经处理');
    if (incident.assignee !== person && !hasPermission(effectiveUser(s), 'incident.viewAll')) throw Error('只有负责人或管理人员可以填写处理结果');
    const result = String(data.result || '').trim().slice(0, 300); if (!result) throw Error('请填写处理结果');
    const note = String(data.note || '').trim().slice(0, 300); if (!note) throw Error('请填写处理备注');
    incident.result = result; incident.note = note; incident.status = '已完成'; incident.resolvedBy = person; incident.resolvedAt = time; incident.lastReminderDate = '';
  } else if (action === 'approveExpense' || action === 'rejectExpense') {
    need(s, ['老板'], 'expense.approve');
    const expense = (s.expenses || []).find(item => item.id === Number(data.id));
    if (!expense || expense.status !== '待老板审批') throw Error('这笔报销不在待审批状态');
    expense.status = action === 'approveExpense' ? '已审批' : '已驳回';
    expense.approver = person;
    expense.approvedAt = time;
  } else throw Error('未知操作');
  s.processed.push(key); return s;
}
function release(s, order) { const r = s.rooms.find(r => r.order === order.id); if (r) { r.status = '待清洁'; r.order = null; } }
function phone(value) { if (!/^1\d{10}$/.test(value || '')) throw Error('请填写11位手机号'); }
