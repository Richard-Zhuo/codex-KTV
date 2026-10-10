## S1 first-install commands (2026-10-10)

The server-side entry is `node production/first-install-cli.js`. An approved plan and production runtime configuration are external files. Run `--dry-run --plan <absolute-plan> --config-file <absolute-config>` first; it makes zero writes and returns the target-bound confirmation string. Apply adds `--apply --confirm-target <exact-dry-run-string> --initiated-by <operator-record>`; stock/approve plans also add `--actor-secrets-file <absolute-protected-file>`. Set `NODE_ENV`, `KTV_HTTP_ENV` and `KTV_DEPLOYMENT_ENV` to `production` only for a separately authorized real operation. Do not place passwords or session tokens in arguments. This is a command contract, not current production execution authorization.

Focused isolated integration: set `STAGE5E_RUN=synthetic-only` and `S1_RUN=synthetic-only`, then run `node --test --test-isolation=none --test-reporter=tap production/first-install.integration.test.js`. Stage 5E compatibility uses the existing synthetic-only rehearsal test. For accepted-baseline-comparable full regression, set `STAGE5E_RUN=synthetic-only`, `S1_RUN=synthetic-only`, and `STAGE5E_TAP_LOG` to a new external `.tap` path, then run `node rehearsal/regression.js` from the repository root. This launcher creates an owned disposable MySQL 8.4.11/InnoDB fixture on port 33313 and spawns the exact command `node --test --test-isolation=none --test-reporter=tap` from that same root with `LEDGER_MYSQL_TEST_URL` and fixture identity; the S1 test creates its own serial fixture on port 33315. Check the TAP totals, exit code, and reported cleanup. A bare command without fixture environment skips gated suites and is not comparable. After any JavaScript edit also attempt `npm test`; the current host may lack npm, in which case record that evidence gap exactly. Current run results are in [CURRENT_STAGE](CURRENT_STAGE.md).

## Stage 5E isolated rehearsal

Stage 5E focused crash recovery: set STAGE5E_RUN=synthetic-only, then run node --test --test-isolation=none --test-reporter=tap rehearsal/crash-recovery.integration.test.js. The isolated fixture owns MySQL 8.4.11/InnoDB on 33315; repeat serially, never in parallel. Its injected clock crosses the persisted crashed-owner lease; the normal 20000 ms recovery wait remains unchanged. No certificate is installed by automated runs. [Evidence](verification/STAGE5E_CRASH_RECOVERY_FIX.md).

Windows / Node24.19.0 / MySQL8.4.11，显式 STAGE5E_RUN=synthetic-only；三个 environment selector 只允许未设置、test 或 development。rehearsal/fresh-environment.js 创建带唯一 ID 的新 temp datadir/server（33315），不读取生产 DB URL；完整旧 fixtures 使用另一个 owned33313实例。端口占用即拒绝，不接管现有实例。

- Focused: node --test --test-isolation=none --test-reporter=tap rehearsal/gates.test.js rehearsal/tooling.test.js rehearsal/browser-evidence.test.js ui/sale-attribution.test.js http/staff-query.test.js
- Real MySQL: 设置 STAGE5E_RUN=synthetic-only 后运行 node --test --test-isolation=none --test-reporter=tap rehearsal/integration.test.js。没有 opt-in 时此测试明确 skip，不虚构真实 DB PASS。
- Full isolated runner: 设置 STAGE5E_RUN=synthetic-only 及 STAGE5E_TAP_LOG=Git外新TAP文件，再运行 node rehearsal/regression.js；内部执行原命令 node --test --test-isolation=none --test-reporter=tap，结束清理两台 owned服务器。
- Browser: node rehearsal/run.js --browser-hold（同样 opt-in）；记录打印的 UID/origin/临时 CA 指纹，人工信任确切测试 CA 后使用 browser-skill/Edge，不 bypass TLS。支付确认遵守工具人工接管。完成浏览器、导出脱敏证据、退出owned session、删除并核对该 CA 后，向hold进程提交一行仅含 browser 的 JSON（status/各步骤值仅 PASS、FAIL、BLOCKED、NOT_RUN；recordId 为13位小写十六进制；不接受任意文本或秘密字段），再完成资源清理。不要手工删除不明目录，不杀共享 daemon。

CLI 不是生产部署命令；不安装生产服务、不更改公网网络、不连接真实 provider。实际 SCM 安装仍 BLOCKED；仅 process lifecycle 模拟。npm test 仍需尝试，缺少 npm 时明确报告，不能以历史测试数替代本轮结果。完整事实见 [演练证据](verification/STAGE5E_CUTOVER_REHEARSAL.md)。

## Stage 5D

Audit focused additionally includes operations/audit.test.js operations/audit.integration.test.js production/runtime.test.js. [Current audit evidence](STAGE5D_HIGH_RISK_AUDIT.md).

Focused: node --test --test-isolation=none --test-reporter=tap operations/lifecycle.test.js operations/runtime.test.js operations/drills.integration.test.js production/runtime.integration.test.js recovery/cli.test.js

