import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const index = read('./index.html');
const admin = read('./admin.html');
const server = read('./server.js');
const app = read('./app.js');
// Phase 7 前测起：UI 拆分为 ui/ 模块；sources = app.js + ui/**（拆分前仅 app.js）。
// 拆分时允许的唯一机械转换是模块级可变状态改为 ctx.*（state/page/filter/
// searchTerm/reportPeriod/busy/storageProblem/APP_ENTRY/DEFAULT_PAGE/modal 等），
// 因此涉及这些标识符的正则写成 (?:ctx\.)? 前缀容忍；其余文本必须逐字保留。
const uiDirs = ['ui', 'ui/pages', 'ui/dialogs'];
const uiFiles = uiDirs.flatMap(d => existsSync(new URL(`./${d}`, import.meta.url))
  ? readdirSync(new URL(`./${d}`, import.meta.url)).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`)
  : []);
const sources = [app, ...uiFiles.map(read)].join('\n');
const moduleOf = name => { const hit = uiFiles.find(f => f.endsWith(name)); return hit ? read(hit) : ''; };
const sliceOf = (src, startMark, endMark) => {
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark, start);
  return start >= 0 && end > start ? src.slice(start, end) : '';
};

test('formal employee and admin pages use separate HTTP module entries', () => {
  assert.match(index, /data-app-entry="staff"/);
  assert.match(index, /type="module" src="\/ui\/staff-app\.js"/);
  assert.match(admin, /data-app-entry="admin"/);
  assert.match(admin, /type="module" src="\/ui\/admin-app\.js"/);
  assert.doesNotMatch(admin, /type="module" src="\/app\.js"|demo-banner/);
  assert.match(server, /'\/admin': \['admin\.html', 'text\/html'\]/);
  assert.match(server, /'\/admin\.html': \['admin\.html', 'text\/html'\]/);
  assert.match(server, /'\/ui\/admin-app\.js': \['ui\/admin-app\.js', 'text\/javascript'\]/);
});

test('营业待办留在员工系统，系统后台不承载日常营业页面', () => {
  assert.match(sources, /const adminPages = \['manage'\]/);
  assert.match(sources, /\['tasks','✓','待办'\]/);
  assert.match(sources, /(?:ctx\.)?page==='tasks'\?taskCenterPage\(\)/);
  assert.match(sources, /canManage \? \[\['manage','▧','系统'\]\] : \[\]/);

  const taskPage = moduleOf('pages/tasks.js') || sliceOf(app, 'function taskCenterPage()', 'function permissionCards()');
  const adminSrc = moduleOf('pages/admin.js') || app;
  // Phase 8 起 stockNotices／handoverHistory 已作为死代码删除，admin.js 以 export 块结尾。
  const systemPage = sliceOf(adminSrc, 'function systemManagementPage()', 'export {') || adminSrc;
  assert.ok(taskPage.length > 0, '待办中心页面实现必须存在');
  assert.ok(systemPage.length > 0, '系统管理页面实现必须存在');

  assert.match(taskPage, /businessReviewSections\(currentUser\(\)\)/);
  for (const renderer of ['creditApprovalCards', 'repaymentReviewCards', 'roundingReviewCards', 'giftRequestCards', 'roomIssueReviewCards', 'inventoryReviewCards', 'incidentResolutionReviewCards', 'expenseReviewCards']) assert.match(taskPage, new RegExp(renderer));

  assert.match(systemPage, /permissionCards\(\)/);
  assert.doesNotMatch(systemPage, /creditCards|ReviewCards|giftRequestCards|roomIssueReviewCards|stockNotices|handoverHistory|reportPage|staffRecordingPanel/);
  // Phase 8 死代码清理：stockNotices／handoverHistory 已从 ui/pages/admin.js 全文删除
  assert.doesNotMatch(adminSrc, /function stockNotices|function handoverHistory/);
  assert.match(sources, /if\(a==='goReviewTasks'\)[\s\S]*?(?:ctx\.)?page='tasks'/);
  assert.doesNotMatch(sources, /goRoomIssueReviews|window\.location\.assign\('\/admin'\)/);
});

// ── Phase 7 前测：UI 页面化拆分前冻结入口路由、事件分发与交互文案 ──
// 以下断言冻结 HEAD（a0c0d1a）行为；拆分后同样必须通过（标识符仅允许 ctx.* 机械转换）。

test('Phase 7 前测：路由分发与入口守卫冻结', () => {
  // 内容分发链完整（rooms→retail→deposits→tasks→manage→expenses→procurement→incidents→report→mine）
  assert.match(sources, /(?:ctx\.)?page==='rooms'\?roomsPage\(\):(?:ctx\.)?page==='retail'\?retailPage\(\):(?:ctx\.)?page==='deposits'\?depositPage\(\):(?:ctx\.)?page==='tasks'\?taskCenterPage\(\):(?:ctx\.)?page==='manage'\?systemManagementPage\(\):(?:ctx\.)?page==='expenses'\?expensesPage\(\):(?:ctx\.)?page==='procurement'\?procurementPage\(\):(?:ctx\.)?page==='incidents'\?incidentPage\(\):(?:ctx\.)?page==='report'\?reportPage\(\):minePage\(\)/);
  // 入口守卫：admin 只停在 manage；staff 不得进入 manage
  assert.match(sources, /if \((?:ctx\.)?APP_ENTRY === 'admin' && !adminPages\.includes\((?:ctx\.)?page\)\) (?:ctx\.)?page = 'manage'/);
  assert.match(sources, /if \((?:ctx\.)?APP_ENTRY === 'staff' && (?:ctx\.)?page === 'manage'\) (?:ctx\.)?page = 'rooms'/);
  // admin 无权限时的拒绝面板
  assert.match(sources, /当前身份不能进入系统后台/);
  assert.match(sources, /<a class="entry-link primary" href="\/">返回员工系统<\/a>/);
  // 员工端主导航按权限显示（零售、报表），admin 只有系统
  assert.match(sources, /\.\.\.\(allowedPermission\('retail\.sale'\)\?\[\['retail','▣','零售'\]\]:\[\]\),\['deposits','▤','存取酒'\],\['tasks','✓','待办'\],\.\.\.\(allowedPermission\('report\.view'\)\?\[\['report','▤','报表'\]\]:\[\]\),\['mine','○','我的'\]\]/);
  // 顶栏连接条与离线提示
  assert.match(sources, /\$\{(?:ctx\.)?APP_ENTRY==='admin'\?'系统管理演示':'本机练习'\}/);
  assert.match(sources, /' · 当前设备离线'/);
  // 存储问题横幅
  assert.match(sources, /\$\{(?:ctx\.)?storageProblem\?`<p class="notice">\$\{(?:ctx\.)?storageProblem\}<\/p>`:''\}/);
  // 底部导航 aria 标签与选中态
  assert.match(sources, /aria-label="\$\{(?:ctx\.)?APP_ENTRY==='admin'\?'系统管理导航':'主导航'\}"/);
  assert.match(sources, /class="\$\{(?:ctx\.)?page===id\?'selected':''\}" \$\{(?:ctx\.)?page===id\?'aria-current="page"':''\}/);
});

test('Phase 7 前测：点击事件动作清单完整冻结', () => {
  const clickStart = sources.indexOf("document.addEventListener('click'");
  const submitStart = sources.indexOf("document.addEventListener('submit'");
  assert.ok(clickStart >= 0 && submitStart > clickStart, '点击与提交监听必须存在');
  const clickBody = sources.slice(clickStart, submitStart);
  const actions = new Set();
  for (const m of clickBody.matchAll(/a==='([a-zA-Z]+)'/g)) actions.add(m[1]);
  const expected = ['close','retryRecovery','toggleTheme','autoTheme','nav','home','goReviewTasks','expenses','procurement','incidents','backMine','addExpense','addProcurement','addIncident','approveExpense','rejectExpense','reviewRoomIssue','rejectRoomIssueDialog','filter','room','markRoomIssueMenu','requestRoomRecovery','open','openDirty','reserve','reserveFuture','cancelReservation','order','sale','startRetail','staffBooking','staffSale','otherCharge','gift','exchange','serveExtra','collect','checkout','credit','clearSignature','step','addInitialMix','removeInitialMix','addSaleItem','removeSaleItem','addCatalogSaleOption','removeCatalogSaleOption','addPayment','removePayment','addDepositItem','removeDepositItem','identity','clock','deposit','withdraw','editPermissions','editCatalogProduct','createCatalogProduct','editCatalogPackage','resolveIncident','reviewIncidentResolution','rejectIncidentResolutionDialog','approveGift','rejectGift','reviewRounding','rejectRoundingDialog','review','reject','repay','reviewRepayment','rejectRepaymentDialog','inventory','stock','consumableStock','reviewInventory','rejectInventoryDialog','handover','guide','reset'];
  assert.deepEqual([...actions].sort(), [...expected].sort(), '点击动作集合必须逐项一致');
});

test('Phase 7 前测：提交事件数据整形与防重入冻结', () => {
  const submitStart = sources.indexOf("document.addEventListener('submit'");
  const windowStart = sources.indexOf('window.addEventListener', submitStart);
  const submitBody = sources.slice(submitStart, windowStart);
  // 防重入：busy 守卫 + 提交按钮禁用 + finally 恢复
  assert.match(submitBody, /if\(!f\.dataset\.form\|\|(?:ctx\.)?busy\)return;/);
  assert.match(submitBody, /(?:ctx\.)?busy=true;const submit=f\.querySelector\('\[type=submit\]'\);if\(submit\)submit\.disabled=true;/);
  assert.match(submitBody, /finally\{(?:ctx\.)?busy=false;if\(submit\)submit\.disabled=false;\}/);
  assert.match(submitBody, /if\(message && f\.isConnected\)message\.textContent=error\.message/);
  // 搜索表单分支
  assert.match(submitBody, /if\(f\.id==='search'\)\{(?:ctx\.)?searchTerm=String\(new FormData\(f\)\.get\('query'\)\|\|''\)\.trim\(\);render\(\);return;\}/);
  // DEMO 三分支：identity / clock / reset
  assert.match(submitBody, /if\(a==='identity'\)\{persist\(\{\.\.\.(?:ctx\.)?state,user:d\.user\}\);(?:ctx\.)?page=(?:ctx\.)?DEFAULT_PAGE;(?:ctx\.)?modal\.close\(\);render\(\);\}/);
  assert.match(submitBody, /persist\(\{\.\.\.(?:ctx\.)?state,clock:new Date\(d\.clock\)\.toISOString\(\)\}\);(?:ctx\.)?modal\.close\(\);render\(\);\}/);
  assert.match(submitBody, /if\(!Number\.isFinite\(Date\.parse\(d\.clock\)\)\)throw Error\('请选择有效时间'\)/);
  assert.match(submitBody, /else if\(a==='reset'\)\{persist\(\{\.\.\.initialState\(\),user:'shaoBoss'\}\);(?:ctx\.)?page=(?:ctx\.)?DEFAULT_PAGE;(?:ctx\.)?filter='全部';(?:ctx\.)?searchTerm='';(?:ctx\.)?storageProblem='';(?:ctx\.)?modal\.close\(\);render\(\);toast\('已恢复，开始新一轮练习'\);\}/);
  // 数字字段整形
  assert.match(submitBody, /if\('count'in d\)d\.count=Number\(d\.count\);if\('opened'in d\)d\.opened=Number\(d\.opened\);if\('quantity'in d\)d\.quantity=Number\(d\.quantity\)/);
  assert.match(submitBody, /if\('halves'in d\)d\.halves=Number\(d\.halves\);if\('request'in d\)d\.request=Number\(d\.request\)/);
  // open：默认酒水、脏房确认、首次配酒数组
  assert.match(submitBody, /d\.beer=d\.beer\|\|'bw';d\.acceptDirty=d\.acceptDirty==='yes';/);
  assert.match(submitBody, /d\.initialMix=products\.map\(\(product,index\)=>\(\{product,count:Number\(counts\[index\]\)\}\)\)/);
  // reserve：dayChoice→dayOffset
  assert.match(submitBody, /if\(a==='reserve'\)d\.dayOffset=Number\(d\.dayChoice==='custom'\?d\.customDays:d\.dayChoice\)/);
  // sale/retailSale：items 数组
  assert.match(submitBody, /d\.items=products\.map\(\(product,index\)=>\(\{product,spec:specs\[index\],count:Number\(counts\[index\]\)\}\)\)/);
  // 金额与付款数组
  assert.match(submitBody, /if\(a==='otherCharge'\)d\.amount=cents\(d\.amount\)/);
  assert.match(submitBody, /d\.payments=methods\.map\(\(method,index\)=>\(\{method,amount:cents\(amounts\[index\]\|\|'0'\)\}\)\)\.filter\(p=>p\.amount>0\)/);
  // 挂账签字画布
  assert.match(submitBody, /if\(!canvas\.dataset\.signed\)throw Error\('请由经办员工本人在框内手写签字'\);d\.signature=canvas\.toDataURL\('image\/png'\)/);
  // 回款 / 交班 / 支出凭证
  assert.match(submitBody, /if\(a==='repay'\)d\.amount=cents\(d\.amount\);if\(a==='handover'\)\{d\.actual=cents\(d\.actual\);d\.drawerCash=cents\(d\.drawerCash\);\}/);
  assert.match(submitBody, /if\(proofFile&&!proofInput\?\.value\)throw Error\('图片正在读取，请稍后再保存'\)/);
  assert.match(submitBody, /if\(proofFile&&!proofInput\?\.value\)throw Error\('现场照片正在读取，请稍后再提交'\)/);
  // 存酒：items + searchTerm 预填
  assert.match(submitBody, /d\.items=products\.map\(\(product,index\)=>\(\{product,count:Number\(counts\[index\]\)\}\)\);\n\s+(?:ctx\.)?searchTerm=String\(d\.phone\|\|d\.name\|\|''\)\.trim\(\)/);
  // 权限矩阵与目录维护
  assert.match(submitBody, /if\(a==='setPermissions'\) d\.permissions=new FormData\(f\)\.getAll\('permission'\)/);
  assert.match(submitBody, /d\.saleOptions=ids\.map\(\(id,index\)=>\(\{id,name:names\[index\],baseQuantity:Number\(quantities\[index\]\),priceCents:cents\(prices\[index\]\)\}\)\)/);
  assert.match(submitBody, /d\.saleOptions=saleOptions\(item\)\.map\(option=>\(\{\.\.\.option,priceCents:cents\(d\[`price_\$\{option\.id\}`\]\)\}\)\)/);
  // 幂等键 + 统一 commit
  assert.match(submitBody, /f\.dataset\.key \|\|= globalThis\.crypto\?\.randomUUID\?\.\(\) \|\| `op-\$\{Date\.now\(\)\}-\$\{Math\.random\(\)\}`/);
  assert.match(submitBody, /commit\(a,d,f\.dataset\.key\)/);
});

test('Phase 7 前测：change/window 监听与外观联动冻结', () => {
  const changeStart = sources.indexOf("document.addEventListener('change'");
  const changeBody = sources.slice(changeStart, sources.indexOf("document.addEventListener('click'", changeStart));
  assert.ok(changeStart >= 0, 'change 监听必须存在');
  assert.match(changeBody, /if\(e\.target\.id==='report-period'\)\{ (?:ctx\.)?reportPeriod=e\.target\.value; render\(\); window\.scrollTo\(0,0\); return; \}/);
  assert.match(changeBody, /if\(e\.target\.id==='appearance-preference'\)/);
  assert.match(changeBody, /const saved=window\.ktvAppearance\.setPreference\(e\.target\.value\)/);
  assert.match(changeBody, /if\(e\.target\.id==='permission-target'\)/);
  assert.match(changeBody, /if\(summary\) summary\.textContent=permissionSummary\(user\)\.join\('、'\) \|\| '当前没有可用操作'/);
  assert.match(changeBody, /if\(e\.target\.id==='expense-proof'\)/);
  assert.match(changeBody, /if\(e\.target\.id==='room-issue-photo'\)/);
  assert.match(changeBody, /toast\('图片需为有效图片且不超过 500KB'\)/);
  assert.match(changeBody, /toast\('图片读取失败，请重新选择'\)/);
  // window 监听：在线状态重渲染 + 跨标签页同步
  assert.match(sources, /window\.addEventListener\('online',\(\)=>\{if\(!FORMAL \|\| ctx\.formal\)render\(\);\}\);/);
  assert.match(sources, /window\.addEventListener\('offline',\(\)=>\{if\(!FORMAL \|\| ctx\.formal\)render\(\);\}\);/);
  assert.match(sources, /window\.addEventListener\('storage',e=>\{if\(!FORMAL && e\.key===DEMO_STATE_KEY\)/);
  assert.match(sources, /ctx\.state=ctx\.persistence\.loadExternal\(e\.newValue\)/);
  assert.match(sources, /ctx\.storageProblem=ctx\.persistence\.recoveryRecord\(\)\?\.problem\|\|''/);
  assert.match(sources, /ctx\.modal\.close\(\);render\(\)/);
  assert.match(sources, /window\.addEventListener\('appearancechange', syncAppearanceControls\)/);
});

test('Phase 7 前测：权限错误与提示文案冻结', () => {
  const messages = [
    '当前身份没有查看支出与报销的权限', '当前身份没有新增支出与报销的权限',
    '当前身份没有查看采购记录的权限', '当前身份没有新增采购的权限',
    '当前身份没有查看客诉与异常的权限', '当前身份没有登记客诉与异常的权限',
    '当前身份没有标记房间异常的权限', '当前身份没有提交恢复申请的权限',
    '当前身份没有房间恢复审核权限', '当前身份没有代员工登记的权限',
    '当前身份没有目录维护权限', '当前身份没有独立零售权限',
    '当前身份没有独立零售权限。', '当前身份只能查询存酒；登记和取酒需要服务员或老板权限。',
    '当前身份没有报表权限，请切换管理员或由管理员分配“查看经营报表”权限。',
    '当前身份没有系统管理后台权限，请切换管理员或由管理员分配“进入系统管理后台”权限。',
    '当前身份不能进入系统后台', '仅管理员可以调整身份权限',
    '审核本人申请需要“允许审核本人申请”权限', '已保存 · 仅为演示记录',
    '已恢复，开始新一轮练习', '另一标签页更新了演示，请重新操作',
    '请由经办员工本人在框内手写签字', '本单没有待收费用', '本单已经收清，无需挂账',
    '请先增购酒水，再登记赠送', '没有可换出的酒水，瓶装水不能继续换出',
    '当前没有可销售商品', '至少保留一种商品', '至少保留一种酒', '至少保留一笔付款',
    '至少保留一种销售规格', '至少保留一种酒水', '请先减少一种酒水的支数',
    '这条客诉／异常已经不存在', '当前没有营业中的账单', '当前没有可标记异常的房间',
    '该身份不能调整', '该商品不存在', '该消耗品不存在', '套餐不存在',
    '请选择有效时间', '请填写有效金额',
    '图片需为有效图片且不超过 500KB', '图片读取失败，请重新选择',
    '图片正在读取，请稍后再保存', '现场照片正在读取，请稍后再提交',
    '房间异常状态已经变化', '该房间恢复申请已经处理',
    '故障标记无需审核，只有恢复为空房需要审核', '这笔报销不在待审批状态',
    '赠酒水申请已处理', '这笔特殊差额已经处理', '这笔回款申请已经处理',
    '这项客诉／异常恢复申请已经处理', '这笔库存盘点已经处理',
    '全部欠款已有回款申请待审核', '本机记录需要核对',
    '当前没有可用操作', '需要服务员或老板取酒',
  ];
  for (const message of messages) assert.ok(sources.includes(message), `文案缺失：${message}`);
});

test('Phase 7 前测：DEMO 练习工具与对话框骨架冻结', () => {
  // 切换身份 / 练习时间 / 恢复数据 / 练习说明
  assert.match(sources, /openDialog\('切换演示身份'/);
  assert.match(sources, /'使用这个身份','identity'\)/);
  assert.match(sources, /仅用于体验权限，不是真实登录；岗位名称只作说明。/);
  assert.match(sources, /openDialog\('调整练习时间'/);
  assert.match(sources, /默认从当天20:00开始练习。改成18:00或02:00可以测试价格边界，不会改写已有订单。/);
  assert.match(sources, /openDialog\('恢复演示数据'/);
  assert.match(sources, /'确认清空，重新练习','reset'\)/);
  assert.match(sources, /openDialog\('跟着练一遍'/);
  assert.match(sources, /用邵老板身份点空房，选饮料并直接配好种类和支数，确认开房。/);
  assert.match(sources, /第一次练习可使用虚构手机号13800000000，不填写真实客人信息。/);
  // 员工补录入口
  assert.match(sources, /'登记员工订房　→','staffBooking','','secondary'\)/);
  assert.match(sources, /'登记员工增购酒水　→','staffSale','','secondary'\)/);
  // The formal staff mine page has no demo identity, clock, guide, or reset tools.
  assert.doesNotMatch(moduleOf('mine.js'), /'identity'|'clock'|'guide'|'reset'/);
  // 交班与取酒对话框
  assert.match(sources, /openDialog\('交班 · 核对收款'/);
  assert.match(sources, /'记录交班差异','handover'\)/);
  assert.match(sources, /挂账不算已收款。/);
  assert.match(sources, /openDialog\('核对并取酒'/);
  assert.match(sources, /'确认取酒','withdraw',\{id\}\)/);
  // openDialog 骨架与 toast 行为
  assert.match(sources, /<div class="dialog-demo">演示数据 · 不产生真实收款<\/div>/);
  assert.match(sources, /<form data-form="\$\{action \|\| ''\}">/);
  assert.match(sources, /<p class="form-error" role="alert"><\/p>/);
  assert.match(sources, /if \((?:ctx\.)?modal\.open\) (?:ctx\.)?modal\.close\(\);/);
  assert.match(sources, /const el = document\.querySelector\('#toast'\); el\.textContent = text; el\.classList\.add\('show'\); clearTimeout\(toast\.timer\); toast\.timer=setTimeout\(\(\)=>el\.classList\.remove\('show'\),4500\)/);
  // persist / commit 边界
  assert.match(sources, /if \(ctx\.formalEnabled\) throw new TypeError\('Server snapshot is read-only'\)/);
  assert.match(sources, /ctx\.persistence\.save\(next\)/);
  assert.match(sources, /await ctx\.formal\.flow\.submit\(action, data\)/);
  assert.match(sources, /const next = transact\(ctx\.state, action, data, key\)/);
  // 启动装配：持久化唯一入口
  assert.match(sources, /const persistence = FORMAL \? null : createDemoPersistence\(\{ storage: localStorage \}\)/);
  assert.match(sources, /const loaded = FORMAL \? \{ state: ctx\.state, problem: '' \} : persistence\.load\(\)/);
  assert.match(sources, /const app = document\.querySelector\('#app'\), modal = document\.querySelector\('#modal'\)/);
  // 主题偏好切换文案
  assert.match(sources, /已设为自动：日出至19:00日间，其余时间夜间/);
  assert.match(sources, /已手动切换\$\{preference==='dark'\?'夜间':'日间'\}模式/);
  assert.match(sources, / · 本次切换仅在当前页面有效/);
});

test('Phase 7 前测：页面与对话框函数清单冻结（拆分不丢函数）', () => {
  const functions = [
    // shell
    'render', 'persist', 'commit', 'toast', 'openDialog', 'syncAppearanceControls',
    // pages
    'reportPage', 'roomsPage', 'retailPage', 'depositPage', 'taskCenterPage',
    'systemManagementPage', 'expensesPage', 'procurementPage', 'incidentPage', 'minePage',
    'myReservationSection', 'staffRecordingPanel', 'permissionCards', 'catalogManagementPanel',
    'creditCards', 'creditApprovalCards', 'repaymentReviewCards', 'expenseReviewCards',
    'giftRequestCards', 'roundingReviewCards', 'inventoryReviewCards',
    'incidentResolutionReviewCards', 'roomIssueReviewCards', 'myTaskCards', 'reviewHistoryCards',
    'roomCard', 'reservationListMarkup',
    // dialogs
    'showRoom', 'openRoom', 'openBookingDialog', 'showOrder', 'giftDialog', 'saleDialog',
    'retailDialog', 'otherChargeDialog', 'exchangeDialog', 'collectDialog', 'checkout',
    'creditDialog', 'inventoryDialog', 'permissionsDialog', 'catalogCreateDialog',
    'catalogProductDialog', 'catalogPackageDialog', 'expenseDialog', 'procurementDialog',
    'incidentDialog', 'resolveIncidentDialog', 'staffBookingDialog', 'openDepositDialog',
    // forms
    'esc', 'btn', 'options', 'stepper', 'paymentFields', 'bindPaymentSummary',
    'bookingFields', 'setupBookingFields', 'initialMixRow', 'saleItemRow', 'bindSaleForm',
    'depositItemRow', 'catalogSaleOptionRow', 'saleCategories', 'saleProductLabel',
    'roomIssueEvidenceFields', 'roomIssueEvidenceMarkup',
    // context helpers
    'product', 'currentUser', 'allowed', 'allowedPermission', 'canReviewSubmission',
    'reviewPermissionHint', 'portalBackButton', 'openingGiftChoices', 'depositChoices',
    'initialMixChoices', 'roomOptions', 'employeeOptions', 'pendingReservations',
    'pendingRoomIssueReview', 'reservationSessionName', 'displayRoomStatus', 'roomMatchesFilter',
    'contactText', 'permissionSummary',
  ];
  for (const name of functions) assert.ok(new RegExp(`function ${name}\\(|const ${name} *=`).test(sources), `函数缺失：${name}`);
});
