# 当前阶段

更新日期：2026-09-28。本文件是当前进度的唯一汇总入口。

## 分阶段重构进度（codex/core-refactor 分支）

按审计报告蓝图执行，每阶段独立可回退检查点，不混入业务修复：

| 阶段 | 内容 | 日期 | 证据 | 检查点 |
|---|---|---|---|---|
| Phase 0 | 行为冻结：新增 27 项 characterization 与缺陷重现证据测试（73→100） | 2026-09-28 | `npm test`（`NODE_OPTIONS=--test-isolation=none`）100/100；Bug #1-#8 均有证据（bugs-evidence*.test.js） | `e6d0fed` |
| Phase 1 | 单一 persistence/migration 边界：迁移链抽入 `migrations.js`，`persistence.js` 成为唯一读写账本 key 的模块；损坏数据先备份不覆盖 | 2026-09-28 | 112/112；抽取前与 app.js 旧代码字节级等价比对通过；浏览器验证开房→重载保留、损坏→备份不覆盖 | `1e6de59` |
| Phase 2 | 共同基础：金额／时段／身份与权限选择器抽入 `shared/money.js`、`shared/time.js`、`shared/identity.js`；`rules.js` 改为 re-export facade，取整、日期、默认岗位、`backend.view`／`review.self` 语义未变 | 2026-09-28 | 前测（金额＋全身份×39权限矩阵，13 项）先冻结 rules.js 行为；后测改测 shared/* 并断言 facade 同绑定；127/127；shared 三模块与 HEAD rules.js 字节级等价比对通过；浏览器抽样权限可见性（邵老板全入口、美娇无零售/报表/后台、卓老板恢复、美娇访问 /admin 被拒） | `9290110`／`a73ed36` |
| Phase 3 | 目录／库存拆分：房间套餐构造唯一来源迁入 `packages.js`（`DEFAULT_PACKAGES`），库存记账／盘点／审核唯一 owner 迁入 `inventory.js`（`need`、`recordInventoryChange`、`submitStock`、`submitConsumableStock`、`decideInventory`），`product` 查询包装迁入 `catalog.js`，`migrateLegacyOrderPricing` 迁入 `migrations.js`（目录不再迁移订单）；`rules.js` 的 transact 库存分支改为委托，既有导入路径经 facade 保持兼容；另修复 Phase 1 遗留的 app.js 导入缺失回归（`inventoryProducts`／`consumableProducts`，库存对话框报错） | 2026-09-28 | 前测 11 项冻结库存边界；后测新增 `inventory.test.js` 16 项（含增购+零售共管道）；迁移前后语句级等价比对通过；143/143；浏览器验证后台商品、期初建账→审核、开房赠饮、房间增购与独立零售共管道 | `986e70a` |
| Phase 4 | 销售领域拆分：成交管道（`prepareSaleRows`／`appendSaleRows`）、付款校验（`validatePayments`／`validateSettlementPayments`）、金额查询（`total`／`outstanding`／`collectableCharges`／`nextCollectCharge`）与命令（`submitSale`／`submitRetailSale`／`collectPayment`／`settleOrder`／`payOrder`／`decideRounding`／`applyCredit`／`decideCredit`／`submitRepay`／`decideRepayment`）迁入 `sales.js`；`rules.js` 的 transact 对应分支改为委托；房间释放 `release` 保留在 rules.js（Phase 5 房间域），命令返回值协调 | 2026-09-28 | 前测 `sales.test.js` 6 项金额矩阵冻结行为；后测补 facade 同绑定+共管道断言；12 基础函数字节级等价；151/151；浏览器验证开房增购半打、分次收款 ¥20+¥39、结账免零 ¥1、独立零售 ¥30 | `3ac66dd` |
| Phase 5 | 房间／运营领域拆分：房间域（`quote`／`canExchange`／预约查询与 `openRoom`／`reserveRoom`／`cancelReservation`／`cleanRoom`／`markRoomIssue`／`clearRoomIssue`／`decideRoomIssue`／`release`）迁入 `rooms.js`；存取酒迁入 `deposits.js`；费用／采购／客诉／交班迁入 `expenses.js`／`procurement.js`／`incidents.js`／`handover.js`；`collected` 实收选择器迁入 `sales.js`；审核中心待办投影（`pendingBusinessReviewCount`／`reviewHistoryRows`）迁入 `reviewInbox.js`（只读不决定业务状态）；`rules.js` 544→288 行，仅余身份／目录命令与订单内联分支；已知 bug #5（采购状态不同步）保持原状并单独标注 | 2026-09-28 | 前测 `rooms.test.js`＋`operations.test.js` 12 项冻结审批／房态／挂账／存取酒行为；后测补 facade 同绑定、reviewInbox 纯投影断言、跨域原子性与领域命令直连；纯函数与命令体字节级／语句级等价比对通过；169/169；浏览器验证房间恢复审核、挂账全链路（申请→店长审批→已挂账）、存取酒（存 6 支→尾号核对取 1→剩 5） | `4a80fb3` |
| Phase 6 | 报表域拆分：报表 selectors 与 view models（`reportMoney`／`reportQuantity`／`reportDateKey`／`reservationDate`／`reportPeriodMatch`／`reportOrder`／`reportGiftAmount`／`reportGiftDetails`／`reportSaleDetails`／`reportOtherDetails`／`reportBreakdown`／`reportTotals`／`reportGiftPerson`／`reportPaymentMethods`／`reportNotes` 及视图模型聚合 `reportViewModel`，含房间行 sales／other 汇总）自 `app.js` 迁入 `reporting.js`（纯 state 输入，不依赖 DOM）；`app.js` 916→828 行，报表页面仅做模板渲染；日/周/月、房间/零售、分类/人员/付款、快照与金额口径不变；Bug #7（聚合 credit 布尔）代码随迁保持原状 | 2026-09-28 | 前测 `reporting.test.js` 8 项冻结明细格式／备注矩阵／付款方式列／视图模型；后测断言 reporting.js 与冻结拷贝输出一致、纯投影不改变 state；17 项函数体与 HEAD app.js 逐字一致（仅闭包→参数转换）；181/181；浏览器验证日报/周报/月报数字、销售明细、免零、零售行、分类/人员 breakdown、无权限视图（导航无报表入口） | `a0c0d1a` |
| Phase 7 | UI 页面化：渲染与事件处理自 `app.js` 拆入 `ui/` 19 个 ESM 模块——`ui/context.js`（`ctx` 单例与 33 个展示辅助）、`ui/shell.js`（`persist`／`toast`／`openDialog`／`commit`／`render`）、`ui/forms.js`（表单行构建）、`ui/pages/`（rooms／retail／deposits／tasks／admin／expenses／procurement／incidents／reports／mine 共 10 页）、`ui/dialogs/`（rooms／orders／retail／deposits／operations／admin 共 6 组）；`app.js` 828→285 行，仅余启动装配、入口路由与事件分发；页面可见性、错误文案、按钮操作与 DEMO 功能不变；审计 §15 提议的 `errors.js` 未建（错误文案留在分支内无复用需求），`retailDialog`／`staffBookingDialog` 同置 `ui/dialogs/retail.js`，`appearanceSettings` 置于 `ui/context.js` 避免循环导入 | 2026-09-28 | 前测 `entry.test.js` 重指向拼接源并新增 7 项冻结（路由分发、78 个点击动作、提交整形、监听与外观联动、错误文案、DEMO 工具与对话框骨架、页面/对话框函数清单）；抽取经字符串感知词法转换（仅代码态标识符改名，字符串/模板/注释不动），逆向转换后与 HEAD app.js 字节级等价；`bugs-evidence-app.test.js` 证据随迁指向新 owner 模块；188/188；浏览器验证员工端/后台、桌面/手机（390×844 底部导航）、明暗主题、开房/增购（含未建账拒售文案）/建账审核/结账全链路、身份切换与 /admin 三身份差异 | `48cd3ad` |
| Phase 8 | 旧 facade／兼容代码清理：删除 `rules.js` 全部 facade re-export（shared 基础、sales 查询、rooms 查询、catalog product、各域可见性选择器），调用方（app.js、migrations.js、ui/ 18 个模块、11 个测试文件）重指向 owner 模块；`rules.js` 288→270 行，仅导出 `OTHER_CHARGE_CATEGORIES`／`bonusAllowance`／`initialState`／`transact`（事务边界唯一职责）；删除死代码 `ui/pages/admin.js` 的 `stockNotices`／`handoverHistory`（从未被调用的死渲染）与 `ui/context.js` 的 `creditRoles`／`managementRoles`／`reportRoles`／`consumableOptions`（导出后无人导入）；`productSnapshot` 改为 rules.js 私有（另有 rooms.js／sales.js 同名私有副本，Phase 4 先例）；不新建业务模块，旧状态迁移与历史快照不变 | 2026-09-28 | 前测＝基线 188/188（含旧格式夹具迁移测试 persistence/migrations）+ 全仓引用搜索矩阵（每个待删符号确认零调用方）；后测：静态核查全部 rules.js 导入可解析、死符号零残留，facade 同绑定测试改写为反向断言（rules.js 导出面恰为 4 符号），188/188；浏览器验证 39 模块全部 200、六页导航、admin 页（死代码删除处）权限卡片、开房（quote→money→transact 全链路）与挂账（签字 canvas→审批中→房态待清洁）；验收后已恢复演示数据 | 本阶段 commit |
| Phase 9 | 终局回归：Git 差异审计（e6d0fed..HEAD 共 10 个提交均为授权重构，无未授权改动混入）；DoD §23 逐项核查通过；后测三组——A 完整自动套件 188/188＋浏览器级旧数据升级（v0 旧格式注入→迁移补齐 capabilitySchemaVersion/能力/快照，未知历史价保持 null，报表 legacy 渲染“历史未分类”，首次保存后写回）；B 资源服务 44 白名单资源全 200、非白名单与路径穿越 404；C 浏览器端到端 §20 全清单（V03 开房→未建账拒售→建账审核→增购→分次收款→结账→待清洁→清洁、独立零售、存取酒、挂账及回款、自审拦截×2、历史目录改价后报表不变、两入口、手机视口、明/自动主题、DEMO 时钟）；验收后已重置演示数据并关停本地服务 | 2026-09-28 | 见“有效证据”表 Phase 9 各行 | 本阶段 commit |

全部 9 个阶段已完成。2026-09-28 另立 bug 修复任务，已修复审计报告 §13 全部未修 Bug #1-#7、#9（#8 由 Phase 1 结构性解决），见下方独立任务表。

## 当前目标

### 已完成：审计报告 §13 业务 Bug 修复（独立于重构）

按用户「修复 bug，全部授权」指令另立任务，与重构提交严格分离。8 个修复点全部完成：

| Bug | 修复要点 | 证据 | 日期 |
|---|---|---|---|
| #1 挂账审批岗位穿透 | `sales.js` decideCredit 在权限校验后增加营业岗位硬限制（店长级可由店长或老板批，老板级仅老板；无对应岗位的身份如管理员被拒，文案「这笔挂账需要XX岗位审批」） | bugs-evidence.test.js 回归×2；浏览器：管理员批 ¥1668 老板级挂账被拒，卓老板批准成功，订单转「已挂账」 | 2026-09-28 |
| #2 套餐总价不校验 | `rules.js` updateCatalogPackage 增加 `priceCents === basePriceCents + includedValueCents` 校验；对话框总价改只读并随基础房费/赠饮参考值联动重算；app.js 提交前重算双保险 | bugs-evidence.test.js；浏览器：小房夜间套餐对话框改基础房费 60→总价自动 178，提交后持久化三元组一致，已恢复原值 | 2026-09-28 |
| #3 换酒不写名称快照 | `rules.js` exchange 换入行写入完整 productNameSnapshot/baseUnitSnapshot/snapshotStatus='current'；migrations.js 为旧 gift.drinks/sale.drinks 行补齐快照字段骨架（历史名保持 null 不读当前目录） | bugs-evidence.test.js；浏览器：V02 增购百威换喜力后账单显示「这笔增购实际领取喜力 1 支」，目录改名后展示不变 | 2026-09-28 |
| #4 历史销售行回退当前目录 | `sales.js` collectableCharges 改用 `productNameSnapshot || 历史商品（id）`，不再回退当前目录，商品移除不抛错 | bugs-evidence.test.js；自动测试覆盖（浏览器可选项未单独执行） | 2026-09-28 |
| #5 采购状态不同步 | `expenses.js` decideExpense 审批后将关联采购单从「报销待老板审批」同步为「已关联支出」或「报销已驳回」（含 decisionAt/decisionBy） | bugs-evidence.test.js + operations/characterization-core 断言更新；浏览器：老板娘登记报销采购 ¥600→卓老板批准→采购页徽标同步显示「已关联支出」 | 2026-09-28 |
| #6 存酒页改名后回退目录 | `ui/pages/deposits.js` 存酒卡改用 `productNameSnapshot`（app.js 取酒对话框同步） | bugs-evidence-app.test.js；浏览器：存酒时商品名「百威（验收改名）」，目录再改名后存酒卡仍显示登记时快照名 | 2026-09-28 |
| #7 日报备注布尔压缩挂账 | `reporting.js` reportNotes 日报分支改按 periodOrders 逐笔列出每笔挂账（含金额与回款状态）；reportOrder 聚合行删除 credit 布尔字段 | bugs-evidence-app.test.js + reporting.test.js 备注矩阵/同房多单回归 + characterization-report.test.js 冻结断言更新；浏览器：V01 挂账 ¥1668 日报备注列显示「挂账¥1668」 | 2026-09-28 |
| #9 种子消耗品行分类错位 | `database/seed.sql` 四行消耗品（瓜子/冰块/纸巾/吸管）补上缺失的 inventory_class 列值「消耗品」，使列数与 INSERT 列名行一致 | database.test.js 静态回归（逐行列数一致性 + 消耗品/套餐配品分类断言）；环境无 PostgreSQL，未执行真实导入 | 2026-09-28 |

全套 `npm test`（`NODE_OPTIONS=--test-isolation=none TZ=Asia/Shanghai`）190/190 通过（188 基线 + Bug#9 新增 1 项 + 备注矩阵新增 1 项）。浏览器验收后已恢复演示数据并关停本地服务。修复 commit 与重构 commit 分离。

### 后续目标

维持可操作的单机浏览器演示，在已统一的 `state.catalog` 上完成普通零售商品的创建、库存建账、房间增购、独立零售、成交快照和通用报表闭环。香烟属于普通商品分类，未添加任何未经确认价格的具体香烟主数据。

本阶段没有接入 PostgreSQL、生产依赖、正式班次或营业日模型，也没有迁移内部 `state.consumables`。运行时仍由本机浏览器 `localStorage` 保存演示状态。

## 当前实现范围

- 员工入口 `/` 保留房间、存取酒、待办、报表与“我的”，新增按 `retail.sale` 权限显示的独立零售入口；后台 `/admin` 按 `catalog.manage` 提供通用新增商品、已有商品当前价格和套餐维护。
- 统一 `orders` 中的 `kind: 'room' | 'retail'`；零售单 `room: null`，一次写入销售行、成交价和商品快照、付款、库存扣减、流水并立即完成。当前时间字段使用 `createdAt`、`paidAt`、`closedAt`，报表日期口径沿用原有订单时间。
- 房间增购和零售共用 `prepareSaleRows`／`appendSaleRows`，以 `saleOptions.baseQuantity` 扣基础单位库存；销售行记录 `employeeId`／`person` 和 `recordedBy`，库存流水关联订单与销售行。
- 新增库存管理商品时余额为 `count: null`，界面显示“未建账”；只有期初库存申请审核通过后可付费销售。确认库存为 0 与未建账分开，库存不足或付款错误时整笔零售不落账。
- 报表从销售行快照汇总房间与零售商品销售，独立列零售明细、分类与销售归属；已移除香烟分类专用统计分支。原有房间视图仍提供房费、套餐赠饮、其他消费、付款与备注。
- 原有房态、预订、赠酒、换酒、挂账、库存审核、内部消耗品、支出／采购、客诉和主题继续沿用原流程。旧订单迁移补 `kind: 'room'` 和 `createdAt`，历史价格无法可靠恢复时继续标为未知。

业务细节以 [REQUIREMENTS](./REQUIREMENTS.md) 为准，文件入口以 [MODULE_MAP](./MODULE_MAP.md) 为准。

## 有效证据

| 证据 | 日期 | 结论 | 状态 |
|---|---|---|---|
| Bug 修复全套自动测试 | 2026-09-28 | `npm test`（`NODE_OPTIONS=--test-isolation=none TZ=Asia/Shanghai`）190/190：Bug #1-#7、#9 各有回归断言（bugs-evidence.test.js / bugs-evidence-app.test.js / database.test.js / reporting.test.js / characterization-report.test.js）；受影响冻结断言同步更新（挂账层级、采购同步后状态、聚合 credit 字段删除） | 本次执行 |
| Bug 修复浏览器验收 | 2026-09-28 | 本地 Chromium `localhost:4321`：#1 管理员批老板级挂账 ¥1668 被拒（「这笔挂账需要老板岗位审批」）、卓老板批准→「已挂账」；#7 日报备注列「挂账¥1668」；#2 套餐对话框改基础房费 60→只读总价自动 178、提交持久化 base:6000/included:11800/price:16000 三元组一致；#6 存酒登记后目录两次改名、存酒卡仍显示登记时快照名；#3 V02 增购百威换喜力、账单显示「这笔增购实际领取喜力 1 支」、目录再改名后展示不变；#5 老板娘登记报销采购 ¥600→卓老板批准→采购页徽标「已关联支出」；#4/#9 由自动测试覆盖（#9 环境无 PostgreSQL 仅静态验证）；验收后已重置演示数据并关停服务 | 本次页面操作通过 |
| 针对性规则测试 | 2026-09-28 | `node --test --test-isolation=none catalog.test.js rules.test.js retail.test.js entry.test.js`：64/64 通过，覆盖统一订单、未建账、库存不足、付款失败原子性、整打 12 支、人员与历史价格快照 | 本次执行 |
| 完整自动测试 | 2026-09-28 | 重构 Phase 9 终局回归后 `npm test`（`NODE_OPTIONS=--test-isolation=none`）188/188 通过（含 Phase 0 新增 27 项、Phase 1 新增 11 项、Phase 2 新增 15 项、Phase 3 新增 16 项、Phase 4 新增 8 项、Phase 5 新增 18 项、Phase 6 新增 12 项、Phase 7 新增 7 项；Phase 8 改写 facade 同绑定断言为反向断言，总数不变） | 本次执行 |
| Phase 9 Git 差异审计 | 2026-09-28 | `git diff e6d0fed..74c3f55` 逐提交核对：10 个提交（Phase 0-8）均为授权重构内容，无未授权文件、无未跟踪用户文件（AI_IN_WORK.pptx、calendar-widget.html、codex-KTV.zip、nocode-*.png、审计报告.txt）混入；无 force push、无远端推送 | 本次执行 |
| Phase 9 DoD §23 核查 | 2026-09-28 | 逐项静态核查：app.js 仅启动装配与事件分发（285 行）且 rules.js 无 facade（导出面恰 4 符号）；领域模块唯一 owner、无巨型替身；UI 不直接读写营业 localStorage（持久化仅经 ui/shell.js→persistence.js）且报表不读当前价推算历史（快照口径）；迁移唯一入口 persistence.load 幂等、失败备份不覆盖；测试保护 73→188 且关键回归全通过；§20 行为冻结清单浏览器流程通过、已知 bug 证据测试未被改动；未来功能落点已在 MODULE_MAP 标注各 domain | 本次执行 |
| Phase 9 旧数据浏览器级迁移证明 | 2026-09-28 | 本地 Chromium 注入 v0 旧格式（version=1、缺 kind/快照/capabilitySchemaVersion）：重载后迁移链补齐 capabilitySchemaVersion=4、7 身份能力、订单 kind='room'、sale.snapshotStatus='legacy'，未知历史价保持 null（不用当前价填补）；报表渲染“历史未分类 · 历史商品（bw） × 1（规格未记录） ¥118”；首次保存触发后写回 localStorage 验证幂等 | 本次页面操作通过 |
| Phase 9 资源服务回归 | 2026-09-28 | server.js 白名单 44 个资源路径全部 HTTP 200（含全部 ui/ 模块）；非白名单路径（`/app.js.bak`、`/.git/config`）与路径穿越（`/../../etc/passwd`）均 404 | 本次执行 |
| Phase 9 浏览器端到端（§20 全清单） | 2026-09-28 | 本地 Chromium `localhost:4321`：V03 全生命周期（开房 ¥290→增购半打前未建账拒售（文案不变）→建账 100→审核通过→增购 ¥59→收款 ¥59→结账多笔付款 ¥100+¥68→房间转待清洁→清洁回空闲）；独立零售（room:null 立即完成）；存取酒（存 6→尾号搜索→取 2→剩 4）；挂账全链路（签字→待审批挂账→已挂账→回款 ¥100→审核通过→余 ¥68）；自审拦截两次（房间恢复与回款均报“允许审核本人申请”权限文案）；历史目录改价（百威半打 ¥59→¥88）后报表历史明细仍 ¥59、合计仍 ¥227；员工端与后台两入口；手机视口 390×844（底部导航 + 房卡可见）；明/自动主题切换；DEMO 时钟 15:00→白天场、20:00→夜间；验收后已恢复演示数据（订单/存酒清零、房间全空闲、库存回未建账） | 本次页面操作通过 |
| Phase 8 引用搜索与导入面冻结 | 2026-09-28 | 前测＝基线 188/188（含旧格式夹具迁移测试 persistence/migrations）＋全仓引用搜索矩阵：每个待删 re-export／死符号逐一确认零外部调用方（`PLATFORM_OPENING_SOURCES`、`platformVoucher`、`reservationTarget` 等仅 rules.js 自身 re-export 使用）；后测静态核查：全仓（生产＋测试）每个 `rules.js` 导入符号均能解析、rules.js 导出面恰为 4 符号、死符号零残留；`bugs-evidence-app.test.js` 的 Bug #6/#7 证据断言不受影响 | 本次执行 |
| Phase 8 浏览器验收 | 2026-09-28 | 本地 Chromium `localhost:4321`（39 个 js 模块全部 200 加载）：员工端六页导航（房间/待办/报表/零售/存取酒/我的）标题正常；后台页（死代码删除处）商品目录与权限卡片正常；开房 V02（quote→money 渲染 ¥168、transact 落单、房态营业中）；挂账全链路（签字 canvas（ctx2d 机械转换处）→待审批挂账→房态待清洁）；验收后已恢复演示数据 | 本次页面操作通过 |
| Phase 7 UI 等价性与冻结 | 2026-09-28 | 抽取前 `entry.test.js` 以宽容前缀正则冻结 HEAD app.js 行为（188/188）；抽取经字符串感知词法转换生成 19 个 `ui/` 模块，逆向转换后与 HEAD app.js 全部符号字节级一致；文档化机械转换：模块级可变状态→`ctx.*` 单例、creditDialog 局部画布 2d 上下文改名 `ctx2d`、`saleOptions` 导入自 `catalog.js`；`bugs-evidence-app.test.js` Bug #6 证据断言随迁指向 `ui/pages/deposits.js`，持久化断言指向 `ui/shell.js` 的 `ctx.persistence.save` | 本次执行 |
| Phase 7 浏览器验收 | 2026-09-28 | 本地 Chromium `localhost:4321`（39 个 js 模块全部 200 加载）：V01/V05 开房（确认开房 ¥168→房卡点亮）；待办 7 审核分区；报表 2 表；我的页全部 DEMO 工具；身份切换邵老板→美娇导航按权限收窄、美娇 /admin 拒绝页、邵老板 /admin 稀疏视图（与 HEAD 基线一致非回归）、管理员 /admin 25 面板＋权限矩阵对话框；明/自动主题切换（外观偏好 select→toast＋徽标）；手机视口 390×844 底部导航与 V05 开房；库存建账→待办审核批准→增购青岛（库存 100→99）→结账收款 ¥178（V05→待清洁、订单已结账）；未建账商品增购被规则拒绝且文案不变（“青岛未建账，完成库存期初建账后才能销售”） | 本次页面操作通过 |
| Phase 6 报表域等价性 | 2026-09-28 | 前测 8 项（销售明细格式、赠酒明细/赠送人、其他消费明细、备注矩阵、付款方式列、视图模型日报/含赠酒/周月报）先冻结 app.js 报表口径；抽取后 `reporting.js` 17 项函数体与 HEAD app.js 逐字一致（仅闭包→参数机械转换：`reportPeriodMatch(order,clock,period)`、`reportOrder(state,roomId,period)`、`reportNotes(order,period)`、视图模型参数化）；后测断言 reporting.js 输出与冻结拷贝完全一致、纯投影反复调用不改变 state；`bugs-evidence-app.test.js` Bug #7 证据断言随迁指向 reporting.js | 本次执行 |
| Phase 6 浏览器验收 | 2026-09-28 | 本地 Chromium `localhost:4321`（ESM 链 app.js→reporting.js 正常解析）：开房 333（¥290）→百威期初建账 100→增购半打 ¥59→其他消费小吃 ¥10→结账收 ¥358 免零 ¥1；日报数字逐项正确（房费 ¥54／赠饮 ¥236／销售 ¥59／其他 ¥10／免零 ¥1／合计 ¥359、备注“已结账”、明细“啤酒 · 百威 × 1（半打） ¥59”与“小吃 ¥10”）；周报/月报数字一致且备注列空；独立零售 D14 现金 ¥10 后日报合计 ¥369、零售行/分类/人员 breakdown 正确；切美娇导航无报表入口；验证后已清理测试数据 | 本次页面操作通过 |
| Phase 5 房间／运营域等价性 | 2026-09-28 | 前测 12 项（房态矩阵、恢复审核矩阵、预约矩阵、开房跨域原子性、赠酒／报销／客诉／挂账审批矩阵、存取酒核对、采购联动支出、交班口径）先冻结 rules.js 行为；抽取后 `rooms.js`／`deposits.js`／`expenses.js`／`procurement.js`／`incidents.js`／`handover.js` 的纯函数与 HEAD rules.js 对应定义除 export 前缀外字节级一致（命令体仅闭包→参数机械转换：`pendingRoomIssueReview(s,…)`、`roomIssueEvidence(data)`、`reviewHistoryRows(state,user)`）；`reviewInbox.js` 两投影与 HEAD app.js 对应函数体一致；后测断言 rules.js facade 同绑定、reviewInbox 纯投影不改变状态、领域命令可不经 transact 直连 | 本次执行 |
| Phase 5 浏览器验收 | 2026-09-28 | 本地 Chromium `localhost:4321`（ESM 链 rules.js→rooms.js／deposits.js／expenses.js 等正常解析）：存酒王生百威 6 支（尾号 1234 核对取 1→剩 5 支，不扣商品库存）；V01 标记故障立即生效→提交恢复申请→邵老板自审被拦→卓老板批准→房间回空闲且异常字段清空；开房 333（¥290）→卓老板申请挂账（店长审批人、房间转待清洁）→邵老板批准→已挂账；审核中心分区计数、审核记录投影正常；验证后已清理测试数据 | 本次页面操作通过 |
| Phase 4 销售域等价性 | 2026-09-28 | 前测 6 项（单支/半打/整打混买快照、分次收款、免零/特殊情况抹零、挂账回款、原子失败）先冻结 rules.js 行为；抽取后 `sales.js` 的 12 个基础函数（total/outstanding/collectableCharges/nextCollectCharge/prepareSaleRows/appendSaleRows/validatePayments/validateSettlementPayments/delegatedEmployee/phone）与 HEAD rules.js 对应定义除 export 前缀外字节级一致；命令函数全部语句在 HEAD 中逐字存在；`sales.test.js` 另断言 rules.js facade 是同一绑定、room/retail 销售行快照结构一致 | 本次执行 |
| Phase 4 浏览器验收 | 2026-09-28 | 本地 Chromium `localhost:4321`（ESM 链 rules.js→sales.js 正常解析）：百威期初建账 100→审核通过；开房 333（¥290，赠饮 -24）；房间增购半打（销售行 + 流水 -6“加购销售”，余 70）；分次收款两笔微信 ¥20+¥39 同组 sale:7；结账收 ¥289 免零 ¥1（rounding=100、roundingReview=null、房间转待清洁）；独立零售 3 支 ¥30 微信（kind:'retail'、已结账、流水 -3“零售销售”，余 67）；部分付款不足时 UI 提示“各项收款之和必须等于本次待收金额”且不落账；验证后已恢复演示数据 | 本次页面操作通过 |
| Phase 3 库存／目录等价性 | 2026-09-28 | 前测 11 项（目录基线 23 商品／8 套餐、未建账禁售、counted 语义、盘点审核）先冻结行为；抽取后 `packages.js`／`inventory.js` 与 HEAD rules.js／catalog.js 对应函数语句级等价比对（need／recordInventoryChange／decideInventory／submitStock／submitConsumableStock 均为 IDENTICAL）；`DEFAULT_PACKAGES` 与 `DEFAULT_CATALOG.packages` 断言一致 | 本次执行 |
| Phase 3 浏览器验收（含回归修复） | 2026-09-28 | 本地 Chromium `localhost:4321`：后台管理员可见商品创建与 8 个套餐名；库存对话框报 `inventoryProducts is not defined`（Phase 1 app.js 导入缺失回归）→ 修复后：邵老板提交百威期初建账 100 支（账面保持 null）→ 老板娘批准后 count=100、流水“期初建账” +100 counted:true → 开房 333（大房夜间 ¥290、赠饮 -24）→ 房间增购百威 2 支（销售行 + 流水 -2“加购销售”）→ 独立零售 3 支 ¥30 微信（kind:'retail'、room:null、已结账、流水 -3“零售销售”）→ 百威余 71 支；验证后已恢复演示数据 | 本次页面操作通过 |
| shared 基础等价性 | 2026-09-28 | 抽取前先以 rules.js 为源运行 13 项前测全部通过（行为冻结）；抽取后 `shared/money.js`、`shared/time.js`、`shared/identity.js` 与 HEAD rules.js 对应定义在结构快照、多组入参出参和函数源码行上字节级一致；`shared.test.js` 另断言 rules.js re-export 是同一绑定 | 本次执行 |
| 权限可见性浏览器抽样 | 2026-09-28 | 本地 Chromium `localhost:4321`（ESM 链 rules.js→shared/* 正常解析）：邵老板导航含零售/报表且头部有系统管理入口；切美娇（仅开单员）后零售/报表导航消失、无系统管理入口；切卓老板后恢复；美娇访问 `/admin` 显示“当前身份不能进入系统后台”拒绝页 | 本次页面操作通过 |
| 持久化迁移链等价性 | 2026-09-28 | `migrations.js` 抽取前与 `app.js` 旧实现（逐字拷贝至临时模块）在新鲜/营业中/旧格式三组夹具上 JSON 字节级一致；旧格式迁移幂等 | 本次执行 |
| 持久化浏览器验收 | 2026-09-28 | 本地 Chromium `localhost:4321`：UI 开房 V01 后 `jbhh-demo-v1` 写入订单且房态营业中；刷新重载后订单与房态保留；手工写入损坏 JSON 后重载，原 key 内容未变、`jbhh-demo-v1-recovery` 保存原文、页面提示新练习 | 本次页面操作通过；验证后已清理测试数据 |
| 真实浏览器验收 | 2026-09-28 | 在本地 Chromium 的 `127.0.0.1:4173` 演示来源：后台创建验收小吃（¥5／包），未建账零售被拒且保持 0 单；期初 10 包审核通过后独立零售 1 包现金 ¥5，333 房增购 1 包；库存余 8 包且两笔各有 -1 包流水；日报列房间 ¥295、零售 ¥5、全部账单 ¥300，分类 ¥10，销售归属分别 ¥5；之后将商品改名并把现价调至 ¥6，旧零售和房间明细仍显示原名称及 ¥5，新零售显示新名称及 ¥6，日报账单合计 ¥306 | 本次页面操作通过；这是演示状态，非真实收款 |
| 上一阶段目录与页面证据 | 2026-09-27 | 商品目录、价格快照及后台职责边界已验证；详见历史文档 | 历史证据，不冒充本次重跑 |
| 数据库契约 | 当前仓库 | `database/schema.sql`、`seed.sql` 和导入模板仍为设计基线 | 本阶段未修改或执行 PostgreSQL |

## 剩余限制

- 浏览器 `localStorage` 不是生产账本；没有业务 API、服务端事务、真实认证、并发控制、多设备同步、真实支付或正式审计。零售原子性仅在单浏览器完整状态写回边界内成立。
- 未实现退款、撤单、冲正、零售挂账、找零、完整 POS、会员、优惠券、并房、换房、拆账、跨店、企业微信、正式班次和营业日关账。
- 后台新增商品只覆盖销售闭环必需字段；未提供商品删除、供应商 SKU、条形码、品牌、已存在规格结构编辑或正式价格审批。没有预设具体香烟价格。
- 内部瓜子、冰块、纸巾、吸管仍用 `state.consumables`；正式统一物料模型需另立任务。
- 真实手机触控、系统大字体、输入法遮挡、弱网与断网恢复仍需现场验收。

## 其他既有缺口与待决定

- 实际金山营业报表尚未导入，只有暂存结构、模板与字段映射；没有持续集成、自动部署、监控、告警、PostgreSQL 集成测试或多设备并发测试。
- 后续正式化仍需决定部署环境、身份来源、支付／验券、通知、附件、备份和历史数据导入验收口径。

## 负责人和任务索引

- 当前没有正式总控、模块负责人或在途计划。
- 出现并行任务时，由唯一 [项目总控](./roles/PROJECT_CONTROLLER.md) 协调；需求和效果由 [模块负责人](./roles/MODULE_OWNER.md) 收口。
- 可使用 [任务启动模板](./roles/TASK_START_PROMPTS.md)，模板只引用权威文档，不复制规则。

## 下一步

普通商品闭环继续沿 `state.catalog`、`rules.js` 和 `app.js` 扩展；正式化先确定后端、认证、数据库 migration 与审计边界，不把浏览器状态直接当作生产账本。正式营业日和班次、内部物料统一分别作为独立任务设计。

## 阶段停止条件

出现以下任一情况时停止依赖该条件的操作并报告：

- 用户目标或权威需求存在冲突且无法从现有文档判定。
- 需要新增生产依赖、外部服务、真实凭据或不可逆数据操作但尚未授权。
- 共享文件、端口、数据库或设备的归属不明，继续会与在途任务冲突。
- 所需真实环境不可用，导致约定证据无法取得；工具失败本身不推断产品结果。

## 阶段提交条件

- 行为用例达到约定结果，相关代码、测试与文档保持一致。
- 按 [开发与验证环境](./DEVELOPMENT_ENVIRONMENT.md) 取得要求的证据，并区分未验证项。
- 盘点并解释全部未提交改动，确认不含凭据、运行数据和临时产物。
- 只有用户授权时才提交；推送、部署和发布分别取得相应授权。