Full: node --test --test-isolation=none --test-reporter=tap

Real MySQL fixtures require the explicitly owned LEDGER_MYSQL_TEST_URL and loopback33313 instance, serialize with the existing fixture lock, and reject operating databases. Runtime monitoring settings, timing and retention: [contract](STAGE5D_MONITORING_RUNBOOK.md). Backup/recovery protected operator config may specify operationalDirectory; reporting never authorizes a scheduled backup/restore. Preflight remains read-only. npm test was attempted; npm remains unavailable. No real alert/deployment/cutover.

## Stage 5C

Target Windows, pinned Node24.19.x, MySQL8.4/InnoDB. Production entry: node ABSOLUTE_APP/production/start.js --config-file ABSOLUTE_EXTERNAL_CONFIG with NODE_ENV=KTV_HTTP_ENV=KTV_DEPLOYMENT_ENV=production. Focused foundation: node --test --test-isolation=none --test-reporter=tap production/runtime.test.js server-static.test.js. No production start is authorized here; synthetic smoke only. [Contract](STAGE5C_DEPLOYMENT_RUNTIME.md).

## Stage 5B verification commands

Focused: node --test --test-isolation=none --test-reporter=tap backup/format.test.js backup/mysql-backup.integration.test.js recovery/gate.test.js recovery/drill.integration.test.js recovery/cli.test.js recovery/audit.integration.test.js

Full: node --test --test-isolation=none --test-reporter=tap

Both use an explicitly owned isolated MySQL test instance via LEDGER_MYSQL_TEST_URL; restore fixtures create only jbhh_ktv_restore_* databases. They serialize through the existing MySQL fixture lock and clean only their own resources. STAGE5B_DRILL_EVIDENCE optionally writes sanitized synthetic timing/count evidence to a Git-external path. npm test was attempted; npm is unavailable. Operator CLI acknowledgments/restart procedure: [contract](STAGE5B_BACKUP_RECOVERY.md).

## Stage 5B

Stage 5B operator commands and safety acknowledgments are in STAGE5B_BACKUP_RECOVERY.md. Focused backup tests use LEDGER_MYSQL_TEST_URL on the owned33313 instance and separate jbhh_ktv_restore_* targets; no production DB is exercised.

## Stage 5A controlled commands

Use node production/bootstrap-cli.js (default --dry-run; explicit --apply), node production/mapping-cli.js, node production/change-password-cli.js and node production/readiness-cli.js only with reviewed Git-external files and exact database/store/ledger confirmation. Full parameters and production-required environment settings: [Stage 5A](STAGE5A_PRODUCTION_BOOTSTRAP.md). Production startup validates configuration and remains API-unavailable until read-only readiness succeeds. Live-control true is refused in this stage. Focused: node --test --test-isolation=none --test-reporter=tap production/bootstrap.test.js production/readiness.test.js production/mysql-bootstrap.integration.test.js with the explicitly isolated LEDGER_MYSQL_TEST_URL. Full: node --test --test-isolation=none --test-reporter=tap. npm test remains required by AGENTS; attempt and report unavailable when absent. Production environment prohibits destructive fixtures even against a test URL. NODE_ENV, KTV_HTTP_ENV and KTV_DEPLOYMENT_ENV use a shared strict parser; noncanonical values and aliases are rejected before SQL or startup, not normalized to development.

## Stage 4C configuration and verification

DEVICE_CONTROL_MODE=disabled (default) preserves existing local business opening with explicit DISABLED device evidence. required needs migration 009 and manually verified enabled room_device_mappings. KTVSky productionEnabled remains false: neither mode nor KTVSKY_LIVE_CONTROL_ENABLED enables the employee runtime in this release. The real worker stays paused. Test composition may explicitly use devices/runtime.js with FakeGateway, testOnly=true and dedicated jbhh_ktv_test; never inject Fake through production environment fallback.

Backend focused: node --test --test-isolation=none --test-reporter=tap ledger/trusted-clean.integration.test.js devices/application.test.js devices/worker.test.js database.test.js. UI focused: node --test --test-isolation=none --test-reporter=tap ui/device-progress.test.js ui/command-flow.test.js ui/server-state.test.js ui/formal-workspace.test.js ui/formal-entry.test.js ui/room-card-accessibility.test.js server-static.test.js. Full: node --test --test-isolation=none --test-reporter=tap. npm test is attempted after JS changes; this machine still has no npm. Browser fixtures must stop and remove only their owned tables before full regression.


### Stage 4B.1 semantics regression

Focused command remains node --test --test-isolation=none --test-reporter=tap devices/application.test.js devices/ktvsky-gateway.test.js devices/ktvsky-validation.test.js. It covers synthetic legacy recovery, ACK waiting, simulated timeout/reset, concurrent claims and pre-ACK read fencing. Include ledger/trusted-sales.test.js in the focused run for the fixed-price SQL fixture regression (DAY/NIGHT/CLOSED); production price rules are unchanged. MySQL persistence cases remain in devices/mysql.integration.js under the guarded ledger/trusted-clean.integration.test.js harness. Full: node --test --test-isolation=none --test-reporter=tap.

