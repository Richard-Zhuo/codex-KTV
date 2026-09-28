# 最小代码阅读地图

本文件回答“改某类内容时从哪里开始读”。符号名优先于行号；入口、测试路线或边界变化时同步更新。

| 改动目标 | 入口文件／稳定符号 | 相关测试 | 对应契约 | 关联边界 |
|---|---|---|---|---|
| 员工／系统管理入口和静态路由 | `index.html`、`admin.html` 的 `data-app-entry`；`server.js` 的静态 `files` 映射（含 `catalog.js`、`packages.js`、`inventory.js`、`sales.js`、`rooms.js`、`deposits.js`、`expenses.js`、`procurement.js`、`incidents.js`、`handover.js`、`reviewInbox.js`、`reporting.js`、`migrations.js`、`persistence.js` 及全部 19 个 `ui/` 模块路径） | `entry.test.js`、`bugs-evidence-app.test.js` | [需求：身份、入口与权限](./REQUIREMENTS.md#已确认身份入口与权限) | `/` 承载日常营业；`/admin` 只承载系统管理；服务器没有 API；新增 ui 模块时必须同步加入 `files` 映射否则浏览器模块加载 404 |
| 本机持久化与旧状态迁移 | `persistence.js`：`createDemoPersistence`、`DEMO_STATE_KEY`、`DEMO_BACKUP_KEY`；`migrations.js`：`validateDemoState`、`migrateStartupState`、`migrateDemoState`、`normalizeDemoUser`、`migrateLegacyOrderPricing` | `persistence.test.js`、`catalog.test.js`、`bugs-evidence-app.test.js` | [架构：数据流](./ARCHITECTURE.md#数据流与事务边界) | 唯一读写账本 key 的模块；载入失败先备份原文再进入新练习，不覆盖；未知历史价格保持 null；目录模块不迁移订单（Phase 3） |
| 商品目录与销售规格 | `catalog.js`：`DEFAULT_CATALOG`、`mergeCatalog`、`findProduct`、`product`、`saleOption`、`inventoryProducts`、`consumableProducts`；`packages.js`：`DEFAULT_PACKAGES`（房间套餐构造唯一来源，Phase 3） | `catalog.test.js`、`inventory.test.js` | [需求：商品、套餐与价格模型](./REQUIREMENTS.md#已确认商品套餐与价格模型) | `DEFAULT_CATALOG` 只用于初始化、迁移和 DEMO 恢复；运行时唯一来源是 `state.catalog`；不维护重复 `sku`；`product` 查询包装也在此（`rules.js` 为 facade re-export） |
| 库存记账、盘点与审核 | `inventory.js`：`need`、`pendingInventoryReview`、`recordInventoryChange`、`submitStock`、`submitConsumableStock`、`decideInventory`（Phase 3 起 `state.inventory`／`state.consumables`／`state.inventoryReviews` 与库存流水的唯一 owner） | `inventory.test.js`、`rules.test.js` | [需求：库存与盘点审核](./REQUIREMENTS.md) | 审核前不改账面；`counted` 区分建账前流水；未建账禁售；`decideInventory` 的自审校验由 `rules.js` 注入 `authorizeReviewer` 以避免循环依赖 |
| 页面导航、待办、零售、目录维护、报表与本机状态 | `app.js` 仅余启动装配、入口路由与事件分发；渲染与事件处理在 `ui/`：`ui/context.js`（`ctx` 单例与 `product`／`esc`／`btn`／`options` 等 33 个展示辅助，模块级可变状态一律 `ctx.*`）；`ui/shell.js`（`persist`／`toast`／`openDialog`／`commit`／`render`）；`ui/forms.js`（表单行构建）；`ui/pages/` 各页面模块（rooms／retail／deposits／tasks／admin／expenses／procurement／incidents／reports／mine）；`ui/dialogs/` 各对话框模块（rooms／orders／retail／deposits／operations／admin）；报表聚合在 `reporting.js` 不在 ui 层 | `entry.test.js`、`retail.test.js`、`characterization-report.test.js`、`characterization-core.test.js`、`bugs-evidence.test.js`；浏览器验收页面流程 | [架构：数据流](./ARCHITECTURE.md#数据流与事务边界) | 零售与房间商品选择共用表单；报表读取销售行快照，独立列零售明细；`ctx` 在 `app.js` 启动时注入真实 `state`／`persistence`／`modal`／`app`；pages 不 import shell（单向依赖），`appearanceSettings` 在 context 以避免循环 |
| 销售成交、收款与挂账回款 | `sales.js`：`total`／`outstanding`／`collectableCharges`／`nextCollectCharge` 金额查询，`collected` 实收选择器（Phase 5 自 `rules.js` 迁入），`prepareSaleRows`／`appendSaleRows` 成交管道，`submitSale`／`submitRetailSale`／`collectPayment`／`settleOrder`／`payOrder`／`decideRounding`／`applyCredit`／`decideCredit`／`submitRepay`／`decideRepayment` 命令（Phase 4 起销售域唯一 owner；`rules.js` 为 facade re-export，金额查询与 `PAYMENT_METHODS` 保持同绑定） | `sales.test.js`、`retail.test.js`、`characterization-core.test.js` | [需求：普通商品与独立零售](./REQUIREMENTS.md#已确认普通商品与独立零售) | 房间增购与独立零售共用同一成交规则与快照；多笔付款、抹零、失败不提交口径不变；结账／挂账后的房间释放经 `rooms.js` 的 `release` 协调（`transact` 在命令返回后调用） |
| 房间域：报价、预约、开房、清洁与异常审核 | `rooms.js`：`quote`／`canExchange`／`platformVoucher`／`reservationTarget`／`reservationReminder`／`reservationActiveAt` 查询，`openRoom`／`reserveRoom`／`cancelReservation`／`cleanRoom`／`markRoomIssue`／`clearRoomIssue`／`decideRoomIssue` 命令，`release`（结账／挂账后解绑房间；Phase 5 起房间域唯一 owner，`rules.js` 为 facade re-export） | `rooms.test.js`、`rules.test.js`、`characterization-core.test.js` | [需求：房态、预约与房间异常](./REQUIREMENTS.md) | 开房首次配酒与目录／库存跨域原子（失败全不提交）；恢复申请走 `roomIssueReviews` 审核链，自审拦截经注入的 `authorizeReviewer`；平台券开房记 `voucher` 待验券 |
| 存取酒 | `deposits.js`：`searchDeposits`（尾号／姓名检索），`submitDeposit`／`withdrawDeposit` 命令（Phase 5 起 `state.deposits`／`state.withdrawals` 唯一 owner） | `operations.test.js` | [需求：存取酒](./REQUIREMENTS.md) | 存酒不扣商品库存；取酒校验归属手机号尾号并受剩余支数限制；失败不提交 |
| 费用报销与采购 | `expenses.js`：`EXPENSE_TYPES`／`EXPENSE_NATURES`／`EXPENSE_APPROVAL_THRESHOLD`、`visibleExpenses`、`submitExpense`／`decideExpense`；`procurement.js`：`visibleProcurements`、`submitProcurement`（联动创建支出；Phase 5 起唯一 owner） | `operations.test.js` | [需求：费用与采购](./REQUIREMENTS.md) | 超阈值（¥500）报销／采购需老板审批；已知 bug #5（采购审核后采购状态不同步）保持原状，修复需另立任务 |
| 客诉与交班 | `incidents.js`：`INCIDENT_TYPES`、`visibleIncidents`、`pendingIncidentReminders`、`submitIncident`／`submitIncidentResolution`／`decideIncidentResolution`；`handover.js`：`submitHandover`（Phase 5 起唯一 owner） | `operations.test.js` | [需求：客诉与交班](./REQUIREMENTS.md) | 客诉恢复走审批链；交班实收口径来自 `sales.js` 的 `collected`；可见性按 `expense.viewAll`／`incident.viewAll` 等权限过滤 |
| 审核中心待办投影 | `reviewInbox.js`：`pendingBusinessReviewCount`（state, section）、`reviewHistoryRows`（state, user）（Phase 5 自 `app.js` 迁入，只读） | `operations.test.js` | [架构：数据流](./ARCHITECTURE.md#数据流与事务边界) | 审核中心不决定业务状态：所有审批决策仍走 `rules.js` 的 `transact` 委托的领域命令；`app.js` 同名函数仅转发 |
| 经营报表 selectors 与视图模型 | `reporting.js`：`reportViewModel`（state, period）及 `reportPeriodMatch`／`reportOrder`／`reportTotals`／`reportBreakdown`／`reportSaleDetails`／`reportGiftDetails`／`reportOtherDetails`／`reportPaymentMethods`／`reportNotes` 等纯投影（Phase 6 自 `app.js` 迁入；纯 state 输入，不依赖 DOM） | `reporting.test.js`、`characterization-report.test.js` | [需求：报表、主题与数据边界](./REQUIREMENTS.md#已确认报表主题与数据边界) | UI 无报表聚合：日/周/月（自然周周一起始）、房间按同房多单聚合、快照优先；Bug #7（聚合 credit 布尔）代码随迁保持原状，修复需另立任务 |
| 事务入口与剩余内联分支 | `rules.js`：`initialState`、`transact`（身份设置 `setPermissions`、目录命令 `createCatalogProduct`／`updateCatalogProduct`／`updateCatalogPackage`、订单内联分支 `sale`／`retailSale`／`collect`／`settle`／`pay`／`credit` 等及赠酒／换酒／其他消费；其余分支委托各领域模块） | `rules.test.js`、`retail.test.js` | [需求：普通商品与独立零售](./REQUIREMENTS.md#已确认普通商品与独立零售) | 金额用整数分；库存按基础单位；零售付款与订单、销售行、流水原子写入，失败不回写原状态；失败不提交由 `transact` 克隆-校验-提交边界保证 |
| 身份与具体权限 | `shared/identity.js`：`USERS`、`PERMISSION_DEFINITIONS`、`permissionsForRoles`、`defaultCapabilities`、`effectiveUser`、`hasPermission`、`businessReviewSections`（`rules.js` 目前作 facade re-export，Phase 8 再清理） | `rules.test.js`、`shared.test.js` | [需求：身份、入口与权限](./REQUIREMENTS.md#已确认身份入口与权限) | `backend.view` 不授予业务审核；`review.self` 只是自审附加条件 |
| 金额与营业时段基础 | `shared/money.js`：`money`、`cents`；`shared/time.js`：`slot`（`rules.js` facade re-export） | `shared.test.js`、`rules.test.js` | [架构：数据流](./ARCHITECTURE.md#数据流与事务边界) | 金额用整数分，取整规则与错误文案已冻结；时段边界 14-18／18-02 |
| 主题与自动切换 | `theme.js`：`refresh`、`window.ktvAppearance`；`style.css` 主题选择器 | `theme.test.js` | [需求：报表、主题与数据边界](./REQUIREMENTS.md#已确认报表主题与数据边界) | 使用设备时间和独立键 `jbhh-appearance-v1`，不跟随练习时间 |
| 房卡、表单、弹窗和报表视觉 | `style.css`；对应渲染在 `ui/pages/*`、`ui/dialogs/*` | 没有独立视觉自动测试；规则行为由现有测试覆盖 | [店员练习手册](../店员练习手册.md) | 视觉通过必须使用约定浏览器或真机证据，不能由规则测试替代 |
| PostgreSQL 关系模型 | `database/schema.sql`、`database/seed.sql` | `database.test.js` | [数据库说明](../database/README.md) | 当前页面未连接数据库；SQL 是未来后端契约基线 |
| 金山日报／支出导入 | `database/kdocs-import.md`、`database/templates/`、schema 中 `import_*` 表 | `database.test.js` | [导入映射](../database/kdocs-import.md) | 先暂存后校验；未知支付方式不猜测；未实际导入 |
| 运行和测试命令 | `package.json` 的 `scripts`；`server.js` 的 `PORT` | Node 内置测试发现全部 `*.test.js` | [开发与验证环境](./DEVELOPMENT_ENVIRONMENT.md) | 项目无正式构建、打包或生产产物 |
| 操作练习说明 | `店员练习手册.md` | 历史证据见 `docs/archive/` | [REQUIREMENTS](./REQUIREMENTS.md) | 手册只说明流程，不成为第二套需求 |

## 常见任务的最短阅读顺序

### 改身份或权限基础

1. 读需求中的身份与权限章节。
2. 进入 `shared/identity.js`（`USERS`、`PERMISSION_DEFINITIONS`、`effectiveUser` 等低层选择器）；`rules.js` 只是 facade，不在那里改定义。
3. 读 `shared.test.js` 的权限矩阵与 `rules.test.js` 对应行为的测试。
4. 入口和静态路由再读 `APP_ENTRY`、入口 HTML、`server.js` 与 `entry.test.js`。

### 改金额或时段基础

1. 金额读 `shared/money.js`（`money`、`cents`），时段读 `shared/time.js`（`slot`）；取整规则、错误文案和时段边界是冻结契约，变化需先更新 `shared.test.js` 与需求。
2. 业务侧消费方在 `rules.js` 事务分支与 `app.js` 展示层。

### 改业务规则

1. 在 `REQUIREMENTS.md` 找到已确认行为。
2. 商品、销售规格变化先读 `catalog.js` 和 `catalog.test.js`，房间套餐构造读 `packages.js`（`DEFAULT_PACKAGES`），确认运行时只从 `state.catalog` 读取。
3. 库存记账、盘点或审核读 `inventory.js` 和 `inventory.test.js`；`rules.js` 的 `transact` 分支只做委托。
4. 销售成交、收款、抹零、挂账回款读 `sales.js` 和 `sales.test.js`；房间增购与独立零售共用同一成交管道。
5. 房态、预约、开房、清洁、房间异常审核读 `rooms.js` 和 `rooms.test.js`；存取酒读 `deposits.js`；费用／采购／客诉／交班读 `expenses.js`／`procurement.js`／`incidents.js`／`handover.js`，测试在 `operations.test.js`；审核中心待办只读投影读 `reviewInbox.js`。
6. 报表口径、聚合或明细格式读 `reporting.js` 和 `reporting.test.js`（历史冻结参考在 `characterization-report.test.js`）。
7. 读 `rules.js` 中对应事务分支，确认仅是委托。
8. 读 `rules.test.js` 中同一行为的测试。
9. 只有界面输入或展示变化时：改页面读 `ui/pages/` 对应模块，改对话框读 `ui/dialogs/` 对应模块，改表单行／行内联动读 `ui/forms.js`，改 toast／弹窗骨架／提交后回执读 `ui/shell.js`，改展示辅助或 `ctx` 状态字段读 `ui/context.js`；`app.js` 只在启动装配或事件分发本身变化时才动。

### 改持久化或旧数据迁移

1. 先读 `persistence.js` 与 `persistence.test.js`，确认账本 key 只在此读写。
2. 旧字段补值或版本升级读 `migrations.js` 及其测试；未知历史价格必须保持 null。
3. 载入失败策略（备份、不覆盖）属于数据安全边界，改动需同步更新 `bugs-evidence-app.test.js` 的回归保护断言。

### 改入口或权限

1. 读需求中的身份与权限章节。
2. 读 `PERMISSION_DEFINITIONS`、`effectiveUser` 和 `transact` 的权限校验。
3. 读 `APP_ENTRY`、入口 HTML、`server.js` 与 `entry.test.js`。

### 改主题或视觉

1. 读需求中的主题边界。
2. 主题行为读 `theme.js` 与 `theme.test.js`；视觉再进入 `style.css`。
3. 按开发环境文档区分自动测试和真实视觉验收。

### 改数据库或导入

1. 先读 `database/README.md` 和 `database/kdocs-import.md`。
2. 再定位 `schema.sql`、`seed.sql` 与 `database.test.js`。
3. 不因 SQL 存在而假定浏览器运行时已经接入数据库。
