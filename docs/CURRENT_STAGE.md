# 当前阶段

更新日期：2026-10-03。本文件是当前进度的唯一汇总入口。

## 当前基线与业务契约纠偏（2026-09-29）

Track A＋B 集成提交 `81e1a4c` 已在 `main`；下方“隔离集成候选尚未合并 main”的文字是当时的历史记录，不再代表当前 Git 状态。本轮收到门店对完整营业职责、≤5 元免零和超额审批自批限制、暂定 06:00 营业日、订单营业额与逐笔付款资金分日归属、平台券先核销和无固定备用金的明确确认，已更新 [REQUIREMENTS](./REQUIREMENTS.md)、[OFFSITE_CONTRACTS](./OFFSITE_CONTRACTS.md)、[OPEN BUSINESS DECISIONS](./OPEN_BUSINESS_DECISIONS.md) 与 [P0 矩阵](./OFFSITE_P0_MATRIX.md)。这些是目标契约纠偏，当前演示代码并未因此实现新规则；K01、K05、K07 仍见 [KNOWN_ISSUES](./KNOWN_ISSUES.md)。真人与历史演示账号 ID 的映射继续待确认。

## P0-1 原始快照只读预检器（2026-09-29）

已新增 `snapshot-preflight.js:preflightDemoSnapshot(raw)` 和 `snapshot-preflight.test.js`。输入为复制出的 `jbhh-demo-v1` 原始 JSON 字符串，按 UTF-8 字节计算 SHA-256；仅在深拷贝上调用现有 `migrations.js` 链，输出订单 room/retail、逐笔/逐渠道付款、挂账回款关联、库存 `count:null` 与 0、计账/未计账流水及房态引用的核对摘要。未知历史名称、规格、单价、基础数量或赠酒参考值保持未知，并返回明确 ambiguity/error；损坏输入不进入可写状态。`ok` 仅表示此预检覆盖项未发现问题，不构成正式导入批准。该模块没有 localStorage、UI、HTTP 或数据库写入口，生产业务规则未改。

上轮预检器修改 JavaScript 后按约定尝试 `npm test`，PowerShell 报 `The term npm is not recognized`，npm 进程未启动；当轮实际运行 `package.json` 对应的 `node --test`：235 项、229 通过、0 失败、6 项已知问题复现跳过，退出码 0，预检器测试 12/12 通过。这是上轮证据；当时没有浏览器或 PostgreSQL 验收。

## P0-1 Stage 1A：账本核心事务协议（2026-09-29）

从干净 `main@a819635` 建立 `codex/p0-1-trusted-ledger`。新增 `ledger/application.js` 与 `ledger/memory-store.js`：独立 Node 应用层接收操作键、期望 revision、动作和 JSON payload，计算稳定请求指纹；在同一原子存储边界内先查已提交回执，再检查 revision，成功后调用原 `rules.js:transact` 并一次提交新状态、成功回执、审计和递增一次的 revision。同键同内容返回首次回执；同键不同内容、旧 revision、已有领域键但回执缺失均拒绝且不改状态。业务失败不写成功结果；两个新键竞争同一旧版本时最多一个提交。`ledger/application.test.js` 覆盖房／零售边界、付款与库存副作用及这些冲突。原 `transact`、门店业务规则和 6 项 Known Issues 未修改。

这里的 `memory-store` 只验证单实例原子协议，重启即丢失，不是正式共享账本；没有接入 `persistence.js`／`migrations.js` 的正式导入、浏览器 UI、HTTP、真人认证或 PostgreSQL。成功审计尚无真人 actor 字段，须待真实认证后由服务端提供，不使用演示身份冒充。

本次修改 JavaScript 后按规则尝试 `npm test`，PowerShell 报 `The term npm is not recognized`，npm 进程未启动；实际执行 `package.json` 对应的 `node --test`：249 项、243 通过、0 失败、6 项已知问题复现跳过，退出码 0。其中 Stage 1A 定向测试 14/14 通过；这仅证明单实例协议行为，未取得跨进程持久化或真实服务验收。

## P0-1 Stage 1A.1：actor 绑定与操作键终态（2026-09-29）