No live validation command is run for this fix. The future 300-second plan and the offline recoverAcknowledgedClose application API are described in [the contract](STAGE4B_KTVSKY_ADAPTER.md); neither authorizes current device control. Keep original archives and the stable external journal intact; stale locks and UNKNOWN must not be manually cleared.

### Stage 4B adapter verification

Focused: node --test --test-isolation=none --test-reporter=tap devices/ktvsky-gateway.test.js devices/ktvsky-validation.test.js devices/application.test.js. Tests use an explicit loopback mock provider and synthetic credentials only; no real KTVSky account, mapping or device is required. Full regression continues to use the guarded disposable MySQL harness. Production provider requests require verified TLS and never follow redirects or retry automatically.

### Stage 4A device verification

Focused: node --test --test-isolation=none --test-reporter=tap devices/application.test.js shared/business-session.test.js catalog-pricing.test.js database.test.js ledger/trusted-sales.test.js ledger/trusted-open.test.js http/staff-query.test.js ui/session-pricing.test.js server-static.test.js. Real integration: ledger/trusted-clean.integration.test.js under the existing guarded MySQL fixture. The fixture now explicitly owns migration 008 room_control_workflows (sixteen InnoDB tables); it refuses a pre-existing device table, and removes only tables it created. Provider calls are fake, must use explicit allowTestGateway and testOnly mode, and never use real devices or credentials. Full command remains node --test --test-isolation=none --test-reporter=tap.

### K10 验证路线

node --test --test-isolation=none --test-reporter=tap database.test.js offsite.contract.test.js ledger/mysql-store.integration.test.js 验唯一 MySQL authority、legacy 禁用入口、真实 room/retail JSON 往返与重复 migration 策略。沿用专用 jbhh_ktv_test 的原三表 fixture、目标校验及 fixture 锁，不增加数据库权限或 cleanup 范围。完整结果见 CURRENT_STAGE。

### 平台券验证路线（R.1）

数据库无关契约：node --test --test-isolation=none vouchers/domain.test.js vouchers/gateways.test.js vouchers/application.test.js。open/binding：node --test --test-isolation=none ledger/trusted-open.test.js vouchers/binding.test.js。真实数据库仍用 LEDGER_MYSQL_TEST_URL，严格校验 URL 与实际 database=jbhh_ktv_test、版本及 InnoDB；绝不输出 URL／密码。

ledger/trusted-clean.integration.test.js 复用现有 fixture lock，新增明确的 voucher 四表和 migration 007。ledger/platform-voucher.integration.js 验 migration、provider 调用锁外取锁、重连、UNKNOWN、独立连接竞争、claim/evidence/event SQL 失败及消息去重。ledger/trusted-open.integration.js 在同一 guarded fixture 验同连接锁序、原子开房、双设备竞争、replay 与数据库故障。Stage 4A fixture 为固定十六表（含 migration 008）；ledger 三表依原授权预清理，其他表必须本轮明确创建才能清理，遇到已有未知数据拒绝。没有动态表名或全局数据库权限。

完整验证：node --test --test-isolation=none --test-reporter=tap。JavaScript 修改后仍先尝试 npm test；无 npm 时报告具体失败并执行本项目对应的 Node 测试。Fake 只接受显式 test mode，不使用真实券、门店或凭据；Meituan production redemption = NOT ENABLED。

# 开发与验证环境

本文件是项目命令、工具链、端口、数据位置和验证路线的唯一维护位置。命令状态分为：

- **配置确认**：本轮从实际配置或代码读取，未执行。
- **历史执行**：过去有记录，本轮没有重跑。
- **本次执行**：只有确实在当前任务运行后才能标记。

## 工具链

- Node.js，ES module 项目（`package.json` 的 `type` 为 `module`）。
- 原生 HTML、CSS、JavaScript；Stage 1B-MySQL 只有一个直接生产依赖 `mysql2`，没有框架构建步骤。
- 测试使用 Node 内置 `node:test`，由 `node --test` 自动发现测试文件。
- 新增依赖时优先使用 `pnpm`；新增生产依赖必须先取得用户确认。
- 当前仓库含 `pnpm-lock.yaml`；运行 MySQL 适配器及其测试需要先安装锁定依赖，静态演示本身未接账本。

## 命令

