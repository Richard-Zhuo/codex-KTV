// Phase 2 后测：金额、时间与权限基础契约的纯函数行为直接针对 shared/* 验证。
// 抽取前的同批断言曾以 rules.js 为导入源运行并全部通过（前测证据，见 CURRENT_STAGE.md Phase 2 行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { money, cents } from './shared/money.js';
import { slot } from './shared/time.js';
import {
  USERS, USER_ALIASES, PERMISSION_ROLES, PERMISSION_DEFINITIONS, PERMISSION_IDS,
  BUSINESS_REVIEW_SECTIONS, businessReviewSections, permissionsForRoles,
  defaultPermissions, defaultCapabilities, effectiveUser, hasPermission, hasRole
} from './shared/identity.js';
import {
  money as facadeMoney, cents as facadeCents, slot as facadeSlot,
  USERS as facadeUSERS, USER_ALIASES as facadeUSER_ALIASES, PERMISSION_ROLES as facadePERMISSION_ROLES,
  PERMISSION_DEFINITIONS as facadePERMISSION_DEFINITIONS, PERMISSION_IDS as facadePERMISSION_IDS,
  BUSINESS_REVIEW_SECTIONS as facadeBUSINESS_REVIEW_SECTIONS, businessReviewSections as facadeBusinessReviewSections,
  permissionsForRoles as facadePermissionsForRoles, defaultPermissions as facadeDefaultPermissions,
  defaultCapabilities as facadeDefaultCapabilities, effectiveUser as facadeEffectiveUser,
  hasPermission as facadeHasPermission, hasRole as facadeHasRole, initialState
} from './rules.js';

const ACTIVE_USER_IDS = ['administrator', 'zhuBoss', 'xiongBoss', 'shaoBoss', 'wife', 'zhuYi', 'meiJiao'];
const LEGACY_USER_IDS = ['staff', 'keeper', 'boss'];

test('money：整数分格式化为带 ¥ 前缀的字符串，整数元省略小数', () => {
  assert.equal(money(0), '¥0');
  assert.equal(money(1), '¥0.01');
  assert.equal(money(10), '¥0.10');
  assert.equal(money(1150), '¥11.50');
  assert.equal(money(5000), '¥50');
  assert.equal(money(6800), '¥68');
  assert.equal(money(16800), '¥168');
  assert.equal(money(23600), '¥236');
  assert.equal(money(50001), '¥500.01');
  assert.equal(money(100000000), '¥1000000');
  // 负数与 NaN 会原样通过（行为冻结，不在 Phase 2 修复）
  assert.equal(money(-100), '¥-1');
  assert.equal(money(NaN), '¥NaN');
});

test('cents：金额字符串解析为整数分，非法输入抛错', () => {
  assert.equal(cents('0'), 0);
  assert.equal(cents('0.00'), 0);
  assert.equal(cents('007'), 700);
  assert.equal(cents('1.5'), 150);
  assert.equal(cents('1.50'), 150);
  assert.equal(cents('1.10'), 110);
  assert.equal(cents('0.1'), 10);
  assert.equal(cents('11.50'), 1150);
  assert.equal(cents('100'), 10000);
  assert.equal(cents(5), 500);
  assert.equal(cents(5.5), 550);
  for (const bad of ['1.001', '-1', 'abc', '', '.', '1.', '1,5']) {
    assert.throws(() => cents(bad), /金额请填写正数，最多两位小数/);
  }
  assert.throws(() => cents('99999999999999'), /金额过大/);
});

test('slot：14-18 点为 day，18-02 点为 night，其余为 closed', () => {
  assert.equal(slot('2024-06-01T13:59'), 'closed');
  assert.equal(slot('2024-06-01T14:00'), 'day');
  assert.equal(slot('2024-06-01T17:59'), 'day');
  assert.equal(slot('2024-06-01T18:00'), 'night');
  assert.equal(slot('2024-06-01T23:30'), 'night');
  assert.equal(slot('2024-06-01T01:59'), 'night');
  assert.equal(slot('2024-06-01T02:00'), 'closed');
  assert.equal(slot('2024-06-01T12:00'), 'closed');
  assert.equal(slot(new Date('2024-06-01T20:00')), 'night');
});

test('身份基线：7 个在用身份 + 3 个 legacy 身份与别名映射不变', () => {
  assert.deepEqual(Object.keys(USERS).filter(id => !USERS[id].legacy), ACTIVE_USER_IDS);
  assert.deepEqual(LEGACY_USER_IDS.filter(id => USERS[id]?.legacy), LEGACY_USER_IDS);
  assert.deepEqual(USER_ALIASES, { staff: 'shaoBoss', keeper: 'wife', boss: 'zhuBoss' });
  assert.deepEqual(USERS.zhuBoss.roles, ['老板', '财务']);
  assert.deepEqual(USERS.wife.roles, ['店长', '采购', '开单员', '服务员', '收银员']);
  assert.deepEqual(USERS.zhuYi.roles, ['开单员', '服务员']);
  assert.deepEqual(USERS.meiJiao.roles, ['开单员']);
});