在 `codex/p0-1-trusted-ledger` 上核查 Stage 1A：原指纹已覆盖动作、期望 revision 和业务 payload，且按 JSON 值规范化属性顺序；额外传输字段原本就不在命令内。此次补上可信调用方注入的 `principal.id` 和适配器的 `ledgerId`，成功回执及审计明确记录 actor，原回执只对同 actor／同请求可重放；另一 actor 使用同键同请求只得冲突。没有新增真人登录或把演示 `state.user` 当成可信账号。

新键的旧 revision 与现有领域规则的业务拒绝分别落为 `revision-conflict`、`business-rejected` 终态：两者只保存该操作键的结果，不改营业 state、revision 或成功审计。此后即使账本继续变化，同 actor／同请求仍取原终态；刷新并决定重试时必须使用新键，付款也不例外。普通 `Error` 是当前领域规则的预期拒绝约定；其他异常不占用操作键，留给故障恢复。内存适配器仍只证明单实例协议，正式持久化留待 Stage 1B。

本轮修改 JavaScript 后已尝试 `npm test`，PowerShell 找不到 npm，命令未启动。实际运行 `package.json` 对应的 `node --test`：252 项、246 通过、0 失败、6 项已知问题复现跳过，退出码 0；Stage 1A.1 所在 `ledger/application.test.js` 定向 17/17 通过。没有数据库、跨进程或真人认证验收。

## P0-1 Stage 1A.2：预期业务拒绝类型（2026-09-29）

`shared/business-error.js:BusinessRejection` 是明确的业务拒绝类型；现有领域校验的显式拒绝改为该类型，判断条件与原提示不变。`ledger/application.js` 仅捕获该类型并保存 `business-rejected` 终态；未知普通 `Error` 或其他异常向外传播，内存原子边界不保存状态、revision、操作结果或成功审计。故障修复后同一 actor 可用原 operationKey 和原请求重试；既有成功、过期 revision 与 actor 冲突协议不变。静态服务白名单加入该共享模块以维持浏览器演示加载。

修改 JavaScript 后已尝试 `npm test`，环境找不到 npm，命令未启动。实际运行 `package.json` 对应的 `node --test`：253 项、247 通过、0 失败、6 项已知问题复现跳过；定向 ledger 测试 18/18 通过。当前仅为单实例协议证据，未取得 PostgreSQL 集成证据。

## P0-1 Stage 1B-MySQL：原子过渡账本（2026-09-29）

从 `47133b4` 新建 `codex/p0-1-mysql-ledger`；原 PostgreSQL 实验 `codex/p0-1-trusted-ledger@7d3c23c` 留作历史，未获得真实 PostgreSQL 集成验收，也未推送或部署。当前分支未继承其 `pg` 依赖，只以项目首选 pnpm 加入已批准的 `mysql2@3.24.4`，没有 ORM。

新增 `ledger/mysql-store.js:createMySqlLedgerStore`、`ledger/mysql-snapshot.js` 和 `database/migrations/001_mysql_ledger_core.sql`。三表均指定 InnoDB；状态使用 MySQL JSON，账本行附语义快照 SHA-256。适配器在单个池连接与事务内锁定 ledger head，保存同键终态；成功同事务更新 state、revision、operation 和审计，明确拒绝只写 operation，未知异常回滚。现有 `ledger/application.js` 仅增加可选数据库时间钩子，内存端口与业务语义不变；`rules.js:transact`、UI、HTTP、真人认证及正式数据导入未变。MySQL JSON 快照不是原始 localStorage 文本，未来导入仍须保留原文与原文校验和。

数据库无关单元测试 9/9 通过，覆盖快照、幂等、冲突、房／零售、库存、故障回滚与提交结果不明。本次提交当时，集成测试要求显式 `LEDGER_MYSQL_TEST_URL` 指向独立 `ledger_test_` 数据库，内部创建并仅清理本轮唯一数据库；本机未发现明确测试实例，当前该项 1 项跳过，**未取得真实 MySQL 8.4 集成测试证据**。Migration 未实际执行，行锁竞争和重启持久性尚未验证。修改 JavaScript 后尝试 `npm test`，本机找不到 npm；实际运行同一脚本 `node --test`：263 项、256 通过、0 失败、7 跳过（原 6 项 Known Issues 加 1 项 MySQL 环境门槛）。

## P0-1 Stage 1B.1-MySQL：真实集成验收（2026-09-29）