| 用途 | 命令 | 状态 | 说明 |
|---|---|---|---|
| 启动静态服务 | `npm start` | 配置确认 | `package.json` 映射到 `node server.js` |
| 直接启动 | `node server.js` | 配置确认 | 默认监听 `0.0.0.0:4173` |
| 使用其他端口（PowerShell） | `$env:PORT = 4174; npm start` | 配置确认 | `server.js` 读取 `PORT`，本轮未执行 |
| 完整自动测试 | `npm test` | 配置确认 | `package.json` 映射到 `node --test` |
| 2026-09-28 历史替代测试 | `$env:NODE_OPTIONS = '--test-isolation=none'; pnpm test` | 历史执行 | 历史记录为 73/73；不能当作本轮结果 |
| 本轮完整自动测试 | `node --test --test-isolation=none` | 本轮执行 | 2C.3 gift 提交／审批、库存申请与审核、房间恢复审批、换酒迁移与配品／其他消费、销售、员工名册／resolver、既有房间／目录／存取酒／预约 trusted 命令及 auth／revalidation、ledger 真实数据库回归的实际结果见 [阶段记录](./CURRENT_STAGE.md)；不沿用 Stage 2B 历史数量 |
| policy attributes 定向单元测试 | `node --test --test-isolation=none auth/policy-attributes.test.js auth/session-revalidation.test.js` | 本次执行 | 显式配置、空集合区分、独立 actor／target 审计、重复变更、rollback、数据库同源属性；真实 MySQL 用例由 auth fixture 承载 |
| 2C.1 定向单元测试 | `node --test --test-isolation=none auth/session-revalidation.test.js auth/auth.test.js ledger/command-policy.test.js ledger/mysql-store.test.js` | 本轮执行 | 同连接能力、可信 context、终态 replay 顺序和既有策略／适配器回归；不连接数据库 |
| 2C.2／2C.3 trusted 命令定向测试 | `node --test --test-isolation=none ledger/trusted-clean.test.js ledger/trusted-clean.integration.test.js` | 配置确认 | 单元与受保护 MySQL fixture；目录、取消预约、存取酒、预约、销售、配品／其他消费及换酒、房间恢复审批及库存申请／审核及 gift 提交／审批 helper 均保留，本轮分开执行的实际结果见 CURRENT_STAGE |
| 预约 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-reserve.test.js ledger/mysql-store.test.js ledger/trusted-clean.test.js rooms.test.js rules.test.js` | 本次执行 | 员工解析、授权／replay、冻结时间、连接绑定及原预约矩阵；结果见 CURRENT_STAGE，保留该集合原已知问题 skip |
| 销售 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-sales.test.js ledger/trusted-reserve.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js sales.test.js retail.test.js inventory.test.js` | 本次执行 | 当前 actor、员工、授权／replay、快照、基础数量、原付款与库存矩阵；结果见 CURRENT_STAGE，不连接数据库 |
| 配品／其他消费 trusted 定向单元 | `node --test --test-isolation=none ledger/trusted-order-additions.test.js auth/auth.test.js` | 本次执行 | session actor、具体权限、不占键／replay、原订单／套餐／库存事实，以及既有 order.serveExtra grant 保存／撤销格式回归；结果见 CURRENT_STAGE，不连接数据库 |
| 库存申请 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-stock.test.js ledger/trusted-clean.test.js inventory.test.js ledger/command-policy.test.js` | 本次执行 | 锁内 null／0 权限选择、可信申请人／DB 时间、不占键／撤权重放、原数量／待审核及 demo 对照；不连接数据库，实际结果见 CURRENT_STAGE |
| 库存审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-inventory-review.test.js ledger/trusted-stock.test.js ledger/trusted-clean.test.js inventory.test.js ledger/command-policy.test.js` | 本次执行 | 锁内本人身份、双权限、legacy／伪造拒绝、不占键与撤权重放，原 null／0／opened／基础单位／数量规则和 JSON-safe 快照；实际结果见 CURRENT_STAGE |
| gift trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-gift.test.js ledger/trusted-clean.test.js rules.test.js inventory.test.js sales.test.js ledger/command-policy.test.js` | 本次执行 | session 申请人／DB 时间、额度内／超额／混合、原数量／库存／快照与 demo 对照，不占键与重放；保留原 rules 测试的已知问题 skip，结果见 CURRENT_STAGE |
| expense trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-expense.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js operations.test.js` | 本次执行 | 当前 session 申请人／权限／DB 时间，原金额／日期／用途／凭证与审批状态，不占键／终态重放／认证失效；实际结果见 CURRENT_STAGE |
| credit trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-credit.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js sales.test.js operations.test.js offsite.contract.test.js characterization-core.test.js` | 本次执行 | session 申请人／冻结时间、余额与顾客输入、原 24 小时期限／路由／release、拒绝不占键与终态 replay；保留该集合原四项 Known Issues skip，实际结果见 CURRENT_STAGE |
| credit 决定 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-credit-review.test.js ledger/trusted-credit.test.js ledger/trusted-expense-review.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js auth/policy-attributes.test.js auth/session-revalidation.test.js sales.test.js operations.test.js offsite.contract.test.js characterization-core.test.js` | 本次执行 | 原批准／驳回分级、锁内稳定申请人／决定人、本人双权限、configured manager／boss、legacy／payload 拒绝、重放／冲突；真实 MySQL 由既有 guarded fixture 承载，006 repeat 与属性 audit rollback 在 auth fixture，实际结果见 CURRENT_STAGE |
| repay trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-repay.test.js sales.test.js operations.test.js` | 本次执行 | session 申请人／冻结时间、原待审余额与金额／方式校验、只创建申请不新增 payment、key 复用、重放／冲突与失败原子性；真实 MySQL helper 由既有 guarded fixture 承载，实际结果见 CURRENT_STAGE |
| K04 trusted 交班定向回归 | `node --test --test-isolation=none ledger/trusted-handover.test.js offsite.contract.test.js operations.test.js` | 本次执行 | bootstrap／实际现金基线、稳定付款 ID 边界、非现金及未证明支出排除、授权／重放／损坏边界；真实 MySQL helper 由原 guarded trusted fixture 承载，完整结果见 CURRENT_STAGE |
| K05 双口径定向回归 | `node --test --test-isolation=none shared/business-day.test.js reporting-ledger.test.js reporting.test.js offsite.report.test.js ledger/trusted-sales.test.js ledger/trusted-repayment-review.test.js` | 本次执行 | 可信订单日期冻结、独立资金筛选、未知历史、零售与回款字段；真实 MySQL 通过原 trusted fixture 执行 k05-reporting.integration.js |
| repayment 审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-repayment-review.test.js ledger/trusted-repay.test.js ledger/trusted-credit-review.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js sales.test.js operations.test.js` | 本次执行 | 本次申请人自审、legacy／伪造拒绝、一笔 payment 与余额原子性、驳回无资金、拒绝不占键、撤权重放和未知异常；真实 MySQL helper 使用既有 guarded fixture，实际结果见 CURRENT_STAGE |
| expense 审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-expense-review.test.js ledger/trusted-expense.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js auth/policy-attributes.test.js auth/session-revalidation.test.js operations.test.js` | 本次执行 | 锁内本人／金额阈值、当前 boss 属性、legacy／伪造拒绝、稳定决定 principal、不占键／撤权重放及原业务矩阵；真实 MySQL 用例由 trusted fixture 承载，005 repeat／属性 SQL 回滚由 auth fixture 承载，结果见 CURRENT_STAGE |
| gift 审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-gift-review.test.js ledger/trusted-gift.test.js ledger/trusted-clean.test.js rules.test.js inventory.test.js ledger/command-policy.test.js` | 本次执行 | 锁内稳定申请人、本人双权限、legacy／伪造拒绝、稳定决定 principal、不占键／撤权重放、原批准／驳回、数量／库存及 demo 对照；保留原 rules 平台券 skip，结果见 CURRENT_STAGE |
| 房间恢复审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-room-issue-review.test.js ledger/trusted-clean.test.js rooms.test.js rules.test.js ledger/command-policy.test.js` | 本次执行 | 锁内稳定申请人、本人双权限、legacy 拒绝不占键、决定 principal、原房态规则与 demo 对照；结果见 CURRENT_STAGE |
| 换酒 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-exchange.test.js ledger/trusted-clean.test.js rules.test.js inventory.test.js sales.test.js` | 本次执行 | 三类换酒来源、库存两步原子性、快照／金额、actor／权限／DB 时间、不占键／replay；结果见 CURRENT_STAGE，不连接数据库，保留该集合原平台券 skip |
| 存取酒单元与原领域回归 | `node --test --test-isolation=none ledger/trusted-clean.test.js operations.test.js` | 本次执行 | 新存取酒 trusted 契约与原业务矩阵；不连接数据库 |
| trusted 命令 MySQL 集成测试 | `node --test --test-isolation=none ledger/trusted-clean.integration.test.js` | 本次执行 | procurement 创建及关联 expense、incident 创建／处理／恢复审核、repay 申请／审批、credit 申请／决定、expense 申请／审批、gift 提交／审批、库存申请与审核、房间恢复 approve／reject、换酒、配品／其他消费、销售／预约及既有房间／目录／存取酒用例共用专用库 fixture；原十一张 fixture 表加 migration 007 的 voucher 四表，共十五张；拒绝预存 auth／employee／voucher 表，不操作其他表 |
| collect／pay trusted 定向回归 | `node --test --test-isolation=none ledger/trusted-payments.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js sales.test.js rules.test.js` | 本次执行 | 可信付款 ID／发生时间／操作者、原 charge／全额结账、拒绝不占键／撤权重放／回滚；真实 MySQL helper 复用原 guarded 十一表 fixture，结果见 CURRENT_STAGE |
| procurement trusted 定向回归 | `node --test --test-isolation=none ledger/trusted-procurement.test.js ledger/trusted-expense.test.js ledger/trusted-expense-review.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js operations.test.js` | 本次执行 | 采购与关联费用同一可信申请人、原业务规则、成对原子性、重试／竞争／回滚；MySQL helper 复用原 guarded 十一表 fixture，结果见 CURRENT_STAGE |
| incident resolution review trusted 定向回归 | `node --test --test-isolation=none ledger/trusted-incident-review.test.js ledger/trusted-incident-resolution.test.js ledger/trusted-incident.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js operations.test.js` | 本次执行 | 本次申请 principal 的本人审核、legacy 拒绝、原批准／驳回规则；真实数据库 helper 复用既有 trusted 十一表 fixture，证据见 CURRENT_STAGE |
| resolveIncident trusted 定向回归 | `node --test --test-isolation=none ledger/trusted-incident-resolution.test.js ledger/trusted-incident.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js operations.test.js` | 本次执行 | principal→employee 显式关联与锁定 assignee 匹配、可信请求字段；真实数据库附加在原 trusted 十一表 fixture，结果见 CURRENT_STAGE |
| incident trusted／员工／原领域回归 | `node --test --test-isolation=none ledger/trusted-incident.test.js ledger/trusted-reserve.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js operations.test.js` | 本次执行 | 负责人同事务解析与操作者独立；真实数据库附加在原 trusted 十一表 fixture；结果见 CURRENT_STAGE |
| 小额免零边界与原业务回归 | `node --test --test-isolation=none rounding-limit.test.js sales.test.js rules.test.js offsite.contract.test.js` | 本次执行 | 10 元包含边界；真实 MySQL 边界附加在原 ledger fixture，K01／K06 不扩修；结果见 CURRENT_STAGE |
| principal 员工解析定向回归 | `node --test --test-isolation=none employees/principal-employee-resolver.test.js employees/employee-resolver.test.js employees/mysql-store.test.js employees/roster.test.js employees/mysql-roster.integration.test.js` | 本次执行 | 新八项契约与真实 MySQL 十项附加在原 guarded roster fixture；不创建／删除 database，无关联／停用／同名、调用方事务及双连接锁序 |
| 员工名册定向单元测试 | `node --test --test-isolation=none employees/employee-resolver.test.js employees/mysql-store.test.js employees/roster.test.js` | 本次执行 | UUID、关联／停用／审计、事务内 resolver、connection 所有权和 rollback／提交结果不明；不连接数据库 |
| 员工名册 MySQL 集成测试 | `LEDGER_MYSQL_TEST_URL` 指向专用库后运行 `node --test --test-isolation=none employees/mysql-roster.integration.test.js` | 本次执行 | 仅本轮创建的八张 auth／employee 表（含 attributes）；原 migration／关联用例及 resolver 当前读取、调用方回滚、双连接停用锁竞争；未配置不得宣称通过 |
| MySQL 账本集成测试 | `LEDGER_MYSQL_TEST_URL` 明确指向 `jbhh_ktv_test` 后运行 `node --test --test-isolation=none ledger/mysql-store.integration.test.js` | 本次执行 | 本轮真实复验结果见 [CURRENT_STAGE](./CURRENT_STAGE.md)；仅清理该库三张已知账本表，不创建或删除数据库；未配置时跳过且不得当作集成通过 |
| MySQL 认证／重验集成测试 | `AUTH_MYSQL_TEST_URL` 或已确认的 `LEDGER_MYSQL_TEST_URL` 指向 `jbhh_ktv_test` 后运行 `node --test --test-isolation=none auth/mysql-auth.integration.test.js` | 本次执行 | 保留原 Stage 2B 16 项，并在同一 auth fixture 调用 2C.1 重验／锁竞争及 attributes 用例；本轮数据库证据见 CURRENT_STAGE。拒绝预存 auth 表，只删除本次创建的六张 auth 表（含 attributes），不动 ledger 表或数据库本身 |
| 隔离浏览器恢复演练 | `node docs/verification/browser-recovery-harness.mjs` | 历史执行 | 上轮仅绑定 `127.0.0.1` 的随机端口，使用合成已付款订单演练停写、复制、人工修正及显式重检；本轮未重跑，见 [浏览器记录](./verification/track-a-b-browser-recovery-2026-09-29.md) |
| 单文件语法诊断 | `node --check app.js` 等 | 历史使用／诊断 | 不能替代 `npm test` |
| 旧 PostgreSQL schema artifact | `database/schema.sql`（LEGACY） | 禁用执行入口 | 不用于初始化/迁移/部署当前 MySQL；当前 authority 见 database/README.md |
| 旧 PostgreSQL seed artifact | `database/seed.sql`（LEGACY） | 禁用执行入口 | 历史数据不构成真人账号/权限 seed |

