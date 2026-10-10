# S1：正式首装账本与期初库存

本文件说明首次安装的受控入口。当前 S1 只在隔离的 synthetic MySQL 环境执行；真人账号、真实库存、真实生产数据库和部署均未执行。生产操作仍须由负责人另行授权与验收。

## S1 CURRENT INITIALIZATION GRAPH

```text
官方 MySQL 001–011 migrations
  → 只建 schema；ledger_heads 为空
production/bootstrap-cli.js
  → 已批准身份计划 → auth/employee/production_bootstrap_events
  → 不创建业务账本
ledger/mysql-store.js
  → 缺 ledger_heads 时拒绝读写
production/readiness.js
  → LEDGER_NOT_INITIALIZED + INVENTORY_NOT_INITIALIZED
  → productionApiGate 拒绝正常 /api，device worker 不启动
production/first-install-cli.js --apply (ledger plan)
  → 核实 schema、MySQL server UUID、DB、store/ledger、身份与空业务表
  → 同一事务 INSERT ledger_heads + first-install-ledger 审计事件
production/first-install-cli.js --apply (stock/approve plans)
  → 正式账号密码登录 → 当前 session/权限重验
  → trusted stock/consumableStock → approveInventory
  → operationKey + expectedRevision + 正式库存审核/流水
  → 所有必需商品 count 从 null 经批准变成实际盘点值后，S1 blocker 消失
```

旧 Stage 5E 的 `rehearsal/prepare.js` 曾直接 `INSERT ledger_heads`。该写入只属于演练，不能作为生产初始化。S1 将演练入口改成上述正式模块；演练仍只使用 Fake 资源。

## 行为用例与停止点

| 用例 | 允许发起的条件 | 操作 | 成功证据 | 停止点 |
|---|---|---|---|---|
| 首次建账 | 001–011 完整、目标为空、身份 bootstrap 已批准，server UUID/DB/store/ledger/应用提交一致 | dry-run，人工核对确认串，再 apply ledger plan | 单个 ledger head，revision 0，同事务首装审计；原计划重放为 already_initialized | 目标、schema、身份、已有业务行或审计不一致即拒绝 |
| 期初盘点 | 已有正式首装账本；显式正式 principal 有 `inventory.opening`；盘点值经批准 | dry-run，apply stock plan | 审核申请及账本 operation；商品 `count` 仍为 `null` | 错商品、已建账余额、权限/版本冲突即拒绝 |
| 审批期初 | 申请仍待审核；另一个正式 principal 有 `inventory.approve`，本人审批另需 `review.self` | dry-run，apply approve plan | 正式审批、库存流水、实际余额、revision 与 audit 同事务 | 审核权限或申请事实不匹配即拒绝 |
| 部分完成 | 仍有任何必需库存 `count=null` | 继续对剩余商品提交独立计划 | 已批准事实保留，`INVENTORY_NOT_INITIALIZED` 仍存在 | 不自动回滚已批准盘点，不开启营业 |
| 失败恢复 | 记录原 `operationKey` 与 `expectedRevision` | 查询状态并以完全相同计划重放 | 只返回原终态，不重复计数/审批 | 结果不明时不得换 key 或改计划重提 |
| 并发首装 | 两个进程同一目标 | 同时 apply | 数据库级锁与单 head/audit；最多一次创建 | 第二个只可 already_initialized 或冲突 |

## 计划、秘密和命令

`production/first-install-cli.js` 只接受环境为 `production` 的计划和三项显式 production 环境标识。计划文件包含目标数据库名、MySQL server UUID、storeId、ledgerId、应用提交、动作种类；库存计划还须包含正式 principal ID、稳定 operationKey、expectedRevision、商品、实际数量和原因。审批计划包含待审申请 ID 和审核说明。数据库和登录秘密放在仓库外的受保护文件中，不能放在计划、命令参数、日志或 Git 中。

先用正式 runtime 配置文件和计划文件执行 `--dry-run`。输出列出目标主机/端口与 DB（不含凭据）、门店/账本、身份状态、当前 revision、仍为 `null` 的商品、计划动作、阻塞项及绑定 server UUID/DB/store/ledger/计划摘要的确认串。`--dry-run` 不登录、不写行。

`--apply` 必须重新提供完整确认串及操作人说明。ledger 计划建立账本；stock/approve 计划另需 `--actor-secrets-file`，由正式账号登录后执行可信业务命令。每次 apply 后重新 dry-run，取得下一条计划的 revision 和审核申请 ID。命令仅输出安全状态、revision、申请 ID 与剩余未建账商品，不输出数据库 URL、密码、session token 或供应商秘密。

同一 ledger 计划可无写入重放；不同账本、不同门店、不同数据库、不同计划摘要、旧业务记录或未受审核的 head 均拒绝。库存计划的同 key 不同内容由原账本指纹返回幂等冲突。提交回执丢失时先查询原 key，不自动换 key。

## 就绪与边界

无 head 时报告 `LEDGER_NOT_INITIALIZED`；任何必需商品 `count=null` 时报告 `INVENTORY_NOT_INITIALIZED`，同时保留逐商品 `OPENING_INVENTORY_REQUIRED`。正常业务 API、开房、零售、收款及设备 worker 在生产 readiness 未满足时保持阻断。CLI 是独立的服务端初始化能力，不开放匿名 HTTP 入口；完成后由既有生产启动门禁重新评估 readiness。

S1 只消除账本与期初库存 blocker。真实告警、备份、网络、部署、人员批准等其他门禁继续独立评估；不能以 `configured=true` 或 synthetic 结果宣称生产 GO。真实生产恢复到新数据库属于另行审核的恢复流程，不作为首次安装或重新建账。

## 审计与验证边界