测试外围已改为只允许 `LEDGER_MYSQL_TEST_URL` 指向 `jbhh_ktv_test`，且在任何清理前实际读取并核对 `DATABASE() = jbhh_ktv_test`、`VERSION() = 8.4.11`、默认引擎 `InnoDB`。开始和结束只按外键顺序清理该库三张账本测试表，不创建或删除数据库。验收后只读查询确认三表均已清理。

`database/migrations/001_mysql_ledger_core.sql` 的三条 `CREATE TABLE` 在空账本表环境中真实成功，三表引擎均为 InnoDB；重复执行首条语句按约定返回 `ER_TABLE_EXISTS_ERROR`。真实集成测试 11/11 通过、0 失败、0 跳过：首次状态／revision／终态／审计提交，重连后同键回执复用，actor 与指纹冲突，旧 revision 与业务拒绝终态，未知异常及审计约束故障注入后的完整回滚，房单、零售无房、历史销售快照、付款及库存不重算、库存 `null` 与 0 区分。revision 竞争使用两个不同的 MySQL connection ID，结果恰为一笔成功和一笔 revision conflict；首次 head 初始化也使用两个独立 connection，恰有一次插入成功、另一次获 `ER_DUP_ENTRY`，持久化的 head 仍为 revision 0 且没有 operation 或审计。该初始化测试验证数据库唯一键语义，当前适配器仍要求可信调用方显式建立初始 head，不代表已实现正式初始化或导入流程。

修改 JavaScript 后已尝试 `npm test`，但本机仍找不到 npm；直接 `node --test` 因受限环境 `spawn EPERM` 无法启动测试文件。实际运行 `node --test --test-isolation=none` 完整集合：273 项、267 通过、0 失败、6 项既有 Known Issues 跳过；集成测试包含在其中。生产 adapter、领域规则、UI、HTTP、真人认证和正式导入均未修改。

## P0-1 Stage 2A：可信命令策略（2026-09-29）

从干净的 `main@cefd0e8` 建立 `codex/p0-1-stage2-command-policy`。新增 `ledger/command-policy.js` 的 `createTrustedPrincipal`、`authorizeCommand`、`createTrustedReviewFacts` 和 `authorizeReviewCommand`：以服务端显式注入的合成 principal 及具体权限，列出 45 个现有非演示领域 action 的正式入口资格；未知 action 默认拒绝，演示身份切换、练习时间、reset 和 `setPermissions` 明确拒绝。纯策略只返回所需权限、实际操作者 ID、尚未核实的销售归属员工 ID 与仍须在账本事务内验权的标记，不读取业务 state、不计算金额或改变领域事务。库存期初/调整、本人审核、超额免零特殊自批和员工名册都保留事务内事实核验；特殊自批以 `rounding.self.excess` 授权属性表达，不按姓名或演示 ID 猜真人。所有正式动作目前仅建立策略，不代表 HTTP、认证或正式写入已接通。

`ledger/command-policy.test.js` 使用 synthetic ID 验证权限隔离、`backend.view` 与营业权限分离、`review.self` 叠加审核权、代登记操作者与销售归属分离、伪造客户端字段不能提升授权、演示动作拒绝及待事务核验条件。定向测试 13/13。修改 JavaScript 后尝试 `npm test`，PowerShell 找不到 `npm`，进程未启动；实际运行 `node --test --test-isolation=none`：286 项、280 通过、0 失败、6 项既有 Known Issues 跳过。MySQL 8.4.11／InnoDB 专用测试库集成 11/11 实际通过、0 跳过。基线测试为本轮改动前 273 项、267 通过、0 失败、6 跳过。原 `rules.js:transact`、Stage 1 ledger 协议、MySQL schema、HTTP、UI 均未修改；Stage 2B/2C/2D 未开始。

## P0-1 Stage 2B：真人账号、凭据与 Session 基础（2026-09-29）

从干净 `main@04895be` 建立 `codex/p0-1-stage2-auth-session`。新增独立 MySQL migration 的五张 InnoDB auth 表及 `auth/` 下的密码、token、限流、存储与服务模块；没有预置真人或演示 ID 映射。账号 principal ID 由随机 UUID 生成，凭据使用异步 scrypt v1（N=16384、r=8、p=1、32 字节独立 salt／派生值），会话使用 32 字节随机 token 且数据库只存 SHA-256 digest。登录失败对外统一为 `invalid-credentials`；显式 rate-limit port 当前提供单进程 15 分钟／5 次失败实现，多进程正式入口须注入共享限流器。