独立 clean、原 auth、原 ledger 和 employee 集成 fixture 共用 `test-support/mysql-fixture-lock.js`，具名锁只串行建表／清理的 fixture 生命周期，不串行或替代生产命令的 InnoDB 行锁。各套 SQL 只作用于已约定的专用测试表，绝不创建或删除数据库。

修改 JavaScript 后，项目约定的正式自动验证命令是 `npm test`。存取酒、员工名册、预约、销售、配品／其他消费、换酒、库存申请／审核及 gift 提交／审批实现均已实际尝试，但 PowerShell 找不到 `npm`，进程未启动；本次使用 `node --test --test-isolation=none` 执行完整 Node 测试集合，结果见上表。此前阶段测试数均为历史证据。

## 入口与端口

- 员工系统：`http://localhost:4173/`
- 系统管理后台：`http://localhost:4173/admin`
- 局域网访问：`http://<电脑局域网IPv4>:4173/`
- `server.js` 只提供显式白名单静态资源，并把 `/api/v1/*` 交给 `http/api.js`。正式 `/admin` 加载 `ui/admin-app.js`，使用同源 session 与服务端过滤的后台 snapshot；`app.js` 仅保留演示入口所需的兼容路径。

`localhost` 与局域网 IP 是不同浏览器来源；演示 `localStorage` 不会自动共享，也不作为正式 `/` 或 `/admin` 的业务事实。

