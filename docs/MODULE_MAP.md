# 最小代码阅读地图

本文件列当前集成候选的稳定入口、测试和改动边界。业务目标见 [REQUIREMENTS](./REQUIREMENTS.md) 与 [OFFSITE_CONTRACTS](./OFFSITE_CONTRACTS.md)；系统依赖见 [ARCHITECTURE](./ARCHITECTURE.md)。

| 改动目标 | 入口与稳定符号 | 主要测试 | 边界 |
|---|---|---|---|
| 员工及系统管理入口、静态资源 | `index.html`、`admin.html`；`server.js` 的 `files` | `entry.test.js` | 静态白名单须列出新增浏览器模块；无业务 API |
| 启动、事件分发与页面状态 | `app.js`；`ui/context.js` 的 `ctx`；`ui/shell.js` 的 `persist`／`commit`／`render` | `entry.test.js`、`bugs-evidence-app.test.js` | 保存成功后才切换页面状态；浏览器 UI 不决定最终权限 |
| 页面、表单与对话框 | `ui/pages/`、`ui/dialogs/`、`ui/forms.js` | `entry.test.js`、相关领域测试 | 新页面函数在所属模块，不再放入 `app.js` |
| 本机数据载入、停写与迁移 | `persistence.js` 的 `createDemoPersistence`／`recoveryRecord`／`isWriteBlocked`；`migrations.js` 的 `validateDemoState`／`migrateDemoState`；`ui/shell.js` 的 `recoveryPage` | `persistence.test.js`、`recovery.test.js`、`catalog.test.js`、浏览器夹具 `docs/verification/browser-recovery-harness.mjs` | 任一异常加载均保留主记录并停写；可解析历史只读查看，原文可复制；人工修正后显式重检；旧成交未知值不回填现价 |
| 原始快照只读预检 | `snapshot-preflight.js` 的 `preflightDemoSnapshot(raw)` | `snapshot-preflight.test.js` | Node 侧输入复制的 `jbhh-demo-v1` JSON 字符串，仅在深拷贝上调用现有迁移链；返回 UTF-8 原文 SHA-256、订单/付款/库存/房态摘要及 ambiguity/error，不接入 UI、localStorage 保存或正式账本写入；`ok` 只代表本预检范围未发现问题，不是导入批准 |
| P0-1 Stage 1A／1A.1／1A.2 账本协议 | `ledger/application.js` 的 `createLedgerApplication`；`ledger/memory-store.js` 的 `createMemoryLedgerStore` | `ledger/application.test.js` | `shared/business-error.js:BusinessRejection` 标记预期领域拒绝，未知异常回滚且不占键；可信注入的 `ledgerId`／`principal.id` 绑定终态回执；同键同 actor 同请求重试返回原结果，过期 revision 和领域拒绝占用原键；成功沿用 `rules.js:transact`；内存适配器仅作协议验证，不接 UI、localStorage、HTTP 或 PostgreSQL |
| 商品、套餐与价格一致性 | `catalog.js` 的 `mergeCatalog`／`assertCatalogPackagePrices`；`packages.js` 的 `DEFAULT_PACKAGES`；`rules.js` 的目录事务 | `catalog.test.js`、`bugs-evidence.test.js`、`offsite.contract.test.js` | 运行时当前目录只认 `state.catalog`；K02 不等式被拒 |
| 事务入口和跨域提交 | `rules.js` 的 `initialState`／`transact` | `rules.test.js`、`characterization-core.test.js` | 克隆、幂等键、校验及跨域原子提交；其他选择器从 owner 导入 |
| 销售、付款、挂账与回款 | `sales.js` 的 `total`／`outstanding`／`collected`、`prepareSaleRows`／`appendSaleRows`、`applyCredit`／`decideCredit` | `sales.test.js`、`retail.test.js`、`offsite.contract.test.js` | room 与 retail 共用订单；K03 岗位限制、自审授权、驳回历史 |
| 房间报价、预约与房态 | `rooms.js` 的 `quote`／`openRoom`／`release`／`decideRoomIssue` | `rooms.test.js`、`rules.test.js` | 报价拒绝不一致套餐；房单引用与房态协调 |
| 库存及期初、盘点审核 | `inventory.js` 的 `recordInventoryChange`／`submitStock`／`decideInventory` | `inventory.test.js`、`offsite.contract.test.js` | `count:null` 是未建账；失败不留部分订单或流水 |
| 身份、权限与金额基础 | `shared/identity.js` 的 `effectiveUser`／`hasPermission`／`businessReviewSections`；`shared/money.js`、`shared/time.js` | `shared.test.js`、`rules.test.js` | `backend.view` 不推导业务审核；`review.self` 是本人审核附加条件 |
| 支出报销与采购 | `expenses.js` 的 `submitExpense`／`decideExpense`；`procurement.js` 的 `submitProcurement` | `operations.test.js`、`offsite.contract.test.js` | 大额报销须老板岗位和本人审核校验；采购审批状态联动 |
| 存取酒、客诉、交班 | `deposits.js`、`incidents.js`、`handover.js` | `operations.test.js`、`bugs-evidence.test.js` | 存酒名称优先历史快照；交班尚未按班次归集 |
| 审核中心投影 | `reviewInbox.js` 的 `pendingBusinessReviewCount`／`reviewHistoryRows` | `operations.test.js`、`offsite.contract.test.js` | 只读投影；挂账驳回历史可查，游离旧单仍待处置 |
| 报表选择器与展示 | `reporting.js` 的 `reportViewModel`／`reportPeriodMatch`／`reportTotals`；`ui/pages/reports.js` 的 `reportPage` | `reporting.test.js`、`offsite.report.test.js` | Track B 直接调用新模块，不截取 `app.js` 源码；资金跨日归属仍是已知问题 |
| PostgreSQL 和历史导入 | `database/schema.sql`、`database/seed.sql`、`database/kdocs-import.md` | `database.test.js`、`offsite.contract.test.js` | SQL 只是设计基线；`room_orders.room_id` 仍不兼容无房零售 |
| 主题和视觉 | `theme.js`、`style.css` | `theme.test.js`；真实浏览器验收 | 视觉证据与 Node 规则测试分开 |

## 最短路线

1. 先从 [REQUIREMENTS](./REQUIREMENTS.md) 判定目标行为，并用 [KNOWN_ISSUES](./KNOWN_ISSUES.md) 区分错误复现。
2. 按表进入对应领域模块及测试；跨域动作再读 `rules.js` 的分支和保存边界。
3. 仅在输入、展示或权限可见性变化时进入 `ui/`；报表计算先读 `reporting.js`。
4. 修改 JavaScript 后按 [开发与验证环境](./DEVELOPMENT_ENVIRONMENT.md) 执行正式测试命令，无法运行时记录等价命令的实际证据。