成功登录的 session 和审计、账号与凭据创建、账号停用与 session 撤销均在单连接事务中完成；数据库时间决定创建、活动、闲置／绝对过期和事件时间。每次 session 认证重读账号启用状态、凭据版本及 grants；轮换凭据使旧 session 失效，停用立即撤销全部 session。当前服务内部管理方法尚未经过 HTTP／命令授权，不能对客户端暴露；Stage 2A、ledger principal 协议、`rules.js`、UI 和旧 Known Issues 均未修改。真人账号、登录名、初始密码与恢复流程仍待决定。

数据库无关定向测试 5/5；专用 MySQL 8.4.11／InnoDB 中 migration、重连、并发、过期、停用、凭据版本、实时 grants 和 SQL 中途失败回滚等真实集成测试 16/16，0 失败、0 跳过。修改 JavaScript 后按约定尝试 `npm test`，PowerShell 找不到 `npm`，进程未启动；实际运行 `node --test --test-isolation=none`：307 项、301 通过、0 失败、6 项原有 Known Issues 跳过。Stage 1 MySQL 账本集成测试单独复验 11/11，0 跳过。

## P0-1 Stage 2C.1：同连接认证重验基础（2026-10-03，真实 MySQL 验收完成）

从干净 `main = origin/main = dd20b5d` 建立 `codex/p0-1-stage2c-auth-revalidation`。新增数据库无关 `auth/session-revalidation.js:revalidateSessionInTransaction`，MySQL store 的 `bindSessionRevalidation(connection)` 在调用方已经开启的事务上提供只读认证能力；不会另借连接、管理事务或更新 session 活动。`ledger/mysql-store.js` 仅增加可选 binder，在 head 行锁之后向事务回调提供该能力，默认 Stage 1 路径与 `ledger/application.js` 未改。没有接入正式业务 action、HTTP 或 UI。

非锁定 token 定位只作线索；权威读取统一为 account → session → 当前 grants 的 locking read，随后只取一次数据库 UTC 微秒时间判断两类过期。退出／撤销修正为 account-first；多 session 按稳定 ID 顺序读取，登录与凭据轮换也先锁 account／既存 session 后读取凭据。返回经 Stage 2A 工厂创建的 principal 与不可伪造的上下文；policy attributes 显式为未配置（false／null），需属性时拒绝。既有终态重试与撤权的顺序只通过合成执行器契约测试冻结，没有修改 production replay 流程。

本阶段早先在 MySQL84 未运行时，修改前基线为 284 total／276 pass／2 fail／6 skip，修改后完整集合为 309 total／301 pass／2 fail／6 skip；两次失败都停在 `ECONNREFUSED`，不能当作数据库验收。服务恢复后，本轮重新连接实际核实 `LEDGER_MYSQL_TEST_URL` 可读取，MySQL 8.4.11／`jbhh_ktv_test`／InnoDB，未输出 URL 或密码。

本轮真实 auth 集成 29 total／29 pass／0 fail／0 skip，其中原 Stage 2B 16 项完整保留执行，新增 2C.1 重验子集 13／13。调用方 connection／事务生命周期、account → session → grants 顺序、停用／撤销／两类过期／凭据版本、旧 REPEATABLE READ 快照之外的当前 grants、一次数据库 UTC 时间、属性 false／null 及不更新活动均实际验证。并发用例从池中取得两条连接并断言 `CONNECTION_ID()` 不同，以真实 `FOR UPDATE NOWAIT` 错误确认 account 锁；分别验证 grant／revoke、disable、revoke／logout 和双重验的先后结果，无死锁。人为查询不存在列触发 SQL 故障，port 向外传播且不自行回滚；调用方回滚后此前未提交的 grant 消失，session 数据不变。

Stage 1 MySQL ledger 集成独立复验 11 total／11 pass／0 fail／0 skip，migration、重连幂等、双连接 revision／初始化竞争和 SQL 中途失败回滚继续真实执行。定向单元测试本阶段 52／52；本轮完整 `node --test --test-isolation=none` 实际为 345 total／339 pass／0 fail／6 skip，退出码 0，包含两套真实数据库用例。所有数字均取实际输出，不沿用连接失败时缺少子测试的数量。