## 数据、产物与缓存路径

| 类型 | 位置 | 说明 |
|---|---|---|
| 演示业务状态 | 浏览器 `localStorage`：`jbhh-demo-v1` | 订单、房态、库存、权限等；恢复演示或清理站点数据会丢失 |
| 主题偏好 | 浏览器 `localStorage`：`jbhh-appearance-v1` | 独立于业务状态 |
| MySQL 过渡账本 | `database/migrations/001_mysql_ledger_core.sql` | 独立适配器已获专用 MySQL 8.4.11 集成测试证据，仍未接客户端 |
| MySQL 认证基础 | `database/migrations/002_mysql_auth_core.sql` | 独立认证与 session 模块已在专用测试库验收，未接 HTTP／账本／客户端 |
| 旧关系型草案 | `database/schema.sql`、`database/seed.sql` | PostgreSQL 历史设计参考，非当前运行数据 |
| 历史导入模板 | `database/templates/` | CSV 表头模板，不是已导入结果 |
| 测试文件 | 根目录、`ledger/` 与 `auth/` 的 `*.test.js` | Node 内置测试自动发现 |
| 本机依赖／缓存 | `node_modules/`、`.pnpm-store/` | 已被 `.gitignore` 排除；没有清理要求时保留 |
| 运行日志 | `*.log` | 被 `.gitignore` 排除，不作为正式文档证据 |
| 正式构建产物 | 无 | 项目没有 build 或 package 脚本，源文件由静态服务器直接提供 |