test('权限定义基线：40 个唯一权限，岗位集合与关键角色不变', () => {
  assert.equal(PERMISSION_DEFINITIONS.length, 39);
  assert.equal(new Set(PERMISSION_IDS).size, 39);
  assert.deepEqual(PERMISSION_ROLES, ['老板', '店长', '财务', '采购', '开单员', '服务员', '收银员', '库管']);
  const byId = Object.fromEntries(PERMISSION_DEFINITIONS.map(p => [p.id, p]));
  // Phase 2 明确不得改变的四个语义点
  assert.deepEqual(byId['review.self'].roles, ['管理员']);
  assert.deepEqual(byId['backend.view'].roles, ['管理员', '老板', '店长', '财务', '采购', '库管']);
  assert.deepEqual(byId['rounding.approve'].roles, ['店长']);
  assert.deepEqual(byId['expense.approve'].roles, ['老板']);
});

test('权限矩阵：默认状态下每个身份的权限与岗位角色派生完全一致', () => {
  const state = initialState();
  for (const id of ACTIVE_USER_IDS) {
    const user = effectiveUser(state, id);
    assert.deepEqual(user.roles, USERS[id].roles, `roles of ${id}`);
    if (id === 'administrator') {
      assert.deepEqual(user.permissions, [...PERMISSION_IDS]);
    } else {
      assert.deepEqual(user.permissions, permissionsForRoles(USERS[id].roles), `permissions of ${id}`);
    }
    for (const permission of PERMISSION_IDS) {
      const expected = id === 'administrator' || PERMISSION_DEFINITIONS.find(p => p.id === permission).roles.some(role => USERS[id].roles.includes(role));
      assert.equal(hasPermission(user, permission), expected, `${id} × ${permission}`);
    }
  }
});

test('权限矩阵抽样：关键权限的默认持有者与需求一致', () => {
  const state = initialState();
  const holds = (id, permission) => hasPermission(effectiveUser(state, id), permission);
  // rounding.approve 只有店长（xiongBoss/shaoBoss/wife），老板不持有
  for (const id of ['xiongBoss', 'shaoBoss', 'wife']) assert.ok(holds(id, 'rounding.approve'), `${id} rounding.approve`);
  assert.ok(!holds('zhuBoss', 'rounding.approve'));
  // review.self 默认只有管理员
  for (const id of ACTIVE_USER_IDS) assert.equal(holds(id, 'review.self'), id === 'administrator', `${id} review.self`);
  // backend.view 不授予业务审核：zhuYi/meiJiao 无后台入口
  assert.ok(!holds('zhuYi', 'backend.view'));
  assert.ok(!holds('meiJiao', 'backend.view'));
  assert.ok(holds('zhuBoss', 'backend.view'));
  // retail.sale：收银员或老板（zhuBoss/xiongBoss/shaoBoss/wife）
  for (const id of ['zhuBoss', 'xiongBoss', 'shaoBoss', 'wife']) assert.ok(holds(id, 'retail.sale'), `${id} retail.sale`);
  assert.ok(!holds('zhuYi', 'retail.sale'));
  assert.ok(!holds('meiJiao', 'retail.sale'));
  // expense.approve 只有老板
  assert.ok(holds('zhuBoss', 'expense.approve'));
  for (const id of ['xiongBoss', 'shaoBoss', 'wife', 'zhuYi', 'meiJiao']) assert.ok(!holds(id, 'expense.approve'), `${id} expense.approve`);
});

test('defaultPermissions/defaultCapabilities：在用身份的默认岗位与能力', () => {
  const permissions = defaultPermissions();
  assert.deepEqual(Object.keys(permissions), ACTIVE_USER_IDS);
  for (const id of ACTIVE_USER_IDS) assert.deepEqual(permissions[id], [...USERS[id].roles]);
  const capabilities = defaultCapabilities();
  assert.deepEqual(Object.keys(capabilities), ACTIVE_USER_IDS);
  assert.deepEqual(capabilities.administrator, [...PERMISSION_IDS]);
  for (const id of ACTIVE_USER_IDS.slice(1)) assert.deepEqual(capabilities[id], permissionsForRoles(USERS[id].roles));
});

test('effectiveUser：配置覆盖、非法值过滤与未知身份', () => {
  // 未配置时回落到默认
  const fresh = effectiveUser({ user: 'shaoBoss' });
  assert.deepEqual(fresh.roles, USERS.shaoBoss.roles);
  assert.deepEqual(fresh.permissions, permissionsForRoles(USERS.shaoBoss.roles));
  // permissions 覆盖角色并过滤非法岗位
  const customRoles = effectiveUser({ user: 'shaoBoss', permissions: { shaoBoss: ['不存在', '服务员'] } });
  assert.deepEqual(customRoles.roles, ['服务员']);
  assert.deepEqual(customRoles.permissions, permissionsForRoles(['服务员']));
  // capabilities 覆盖具体权限并过滤非法项
  const customCaps = effectiveUser({ user: 'shaoBoss', capabilities: { shaoBoss: ['room.open', '不存在'] } });
  assert.deepEqual(customCaps.permissions, ['room.open']);
  // 未知身份返回 undefined
  assert.equal(effectiveUser({ user: 'nobody' }), undefined);
  assert.equal(effectiveUser({}), undefined);
  // administrator 恒为全权限、单角色
  const admin = effectiveUser({ user: 'administrator', permissions: { administrator: ['服务员'] } });
  assert.deepEqual(admin.roles, ['管理员']);
  assert.deepEqual(admin.permissions, [...PERMISSION_IDS]);
});