已再次实际尝试 `npm test`，环境仍找不到 npm，进程未启动。原 6 项 Known Issues 保持 skip；`rules.js`、演示身份／时钟、command-policy 清单、ledger fingerprint／revision／terminal 协议及数据库 migration 均未修改；没有新增依赖或真人账号。本阶段实现及验收纳入一个独立提交，不进入 2C.2，不 push 或部署。

## P0-1 Stage 2C.2：clean 首个 trusted vertical slice（2026-10-03）

从干净 `main = origin/main = 0768814` 建立 `codex/p0-1-stage2c-clean-slice`。开始前本轮实际核实 MySQL 8.4.11／jbhh_ktv_test／InnoDB，并重跑基线 345 total／339 pass／0 fail／6 skip；未输出 URL 或密码。

新增 `ledger/application.js:createTrustedLedgerApplication` 的显式入口和 `ledger/trusted-execution.js:TRUSTED_ENABLED_ACTIONS`，已迁移集合只含 clean，Stage 2A 的其他 44 个 eligible action 不开放执行。正式入口只收四字段 command 与独立 token digest credential；head 锁后调用现有同连接 revalidation，真实 actor／当前 grants／一次冻结 dbNow 来自数据库。先认证，再读 old operation；同 actor／同 fingerprint 返回原终态，只有新 key 才执行 enablement、Stage 2A 当前授权和 revision 检查。授权拒绝向外抛 AuthorizationDenied，不属于 BusinessRejection，不写 operation／成功 audit，不占 key。Stage 1 fingerprint、revision 和 terminal 类型均保留。

`rules.js:transact` 第五参数显式 demo／trusted；trusted 只分流 clean，在演示身份和时钟求值前返回。`rooms.js:cleanRoom` 从 context.permissionIds 检查 room.clean，待清洁 → 空闲及原房态拒绝保持。`shared/identity.js` 增加浏览器兼容的 WeakSet context guard 与具体 trusted permission guard，`auth/session-revalidation.js` 在其 Stage 2A principal 创建后注册并保留旧 guard 导出；复制的 JSON context 无法通过。snapshot 的 user／clock／permissions／capabilities 仅原样保留，不用于可信授权或时间。policy attributes 仍 false／null，未新增模型。生产 MySQL store、schema、HTTP、UI 与其他领域 action 均未修改。

本轮行为用例：synthetic session + room.clean + 正确 revision + 待清洁房间可提交一次 state／result／audit；演示和 payload 中的 actor／role／permission／clock 不影响可信事实；无 grant 拒绝后同一未占 key 在授予权限后可成功；撤权后原 key 重放仍取原结果，新 key 拒绝；disabled／revoked／idle／absolute／凭据轮换在 old operation 查询前拒绝；不同 actor／payload／expectedRevision 保持原冲突。业务拒绝与 revision conflict 继续 terminal，未知异常与 SQL 故障完整回滚。

最终定向 `node --test --test-isolation=none ledger/trusted-clean.test.js ledger/trusted-clean.integration.test.js`：29 total／29 pass／0 fail／0 skip（单元 12，MySQL suite 17，其中真实子用例 15）。实际追踪 BEGIN／head／account／session／locking grants／dbNow／operation／domain／state／result／audit／COMMIT 顺序，同一 connection 仅一次 BEGIN／COMMIT。撤权后新建 pool 重连返回原终态，domain 未再次执行；session 活动时间不变。两条实际 CONNECTION_ID 不同的连接分别验证 revision 竞争最多一成功及同 key 只执行一次。成功 audit 上注入 CHECK 故障，确认已尝试 state 与 operation SQL 写入后整体回滚，修复约束后原 key 可重试。

新 clean fixture 与原 auth／ledger fixture 共用 `test-support/mysql-fixture-lock.js`，只互斥各套建表／清理生命周期；不替代生产 InnoDB 行锁。三套测试严格限制专用库，不 CREATE／DROP database；clean fixture 拒绝预存 auth 表并仅清理本轮创建的八张 auth／ledger 表。原两套断言数量保持：auth 29／29（含 revalidation 13／13）、ledger 11／11，均在最终完整运行中真实执行。