## 开发、验收与证据层级

1. **配置确认**：读取 `package.json`、入口或静态路由，证明命令和路径存在。
2. **语法诊断**：只能证明目标文件可解析。
3. **自动测试**：证明测试覆盖的规则与契约通过，不证明真实浏览器或生产环境。
4. **运行验证**：启动服务并检查 HTTP 或实际流程，证明对应环境可达。
5. **视觉／真机验收**：检查真实浏览器或手机上的布局、触控、输入法和可读性。
6. **生产验收**：认证、支付、数据库、通知、备份和并发必须在正式系统单独取得证据；当前项目没有这条路线。

每个任务按变化范围选择必要层级。用户明确禁止启动、测试或设备操作时，只能做静态核对，并在结果中写明未取得运行证据。

## 资源、并行与清理

- 4173 端口是单实例共享资源；启动前确认没有其他任务占用。不要在未核对进程归属时停止未知 PID。
- 项目没有配置构建并行度、共享构建缓存或独占测试设备，不得把环境观察推断为固定 CPU 百分比保证。
- 多个任务同时修改 `app.js`、`rules.js`、`style.css` 或数据库 schema 时，先明确文件归属；多工作树只有获授权后才使用。
- 前台服务用 `Ctrl+C` 停止。临时使用其他端口后，移除当前 PowerShell 会话中的 `PORT` 或关闭该会话。
- 浏览器演示数据优先通过页面的“恢复演示数据”清理；不要把真实客人信息写入演示状态。
- 不为清理而递归删除 `node_modules`、缓存、用户工作树或来源不明的文件。

## 当前验证状态

当前结论与最后证据见 [CURRENT_STAGE](./CURRENT_STAGE.md)。具体任务是否已运行自动测试和浏览器验收，只在该文件按日期记录。

## Stage 3A HTTP 配置与验收（2026-10-06）

/admin 静态演示路径默认继续可用；正式员工入口 / 需要 API，正式 API 仅在 KTV_API_MODE=enabled 时启用。启用时必须提供 KTV_MYSQL_URL（指向已执行 MySQL migrations 001…007 的库）、KTV_LEDGER_ID、KTV_STORE_ID、KTV_BUSINESS_TIME_ZONE 和 KTV_PUBLIC_ORIGIN。KTV_PUBLIC_ORIGIN 必须是浏览器实际访问的精确 Origin；生产默认 KTV_HTTP_ENV=production，要求 HTTPS 且 Cookie 带 Secure。仅本地开发可显式设置 KTV_HTTP_ENV=development 与 KTV_INSECURE_COOKIE=true，仅允许本机 Origin 使用 HTTP 和非 Secure Cookie。不要把数据库 URL、密码或 session token 写入仓库或日志。启动命令仍为 node server.js；本阶段没有自动建表、正式账号初始化或部署步骤。