test('hasPermission：管理员旁路、无配置时按角色派生、空身份为假', () => {
  assert.ok(hasPermission({ roles: ['管理员'] }, 'rounding.approve'));
  assert.ok(hasPermission({ roles: ['开单员'] }, 'room.open'));
  assert.ok(!hasPermission({ roles: ['开单员'] }, 'room.clean'));
  assert.ok(!hasPermission({}, 'room.open'));
  assert.ok(!hasPermission(null, 'room.open'));
  assert.ok(!hasPermission({ roles: ['服务员'] }, 'expense.approve'));
});

test('hasRole：管理员旁路，按岗位名单命中', () => {
  assert.ok(hasRole({ roles: ['管理员'] }, ['收银员']));
  assert.ok(hasRole({ roles: ['开单员', '服务员'] }, ['服务员']));
  assert.ok(!hasRole({ roles: ['开单员'] }, ['收银员']));
  assert.ok(!hasRole({ roles: ['开单员'] }, []));
  assert.ok(!hasRole(null, ['收银员']));
  assert.ok(!hasRole({}, ['收银员']));
});

test('businessReviewSections：按用户权限过滤 8 个审核区', () => {
  assert.deepEqual(BUSINESS_REVIEW_SECTIONS.map(s => s.id), ['creditApproval', 'creditRepayment', 'rounding', 'gift', 'roomRecovery', 'inventory', 'incident', 'expense']);
  const state = initialState();
  const admin = effectiveUser(state, 'administrator');
  assert.deepEqual(businessReviewSections(admin), BUSINESS_REVIEW_SECTIONS.map(s => s.id));
  const wife = effectiveUser(state, 'wife');
  // 老板娘（店长）默认持有除 expense.approve 外的七个审核区
  assert.deepEqual(businessReviewSections(wife), ['creditApproval', 'creditRepayment', 'rounding', 'gift', 'roomRecovery', 'inventory', 'incident']);
  const meiJiao = effectiveUser(state, 'meiJiao');
  assert.deepEqual(businessReviewSections(meiJiao), []);
});

test('permissionsForRoles：岗位到权限的派生与空输入', () => {
  assert.deepEqual(permissionsForRoles([]), []);
  assert.deepEqual(permissionsForRoles(), []);
  assert.deepEqual(permissionsForRoles(['不存在']), []);
  const bossPerms = permissionsForRoles(['老板']);
  assert.ok(bossPerms.includes('expense.approve'));
  assert.ok(!bossPerms.includes('rounding.approve'));
  assert.ok(permissionsForRoles(['收银员']).includes('retail.sale'));
});

test('facade：rules.js 对 shared 基础符号的 re-export 是同一绑定，未复制第二份定义', () => {
  assert.equal(facadeMoney, money);
  assert.equal(facadeCents, cents);
  assert.equal(facadeSlot, slot);
  assert.equal(facadeUSERS, USERS);
  assert.equal(facadeUSER_ALIASES, USER_ALIASES);
  assert.equal(facadePERMISSION_ROLES, PERMISSION_ROLES);
  assert.equal(facadePERMISSION_DEFINITIONS, PERMISSION_DEFINITIONS);
  assert.equal(facadePERMISSION_IDS, PERMISSION_IDS);
  assert.equal(facadeBUSINESS_REVIEW_SECTIONS, BUSINESS_REVIEW_SECTIONS);
  assert.equal(facadeBusinessReviewSections, businessReviewSections);
  assert.equal(facadePermissionsForRoles, permissionsForRoles);
  assert.equal(facadeDefaultPermissions, defaultPermissions);
  assert.equal(facadeDefaultCapabilities, defaultCapabilities);
  assert.equal(facadeEffectiveUser, effectiveUser);
  assert.equal(facadeHasPermission, hasPermission);
  assert.equal(facadeHasRole, hasRole);
});

test('facade：经 rules.js 使用 shared 基础符号的领域行为不变（quote 场景金额与时段）', () => {
  const state = initialState();
  // slot 经 shared/time.js 参与报价：白天小房固定价 6800 分
  assert.equal(facadeSlot('2024-06-01T15:00'), 'day');
  const dayQuote = state.catalog.packages.find(p => p.roomType === '小房' && p.period === 'day');
  assert.ok(dayQuote);
  assert.equal(facadeMoney(dayQuote.priceCents), '¥68');
});