首装审计在 `production_bootstrap_events` 记录来源、操作人说明、时间、server UUID、DB、store/ledger、schema migration、状态版本、初始 revision、应用提交与结果，并与 ledger head 同事务提交。期初库存使用正式 `ledger_operations`、`ledger_success_audit` 和库存审核/流水。没有新增生产依赖或迁移。

隔离验证使用临时 MySQL 8.4.11/InnoDB、官方 001–011、synthetic 身份及显式盘点，验证空库、重复、并发、错目标、已有业务行、权限、部分完成、重放和提交回执丢失。证据与未完成项见 [当前阶段](CURRENT_STAGE.md)。当前实施不创建真人 principal、不写真实生产 DB、不推送、不合并、不部署。

## 操作文件与命令格式

操作员先完成已批准的身份 bootstrap。运行本命令的账户使用已审阅的 Windows 服务账户和外部文件 ACL；--config-file、其中引用的 secretsFile 与 --actor-secrets-file 均应位于 Git 工作区外。CLI 校验其外部路径，文件 ACL 的现场复核仍是生产前置步骤。正式环境须设置 NODE_ENV=production、KTV_HTTP_ENV=production、KTV_DEPLOYMENT_ENV=production，并使用 Node 24.19.x。CLI 不从浏览器暴露初始化接口。

计划文件是 JSON。ledger 计划的必填字段为 version: 1、environment: "production"、database、serverUuid、storeId、ledgerId、applicationCommit、kind: "ledger"。stock 计划沿用同一目标字段，将 kind 改为 "stock"，并提供 operationKey、expectedRevision、actorPrincipalId、stockKind（drink/consumable）、productId、count（人工核对的整数）、reason；消耗品另需 opened。approve 计划沿用同一目标字段，将 kind 改为 "approve"，并提供独立 operationKey、expectedRevision、actorPrincipalId、前一步输出的 requestId 和 decisionNote。每一步使用新的操作标识；结果不明时保留原计划和原标识重试。actorPrincipalId 必须与外部凭据文件登录的正式账号一致。

命令顺序如下，路径均替换为现场已批准的绝对路径；确认串取自对应计划的 dry-run 输出：

```text
node production/first-install-cli.js --dry-run --plan ABSOLUTE_LEDGER_PLAN --config-file ABSOLUTE_CONFIG
node production/first-install-cli.js --apply --plan ABSOLUTE_LEDGER_PLAN --config-file ABSOLUTE_CONFIG --confirm-target DRY_RUN_CONFIRMATION --initiated-by APPROVED_OPERATOR_ID

node production/first-install-cli.js --dry-run --plan ABSOLUTE_STOCK_PLAN --config-file ABSOLUTE_CONFIG
node production/first-install-cli.js --apply --plan ABSOLUTE_STOCK_PLAN --config-file ABSOLUTE_CONFIG --actor-secrets-file ABSOLUTE_ACTOR_SECRETS --confirm-target DRY_RUN_CONFIRMATION --initiated-by APPROVED_OPERATOR_ID

node production/first-install-cli.js --dry-run --plan ABSOLUTE_APPROVAL_PLAN --config-file ABSOLUTE_CONFIG
node production/first-install-cli.js --apply --plan ABSOLUTE_APPROVAL_PLAN --config-file ABSOLUTE_CONFIG --actor-secrets-file ABSOLUTE_APPROVER_SECRETS --confirm-target DRY_RUN_CONFIRMATION --initiated-by APPROVED_OPERATOR_ID
```

正式 MySQL 凭据来自 runtime config 指向的外部 secrets 文件；库存账号凭据文件只包含 loginIdentifier、password。CLI 输出目标摘要、状态、revision、requestId 或剩余未盘点商品，不输出密码、连接 URL 或 session token。每个商品审核后重新核对 revision，再生成下一个计划。确认串绑定完整计划摘要、server UUID、数据库、store 和 ledger；计划改动后必须重新 dry-run 获取新串。运行前还须按 [生产切换计划](PRODUCTION_CUTOVER_PLAN.md) 核查真实备份、网络、权限和其他独立门槛。

## S1 高风险核对

| 风险 | 当前软件约束与本轮证据 |
|---|---|
| 重置已有营业数据 | 无删除或重置命令；已有 head 必须有同目标、同计划的 S1 receipt 才能只读重放；首次建账前扫描业务表，测试验证有业务记录时拒绝。 |
| 双账本权威与并发 | 目标绑定 server UUID、DB、store、ledger；数据库级命名锁与唯一约束保护建账事务；双并发测试仅产生一个 head 和一份 S1 audit。 |
| null 变成零与越权盘点 | 初始快照保持 null；库存只走正式账号登录与 trusted stock/consumableStock、approveInventory；无授权账号测试拒绝，未审批和部分盘点时 readiness 仍阻断。 |
| 绕过营业门槛 | 首装入口是服务端 CLI；普通 /api 和设备 worker 继续由 readiness gate 约束；无 head 或任一必管库存未初始化都会显示明确 blocker。 |
| 提交回执丢失和重复盘点 | head 与 receipt 同事务；库存使用现有 operationKey、expectedRevision 与终态指纹；针对建账、盘点、审核的提交后丢回执测试均以原计划重放，未重复入账。 |
| 错误目标与秘密泄露 | 错 DB/store/ledger/server UUID 拒绝；dry-run 测试确认零写入；CLI 输出检查未包含 DB 密码、账号密码或连接 URL。 |

该核对只覆盖本轮软件路径与隔离 MySQL 演练。真实服务账户 ACL、正式备份、监控告警、网络、人员授权和现场盘点值须在各自生产门槛中验证；本轮没有对真实生产库执行写入，也没有独立于本实现者的代码审核结论。
