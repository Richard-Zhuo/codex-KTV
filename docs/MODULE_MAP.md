# 最小代码阅读地图

本文件回答“改某类内容时从哪里开始读”。符号名优先于行号；入口、测试路线或边界变化时同步更新。

| 改动目标 | 入口文件／稳定符号 | 相关测试 | 对应契约 | 关联边界 |
|---|---|---|---|---|
| 员工／系统管理入口和静态路由 | `index.html`、`admin.html` 的 `data-app-entry`；`server.js` 的静态 `files` 映射（含 `catalog.js`、`packages.js`、`inventory.js`、`sales.js`、`migrations.js`、`persistence.js`） | `entry.test.js`、`bugs-evidence-app.test.js` | [需求：身份、入口与权限](./REQUIREMENTS.md#已确认身份入口与权限) | `/` 承载日常营业；`/admin` 只承载系统管理；服务器没有 API |
| 本机持久化与旧状态迁移 | `persistence.js`：`createDemoPersistence`、`DEMO_STATE_KEY`、`DEMO_BACKUP_KEY`；`migrations.js`：`validateDemoState`、`migrateStartupState`、`migrateDemoState`、`normalizeDemoUser`、`migrateLegacyOrderPricing` | `persistence.test.js`、`catalog.test.js`、`bugs-evidence-app.test.js` | [架构：数据流](./ARCHITECTURE.md#数据流与事务边界) | 唯一读写账本 key 的模块；载入失败先备份原文再进入新练习，不覆盖；未知历史价格保持 null；目录模块不迁移订单（Phase 3） |
| 商品目录与销售规格 | `catalog.js`：`DEFAULT_CATALOG`、`mergeCatalog`、`findProduct`、`product`、`saleOption`、`inventoryProducts`、`consumableProducts`；`packages.js`：`DEFAULT_PACKAGES`（房间套餐构造唯一来源，Phase 3） | `catalog.test.js`、`inventory.test.js` | [需求：商品、套餐与价格模型](./REQUIREMENTS.md#已确认商品套餐与价格模型) | `DEFAULT_CATALOG` 只用于初始化、迁移和 DEMO 恢复；运行时唯一来源是 `state.catalog`；不维护重复 `sku`；`product` 查询包装也在此（`rules.js` 为 facade re-export） |
| 库存记账、盘点与审核 | `inventory.js`：`need`、`pendingInventoryReview`、`recordInventoryChange`、`submitStock`、`submitConsumableStock`、`decideInventory`（Phase 3 起 `state.inventory`／`state.consumables`／`state.inventoryReviews` 与库存流水的唯一 owner） | `inventory.test.js`、`rules.test.js` | [需求：库存与盘点审核](./REQUIREMENTS.md) | 审核前不改账面；`counted` 区分建账前流水；未建账禁售；`decideInventory` 的自审校验由 `rules.js` 注入 `authorizeReviewer` 以避免循环依赖 |
| 页面导航、待办、零售、目录维护、报表与本机状态 | `app.js`：`render`、`retailPage`、`retailDialog`、`saleDialog`、`reportPage`、`catalogCreateDialog`、`persist`、`commit`（载入／保存仅经 `persistence.js` 装配） | `entry.test.js`、`retail.test.js`、`characterization-report.test.js`、`characterization-core.test.js`、`bugs-evidence.test.js`；浏览器验收页面流程 | [架构：数据流](./ARCHITECTURE.md#数据流与事务边界) | 零售与房间商品选择共用表单；报表读取销售行快照，独立列零售明细 |
| 销售成交、收款与挂账回款 | `sales.js`：`total`／`outstanding`／`collectableCharges`／`nextCollectCharge` 金额查询，`prepareSaleRows`／`appendSaleRows` 成交管道，`submitSale`／`submitRetailSale`／`collectPayment`／`settleOrder`／`payOrder`／`decideRounding`／`applyCredit`／`decideCredit`／`submitRepay`／`decideRepayment` 命令（Phase 4 起销售域唯一 owner；`rules.js` 为 facade re-export，金额查询与 `PAYMENT_METHODS` 保持同绑定） | `sales.test.js`、`retail.test.js`、`characterization-core.test.js` | [需求：普通商品与独立零售](./REQUIREMENTS.md#已确认普通商品与独立零售) | 房间增购与独立零售共用同一成交规则与快照；多笔付款、抹零、失败不提交口径不变；房间释放 `release` 仍在 `rules.js`（Phase 5 房间域） |
| 房型报价、普通商品、统一订单和销售事务 | `rules.js`：`initialState`、`quote`、`transact`（`createCatalogProduct`、`sale`、`retailSale`） | `rules.test.js`、`retail.test.js` | [需求：普通商品与独立零售](./REQUIREMENTS.md#已确认普通商品与独立零售) | 金额用整数分；库存按基础单位；零售付款与订单、销售行、流水原子写入，失败不回写原状态 |
| 身份与具体权限 | `shared/identity.js`：`USERS`、`PERMISSION_DEFINITIONS`、`permissionsForRoles`、`defaultCapabilities`、`effectiveUser`、`hasPermission`、`businessReviewSections`（`rules.js` 目前作 facade re-export，Phase 8 再清理） | `rules.test.js`、`shared.test.js` | [需求：身份、入口与权限](./REQUIREMENTS.md#已确认身份入口与权限) | `backend.view` 不授予业务审核；`review.self` 只是自审附加条件 |
| 金额与营业时段基础 | `shared/money.js`：`money`、`cents`；`shared/time.js`：`slot`（`rules.js` facade re-export） | `shared.test.js`、`rules.test.js` | [架构：数据流](./ARCHITECTURE.md#数据流与事务边界) | 金额用整数分，取整规则与错误文案已冻结；时段边界 14-18／18-02 |
| 主题与自动切换 | `theme.js`：`refresh`、`window.ktvAppearance`；`style.css` 主题选择器 | `theme.test.js` | [需求：报表、主题与数据边界](./REQUIREMENTS.md#已确认报表主题与数据边界) | 使用设备时间和独立键 `jbhh-appearance-v1`，不跟随练习时间 |
| 房卡、表单、弹窗和报表视觉 | `style.css`；对应 `app.js` 渲染函数 | 没有独立视觉自动测试；规则行为由现有测试覆盖 | [店员练习手册](../店员练习手册.md) | 视觉通过必须使用约定浏览器或真机证据，不能由规则测试替代 |
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
5. 读 `rules.js` 中对应事务分支和领域函数。
6. 读 `rules.test.js` 中同一行为的测试。
7. 只有界面输入或展示变化时再读 `app.js` 和 `style.css`。

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