最终完整 `node --test --test-isolation=none`：374 total／368 pass／0 fail／6 skip，退出码 0，包含全部真实 MySQL 回归。首轮 clean MySQL 测试中的一处执行顺序断言曾把 FOR UPDATE 当成 UPDATE，已改为 SQL 动词匹配，最终定向与完整测试均重新通过。JavaScript 修改后已实际尝试 `npm test`，PowerShell 仍报 npm 未识别，进程未启动；不宣称取得 npm 通过证据。

原六项 Known Issues 的测试与结论保持 skip，无新增生产依赖；未创建真人账号、employee 映射、policy attribute schema 或正式导入。本阶段仅一个独立提交，不进入 2C.3，不 push 或部署。

## 本轮隔离集成候选（2026-09-29）

来源：用户交付的 `jbhh-ktv-full.zip`，基线 `ca726b2`；纯重构检查点 `74c3f55`；业务修复终点 `6aa01ba`。Track B 来源为 `codex/offsite-contracts@3193635`。候选位于独立工作树的 `codex/track-a-integration`，主工作区未提交内容保留；未合并 `main`、未推送。

| 本轮检查 | 实际结果 | 结论 |
|---|---|---|
| `74c3f55` 纯重构检查点 | Node 全量 188 项：187 通过、1 失败；`entry.test.js` 对 LF 换行的源码匹配在 Windows CRLF 检出下误报 | 业务断言通过；检查点含 Phase 1 损坏数据备份安全行为，不是绝对零行为变化 |
| `6aa01ba` 业务修复单独检查 | Node 全量 190 项：188 通过、2 失败；`entry.test.js`、`database.test.js` 都是 LF/CRLF 源码匹配失配 | #1–#7、#9 的业务修复断言通过；换行测试接缝需修 |
| Track A＋B 初始集成候选 | `package.json` 对应的 `node --test` 全量 219 项：213 通过、6 项已知问题复现跳过、0 失败、退出码 0（[原始输出](./verification/track-a-b-2026-09-29-package-script.txt)）；兼容参数执行同为 213 通过、6 跳过、0 失败（[输出](./verification/track-a-b-2026-09-29-node-test.txt)）；Track B 正向合同接到 owner 模块和 `reporting.js`，K02/K03 已改为修复后断言 | 自动证据覆盖零售无房、历史快照、未建账、失败原子性、备份失败停写、自审与驳回历史 |
| 项目规定命令 | 每次修改 JavaScript 后尝试 `npm test`；最终候选再次执行时 PowerShell 报命令不存在，npm 进程未启动（[原始输出](./verification/track-a-b-2026-09-29-npm-test.txt)）；`pnpm test` 的本地回退包装器尝试安装并因只读限制报 EPERM | `npm test` 通过证据未取得；等价 Node 内置测试命令取得上表结果 |

初始集成时在本机浏览器访问隔离候选的 `127.0.0.1:4322`：员工端显示空闲房间，管理端显示系统管理页，日报显示空数据表；这是入口与空状态的页面检查，未覆盖完整营业流程。未执行真机或 PostgreSQL 验收。旧段落的 2026-09-28 浏览器与自动测试记录来自 Track A 压缩包，只作历史证据。

本轮将 6 条未修错误行为的复现改为 `test.skip`，保留排查样例而不将错误当作通过条件。补上：备份原文失败后停写；已存在价格不一致套餐的加载与报价拒绝；挂账和大额报销本人审核附加授权；驳回挂账写入 `creditHistory` 并进入审核历史。当前可复现的未解问题与 P0 阻塞见 [KNOWN_ISSUES](./KNOWN_ISSUES.md) 和 [OFFSITE P0 矩阵](./OFFSITE_P0_MATRIX.md)。集成候选供审查，尚未达到 14 天离场验收。

## 后续安全修整（2026-09-29）

旧记录若有套餐价格不一致，现在只在内存中迁移供核对：历史订单与付款笔数、原始 JSON 可在只读核对页查看和复制；主存储键不变，备份副本不覆盖已有不同备份。JSON 损坏、备份成功或失败、跨标签页异常新值及停写后主记录缺失均保持停写。人工修正当前套餐配置并点击“重新检查本机记录”通过完整校验后才恢复保存；测试核对了原付款和成交金额没有被重算或覆盖。`characterization-core.test.js` 的挂账分级标题也已更正。