接口：POST /api/v1/auth/login；POST /api/v1/auth/logout；GET /api/v1/auth/session；POST /api/v1/commands/:action；GET /api/v1/store/snapshot。写入需同源 Origin，退出及命令还需 X-CSRF-Token。Stage 3B 员工入口 / 现已调用这些正式接口；/admin 仍为演示。

定向测试：node --test --test-isolation=none http/auth.test.js http/contract.test.js auth/auth.test.js；真实 MySQL HTTP 集成用例沿用 LEDGER_MYSQL_TEST_URL 和 ledger/trusted-clean.integration.test.js 的受保护 fixture。完整回归：node --test --test-isolation=none --test-reporter=tap。修改 JavaScript 后仍尝试 npm test；当前环境没有 npm 时记录该证据未取得，不替代直接 Node 测试结果。


## Stage 3B 员工入口运行与测试（2026-10-06）

要打开正式员工入口 /，先在本地 MySQL 测试/开发库执行 MySQL migrations 001–007，准备正式测试账号与权限，再按上文设置 KTV_API_MODE=enabled、数据库、ledger/store、时区和精确 Origin 配置，运行 node server.js。未开启 API 或数据库不可达时员工入口显示连接错误并停止业务写入，不退回演示身份。开发 HTTP Cookie 必须显式选择 development 且仅限本机；生产默认 HTTPS/Secure。/admin 仍是浏览器演示，不接正式账本。

2026-10-06 本机网页复验使用 jbhh_ktv_test 中的临时合成 fixture 与仅绑定 127.0.0.1 的开发服务。该库在完整回归后建表；fixture 存续时，既有真实 MySQL 测试的“预置 auth 表必须为空”前置条件不成立。重新跑完整测试前，先停止本地网页服务，并只清理由本次 fixture 创建且已确认所有权的测试数据；不要对来源不明的表执行清理。合成测试账号不是正式员工账号，凭据不进入仓库。

静态员工模块交付验证：node --test --test-isolation=none --test-reporter=tap server-static.test.js。定向验证：node --test --test-isolation=none --test-reporter=tap entry.test.js ui/api-client.test.js ui/server-state.test.js ui/command-flow.test.js ui/formal-workspace.test.js ui/formal-entry.test.js ui/room-card-accessibility.test.js http/staff-query.test.js employees/mysql-roster-read.test.js。真实 MySQL 集成：node --test --test-isolation=none --test-reporter=tap ledger/trusted-clean.integration.test.js。完整回归：node --test --test-isolation=none --test-reporter=tap。JavaScript 修改后也尝试 npm test；若当前环境没有 npm，应如实记录此证据缺口，不能把 Node 完整回归写作 npm 执行结果。

### Stage 4B manual validation

See [safe tool configuration and stops](STAGE4B_KTVSKY_ADAPTER.md). The command is node tools/ktvsky-validate.js --config <external-config-path> --action query --room <confirmed-room-id>. Secrets are environment-only; no live control is enabled by default. Mutation needs the explicit live flag, matching human-approved unoccupied target, enabled mapping and one stable external journal directory. No real target is preconfigured. Pending records may not be deleted to bypass reconciliation.

## Stage 4B.1 countdown verification regression

Focused: node --test --test-isolation=none --test-reporter=tap devices/ktvsky-countdown.test.js devices/application.test.js devices/ktvsky-gateway.test.js devices/ktvsky-validation.test.js ledger/trusted-sales.test.js. Provider requests use local synthetic fixtures only. Full regression uses the existing dedicated MySQL harness; counts and current evidence are maintained in CURRENT_STAGE.md. The original live archives and journal are not test fixtures and must not be changed by these tests.

## Stage 5C production and isolated validation

Production entry (future authorized deployment): set NODE_ENV=production, KTV_HTTP_ENV=production and KTV_DEPLOYMENT_ENV=production; run node production/start.js --config-file ABSOLUTE_PROTECTED_CONFIG. Read-only preflight: node production/preflight.js --config-file ABSOLUTE_PROTECTED_CONFIG. Both require Windows x64, Node24.19.x and Git-external config/secrets; no secret argv. Configuration, TLS, service installation templates and packaging rules: [Stage5C](STAGE5C_DEPLOYMENT_RUNTIME.md). server.js is development-only HTTP and rejects production mode.

Focused: node --test --test-isolation=none --test-reporter=tap production/runtime.test.js production/http-security.test.js production/runtime.integration.test.js devices/worker.test.js server-static.test.js. Full: node --test --test-isolation=none --test-reporter=tap. Real MySQL tests require the existing owned LEDGER_MYSQL_TEST_URL harness on33313, never an arbitrary production URL. Production-like fixture restores a synthetic target, creates one synthetic least-privilege DB account, test TLS/config and compiled host outside Git, then cleans only resources it created. It does not initialize real production data or register a system service. Browser smoke runs serially while the same fixture lock is held.