本次按约定尝试 `npm test`，PowerShell 仍找不到命令，进程未启动（[原始报错](./verification/track-a-b-recovery-2026-09-29-npm-test.txt)）；执行 `package.json` 中相同脚本 `node --test`，223 项中 217 通过、6 条已知问题复现跳过、0 失败，退出码 0（[完整输出](./verification/track-a-b-recovery-2026-09-29-node-test.txt)）。核对页有 Node 渲染与转义测试，本次未单独取得真实浏览器恢复流程证据。当时尚未提交；本轮浏览器验收及提交见下节。

## 隔离浏览器恢复演练与提交（2026-09-29）

在 Codex 内置浏览器、仅绑定 `127.0.0.1` 的随机端口来源注入合成已付款订单 D1；原浏览器资料和主工作区均未操作。价格不一致时员工页只显示停写与历史订单／付款笔数；只读原文经全选复制，与主键逐字一致。未修正时重检仍停写。第二标签页逐字核对复制内容后，只把当前套餐价从 100 分修为 16800 分；原员工页在跨标签页更新后仍停写，点击“重新检查本机记录”才恢复房间页。前后订单 D1 完整对象一致，历史套餐成交价与 1 笔现金付款均为 16800 分，原始异常原文仍在恢复副本（[完整演练记录与夹具](./verification/track-a-b-browser-recovery-2026-09-29.md)）。

`characterization-core.test.js` 的“免零上限”过时标题已改为“结账免零记录与超收拒绝”，免零业务规则未改。修改 JavaScript 后再次尝试 `npm test`，PowerShell 未找到命令、npm 进程未启动（[原始报错](./verification/track-a-b-browser-2026-09-29-npm-test.txt)）；运行 `package.json` 中完整脚本 `node --test`：223 项、217 通过、6 项已知问题复现跳过、0 失败、退出码 0（[完整输出](./verification/track-a-b-browser-2026-09-29-node-test.txt)）。候选在此验收后提交于 `codex/track-a-integration`，未合并 `main` 或推送。

## 分阶段重构进度（Track A 压缩包历史记录，2026-09-28）

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

## Track A 原交付证据（2026-09-28，非本轮重跑）

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

- 浏览器 `localStorage` 不是生产账本；当前页面没有业务 API、服务端账本或 Stage 2B 认证接入、多设备同步、真实支付或正式审计。零售原子性仅在单浏览器完整状态写回边界内成立；独立 MySQL 账本与认证模块尚未成为浏览器运行路径。
- 未实现退款、撤单、冲正、零售挂账、找零、完整 POS、会员、优惠券、并房、换房、拆账、跨店、企业微信、正式班次和营业日关账。
- 后台新增商品只覆盖销售闭环必需字段；未提供商品删除、供应商 SKU、条形码、品牌、已存在规格结构编辑或正式价格审批。没有预设具体香烟价格。
- 内部瓜子、冰块、纸巾、吸管仍用 `state.consumables`；正式统一物料模型需另立任务。
- 真实手机触控、系统大字体、输入法遮挡、弱网与断网恢复仍需现场验收。

## 其他既有缺口与待决定

- 实际金山营业报表尚未导入，只有暂存结构、模板与字段映射；没有持续集成、自动部署、监控、告警或客户端多设备并发测试。
- 后续正式化仍需决定部署环境、身份来源、支付／验券、通知、附件、备份和历史数据导入验收口径。

## 负责人和任务索引

- 当前没有正式总控、模块负责人或在途计划。
- 出现并行任务时，由唯一 [项目总控](./roles/PROJECT_CONTROLLER.md) 协调；需求和效果由 [模块负责人](./roles/MODULE_OWNER.md) 收口。
- 可使用 [任务启动模板](./roles/TASK_START_PROMPTS.md)，模板只引用权威文档，不复制规则。

## 下一步

只读快照预检器、Stage 1A／1A.1／1A.2 协议、Stage 1B-MySQL 适配器、Stage 2A 纯命令策略及 Stage 2B 独立认证基础已完成；Stage 1B.1 和 Stage 2B 已分别在专用 MySQL 8.4 测试库取得真实验收证据。Stage 2C.1 同事务认证与 2C.2 clean 可信执行已通过真实数据库验收，其他正式 action 尚未迁移；HTTP／客户端及 2C.3／2D 未开始。正式营业日和班次规则已确认的部分见 [REQUIREMENTS](./REQUIREMENTS.md)，运行实现仍属后续任务。

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
