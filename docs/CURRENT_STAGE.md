# 当前阶段

更新日期：2026-10-05。本文件是当前进度的唯一汇总入口。

## 营业日正式切换为 12:00（2026-10-05）

先核实 db4ec73 parent=d9f9124，ff-only 合入 main。合入后真实完整回归 1596／1592／0／4，auth／employee／ledger／trusted MySQL 均实际执行；fetch 核实远端无新增后普通 push，main=origin/main=db4ec73、0/0、clean。从该基线建立 codex/p0-1-business-day-noon。本批只改变正式营业日 cutoff，不迁移 open／handover或修其他 Known Issues。

核查当前代码无原 06:00 计算或 businessDate 写入，只有契约和历史 PostgreSQL default；新增 shared/business-day.js:businessDateFor 的 noon-v1／12:00 纯规则，显式要求门店时区及带 offset 的有效原始时间。凌晨和 11:59:59 归前日，12:00:00／12:00:01／晚间归当日；不修改 payment occurredAt、不回填或重算历史日期，不使用设备默认时区。新规则的订单创建与 reporting 接入仍待 K05，不能把纯规则验收当作订单营业额／资金双口径已完成。门店时区配置仍 OPEN。

同步当前 REQUIREMENTS／OFFSITE_CONTRACTS／P0 矩阵／OPEN BUSINESS DECISIONS／架构／模块地图与 K05 目标规则。主题 06:00 日间边界、历史 CURRENT_STAGE 和旧 PostgreSQL SQL 原文保留，不机械替换历史。业务权限、¥10、K01／K06、付款／报表均不改；剩余 K04／K05／K07／K10 四项 skip 保持。

本批实际单元 16／16／0／0，定向两文件 37／37／0／0；新增 MySQL JSON 往返一项实际通过，保留原账本并发／重连／回滚回归。已实连核实 MySQL 8.4.11、jbhh_ktv_test、InnoDB，不输出 URL／密码。最后 JavaScript 修改后实际尝试 npm test，环境仍无 npm（The term npm is not recognized），未取得 npm 运行证据；完整 node --test --test-isolation=none 为 1613／1609／0／4，退出码 0，auth／employee／ledger／trusted 四组均真实执行；四项 skip 名称与 db4ec73 收尾逐项一致。无依赖／migration／业务 action／HTTP／UI 变动；只提交本批规则，后续 K04／K05／K07／K10 保持只读审计。

下方为历史交付记录，原暂定 06:00 已被当前正式 12:00 规则取代。

## K01／K06 免零生效、余额与结清修复（2026-10-05）

先核实 d9f9124 parent=a66377f，ff-only 合入 main，无 merge commit。合入后真实完整回归 1568／1562／0／6；fetch 核实远端无新提交，普通 push 后 main=origin/main=d9f9124、0/0、clean。从该干净基线创建 codex/p0-1-rounding-k01-k06，本批仅修 K01／K06，不迁移 handover／open。

sales.js:settleOrder 普通 ≤1000 分直接免零与真实付款一并生效、结清及释放房；>1000 分及特殊情况只记录 payment 和 pending review，订单继续营业、房间保持占用。decideRounding 批准后才使免零生效，经 closeSettledOrder 重新核对 outstanding=0 才关单，由 rules.js 同一 transact 调用 rooms.js:release；尚有新增收费余额时继续营业。驳回不生效、不关单／释放房，不改已收 payment，不退款或自动二次结算。

sales.js:outstanding 扣除原付款合计及 effectiveRoundingCents，余额不小于零。只承认明确无 review 的普通 ≤1000 分直免，以及金额一致且明确已批准的 review；pending、rejected、状态／金额不明的 legacy 均不抵扣。后续合法 pay／settle 覆盖当前字段前，用可选 roundingHistory 保留原免零事实快照，使已批准免零不会在补款时丢失；无需新 migration，不补造历史状态，不把免零变成 payment。付款 UUID／occurredAt／principal、¥10、具体审核权限／review.self／rounding.self.excess、ledger/application/store/fingerprint/revision、reporting/businessDate 均保持；历史错误订单不批量重开或自动修复。

本轮最终定向四文件单元测试 87／87／0／0（含新增 rounding-finality 20 项及原 trusted rounding 47 项）。原 offsite.contract.test.js 的 K01／K06 两项 test.skip 转为正式正向断言；characterization-core.test.js 的特殊情况旧断言曾要求待审即结账，完整回归发现后按本轮授权改为待审占房、批准结清及驳回保留余额。既有 trusted 用例的身份／权限／attributes 组合、终态／冲突和撤权 replay 保留，仅更新已修业务状态断言。

真实 MySQL 8.4.11、jbhh_ktv_test、InnoDB 已实连核实，未输出 URL／密码。四文件 MySQL 回归 679／679／0／0，其中免零 64 项实际执行；七项真实双连接竞争核实不同 CONNECTION_ID，付款／申请／决定只执行一次，approve/reject 只有一个终态。原键在撤权后重放、授权拒绝不占键、pending replay 保持占房、批准 replay 不重复免零／关单均通过。operation／audit 中途 SQL CHECK 故障、未知异常、实际 settle／approval release TypeError 均整体 rollback；直接免零 payment／order／room 与批准决定／余额／room／revision／operation／audit 同一原子提交。

最后 JavaScript 修改后实际尝试 npm test，环境仍无 npm（The term npm is not recognized），未取得 npm 运行证据；实际完整 node --test --test-isolation=none 最终 1596／1592／0／4，退出码 0，auth／employee／ledger／trusted MySQL 均真实执行。剩余四项 skip 的名称与收尾基线逐项一致：K04、K05、K07、K10；仅移除 K01／K06 两项跳过。无新增依赖或数据库结构，无 HTTP／UI、正式导入、退款等范围扩张。仅本批一个独立提交，不合入／push 新修复、不进入下一阶段、不部署。下方是各次交付的历史记录，K01／K06 的旧保留说明不再代表当前实现。

## P0-1 Stage 2C.3 settle／免零审批 trusted 迁移（2026-10-05）

先核实 a66377f 的 parent 为 3cdd29a，ff-only 合入 main，真实完整回归 1465／1459／0／6 后 fetch 核实远端无新增并普通 push；main=origin/main=a66377f、0/0、clean。从该干净基线创建 codex/p0-1-stage2c-settle-rounding。

只新增 settle、approveRounding、rejectRounding 的 trusted-enabled 与显式 domain 路径；actor／permission／attribute／冻结 dbNow 均由同事务 session 重验产生。settle 复用安全随机付款 UUID、occurredAt、recordedByPrincipalId，待审免零保存 submittedByPrincipalId／submittedAt；审核从锁定 review 读取申请人及与 order.rounding 一致的实际分值，不接收 payload 身份或金额替代事实。决定保存 decidedByPrincipalId／decidedAt，姓名仅为可信显示快照。新 key 先检查锁定申请对应的当前资格，再检查已处理状态；撤属性时不以业务拒绝占键，旧 key 重放顺序不变。

两种决定都需要 rounding.approve，本人还需 review.self；只有 >1000 分的本人批准额外要求数据库已配置且具有 rounding.self.excess，本人驳回及 ≤1000 分特殊情况本人批准不要求此属性。旧申请缺 principal 或免零事实无法安全解释时授权拒绝，不占 key。原终态先于当前动作授权，撤权仍可重放，但失效账号／session 不能读结果；Stage 1 application／MySQL store／fingerprint／revision 协议不改。

普通差额 ≤1000 分直接免零，>1000 分待审；特殊情况仍需说明和审核。原 K01 待审即结账／释放房间、K06 outstanding 不扣免零均保留；决定不恢复房态、不重开订单、不重算余额。reporting／businessDate／¥10 门店额度及原六项 Known Issues 不改；handover／open 仍 fail closed，不接 HTTP／UI，无新依赖或 migration，停止在本批。

本轮实际验收：npm test 再次实际尝试，环境无 npm（The term npm is not recognized），未取得 npm 运行证据；执行 node --test --test-isolation=none。本批新单元 47/47，新 MySQL 集成 56/56；四文件真实 MySQL 回归 671／671／0／0，完整 1568／1562／0／6。MySQL 8.4.11、jbhh_ktv_test、InnoDB 已实连核实，未输出 URL／密码。六项 skip 与本轮 main@a66377f 回归的名称逐项一致，含 K01／K06／K05。七项并发用例均确认不同 CONNECTION_ID；同 key 只一次执行，旧 revision 最多一次付款批次或决定，批准／驳回竞争只有一个终态。重连撤属性重放不再执行领域，新 key 授权拒绝不占键；operation／audit 各中途 CHECK 失败、未知异常和实际 release TypeError 完整回滚。真实回归暴露并回归固定了新 key 的属性授权先于已处理状态检查，demo 与原领域状态转换不变。单个独立提交，不 push 新提交、不进入 handover／open、不部署。

## P0-1 Stage 2C.3 collect／pay trusted 付款（2026-10-05）

从干净 main=origin/main@3cdd29a 创建 codex/p0-1-stage2c-collect-pay，分支起点与 main 相同。只新增 collect／pay 的 trusted-enabled 和显式 domain 执行路径；payment.collect／payment.settle、session principal、冻结 DB 时间是唯一可信来源。新付款保存服务端随机 UUID paymentId、occurredAt、recordedByPrincipalId，person/time 仅兼容快照；旧付款和历史商品事实不改写、不回填。原 charge 收款、五渠道、多笔、全额无免零结账及房态语义保持。

ledger application／MySQL adapter 协议和 schema 未改：原终态先于当前 action 授权，授权拒绝不占 key，付款／订单／房态／revision／result／audit 原子提交。两真实连接竞争、重连撤权 replay、SQL／未知异常回滚通过既有 guarded fixture 验证。停止在本批：settle、approveRounding、rejectRounding、handover、open 仍未迁移；不接 HTTP/UI，不改 ¥10、businessDate 或报表，原六项 Known Issues 继续保留。

本轮最终验收：按约定实际尝试 npm test，环境无 npm（The term npm is not recognized），未取得 npm 运行证据；实际运行 node --test --test-isolation=none。collect／pay 新单元 25/25，定向五文件 162 total／161 pass／0 fail／1 skip（原平台券）；四文件真实 MySQL 回归 615／615／0／0，含新增付款集成 26/26；完整 1465／1459／0／6。真实环境为 MySQL 8.4.11、jbhh_ktv_test、InnoDB，URL／密码未输出。四个 collect／pay 竞争用例分别确认不同 CONNECTION_ID；旧 revision 最多一次资金批次，同 key 只一次执行，重连和撤权不生成新 paymentId；operation／audit 中途 CHECK 失败与未知异常完整回滚。旧六项 skip 与稳定 main 基线逐项一致，K05 不改变。原 auth（含 revalidation）、employee、ledger 和全部 trusted 回归实际执行，无数据库 skip。没有新增依赖或 migration，没有 push／部署，停止在本批。

## 当前基线与业务契约纠偏（2026-09-29）

Track A＋B 集成提交 `81e1a4c` 已在 `main`；下方“隔离集成候选尚未合并 main”的文字是当时的历史记录，不再代表当前 Git 状态。本轮收到门店对完整营业职责、当时的≤5 元免零（本轮门店已改为≤10 元）和超额审批自批限制、暂定 06:00 营业日、订单营业额与逐笔付款资金分日归属、平台券先核销和无固定备用金的明确确认，已更新 [REQUIREMENTS](./REQUIREMENTS.md)、[OFFSITE_CONTRACTS](./OFFSITE_CONTRACTS.md)、[OPEN BUSINESS DECISIONS](./OPEN_BUSINESS_DECISIONS.md) 与 [P0 矩阵](./OFFSITE_P0_MATRIX.md)。这些是目标契约纠偏，当前演示代码并未因此实现新规则；K01、K05、K07 仍见 [KNOWN_ISSUES](./KNOWN_ISSUES.md)。真人与历史演示账号 ID 的映射继续待确认。

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

## P0-1 Stage 2C.3 第一批：房间异常提交（2026-10-03）

开始时实际工作树 clean，HEAD 为已验收 492f75d；本地 main 尚为 0768814，且与 492f75d 为线性祖先、无 main 独有提交。本轮仅 fast-forward main 至 492f75d，再建立 codex/p0-1-stage2c-room-issues，不创建 merge commit 或推送。重跑基线 374 total／368 pass／0 fail／6 skip。

只向已迁移集合增加 markRoomIssue、clearRoomIssue。两者在演示 operator／clock 求值前进入 trusted 分支，具体 room.issue 权限、提交人 principal 和冻结 dbNow 只来自 session 重验 context；新记录增加 submittedByPrincipalId，旧演示 submittedById 留空，不猜真人映射。原房态、证据、异常类型和重复待审申请校验保持；标记立即生效，恢复仍为待审核申请。其他 42 个 eligible action、demo 与未知动作继续 fail closed；审核动作及其他领域逻辑均未修改。

行为用例：有效 synthetic session＋room.issue＋正确 revision 可提交；state／payload 中的 actor、role、permissions、clock 无法授权或覆盖 actor／时间；缺权限不写 state、revision、operation、audit，授予权限后同 key 可用；撤权后重连取回原终态，新 key 拒绝；disabled／revoked／idle／absolute／凭据轮换拒绝旧回执访问；actor／payload／action／expectedRevision 冲突继续 Stage 1 语义。revision conflict 和明确领域拒绝继续持久终态，重放不重新执行。

复用 ledger/trusted-clean.test.js 与 ledger/trusted-clean.integration.test.js，新增 12 个单元契约和 13 个真实数据库子用例。定向 Node 测试 54 total／54 pass／0 fail／0 skip（单元 24，MySQL 集成 30，含 28 个真实子用例及 guard／suite）。两个动作撤权后的新 pool 重连重放均未再调用 domain。两个独立 CONNECTION_ID 实测 revision 竞争最多一个成功、同 key 恢复申请只新增一次；audit CHECK 故障在 state 与 operation SQL 写入后触发，全部回滚且修复后原 key 可成功。专用数据库为 MySQL 8.4.11／jbhh_ktv_test／InnoDB；没有扩大 fixture 清理范围或创建／删除数据库。

完整 node --test --test-isolation=none：399 total／393 pass／0 fail／6 skip，退出码 0；auth 29／29（其中 revalidation 13／13）、ledger 11／11 和房间命令集成都真实执行。原六项 Known Issues 保持 skip。已实际尝试 npm test，环境仍报 npm 未识别，未取得 npm 运行证据。ledger application、MySQL store、auth、command-policy、schema／migration、HTTP／UI、依赖和历史业务快照规则未修改；本批仅一个提交，不进入下一批，不 push 或部署。

## P0-1 Stage 2C.3 第二批：目录维护（2026-10-03）

开始前核实工作树 clean，本地 main 与 origin/main 引用均为 94f1c00；从 main 建立 codex/p0-1-stage2c-catalog-slice。重跑基线 399 total／393 pass／0 fail／6 skip。实际 MySQL 8.4.11／jbhh_ktv_test／InnoDB，未输出连接 URL 或密码。

只增加 createCatalogProduct、updateCatalogProduct、updateCatalogPackage 的 trusted enablement。审计确认三者只需 catalog.manage，不依赖 employee 映射、审批或尚未迁移的身份逻辑；原已修复套餐总价一致性校验保留，不涉及当前六项 skip。rules.js 将原三段命令体收拢为私有 executeCatalogCommand，demo／trusted 共用原校验；trusted 在演示身份／时钟求值前分流，只用可信权限。原目录记录没有业务操作者／时间字段，未新增该模型；actor 继续来自 session 并进入原 operation／audit，context 的 dbNow 保持数据库单次冻结。其他 39 个 eligible action 保持未迁移，未知与 demo 动作继续 fail closed。

行为用例：合成有效 session＋catalog.manage＋正确 revision 成功提交；state／payload 的身份、角色、权限、时钟不能授权或改写可信事实；新库存商品仍未建账 count=null，既有 count=0 和 null 保持区别；当前目录更名／改价／规格维护不改写历史 room／retail、名称、价格、基础数量和套餐组成快照，历史未知仍未知。缺权限不占 key，授予权限后同 key 可用；撤权后新 pool 重连重放原终态，新 key 拒绝；actor／payload／expectedRevision 冲突保持；disabled／revoked／idle／absolute／凭据版本失效拒绝 old operation 访问。原业务拒绝与 revision conflict 保持 terminal；SQL 中途失败全回滚。

新增 15 个单元契约、19 个真实 MySQL 子用例。复用原 ledger/trusted-clean.test.js 与八表集成 fixture；新增 ledger/trusted-catalog.integration.js 只组织目录用例、test-support/trusted-catalog-fixture.js 只提供合成数据，不改变 DDL／清理范围。定向 node --test --test-isolation=none ledger/trusted-clean.test.js ledger/trusted-clean.integration.test.js：88 total／88 pass／0 fail／0 skip（单元 39，MySQL suite 49，含 47 个真实子用例及 guard／suite）。另一次目录／零售加 trusted 单元定向为 49／49。三个动作撤权后重连均未再次执行 transact；audit CHECK 故障在 state／operation SQL 写入后触发，整体回滚、修复后原 key 可用；两个独立 CONNECTION_ID 验证不同动作竞争旧 revision 最多一成功，以及同 key 只执行一次。

完整 node --test --test-isolation=none：433 total／427 pass／0 fail／6 skip，退出码 0；auth 29／29（含 revalidation 13／13）、ledger 11／11 及全部 trusted MySQL 回归真实执行。原六项 Known Issues 保持 skip。修改 JavaScript 后实际尝试 npm test，环境仍无法识别 npm，未取得 npm 运行证据。ledger application／store、auth、command-policy、schema／migration、HTTP／UI、依赖及其他领域文件均未修改，不建立真人账号、员工映射或审批模型；本批一个提交，不进入下一批，不 push 或部署。

## P0-1 Stage 2C.3：cancelReservation 原分叉验收（2026-10-03）

原提交 7729d61 当时从实际干净 main@94f1c00 建立 codex/p0-1-stage2c-cancel-reservation；上一批 catalog 提交 b1e512d 仍保留在独立分支，本轮没有合并它或改动旧工作区。开始前真实确认 MySQL 8.4.11／jbhh_ktv_test／InnoDB，完整基线为 399 total／393 pass／0 fail／6 skip。

只将 cancelReservation 加入 trusted-enabled，原分支当时已迁移四动作：clean、markRoomIssue、clearRoomIssue、cancelReservation。cancelReservation 只从 branded context 检查 room.reserve，使用同连接 revalidation 冻结的 dbNow；demo 保留原 permission／clock 路径。原预约 ID 选择、唯一待预约的缺省选择、取消状态及其他有效预约决定房态的规则逐字保留，不改下午四小时／夜间六小时边界，不增加员工映射或审批。历史 person／employeeId／recordedBy 仍原样保留；实际 actor 由 session principal 写入现有 operation／audit。

新增 11 项定向单元与 15 项真实 MySQL 子用例：预约选择与原房态／时段矩阵、篡改 demo／payload 无效、授权拒绝不占 key 且授予权限后原 key 可用、撤权后重连重放原终态、新 key 拒绝、actor／action／payload／expectedRevision 冲突、disabled／revoked／idle／absolute／credential version 失效，以及拒绝终态在后续状态变化后保持。两个实际不同 CONNECTION_ID 的连接验证 revision 竞争最多一次提交和同 key 只执行一次；在成功 audit 注入 CHECK 失败，确认 state／operation SQL 已执行后完整回滚，修复后原 key 可重试。未知异常同样回滚。

定向单元实际 35 total／35 pass／0 fail／0 skip；房间 MySQL suite 45／45／0／0（含取消预约 15／15）。auth 29／29／0／0（其中 revalidation 13／13）、ledger 11／11／0／0 真实复验通过。最终完整 node --test --test-isolation=none：425 total／419 pass／0 fail／6 skip，退出码 0。已实际尝试 npm test，PowerShell 仍未识别 npm，进程未启动；不宣称取得 npm 通过证据。

源码对照确认 ledger application、MySQL store、auth、command-policy、schema／migration、其他 demo／领域 action、依赖和六项 Known Issues 未修改。沿用同一受保护八表 fixture，不 CREATE／DROP database，测试结束只清理本次创建的表。本批仅一个提交，不进入下一批，不 push 或部署。

## P0-1 Stage 2C.3：目录与取消预约线性整合（2026-10-03）

用户明确要求修正分叉：b1e512d 和原 cancel 提交 7729d61 均直接以 94f1c00 为 parent；main 先 ff-only 前进至 b1e512d，再只重放 cancel 提交到 catalog 之后。两个批次的原验收数字见上文，不能当作组合回归证据。

重放保留七个 trusted-enabled action：clean、markRoomIssue、clearRoomIssue、createCatalogProduct、updateCatalogProduct、updateCatalogPackage、cancelReservation。保留完整目录命令体、目录 fixture／helper 和取消预约 helper／测试；其余 38 个 eligible action 继续 fail closed。不改变 auth、ledger application／store、fingerprint／revision／terminal 协议或任何 Known Issues。

组合验收实际结果：定向 node --test --test-isolation=none ledger/trusted-clean.test.js ledger/trusted-clean.integration.test.js 为 114 total／114 pass／0 fail／0 skip，完整保留 catalog 新增 15 单元／19 MySQL 子用例和取消预约新增 11 单元／15 MySQL 子用例。实际数据库为 MySQL 8.4.11／jbhh_ktv_test／InnoDB；auth 29／29（含 revalidation 13／13）、ledger 11／11 真实复验，未变为 skip。两批各自的重连撤权重放、实际不同 CONNECTION_ID 的连接竞争和 audit SQL 故障回滚均通过。完整 node --test --test-isolation=none 为 459 total／453 pass／0 fail／6 skip，退出码 0；原六项 Known Issues 仍跳过。已实际尝试 npm test，环境仍未识别 npm，未取得 npm 通过证据。

## P0-1 Stage 2C.3：存酒与取酒（2026-10-03）

开始前本轮实际核实 `main = origin/main = 15907357f3b26c8b958efffa72b70160d8e4bb6e`、工作树 clean；从该 main 建立 `codex/p0-1-stage2c-deposit-withdraw`，创建后再次确认 HEAD／main 一致。真实 MySQL 8.4.11／jbhh_ktv_test／InnoDB；完整基线实跑 459 total／453 pass／0 fail／6 skip，没有沿用旧分叉测试数。

只向 trusted-enabled 与 transact 的显式 trusted 分支增加 deposit、withdraw，已有房间四动作和目录三动作完整保留，其余 36 个 eligible action 仍 fail closed。deposits.js 仅增加 context-aware 操作者／时间来源：trusted 从 branded context 校验 deposit.manage，将 principalId／dbNow 写入原 person／time 字段；demo 保持原 need／person／time。顾客姓名、手机号和取酒 identity 是业务输入，不能用于授权或推断 principal。手机号或姓名至少一个、一次多酒、商品可存条件、基础数量、严格存酒 ID、手机号尾号或完整姓名核对和取酒余额规则均保留；不扣商品库存，旧记录与未知历史名称不改写。没有 employee 映射、审批或 Known Issues 依赖。

新增 14 项 trusted 单元契约及 17 项真实 MySQL 子用例。定向 `node --test --test-isolation=none ledger/trusted-clean.test.js operations.test.js` 实际 75 total／75 pass／0 fail／0 skip；`node --test --test-isolation=none ledger/trusted-clean.integration.test.js` 实际 81 total／81 pass／0 fail／0 skip（包含 guard／suite 与全部既有 trusted 用例）。新增 ledger/trusted-deposits.integration.js 只组织用例，test-support/trusted-deposits-fixture.js 只提供合成数据；复用既有八表 fixture，不新增 migration、不扩大清理范围，不 CREATE／DROP database。

实际用例验证 state／payload 伪造 actor、role、permissions、clock 不能授权或覆盖操作者／时间；缺权限不写 state／revision／operation／audit，授予权限后原 key 可用；撤权后新 pool 重连取原 terminal，新 key 拒绝；失效账号／session 在 operation 查询前拒绝；actor／action／payload／expectedRevision 冲突及业务／revision 拒绝终态保持。同顾客可以由两个不同 synthetic principal 存入／取出，不混淆顾客核对值和操作者；多酒、旧单件、姓名或手机号单独输入、原数量及历史快照保持。

使用两个实际 CONNECTION_ID 不同的 MySQL connection 验证存入／取出竞争同一旧 revision 最多一成功，并分别验证两动作同 key 竞争只执行一次。未知异常完整回滚、原 key 可重试；成功 audit 上注入 CHECK 故障，确认 state 与 operation SQL 已尝试写入后 state／serial／revision／operation／audit 全部回滚，修复约束后同 key 成功。JSON 往返仍保持 retail.room=null、库存 count=null 与 0，以及既有商品名称、价格、规格和基础数量快照；revalidation 一次数据库时间且不 touch session 活动。

独立真实回归 auth 29 total／29 pass／0 fail／0 skip（原 2B 16 项、revalidation 13 项）、ledger 11 total／11 pass／0 fail／0 skip。最终完整 `node --test --test-isolation=none` 为 490 total／484 pass／0 fail／6 skip，退出码 0；三套 MySQL fixture 均实际运行，原六项 Known Issues 继续 skip。JavaScript 修改后实际尝试 `npm test`，PowerShell 仍报 npm 未识别、进程未启动，不宣称取得 npm 通过证据。

源码对照确认存取酒原业务命令体与其他 demo 分支保持；ledger application／MySQL store、auth、Stage 2A policy、fingerprint／revision／terminal 协议、schema、依赖、HTTP／UI、其他领域和 Known Issues 测试未修改。本批只做一个独立提交，不进入下一批，不 push 或部署。

## P0-1 员工名册基础（2026-10-03）

原独立批次开始时，main = origin/main = 15907357f3b26c8b958efffa72b70160d8e4bb6e；存取酒 7a02edf 当时仍保留在其独立分支，未合并或覆盖。从干净 main 建立 codex/p0-1-employee-roster，创建后 HEAD 与 main 再次一致。实跑修改前完整基线 459 total／453 pass／0 fail／6 skip；测试 URL 可读取，实际 MySQL 8.4.11／jbhh_ktv_test／InnoDB，未输出连接 URL 或秘密。

新增 003_mysql_employee_core.sql 的 employees 与 employee_events（InnoDB）。employee_id 由服务端随机 UUID 生成，display_name 可同名；enabled 独立，principal_id nullable unique FK，允许无账号员工。独立 employees/service.js／mysql-store.js／errors.js 提供 createEmployee、getEmployee、disableEmployee、linkPrincipal、unlinkPrincipal；写接口显式接收可信内部审计 actor，不是面向客户端的认证／管理授权入口。没有创建真人账号或员工、导入 USERS、按姓名映射或扩展任何业务 action。

关联变化与审计同 connection／事务；actor、旧关联和目标 account 按 UUID 排序加锁后锁 employee，重新核对非锁定定位的旧关联。唯一 principal 冲突与禁止静默替换明确拒绝，解除后才可显式关联其他账号；同值重复操作不新增 event。员工停用保留 ID／名字／关系，不改账号或 session；账号停用不改员工。新事件保存 actor／before／after principal 及数据库 UTC，四种 event type 与 FK／CHECK 保护元数据；不存密码、token、权限或业务 payload。

定向 node --test --test-isolation=none employees/roster.test.js employees/mysql-store.test.js 为 18 total／18 pass／0 fail／0 skip；employee MySQL 定向为 18 total／18 pass／0 fail／0 skip（16 个真实子用例及 guard／suite）。首轮集成中引擎断言因 information_schema 元数据列名未显式 alias 而失败，最小修正测试查询后重新通过，生产 SQL／语义未因此改动。

真实数据库验证 migration 两表成功执行、重复首表报已存在、空名单无 seed；同名及无账号员工、稳定 UUID、关联／解除前后审计、唯一约束、FK、员工／账号独立停用、重连持久性和非 UTC session 下的数据库 UTC 时间。两个实际不同 CONNECTION_ID 的 connection 争抢同一 principal，最多一人关联成功，另一人明确冲突；locator 期间关系改变后拒绝旧请求。

创建／关联／解除／停用四条路径均在 employee SQL 写入后人为把 audit INSERT 列名改为不存在列，数据库实际报 ER_BAD_FIELD_ERROR 并整体回滚；employee 与事件行和 updated_at 全部保持。另在真实 audit INSERT 成功后注入未知 Error，确认两者同回滚。unit 单独验证 COMMIT 回执不明时销毁连接并返回 employeeId 供核对，不自动重复创建。

最终完整 node --test --test-isolation=none 实际 495 total／489 pass／0 fail／6 skip，退出码 0；原 auth 29 项（含 revalidation 13）、ledger 11 项及全部既有 trusted MySQL 用例实际执行，未变成 skip。原六项 Known Issues 保持；npm test 在 JS 修改及最小测试修正后均已实际尝试，环境仍报 npm 未识别、进程未启动，没有 npm 通过证据。新 fixture 只清理自己创建七张 auth／employee 表，未创建／删除数据库或操作 ledger／其他表。

auth、ledger、rules.js、领域模块、UI／HTTP、旧 SQL／migration、历史快照及依赖均未修改；业务 action 的员工解析 port 仍未接入。仅本批一个提交，当前停止在员工名册基础，不进入业务迁移、不 push 或部署。

## Transaction-bound employee resolver（2026-10-04）

本轮实际核实 clean main = origin/main = 509add9e798e8e6050529ed47bb84e1033ce2eca；从该 main 建立 codex/p0-1-employee-resolver，创建后再次读取 HEAD／main 相等。测试 URL 可读取但未输出，实际数据库为 MySQL 8.4.11／jbhh_ktv_test／InnoDB。

只新增 createTransactionBoundEmployeeResolver 与 MySQL bindEmployeeResolver(connection)，提供 resolveCreditedEmployeeInTransaction({creditedEmployeeId}) → 冻结 employeeId／displayName。显式 UUID、调用方活动事务、employee_id 的 FOR SHARE 当前读确认存在且 enabled；无 principal 员工合法、同名员工 ID 独立。显式拒绝 pool 参数，DO 0 事务状态位及实际库校验 fail closed；不猜 principal／姓名／USERS，不改变 actual actor，不借连接、不 BEGIN／COMMIT／ROLLBACK／release，不更新活动或审计。业务 action 尚未调用此接口，ledger／auth／rules／领域、schema、依赖及 trusted-enabled 九动作未修改。

新增 10 项 resolver 单元与 4 项 adapter 绑定契约；定向 node --test --test-isolation=none employees/employee-resolver.test.js employees/mysql-store.test.js employees/roster.test.js 实际 32 total／32 pass／0 fail／0 skip。原员工七表 fixture 新增 12 项真实 MySQL resolver 子用例，保留原 16 项；员工定向集成实际 30 total／30 pass／0 fail／0 skip（含 guard／suite），不扩大建表／清理范围，不 CREATE／DROP database。

真实用例覆盖 enabled／disabled／不存在、无账号、同名 UUID、actor／关联 principal 与归属独立、冻结显示快照、缺少活动事务、仅调用方 connection 和生命周期、调用方回滚、实际 SQL 故障后先前写入回滚。REPEATABLE READ 非锁定读取仍见旧 enabled 时，resolver 当前读明确拒绝已提交停用。两种锁竞争分别核对独立 CONNECTION_ID；用真实 InnoDB 行锁等待超时证明 resolver 共享锁阻塞 disable、disable 排他锁阻塞 resolver；先持锁事务结束后得到确定结果，不使用假并发或额外权限。

首轮并发用例在主体通过后，恢复 session 超时变量因 mysql2 返回 bigint 字符串而报类型错误；仅将测试保存值转换为 Number，重新验收全部通过，生产 resolver 未因此修改。JS 修改及测试修正后均实际尝试 npm test，PowerShell 报 The term 'npm' is not recognized，进程未启动；不宣称 npm 通过。

完整 node --test --test-isolation=none 实际 552 total／546 pass／0 fail／6 skip，退出码 0。auth 29 项（含 revalidation 13）、ledger 11 项、所有既有 trusted MySQL 子用例及新增 resolver 全部实际执行；原六项 Known Issues 继续 skip。结束后只读核实十张已知 fixture 表均已清理。本轮一个独立提交，停止在 resolver 基础，不创建真人配置，不接新业务 action，不 push 或部署。

## P0-1 Stage 2C.3 trusted reserve（2026-10-04）

开始时只读核实 main = origin/main = 509add9，而 resolver 提交 d4d8179 尚未合入。用户明确确认后，本地 main 使用 ff-only 前进到 d4d81790c77f24ace6ce58b929396fbd86a6e105，无 merge commit；确认 clean 后从该 main 建立 codex/p0-1-stage2c-reserve，HEAD／main 再次一致。本地前置合入未 push；沿用 resolver 已有验收，不重复用其完整测试作为合入前置。

本批仅将 reserve 加入 trusted-enabled，第十个已迁移动作。createMySqlLedgerStore 在 head 锁定后把同一 connection 的可选 bindEmployeeResolver 暴露为 transaction.employeeResolver；application 在认证、existing operation、当前 policy 与 revision 校验后，通过 resolveReservationContext 调用员工 resolver。data.employee 只作 UUID 别名，不改变原请求或 fingerprint；保留原显式员工归属的 staff.record 代录权限，room.reserve 本身不能绕过这一 gate。缺少显式员工 UUID、旧演示 ID、姓名或冲突别名均拒绝，不按 principal 推断本人。

withTrustedCreditedEmployee 仅扩展已认证 branded context，保留 principal／permissionIds／dbNow，仅新增 resolver 返回的稳定 ID 与当时姓名。rooms.js:reserveRoom 的 trusted 分支只从此 context 取实际 actor、权限、时间与员工快照；保存 actualActorPrincipalId、creditedEmployeeId、creditedEmployeeNameSnapshot，原 person／employeeId／recordedBy 分别保存可信姓名／UUID／principal。无账号与同名员工可用，关联到其他停用账号也不替换实际 actor；未知或 disabled employee 明确拒绝。

预约时段、0–30 天、未来场次、source、房态、待恢复审核和重复预约校验保持；房态／库存不因预约变化，历史 retail.room=null、count=null／0、名称／价格／规格／数量及付款事实保持。demo 分支原校验仍保留，不调用新 resolver。没有员工映射、真人账号、营业日、其他 business action、HTTP／UI、migration 或依赖扩展。

有效 auth 先于原终态返回；旧 key 不重授权、不重查员工，撤权、员工停用或改名不能改写旧预约快照。新 key 用当前权限；authorization-denied 不占键。仅显式 EMPLOYEE_NOT_FOUND／EMPLOYEE_DISABLED 转为 BusinessRejection，业务拒绝／revision-conflict 仍占原键；未知 SQL／程序故障完整回滚、不占键，修复后可原 key 重试。

新增 reserve 单元 12 项与 store binding 契约 2 项；定向 node --test --test-isolation=none ledger/trusted-reserve.test.js ledger/mysql-store.test.js ledger/trusted-clean.test.js rooms.test.js rules.test.js 实际 148 total／147 pass／0 fail／1 skip（该定向集合原平台券 Known Issue），不把 skip 当通过。npm test 在 JS 修改后及测试修正后均实际尝试，环境报 The term 'npm' is not recognized，进程未启动；未取得 npm 通过证据。

实际只读连接确认 MySQL 8.4.11／jbhh_ktv_test／InnoDB，URL 可读取且未输出凭据。原 trusted fixture 为 reserve 增加本次创建的 employee 两表，实际执行 003 migration，共十张已知表；拒绝预存 auth／employee 表，只逆序清理本次创建表，不 CREATE／DROP database、不操作其他表。新增 16 个真实 reserve 子用例，全部 trusted 定向集成 97 total／97 pass／0 fail／0 skip。首轮一项新增测试给 logout 传错对象，导致没有真正撤销；仅修正为当前接口的 token 字符串并断言 logout 返回 true，生产认证代码未改变，随后全通过。

同 connection、冻结一次 dbNow、无 session activity 更新、真实重连幂等、撤权拒绝新键、五类 auth 失效、employee 未知／停用、原领域校验、actor／payload／revision 冲突均实际验证。人为 employee SELECT 不存在列和 audit CHECK 中途失败都验证完整 rollback；后者确认 head 与 operation SQL 已执行后仍无 state／revision／result／audit 留存。未知 Error 在领域克隆变化后回滚。revision／同 key 竞争、reserve 先持 employee 共享锁、disable 先持 employee 排他锁三类竞争都核对两个不同 CONNECTION_ID；真实 InnoDB 等待／超时证明顺序，再验证提交或原 key 重试结果。

最终完整 node --test --test-isolation=none 实际 582 total／576 pass／0 fail／6 skip，退出码 0。auth 29／29（含 revalidation 13／13）、employee 30／30、ledger 11／11、trusted 97／97 全部真实执行；原六项 Known Issues 名称与 skip 结论保持。结束后只读核实十张已知 fixture 表均不存在。本批一个独立提交；main 保持本地前置 d4d8179，不继续下一批、不 push 或部署。

## P0-1 Stage 2C.3 trusted sale／retailSale（2026-10-04）

本轮开始重新核实 main = origin/main = d205f2d933e8cc58feaf283ff2f08fa51d065f0f、工作树 clean；从该 main 建立 codex/p0-1-stage2c-sales，分支起点与 main HEAD 严格一致。本批只新增 sale／retailSale 两个 trusted-enabled action，当前共十二个；其余 eligible action 继续 fail closed，不 push、不部署或进入下一批。

原 reservation-attribution 模块扩成 ledger/employee-attribution.js，供 reserve／sale／retailSale 复用已有同事务 employee resolver；兼容 employee UUID 别名只进入 policy 视图，不改原请求／fingerprint。有效 session → existing operation → 当前 action policy → revision → employee FOR SHARE → trusted transact 的顺序保持。显式员工归属保留原 gate：sale 需要 staff.record；retailSale 还需要 retail.sale。员工的 principal 关联不能替实际 actor 授权，无账号与同名员工按 UUID 可用，未知／停用员工明确业务拒绝，不留半笔销售或库存。

sales.js 为两个入口增加显式 trusted 分支，保存 actualActorPrincipalId、creditedEmployeeId 和 creditedEmployeeNameSnapshot；销售行／零售订单原 person、employeeId、recordedBy 分别为可信员工姓名快照、UUID 和 session principal。inventory.js:recordInventoryChange 仅在这些销售的显式 trusted 调用中用 context principal／dbNow 记录操作者与时间，其余调用默认保留 demo。零售原有付款字段用 context principal／dbNow，并附 actualActorPrincipalId，成交时仍必须全额多笔付款、room=null；room sale 不发起收款或结账。

只读比较基线确认 prepareSaleRows、validatePayments／validateSettlementPayments、collectPayment 起之后的所有销售业务、submitStock 起之后的库存业务、rules demo 分支及账本请求 fingerprint 代码均保持。未改金额、规格基础数量、历史快照、付款／审核规则、schema、auth、员工 resolver 或 Known Issues；未创建真人员工或账号。

新增销售单元 22 项与真实 MySQL 子用例 26 项。单元及原领域定向命令（见 DEVELOPMENT_ENVIRONMENT）实际 141 total／141 pass／0 fail／0 skip；trusted MySQL 定向实际 123 total／123 pass／0 fail／0 skip。首轮只发现新增测试夹具的权限前置、UUID 别名构造及零库存商品哨兵不正确；仅修正测试，生产业务未因此调整。JS 修改后实际多次尝试 npm test，PowerShell 报 The term 'npm' is not recognized，npm 未启动，未取得 npm 通过证据。

实际只读确认环境变量可读取、MySQL 8.4.11／jbhh_ktv_test／InnoDB，不输出 URL 或密码。沿用 guarded 十表 fixture，仅本次创建／清理已授权表，不 CREATE／DROP database。新增真实测试确认同一调用方 connection、head → account → session → grants → operation → employee → domain／commit，单次冻结 DB 时间、不 touch session 活动；员工归属、篡改拒绝、不占键、五类 auth 失效、三类幂等冲突、旧 revision 终态、历史快照和 null／0 往返保持。撤权与员工改名／停用后，重新连接仍返回原终态，不重做 employee／销售／付款／库存；新 key 授权拒绝。两 action 的 revision／同 key 竞争均实际使用两个不同 CONNECTION_ID，最多提交一次。

人为 employee SELECT 列错误、领域变更后未知 Error、在 head UPDATE／operation INSERT 后触发 audit CHECK 失败，都验证全事务 rollback；原 key 未消耗，修复故障可重试成功，库存／付款不重复。

最终完整 node --test --test-isolation=none 实际 630 total／624 pass／0 fail／6 skip，退出码 0。真实 MySQL auth 29／29（含 revalidation 13／13）、employee 30／30、ledger 11／11、trusted 123／123（含新增销售 26／26）均实际执行且无 skip；原六项 Known Issues 名称与 skip 结论保持。结束后只读核实十张已知 fixture 表均不存在。本批一个独立提交，parent 为 d205f2d；未合入 main、未 push。

## P0-1 Stage 2C.3 trusted serveExtra／otherCharge（2026-10-04）

本轮开始核实干净 main = origin/main = ca5c8722b02765949d07fb79efa83a92badbe979；从该 main 创建 codex/p0-1-stage2c-extra-charge，分支起点严格等于 main HEAD。仅这两个 action 新增 trusted-enabled，当前共十四个，其余 31 个 eligible action 继续 fail closed。基线销售批的 630／624／0／6 是此前验收证据，本轮结果如下。

rules.js 私有 executeOrderAddition 共用原 demo／trusted 命令体，trusted 在演示身份／时间读取前分流；只从 branded context 取得具体 permission、session principal 和冻结 dbNow。serveExtra 沿用 order.serveExtra，只标记既有配品 served／servedBy／servedAt，附 servedByPrincipalId，不重查当前商品、重算套餐或再次扣库存。otherCharge 沿用 order.sale，保持类别、整数分金额、自定义项目和营业中账单校验；新行 person／time 由 context 提供并附 actualActorPrincipalId。两动作原本没有员工归属，不调用 employee resolver、不新增员工映射，历史套餐／商品／价格／规格／数量、库存 null／0、多渠道付款及 room／retail 事实保持。

ledger application／MySQL store、Stage 2A policy、员工 resolver、sales／inventory 和其余领域模块均未修改。有效 session → existing operation → 原终态／actor／fingerprint 判断 → 新 key 当前权限／revision → trusted transact 的链沿用；授权拒绝不占键。首次真实测试发现 auth service 的全小写格式校验拒绝既有 order.serveExtra；仅放行这个准确 ID 的保存／撤销，保留其他校验，不改权限含义或重命名，新增单元回归。未改 schema／migration、依赖、HTTP／UI 或六项 Known Issues。

新增两个动作单元 22 项、权限格式单元回归 1 项及真实 MySQL 子用例 24 项。最终定向 node --test --test-isolation=none ledger/trusted-order-additions.test.js auth/auth.test.js 实际 28 total／28 pass／0 fail／0 skip；guarded trusted MySQL 定向实际 147 total／147 pass／0 fail／0 skip，包含全部既有用例和新增 24 项。JS 修改和最小修复后实际尝试 npm test，PowerShell 报 The term 'npm' is not recognized，npm 进程未启动，未取得 npm 通过证据。

只读连接核实 MySQL 8.4.11／jbhh_ktv_test／InnoDB，环境变量可读，未输出 URL 或密码。沿用十表 fixture，不 CREATE／DROP database，仅创建／清理已授权表。实际确认单 connection、head → account → session → grants → operation → domain／commit、一次冻结 DB 时间、不 touch session activity、篡改无效、不占键、五类 auth 失效和 actor／action／payload／revision 冲突。撤权后新 pool 重连仍返回原终态，不重新标记或收费；新 key 拒绝。每个 action 的 revision 和同 key 竞争均核对两个不同 CONNECTION_ID，最多执行／递增一次；unknown Error 在领域变更后及 audit CHECK 在 head UPDATE／operation INSERT 后故障都完整 rollback，无 state／revision／operation／audit 残留，修复后原 key 成功。

最终完整 node --test --test-isolation=none 实际 677 total／671 pass／0 fail／6 skip，退出码 0。真实 MySQL auth 29／29（含 revalidation 13／13）、employee 30／30、ledger 11／11、trusted 147／147（新增 24／24）均执行且无 skip；原六项 Known Issues 名称与 skip 结论保持。本批只做一个提交，parent 为 ca5c872；main 不前进，不 push、不部署或进入下一批。

## P0-1 Stage 2C.3 trusted exchange（2026-10-04）

本轮先核实 34c2365 的直接 parent = 干净 main@ca5c872，使用 ff-only 将 main 前进至 34c23656b8478ef9f8b99107e5c7c01ad3f4f413，无 merge commit。合入后完整 node --test --test-isolation=none 实际 677 total／671 pass／0 fail／6 skip；MySQL 8.4.11／jbhh_ktv_test／InnoDB 中 auth 29／29（含 revalidation 13）、employee 30／30、ledger 11／11、trusted 147／147 均真实执行。随后 fetch 确认 origin/main 仍为 ca5c872，本地单纯领先 1／0，普通 push 成功；同步后 main = origin/main = 34c2365、0／0、clean。立即从该 main 建立 codex/p0-1-stage2c-exchange，分支起点严格等于 main HEAD。

本批仅 exchange 新增 trusted-enabled，当前十五动作，其他 30 个 eligible action 继续 fail closed。rules.js 私有 executeExchange 复用原 demo／trusted 换酒规则，在演示 user／clock 读取前分流；trusted 只从 branded context 检查 order.exchange、取 session principal 与冻结 dbNow。两笔 recordInventoryChange 显式传递同一 execution，复用已有可信库存 actor／time；换酒记录 person／time 来自 context 并附 actualActorPrincipalId。原动作没有员工归属，不调用 resolver，不重选或改写历史人员快照。

对照同步 main，除显式 execution 参数和稳定 actor 元数据外，原换酒命令体保持。套餐／增购／已存在赠饮行、按实际支数 1:1、同级或向下、数量限制、库存退回／领取、目标行合并／新快照、成交金额和历史快照共用原规则。源库存已在克隆中退回后，目标不足或缺账仍拒绝整笔，不留半状态。inventory.js、sales／rooms／auth／employee、ledger application／store／fingerprint、schema／migration、依赖及六项 Known Issues 均未修改；不迁移 gift／审核、开房、付款、挂账或其他动作。

新增 exchange 单元 16 项、真实 MySQL 子用例 15 项。定向 node --test --test-isolation=none ledger/trusted-exchange.test.js ledger/trusted-clean.test.js rules.test.js inventory.test.js sales.test.js 实际 156 total／155 pass／0 fail／1 skip（该集合原平台券 Known Issue），exchange 16／16 通过。首轮仅新增 demo 对照夹具把保留原 clock 文本的时间误归一化为三位毫秒；修正测试匹配现行 demo 格式，生产时间语义不变。JS 修改后多次实际尝试 npm test，PowerShell 报 The term 'npm' is not recognized，npm 未启动，未取得 npm 通过证据。

trusted MySQL 定向实际 162 total／162 pass／0 fail／0 skip，含新增 exchange 15／15。沿用严格专用库十表 fixture，不 CREATE／DROP database 或扩大清理；仅合成账号。实际验证同一 connection、head → account → session → grants → operation → domain／commit、单次 dbNow、不 touch session activity；三类来源、部分／全部换酒、已有目标合并、原数量／级别拒绝、counted／uncounted／null／0、非库存商品运行时标记和历史快照保持。有效账号撤权后，新 pool 重连取回原终态，不重复库存；新键拒绝且不占键。五类 auth 失效先于 operation 查询；actor／action／payload／revision 冲突保持。两个独立 CONNECTION_ID 的 revision 竞争最多一笔成功，同 key 竞争只执行一次。领域变化后 unknown Error 及 head UPDATE／operation INSERT 后 audit CHECK 故障，均完整回滚 state／revision／operation／audit 和两笔库存；修复后原 key 可成功。

最终完整 node --test --test-isolation=none 实际 708 total／702 pass／0 fail／6 skip，退出码 0。真实 MySQL auth 29／29（含 revalidation 13／13）、employee 30／30、ledger 11／11、trusted 162／162（exchange 15／15）均执行且无 skip；原六项 Known Issues 名称和 skip 保持。结束后只读核实十张 fixture 表均不存在。本批一个独立提交，parent 为 34c2365；main／origin/main 保持该已同步基线，exchange 新提交不 push，不继续下一批或部署。

## P0-1 Stage 2C.3 trusted 房间恢复审批第一批（2026-10-04）

本轮现场核实 clean main = origin/main = ec1071c8521e80403b10558a118d24ae84f615c3，从该 main 直接建立 codex/p0-1-stage2c-room-issue-review，分支起点严格等于 main HEAD。旧 Track A／B 与 PostgreSQL 历史工作树均保留。

本批只新增 approveRoomIssue／rejectRoomIssue trusted-enabled，当前共十七动作，其余 28 个 eligible action 继续 fail closed。rules.js 的显式 trusted 分支在演示 operator／clock 读取前调用 rooms.js:decideRoomIssue；现有 ledger application／store、session revalidation、command-policy 和 Stage 1 fingerprint／revision／terminal replay 协议均未修改。未新增 schema、依赖、真人映射或 policy attributes 模型。

行为用例以有效 synthetic session、room.issue.approve、正确 revision 和锁内待审核恢复申请为前置。decideRoomIssue 从 transact 隔离克隆的 ledger state 按 request ID 读取 submittedByPrincipalId；非本人只需普通审核权，本人还需 review.self。payload 的 submittedBy／submittedByPrincipalId／applicant／selfReview／approver 不能作为事实。缺少或无效稳定申请人字段时抛 AuthorizationDenied，state／revision／operation／成功 audit 均不变，key 不被消耗；旧姓名、演示 ID、employee 关联均不猜映射。批准和驳回新增 decidedByPrincipalId，时间使用冻结 dbNow；decidedBy 仅取可信显示快照，当前 auth actorSnapshot=null，因此为 null，不伪造姓名。原房态恢复、异常字段清空、驳回原因和状态判断共用原命令体；demo 保持原行为。

新增数据库无关契约测试 21 项，以及共用既有十表专用库 fixture 的真实 MySQL 子用例 20 项。定向 node --test --test-isolation=none ledger/trusted-room-issue-review.test.js ledger/trusted-clean.test.js rooms.test.js rules.test.js ledger/command-policy.test.js：157 total／156 pass／0 fail／1 skip（该集合原平台券 Known Issue）。用例验证本人双权限、后台权限不替代审核权、请求伪造、legacy 停写、不占键与后续授予权限重试、可信 principal／DB 时间、原房态业务拒绝终态、demo／trusted 业务对照、无 context／伪造 context、未知异常完整回滚。

现场读取并核对 MySQL 8.4.11／jbhh_ktv_test／InnoDB，未输出 URL 或密码。trusted MySQL 定向 182 total／182 pass／0 fail／0 skip（含新增 20 项）：先通过真实 trusted mark／clear 产生申请，再由另一 session 审核；确认同一 connection 与 head → account → session → current grants → DB time → operation → domain → state／result／audit／COMMIT 顺序。本人缺 review.self、legacy 缺可信 principal、权限不足均回滚且无终态；有效原 actor 撤销审核与自审权后，新 pool 重连仍返回旧结果，新 key 拒绝。账号／session 停用、撤销、过期和凭据版本失效均早于旧回执查询。两个真实独立 CONNECTION_ID 分别验证 approve／reject 基于同一旧 revision 最多一成功，以及同 key 仅决定一次。成功 audit 的 CHECK 故障在 head UPDATE 和 operation INSERT 后触发，完整回滚 state／revision／operation／audit；修复约束后原 key 可重试。首次两处新增审计 revision 断言误用数字，mysql2 按现有 bigNumberStrings 配置返回字符串；只修正测试断言后重新取得通过证据，生产账本未改。

JavaScript 修改后实际尝试 npm test，PowerShell 报 The term 'npm' is not recognized，npm 未启动。最终完整 node --test --test-isolation=none：749 total／743 pass／0 fail／6 skip，退出码 0。MySQL auth 29／29（含 revalidation 13／13）、employee 30／30、ledger 11／11、trusted 182／182 均真实执行、0 skip；原六项 Known Issues 的名称与 skip 保持。结束后只读确认十张 fixture 表均不存在，不 CREATE／DROP database，不操作其他表。

本批仅一个独立提交，parent 为 ec1071c；不进入其他审批或下一批，不 push／部署，不接 HTTP／UI，不修六项 Known Issues。

## P0-1 Stage 2C.3 trusted 库存申请（2026-10-04）

本轮先核实房间恢复审批提交 88a5c1a 的直接 parent 为 ec1071c；clean main 从 ec1071c ff-only 到 88a5c1a，没有 merge commit。合入后完整 node --test --test-isolation=none 实际 749 total／743 pass／0 fail／6 skip，auth 29、employee 30、ledger 11、trusted 182 均真实执行。fetch 后确认 origin/main 未新增、仅本地领先一提交，再普通 push；main = origin/main = 88a5c1a，0／0、clean。旧 Track A／B 和 PostgreSQL 工作树未改。

随后从该 clean main 直接建立 codex/p0-1-stage2c-stock，再次核实新分支 HEAD = main HEAD = 88a5c1a。本批仅增加 stock／consumableStock 到 trusted-enabled，共十九动作，其余 26 个 eligible action 仍 fail closed，特别是 approveInventory／rejectInventory。无新 schema、依赖、员工映射或 policy attributes；ledger application／MySQL store／auth／command-policy 和 Stage 1 指纹、revision、terminal replay 顺序均未改变。

用例以有效 synthetic session、当前对应库存权限、正确 revision 和锁内 inventory／consumables 为前置。rules.js 在 demo operator／clock 求值前传入显式 trusted execution；inventory.js 两个提交函数保留原 item.count === null 判断，期初需 inventory.opening，其他余额包括 0 需 inventory.adjust。私有 inventorySubmission 只从 branded context.permissionIds 精确验权；submittedByPrincipalId 取 session principal，submittedAt 取一次冻结 dbNow，submittedById 留空；submittedBy 仅作 actorSnapshot.displayName 快照，当前为 null，不伪造姓名。payload 申请人、actor、权限、role、clock 或伪造 before／source 不能覆盖真实事实。

原整数库存与 opened 数量、原因截断、同商品待审核阻拦、来源、基础单位及 before／after 字段共用原规则。提交只创建待审核申请，不改变库存余额、opened、流水或通知；count=null 与 0 严格区分。demo 原行为保持。权限不足抛 AuthorizationDenied、完整回滚，不占 operationKey；授予正确权限后原 key 可重试。明确业务拒绝和 revision conflict 仍是 terminal；未知异常不占键。

新增 20 项数据库无关测试与 21 项真实 MySQL 子用例，复用原受保护十表 fixture，没有新增 DDL／清理生命周期。定向 node --test --test-isolation=none ledger/trusted-stock.test.js ledger/trusted-clean.test.js inventory.test.js ledger/command-policy.test.js 实际 113 total／113 pass／0 fail／0 skip。验证锁内 null／0／正数权限选择、申请人及时间、防伪造、拒绝不占键、旧 key 重放与 actor／payload／expectedRevision／action 冲突、失效认证、原数量及待审核规则、demo 对照、不读取演示身份／时间、缺失／复制 context 拒绝和未知异常完整回滚。

现场 MySQL 8.4.11／jbhh_ktv_test／InnoDB 已核实，URL 可读且未输出。真实定向 node --test --test-isolation=none ledger/trusted-clean.integration.test.js auth/mysql-auth.integration.test.js ledger/mysql-store.integration.test.js employees/mysql-roster.integration.test.js：273 total／273 pass／0 fail／0 skip。trusted 203／203，含新增库存 21／21；auth 29／29（revalidation 13／13）、employee 30／30、ledger 11／11 继续执行。申请在同一 connection 依序 head → account → session → 当前 grants → 一次 dbNow → existing operation → domain → state／result／audit／COMMIT；不 touch session activity，也不调用员工 resolver。撤销权限后新 pool 重连仍返回原 terminal、不再生成申请，新 key 拒绝；disabled／revoked／idle／absolute／credential version 失效均先于 operation 查找。

每个动作都使用两个实际不同 CONNECTION_ID 的 MySQL connection 验证不同 key 的同旧 revision 竞争：一笔 committed、一笔 revision-conflict、仅一申请和一次 revision；同 key 竞争只执行一次。未知异常以及 head UPDATE 和 operation INSERT 后成功 audit 的 CHECK SQL 故障均完整回滚 state／库存／申请／revision／operation／audit；修复故障后原 key 成功。零售 room=null、未知历史名称／价格／规格和基础数量快照、counted=false 旧流水保持。

JavaScript 修改后实际尝试 npm test，PowerShell 报 The term 'npm' is not recognized，进程未启动，未取得 npm 通过证据。最终完整 node --test --test-isolation=none：790 total／784 pass／0 fail／6 skip，退出码 0；上述全部 MySQL 套件真实执行且 0 skip，原六项 Known Issues 名称与 skip 保持。测试结束后只读确认十张 fixture 表均不存在，不 CREATE／DROP database，不操作其他表。

本批仅一个独立提交，parent 为 88a5c1a；main／origin/main 保持已同步基线，新提交不 push，不进入库存审批或下一批，不部署。不改变库存业务规则或 Known Issues，无范围偏离。

## P0-1 Stage 2C.3 trusted 库存审批（2026-10-04）

本轮先核实 ed2257f 的直接 parent 为 88a5c1a；clean main 从 88a5c1a ff-only 到 ed2257f，没有 merge commit。合入后完整 node --test --test-isolation=none 实际 790 total／784 pass／0 fail／6 skip，auth 29、employee 30、ledger 11、trusted 203 均真实执行。fetch 后确认 origin/main 无新增、仅本地领先一提交，再普通 push；main = origin/main = ed2257f，0／0、clean。旧 Track A／B 与 PostgreSQL 工作树未改。

随后从该 clean main 直接建立 codex/p0-1-stage2c-inventory-review，核实初始分支 HEAD = main HEAD = ed2257f。本批仅增加 approveInventory／rejectInventory 到 trusted-enabled，共二十一动作；其他 24 个 eligible action 继续 fail closed。未新增 schema、依赖、员工映射或 policy attributes；ledger application／MySQL store／auth／command-policy 和 Stage 1 指纹、revision、terminal replay 顺序不变。

用例前置为有效 synthetic session、当前具体审批权限、正确 revision 与锁内待审 inventoryReviews。rules.js 在 demo actor／clock 求值前传入显式 trusted execution；inventory.js:decideInventory 从锁定 head 的隔离 state 按 request ID 找申请，只认申请的 submittedByPrincipalId，与 context.principalId 相等时必须同时满足 inventory.approve 与 review.self。非本人仍需 inventory.approve；backend.view、库存期初／调整权限、自审权限单独均不能代替。payload 的 applicant、submittedBy／submittedByPrincipalId、selfReview、approver、actor、permissions、role、clock 不能覆盖授权事实。缺失或无效 principal 字段的 legacy 待审申请，批准与驳回均抛 AuthorizationDenied、完整回滚且不占 operationKey，不按姓名、旧演示 ID 或员工关联补映射。

批准与驳回都保存 decidedByPrincipalId = session actor，decidedAt 只用冻结 dbNow；decidedBy 仅作可信显示快照，当前为 null。批准流水／通知附 submittedByPrincipalId、reviewedByPrincipalId，原 person、reviewedBy 只作显示，历史记录不改写。原库存严格 before 比较、null／0、opened、delta、基础单位、数量变化、原因截断、批准／驳回和 demo 回调共用原规则。

首轮真实 MySQL 定向测试实际 297 total／286 pass／11 fail／0 skip，发现饮品批准通知的 openedBefore／openedAfter 为 undefined，严格账本 JSON 快照拒绝提交。最小修复仅在新 trusted 通知中省略这两个未定义字段，保持既有 JSON 持久化省略语义，不赋 0／null 或伪造开封数量；demo 保持原结构。新增 JSON-safe 往返回归，未修改快照编码器或库存计算。

新增 23 项数据库无关测试与 24 项真实 MySQL 子用例，复用原受保护十表 fixture，没有新增 DDL／清理生命周期。定向 node --test --test-isolation=none ledger/trusted-inventory-review.test.js ledger/trusted-stock.test.js ledger/trusted-clean.test.js inventory.test.js ledger/command-policy.test.js 实际 136 total／136 pass／0 fail／0 skip。验证本人双权限、非本人权限、payload 防伪造、legacy fail closed、不占键、撤权重放与 actor／payload／expectedRevision／action 冲突、失效认证、原 null／0／正数／opened／基础单位规则、demo 对照、缺失／复制 context 拒绝及未知异常完整回滚。

现场 MySQL 8.4.11／jbhh_ktv_test／InnoDB 已核实，URL 可读且未输出。修复后真实定向 node --test --test-isolation=none ledger/trusted-clean.integration.test.js auth/mysql-auth.integration.test.js ledger/mysql-store.integration.test.js employees/mysql-roster.integration.test.js：297 total／297 pass／0 fail／0 skip。trusted 文件 227／227，含新增库存审批 24／24；auth 29／29（revalidation 13／13）、employee 30／30、ledger 11／11 继续真实执行。成功证据来自原 trusted stock／consumableStock 创建的真实申请，再由另一 principal 审批，在同一 connection 依序 head → account → session → 当前 grants → 一次 dbNow → existing operation → domain → state／result／audit／COMMIT；不 touch session activity，不调用员工 resolver。撤权后重建 pool 返回原 terminal、不重复数量变化或流水，新 key 拒绝；disabled／revoked／idle／absolute／credential version 失效均先于 operation 查找。

两种库存均使用两个实际不同 CONNECTION_ID 的 MySQL connection 验证同 key 竞争只执行一次，以及 approve／reject 基于同旧 revision 的竞争：一笔 committed、一笔 revision-conflict、只产生一次业务变化与 revision。未知异常在领域变化后完整回滚；真实成功 audit CHECK SQL 故障在 head UPDATE 和 operation INSERT 后触发，验证余额、opened、申请、流水／通知、revision、operation、audit 全部回滚，修复后原 key 可重试。retail.room=null、未知历史名称／价格／规格和基础数量快照、count=null／0 以及 counted=false 的旧流水保持。

JavaScript 修改后实际尝试 npm test，PowerShell 报 The term 'npm' is not recognized，进程未启动，未取得 npm 通过证据。最终完整 node --test --test-isolation=none：837 total／831 pass／0 fail／6 skip，退出码 0；全部上述 MySQL 套件真实执行且 0 skip，原六项 Known Issues 名称与 skip 保持。测试结束只读确认十张 fixture 表均不存在，不 CREATE／DROP database，不操作其他表。

本批仅一个独立提交，parent 为 ed2257f；main／origin/main 保持已同步基线，新提交不 push，不进入其他审批或下一批，不部署。无业务规则变更或范围偏离。

## P0-1 Stage 2C.3 trusted gift 提交（2026-10-04）

本轮先核实库存审批提交 2f53c8f 的直接 parent 为 ed2257f；clean main 从 ed2257f ff-only 到 2f53c8f，没有 merge commit。合入后完整 node --test --test-isolation=none 实际 837 total／831 pass／0 fail／6 skip，auth 29、employee 30、ledger 11、trusted 227 均真实执行。fetch 后确认 origin/main 无新增、仅本地领先一提交，再普通 push；main = origin/main = 2f53c8f，0／0、clean。旧 Track A／B 与 PostgreSQL 工作树未改。

随后从该 clean main 直接建立 codex/p0-1-stage2c-gift，核实初始分支 HEAD = main HEAD = 2f53c8f。本批只增加 gift 到 trusted-enabled，共二十二动作；其他 23 个 eligible action 仍 fail closed，特别是 approveGift／rejectGift。原赠酒无员工归属输入，不接 resolver、不改写现有订单 credited employee；显式 creditedEmployeeId 保持 Stage 2A 的 invalid-attribution 拒绝，不借员工给 actor 授权。没有新增 schema、依赖、真实账号／映射或 policy attributes；ledger application／MySQL store／auth／command-policy 及 Stage 1 指纹、revision、terminal replay 顺序均未改变。

用例前置为有效 synthetic session、当前 order.gift、正确 revision、营业中订单及对应原赠酒商品／增购额度。使用 tdd 技能在既有公开 trusted 命令边界先跑首条测试，实际 1 total／0 pass／1 fail／0 skip，原因为 trusted-action-not-enabled；最小迁移后取得通过。rules.js 在 demo actor／clock 求值前分流到私有 executeGift，demo 与 trusted 共用原正整数、商品参与赠酒、half 规格、增购与待确认额度规则；grantBonus 只增加显式 execution 参数，复用原库存管道。没有修改原赠送金额、数量、库存基础单位或审批状态规则。

超额 giftRequest 保持待确认，新增 submittedByPrincipalId = session principal；requestedBy 只取可信 actorSnapshot.displayName（当前 null），requestedById 留空；submittedAt／time 用同连接重验冻结 dbNow。payload actor、principal、user、permissions、role、clock、requestedBy／requestedById 或 submittedByPrincipalId 均不能覆盖。额度内 bonusGift 附 actualActorPrincipalId，person 使用 session principal，requestedBy 仅显示快照；库存流水显式使用同一 context 的 actor／dbNow。纯待确认不扣库存，混合请求只扣原额度内部分；count=null／0、counted、managed／unmanaged、半打基础数量、商品／规格／参考值快照、不增加应收和未审核前状态均保持。历史名称／未知价格／规格／基础数量、订单员工快照、付款和房态不改写。

新增 14 项数据库无关测试与 14 项真实 MySQL 子用例，复用原受保护十表 fixture，没有新增 DDL／清理生命周期。gift 单元实际 14／14；定向 node --test --test-isolation=none ledger/trusted-gift.test.js ledger/trusted-clean.test.js rules.test.js inventory.test.js sales.test.js ledger/command-policy.test.js：167 total／166 pass／0 fail／1 skip，保留原 rules 的平台券 Known Issue。覆盖额度内／超额／混合／已赠／已有待确认额度、库存不足和原商品／数量拒绝、trusted 与 demo 对照、可信申请人／时间、防伪造、不占键／授予权限后同 key 重试、撤权重放、认证失效、指纹冲突、缺失／复制 context、原参考值快照及未知异常回滚。

现场 MySQL 8.4.11／jbhh_ktv_test／InnoDB 已核实，连接 URL 可读且未输出。真实定向 node --test --test-isolation=none ledger/trusted-clean.integration.test.js auth/mysql-auth.integration.test.js ledger/mysql-store.integration.test.js employees/mysql-roster.integration.test.js：311 total／311 pass／0 fail／0 skip。trusted 文件 241／241，含新 gift 14／14；auth 29／29（revalidation 13／13）、employee 30／30、ledger 11／11 均继续真实执行。单一 connection 中 head → account → session → 当前 grants → 一次 dbNow → existing operation → domain → state／result／audit／COMMIT；不 touch session activity，不读取员工。撤权后新 pool 重连返回原 terminal、不重复赠送／扣库／申请，新 key 拒绝；disabled／revoked／idle／absolute／credential version 失效先于 operation 查找；原 actor／action／payload／expectedRevision 冲突保持。

真实同 key 和不同 key 的同旧 revision 竞争均验证两个不同 CONNECTION_ID：同 key 只执行一次；不同 key 一笔 committed、一笔 revision-conflict，只增加一次 revision、一次库存扣减、一次直接赠送和一条超额申请。未知异常在领域变更后完整回滚；成功 audit CHECK SQL 故障在 head UPDATE 和 operation INSERT 后触发，验证库存／赠送／申请／state／revision／operation／audit 全部回滚，修复后原 key 可重试。即使具备 gift.approve 与 review.self，新可信申请的 approveGift／rejectGift 仍被未迁移门拒绝、不占键。

JavaScript 修改后实际尝试 npm test，PowerShell 报 The term 'npm' is not recognized，进程未启动，未取得 npm 通过证据。最终完整 node --test --test-isolation=none：865 total／859 pass／0 fail／6 skip，退出码 0；以上 MySQL 套件全真实执行、0 skip，原六项 Known Issues 名称与 skip 保持。测试后只读确认十张 fixture 表均不存在，不 CREATE／DROP database，不操作其他表。

本批只做一个独立提交，parent 为 2f53c8f；main／origin/main 保持已同步基线，新提交不 push，不进入 gift 审批或其他下一批，不部署。无范围偏离。

## P0-1 Stage 2C.3 trusted gift 审批（2026-10-04）

本轮先核实已验收 gift 提交 048cd23 的直接 parent 为 2f53c8f；clean main 从 2f53c8f ff-only 到 048cd23，没有 merge commit。合入后完整 node --test --test-isolation=none 实际 865 total／859 pass／0 fail／6 skip，auth 29、employee 30、ledger 11、trusted 241 均真实执行。fetch 后确认 origin/main 无新增、仅本地领先一提交，再普通 push；main = origin/main = 048cd23，0／0、clean。旧 Track A／B 与 PostgreSQL 工作树未改。

随后从 clean main 直接建立 codex/p0-1-stage2c-gift-review，核实初始分支 HEAD = main HEAD = 048cd23。本批只新增 approveGift／rejectGift 到 trusted-enabled，共二十四动作；其他 21 个 eligible action 仍 fail closed。未新增 schema、依赖、真实账号／映射、岗位或 policy attributes 限制；ledger application／MySQL store／auth／command-policy 及 Stage 1 fingerprint、revision、terminal replay 顺序均未改变。

用例以有效 synthetic session、当前 gift.approve、正确 revision、锁内营业中订单和待确认 giftRequest 为前置。rules.js 在 demo actor／clock 求值前分流到私有 executeGiftDecision；只按该申请的 submittedByPrincipalId 比较 context.principalId，本人还需 review.self。payload 的申请人／selfReview／approver、身份、权限、role、clock、商品或数量均不能覆盖锁内事实；legacy 缺失或无效的稳定 principal，两动作均抛 AuthorizationDenied，不改 state／revision，不写 terminal／success audit，不占 key，不按姓名、旧演示 ID 或员工关系猜映射。

两动作保存 decidedByPrincipalId = session actor，decidedAt 只取冻结 dbNow，decidedBy 仅取可信显示快照（当前 null），原 requestedBy 快照保留。批准复用原 grantBonus 及库存管道，显式传同一 execution；新赠送／流水的 actual actor 与 time 来自 context。原请求数量、half 规格、当前目录用于新赠送快照、库存 null／0／counted、赠送不增加应收、原申请及历史记录均保持。驳回不扣库、不生成赠送；demo 原行为保持，无员工 resolver。

使用 tdd 技能在既有公开 trusted ledger 边界先跑首条用例：1 total／0 pass／1 fail／0 skip，原因为 trusted-action-not-enabled；最小接入后通过。新增 24 项数据库无关测试与 25 项真实 MySQL 子用例，复用原受保护十表 fixture，没有 DDL／清理范围变化。定向 node --test --test-isolation=none ledger/trusted-gift-review.test.js ledger/trusted-gift.test.js ledger/trusted-clean.test.js rules.test.js inventory.test.js ledger/command-policy.test.js 实际 183 total／182 pass／0 fail／1 skip，保留原 rules 平台券 Known Issue。验证本人双权限、非本人具体权限、legacy／伪造拒绝、不占键与补权限后同键成功、认证失效、指纹冲突、原领域拒绝／库存／JSON 快照和 demo 对照。

首轮真实 MySQL 实际 336 total／334 pass／2 fail／0 skip：新增赠酒审批 25／25 均通过，但一条旧 stock 用例仍把本批 gift 审批视为未迁移，使子用例及父套件失败。仅更新该门禁断言为当前 missing-permission，继续验证库存权限不能取得 gift 审批权；生产实现未因此改变。重跑真实定向 node --test --test-isolation=none ledger/trusted-clean.integration.test.js auth/mysql-auth.integration.test.js ledger/mysql-store.integration.test.js employees/mysql-roster.integration.test.js：336 total／336 pass／0 fail／0 skip；trusted 266／266（新增审批 25／25）、auth 29／29（revalidation 13／13）、employee 30／30、ledger 11／11 全真实执行。现场 MySQL 8.4.11／jbhh_ktv_test／InnoDB 已核实，URL 可读但不输出。

成功用例先由有效申请人通过 trusted gift 创建真实申请，再由另一 session principal 审批；同一 connection 中 head → account → session → 当前 grants → 一次 dbNow → existing operation → domain → state／result／audit／COMMIT，不 touch session activity，不读取 employee。撤权并新建 pool 重连后原 actor 返回原终态、不会重新赠送／扣库／改变决定，新 key 拒绝；disabled／revoked／idle／absolute／credential version 失效均先于 operation 查找。相同 key 的 actor／action／payload／expectedRevision 冲突保持。

批准和驳回的同 key 竞争、approve／reject 的同旧 revision 竞争均验证两个实际不同 CONNECTION_ID：同 key 只执行一次；不同 key 一笔 committed、一笔 revision-conflict，只产生一次决定、revision、库存／赠送变化。未知异常在领域变化后完整回滚；真实 success audit CHECK SQL 故障在 head UPDATE 和 operation INSERT 后触发，验证申请、赠送、库存／流水、state、revision、operation、audit 全部回滚，修复后原 key 可重试。retail.room=null、count=null／0、历史未知价格／名称／规格／基础数量及原员工归属保持。

JavaScript 修改后实际尝试 npm test，PowerShell 报 The term 'npm' is not recognized，进程未启动，未取得 npm 通过证据。最终完整 node --test --test-isolation=none：914 total／908 pass／0 fail／6 skip，退出码 0；上述 MySQL 套件全真实执行且 0 skip，原六项 Known Issues 的名称及 skip 与本轮 main 回归一致。测试后只读确认十张 fixture 表均不存在，不 CREATE／DROP database，不操作其他表。

本批仅一个独立提交，parent 为 048cd23；main／origin/main 保持已同步基线，新提交不 push，不进入下一批，不部署。赠酒业务规则不变，无范围偏离。

## P0-1 policy attributes 基础（2026-10-04）

先核实 8fdba43 的直接 parent 为 048cd23，ff-only 合入 main；本次在 main 实际运行完整回归 914 / 908 / 0 / 6，真实 MySQL 全部执行。fetch 后确认远端无新增，普通 push 完成 main = origin/main = 8fdba43、0/0、clean。随后从该 HEAD 创建 codex/p0-1-auth-policy-attributes，本批只有属性基础设施，不开放新的业务 action。

新增 004_mysql_auth_policy_attributes.sql：InnoDB auth_policy_attributes、auth_accounts.policy_attributes_configured 默认 0、auth_events 的 actual actor／target 属性变更审计。未配置返回 false/null；显式 configure 后可返回 true/[]。configure／grant／revoke 位于独立 auth/policy-attributes.js；实际内部 actor 与 target 分开校验，两者 account 按 UUID 升序锁定，变更与事件同事务，重复变更不增加事件；grant／revoke 要求先配置。未配置却已有异常属性行时 configure 拒绝且不改状态，不静默采纳未经审计的属性；合成及真实数据库回归均覆盖。当前唯一支持的属性 rounding.self.excess 保持既有表达，不替代审核权限或 review.self。

同事务 revalidation 当前读 account 配置标志、grants 和属性集合，按 account → session → grants → attributes 取一次 DB UTC，创建可信 principal/context。只使用调用方 connection，不管理事务、不 touch session 活动；已配置空集合明确区分于未配置，字段缺失／集合不一致／未知属性停写失败，不从请求、姓名或演示 role 补全。真实账号停用与已有撤销／过期／凭据版本规则保持；API 仍是内部管理能力，未接管理授权、HTTP 或 UI，不创建真人账号／属性配置。

实际测试证据（total / pass / fail / skip）：

- 按项目规则尝试 npm test；PowerShell 报 The term 'npm' is not recognized，npm 未启动，未取得 npm test 证据。
- node --test --test-isolation=none auth/policy-attributes.test.js auth/session-revalidation.test.js：31 / 31 / 0 / 0。
- 上述两文件加原十套已迁移 trusted 单元 fixture：269 / 269 / 0 / 0；仅为合成数据库 port 增加明确未配置标志与空属性查询，业务断言不改。
- 专用库 jbhh_ktv_test，MySQL 8.4.11 / InnoDB：四套真实 MySQL 回归共 350 / 350 / 0 / 0；auth 43/43（保留原 29，含 revalidation 13；新增 attributes 14）、employee 30/30、ledger 11/11、trusted 266/266。
- 新 14 项验证了 004 实际执行与重复执行拒绝、默认／空集合、即时 grant/revoke 与重复安全、actual actor／target 及 DB UTC 无秘密审计、停用／未知账号、旧 REPEATABLE READ 快照后的当前读、只读连接能力／冻结时间、配置与 grant/revoke 的双向并发顺序、双连接重复 grant、交叉 actor／target 稳定锁序、配置／grant／revoke 审计 SQL 故障完整 rollback、FK／唯一／shape 约束与原 rounding 属性表达。并发实际比较不同 CONNECTION_ID，不用单连接模拟。
- 完整 node --test --test-isolation=none：936 / 930 / 0 / 6，退出码 0；skip 仍仅原六项 Known Issues，没有数据库 skip。

测试只在核实的专用库创建/迁移/清理本轮 fixture 拥有的表；auth 六表、employee 八表、trusted 十一表，未 CREATE/DROP database。历史 002/003、rules.js、ledger application/store、指纹、operationKey、revision、终态 replay 及 trusted-enabled 二十四动作均不改；没有新增生产依赖、岗位限制、真人映射、业务 action、部署或本批 push。

## P0-1 Stage 2C.3 expense 申请创建（2026-10-04）

先核实 b5ba5a8 直接 parent 为 8fdba43，ff-only 合入 main，没有 merge commit。本次 main 完整回归实际 936 / 930 / 0 / 6，MySQL 8.4.11 / jbhh_ktv_test / InnoDB 真实执行；fetch 确认远端仍为 8fdba43 后普通 push，main = origin/main = b5ba5a8、0/0、clean。随后从该 HEAD 创建 codex/p0-1-stage2c-expense，起点等于 main HEAD。

本批只把 expense 加入 trusted-enabled，共二十五动作；其余二十个 eligible action 仍拒绝。rules.js 在 demo operator／clock 求值前分流到 expenses.js:submitExpense 的显式 trusted 模式。expense.create、session principal 和冻结 dbNow 只取 branded context；新 state.expenses[] 保存 submittedByPrincipalId，submittedById 留空，person 只取可信显示快照（当前 null），time 为 dbNow。原 data.date 是业务输入，不改为数据库当天；原金额、用途、付款方式、支出性质、凭证截断、报销超过 500 元进入待老板审批等创建规则不变。没有员工归属，不接 resolver、不推断真人；未迁移 approveExpense／rejectExpense 或采购，也未建立新的老板审批授权。

实际测试证据（total / pass / fail / skip）：

- npm test 在 JavaScript 修改后实际尝试两次，PowerShell 报 The term 'npm' is not recognized，npm 未启动，未取得该命令通过证据。
- node --test --test-isolation=none ledger/trusted-expense.test.js：16 / 16 / 0 / 0；新增单元契约涵盖 session 身份、业务字段与 demo 对照、伪造无效、授权拒绝不占键、授予权限后同 key 重试、撤权重放、认证失效、指纹冲突、业务终态、未知故障、竞争、缺失 context 与未迁移动作拒绝。直接领域入口用 getter 验证不读取 state.user／permissions／clock。
- node --test --test-isolation=none ledger/trusted-expense.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js operations.test.js：104 / 104 / 0 / 0，原业务矩阵保持。
- 四套真实 MySQL：node --test --test-isolation=none auth/mysql-auth.integration.test.js employees/mysql-roster.integration.test.js ledger/mysql-store.integration.test.js ledger/trusted-clean.integration.test.js，364 / 364 / 0 / 0。auth 43/43（保留 revalidation 13/13 与原 auth 用例）、employee 30/30、ledger 11/11、trusted 280/280；新增 expense 14/14。
- 首次完整回归 966 / 958 / 2 / 6：两条旧赠酒单元用例仍认为 expense 未迁移，实际正确拒绝但原因是 missing-permission。仅更新这两处门禁断言，继续验证 gift 权限不能取得 expense.create；赠酒实现不改。修正定向 expense／gift／gift-review 三文件 54 / 54 / 0 / 0。
- 最终完整 node --test --test-isolation=none：966 / 960 / 0 / 6，退出码 0；上述 MySQL 套件全部真实执行。逐项对照本轮 main 回归，六项 Known Issues 的名称及 skip 完全相同，无数据库 skip。

真实数据库验证一次借连接、head → account → session → grants → dbNow → operation → transact → state／result／audit／COMMIT；revalidation 不更新 session activity。撤权后新建 pool 重连返回已存终态、不再次创建报销，新 key 授权拒绝且不占键；disabled／revoked／idle／absolute／credential version 失效均在 lookup 前拒绝。两种竞争比较了两个不同 CONNECTION_ID：同 key 只执行一次，不同 key 基于旧 revision 得到一成功／一 revision-conflict。未知异常在领域变化后回滚；实际 audit CHECK SQL 故障在 head UPDATE／operation INSERT 后触发，state／revision／operation／audit 完整回滚，修复后原 key 可重试。retail.room=null、count=null／0、历史商品／付款／报销快照与关联采购不变。

复用受保护十一表 fixture，无新增表或 migration；测试结束只读确认这些表均不存在，没有 CREATE／DROP database 或操作无关表。ledger application／store、auth 实现、command-policy、fingerprint、operationKey、revision 与 terminal replay 不改，无新增生产依赖或真人属性配置。本批仅一个独立提交、parent b5ba5a8；main／origin/main 保持已同步基线，新提交不 push，不进入 expense 审批或下一批，不部署，无范围偏离。

## P0-1 Stage 2C.3 expense 审批（2026-10-05）

先核实 ec467a8 直接 parent 为 b5ba5a8，ff-only 合入 main，没有 merge commit。main 完整回归实际 966 / 960 / 0 / 6，MySQL 8.4.11 / jbhh_ktv_test / InnoDB 真实执行；fetch 确认远端仍为 b5ba5a8 后普通 push，main = origin/main = ec467a8、0/0、clean。随后从该 HEAD 创建 codex/p0-1-stage2c-expense-review，起点等于 main HEAD；旧 Track A 与 PostgreSQL 工作树保留。

本批只将 approveExpense／rejectExpense 加入 trusted-enabled，共二十七动作，其余十八个 eligible action 仍拒绝。expenses.js:decideExpense 在显式 trusted 分支读取锁内申请 principal 与保存金额：expense.approve 必需，本人另需 review.self；严格 >50000 分还需已配置 expense.approval.boss。未配置／空集合不满足大额审核，≤50000 不需 boss 属性。legacy／采购关联旧记录缺少可信 principal 或未知金额无法判定阈值时授权拒绝，不猜姓名／演示岗位／payload，不占 key。决定写 decidedByPrincipalId，approver 只取可信显示快照，approvedAt 只取 dbNow。原待老板审批校验、金额、日期、批准／驳回及关联采购状态同步不改；≤500 元正常创建仍为已记录，低额审批测试显式以待审记录为前提，不扩大状态机。

新增 005_mysql_expense_approval_attribute.sql 只扩展 004 的两个具体属性 CHECK；旧 004 不改写。属性管理 API、可信 principal 工厂及当前读接受明确 expense.approval.boss，rounding.self.excess 继续兼容；没有真人配置。005 实际执行成功，重复替换两次保留配置、原属性与审计；DDL 各条独立提交，部分故障需检查，不能当整体可回滚事务。

实际测试证据（total / pass / fail / skip）：

- JavaScript 修改后尝试 npm test；PowerShell 报 The term 'npm' is not recognized，npm 未启动，未取得 npm test 通过证据。
- 新审批单元 node --test --test-isolation=none ledger/trusted-expense-review.test.js：30 / 30 / 0 / 0。先验证未迁移门禁和未支持 boss 属性的真实失败，再做最小实现。最终七文件定向集合见 DEVELOPMENT_ENVIRONMENT：166 / 166 / 0 / 0。
- 四套真实 MySQL 回归：auth/mysql-auth.integration.test.js、employees/mysql-roster.integration.test.js、ledger/mysql-store.integration.test.js、ledger/trusted-clean.integration.test.js：395 / 395 / 0 / 0。auth 45/45（原 revalidation 13 保留、attributes 新增两项）；employee 30/30、ledger 11/11、trusted 309/309（新增审批 29/29）。均在已核实的专用 MySQL 8.4.11 / InnoDB 执行，没有数据库 skip。
- 最终完整 node --test --test-isolation=none：1028 / 1022 / 0 / 6，退出码 0；六项 Known Issues 名称和 skip 与本轮 main 回归相同，没有修复或提升为通过。

真实数据库验证 head → account → session → 当前 grants／attributes → 单次 DB UTC → existing operation → 新 key 验权与领域决定 → state／result／audit／COMMIT，只有一条连接，认证不 touch 活动。撤销 permission 或 boss 后新 pool 重连，原 actor 同请求返回旧终态、不再执行；新 key 使用另一待审记录验证授权拒绝、不消耗 key，修复授权可原 key 重试。disabled／revoked／idle／absolute／credential version 失效先于 lookup 拒绝。两动作的同 key 竞争及 approve／reject 旧 revision 竞争实际比较不同 CONNECTION_ID，后者为两 session principal，只有一个提交。未知领域故障及实际 audit CHECK SQL 故障均验证 state／revision／operation／audit 完整回滚、恢复后原 key 重试；属性 grant／revoke 的审计 SQL 故障也验证组合回滚。原历史快照、retail.room=null、inventory.count=null／0、库存／付款不变。

受保护 fixture 仍只管理本轮创建的 auth 六表、employee 八表、trusted 十一表；没有 CREATE／DROP database 或操作无关表。ledger application／store、fingerprint、operationKey、revision、terminal replay 与 auth 锁序均不改，没有新生产依赖、HTTP／UI、真人映射、procurement 或其他新 action。只做本批一个提交，parent ec467a8；main／origin/main 保持同步 ec467a8，新提交不 push、不进入下一批、不部署，无范围偏离。

## P0-1 Stage 2C.3 credit 申请创建（2026-10-05）

先核实 1a05549 直接 parent 为 ec467a8，ff-only 合入 main，无 merge commit。本次 main 完整 node --test --test-isolation=none 实际 1028 / 1022 / 0 / 6，全部 MySQL suite 真实执行；fetch 确认远端仍为 ec467a8 后普通 push，main = origin/main = 1a05549、0/0、clean。随后从此 HEAD 创建 codex/p0-1-stage2c-credit，起点等于当前 main；旧 Track A／PostgreSQL 工作树不改动。

本批只增加 credit，trusted-enabled 共二十八动作，其他十七个 eligible action 仍拒绝。rules.js 在 demo operator／clock 求值前按原订单与营业中状态校验，调用 sales.js:applyCredit 的显式 trusted 模式并复用原 release。credit.apply、session principal、dbNow 只取 branded context；order.credit 新增 submittedByPrincipalId，submittedById 留空，person 只作可信显示快照（当前 null），submittedAt／24 小时 due 使用同一冻结时间。顾客姓名／手机号／备注／签名仍为业务输入；金额只取原未收余额、历史归属快照、approver 路由标签、待审批及房态释放不改。无 employee resolver，不判断 manager／boss 属性，不迁移 approve／reject／回款或付款。

实际测试证据（total / pass / fail / skip）：

- 首个公共 trusted 契约先因 trusted-action-not-enabled 真实失败，再完成最小分流后通过。最终 credit 单元：16 / 16 / 0 / 0，覆盖当前身份、原字段／金额／期限、伪造无效、key 复用、重放／冲突／认证失效、原业务拒绝、未知故障和其余动作 fail closed。直接领域 getter 验证不读 state.user／permissions／clock。
- JavaScript 修改后实际尝试 npm test；PowerShell 报 The term 'npm' is not recognized，npm 未启动，没有该命令通过证据。
- DEVELOPMENT_ENVIRONMENT 的七文件定向：143 / 139 / 0 / 4；四项 skip 是该集合原 Known Issues，不改结论。
- 四套真实 MySQL：auth/mysql-auth.integration.test.js、employees/mysql-roster.integration.test.js、ledger/mysql-store.integration.test.js、ledger/trusted-clean.integration.test.js：409 / 409 / 0 / 0。auth 45/45（revalidation 13 保留）、employee 30/30、ledger 11/11、trusted 323/323（新 credit 14/14）；MySQL 8.4.11 / jbhh_ktv_test / InnoDB 全部实际执行，无数据库 skip。
- 最终完整 node --test --test-isolation=none：1058 / 1052 / 0 / 6，退出码 0；逐项比较本轮 main 日志，六项 Known Issues 名称与 skip 完全一致。

真实 MySQL 验证单连接 head → account → session → 当前 grants／attributes → 一次 DB UTC → operation → trusted transact → state／result／audit／COMMIT，revalidation 不 touch 活动。未配置属性即可合法提交，包括原高额路由；顾客身份不替代操作者或授权。撤权后新 pool 重连取回原终态、不重新创建或重复释放；新 key 当前权限不足不占键。disabled／revoked／idle／absolute／credential version 失效先于 lookup 拒绝；actor／payload／action／revision 指纹冲突保持。两种竞争实际核对两个不同 CONNECTION_ID：同 key 一次执行／一个 audit，不同 key 旧 revision 一成功／一 revision-conflict。未知异常在申请与房态变化后回滚；实际 audit CHECK SQL 故障在 head UPDATE／operation INSERT 后验证 state、room、revision、operation、audit 全回滚，修复后原 key 重试成功。

复用受保护十一表 fixture，无新 migration、表或生产依赖；未 CREATE／DROP database，不操作无关表。ledger application／store、fingerprint、operationKey、revision、terminal replay、auth／attributes 实现、审批与六项 Known Issues 不改。只做本批一个提交，parent 1a05549；main／origin/main 保持已同步基线，新提交不 push、不进入 credit 审批或下一批、不部署，无范围偏离。

## P0-1 Stage 2C.3 credit approve／reject（2026-10-05）

先确认 96a363f 的直接 parent 为 1a05549，ff-only 合入 main，无 merge commit；本次 main 完整 node --test --test-isolation=none：1058 / 1052 / 0 / 6，MySQL 真实执行。fetch 确认 origin/main 无新增后普通 push，main = origin/main = 96a363f、0/0、clean。随后从此 HEAD 创建 codex/p0-1-stage2c-credit-review；旧 Track A／PostgreSQL 工作树未改动。

本批只新增 approve／reject 作为 credit decision，trusted-enabled 共三十项，其余十五个 eligible action 仍拒绝。rules.js 在 demo operator／clock 求值前分流到 sales.js:decideCredit 的显式 trusted 分支。锁内 order.credit.submittedByPrincipalId 与 session principal 比较；必须 credit.approve，本人另需 review.self。配置后的 credit.approval.manager 或 boss 可决定≤1000 元，>1000 元仅 boss，两动作保留相同分级；approver 仍是原保存审批级别，不是审核人身份。保存金额和路由级别未知／矛盾时授权拒绝，不猜值、不按当前余额重算；legacy 无可信 applicant 两动作都拒绝、不占 key。姓名／旧 USERS／员工关系／payload 不提供 principal 或属性。

决定新增 decidedByPrincipalId，decisionBy 只取可信显示快照（当前 null），decisionAt 取同一冻结 dbNow；原批准转已挂账、驳回归档含稳定决定 ID 的申请后清除当前 credit／转营业中、不抢占已释放房间的语义保持。金额、期限、顾客输入、历史快照、payment、库存均不改。006_mysql_credit_approval_attributes.sql 仅在 005 后增量扩展两个具名 metadata CHECK，支持两项具体属性；不新增表、真人配置或生产依赖，旧 004／005 不改。

实际证据（total / pass / fail / skip）：

- 首个新增公开 trusted 审批用例先因 principal 工厂尚不支持 manager 属性失败；最小接入后通过。最终 credit review 单元 31 / 31 / 0 / 0，包含两个动作分级／本人资格、未知或矛盾保存事实、payload／legacy 拒绝、不占键、重放／冲突、失败原子性、demo 业务对照及直接领域 getter 不读演示身份／时钟。
- 修改 JavaScript 后实际尝试 npm test；PowerShell 报 The term 'npm' is not recognized，npm 未启动。DEVELOPMENT_ENVIRONMENT 所列十一文件定向 Node 回归：238 / 234 / 0 / 4，四项为原 Known Issues 子集。
- 四文件真实 MySQL 回归：443 / 443 / 0 / 0；auth 47/47（原认证 16、revalidation 13、旧属性 16 保留，新增属性用例 2），employee 30/30、ledger 11/11、trusted 355/355（新 credit review 32/32）。环境 MySQL 8.4.11 / jbhh_ktv_test / InnoDB，全部真实执行，无数据库 skip。
- 最终完整 node --test --test-isolation=none：1125 / 1119 / 0 / 6，退出码 0；逐项比较本次 main 日志，六项 Known Issues 名称与 skip 完全一致。

真实 DB 用例核对同连接 head → account → session → 当前 grants／attributes → 一次 DB 时间 → operation → domain → state／result／audit／COMMIT，不 touch session activity，不查 employee。创建 credit 的 actor 与决定 actor 使用独立合成 session 验证。撤 permission／manager／boss 后新 pool 重连返回原终态不重做；新 key 目标为另一仍待审申请，当前资格不足不写回执，重新授予后原 key 可用。失效认证先于旧 operation 查询；actor／action／payload／expectedRevision 冲突保持。竞争真实查询不同 CONNECTION_ID：同 key 两连接只决定一次，两个 principal 竞争 approve／reject 一成功／一 revision conflict。audit CHECK 中途 SQL 失败确认 head UPDATE／operation INSERT 已到达后，state／history／revision／operation／audit 全回滚；未知故障及属性事件 SQL 故障同样回滚，修复后原 key 可重试。006 在空 fixture 后实际执行，并在保留已有属性与事件时重复执行两次，配置和 rows 不变。

测试只复用受保护十一表 fixture，无 CREATE／DROP database；结束只清理本轮拥有的表，验收后只读查询确认十一张 fixture 表均已清理。ledger application／store、指纹／revision／终态顺序、回款、免零、付款／结账及其他业务动作、六项 Known Issues 均未修改。本批一个提交，parent 96a363f；main／origin/main 保留已同步基线，新提交不 push、不进入下一批、不部署，无范围偏离。

## P0-1 Stage 2C.3 repay 申请创建（2026-10-05）

先核实 3a42360 的直接 parent 为 96a363f，ff-only 合入 main，无 merge commit；本次 main 完整 node --test --test-isolation=none：1125 / 1119 / 0 / 6，MySQL 真实执行。fetch 确认远端无新增后普通 push，main = origin/main = 3a42360、0/0、clean。随后从该 HEAD 创建 codex/p0-1-stage2c-repay；起点等于当前 main，旧工作树与历史分支未改动。

本批只新增 repay，trusted-enabled 共三十一项，其余十四个 eligible action 仍 fail closed。rules.js 在 demo operator／clock 求值前进入 sales.js:submitRepay 的显式 trusted 分支；credit.repay、session principal、dbNow 只取 branded context。新 order.credit.repaymentRequests 条目保存 submittedByPrincipalId，submittedById 留空，submittedBy 仅作可信显示快照（当前 null），submittedAt 取同一次 DB 时间。payload 身份、权限、角色、时钟或状态均不能覆盖这些事实。

原已挂账订单、正整数分金额、付款方式、扣除现有待审核申请后的可用余额及待审核状态共用原规则；只追加申请，不扣 credit.remaining，不写 credit.repayments／order.payments，不改房态、库存、原信用申请或历史快照。原挂账申请人不等于新回款申请人，无员工归属，不用 resolver 或 manager／boss 属性；已批准 legacy credit 可创建新的稳定申请，但不猜原申请人。approveRepayment／rejectRepayment、免零、收款／结账及跨日资金归属未迁移或修复。

实际测试证据（total / pass / fail / skip）：

- 首个公共 trusted 契约先因 trusted-action-not-enabled 真实失败，最小分流后通过。新增 repay 单元 17 / 17 / 0 / 0；DEVELOPMENT_ENVIRONMENT 的三文件定向回归 36 / 36 / 0 / 0。直接领域 getter 验证不读取 state.user／permissions／clock／capabilities／administrator。
- JavaScript 修改后实际尝试 npm test；PowerShell 报 The term 'npm' is not recognized，npm 未启动，没有该命令通过证据。
- 四文件真实 MySQL：auth/mysql-auth.integration.test.js、employees/mysql-roster.integration.test.js、ledger/mysql-store.integration.test.js、ledger/trusted-clean.integration.test.js，460 / 460 / 0 / 0。每文件含 fixture guard／根测试：auth 47/47（原 revalidation 13 保留）、employee 30/30、ledger 11/11、trusted 372/372（新增 repay 17/17）；MySQL 8.4.11 / jbhh_ktv_test / InnoDB 全部实际执行，无数据库 skip。
- 最终完整 node --test --test-isolation=none：1159 / 1153 / 0 / 6，退出码 0；完整测试中的四套 MySQL 同样真实通过。六项 Known Issues 的名称及 skip 与本次 main 日志逐项完全一致。

真实 DB 用例验证同连接 head → account → session → 当前 grants／attributes → 一次 DB UTC → operation → trusted transact → state／result／audit／COMMIT，不 touch session activity、不查询员工。撤 credit.repay 后新 pool 重连返回原终态、不重建申请；新 key denied 不占键，重新授予后原 key 可用。disabled／revoked／idle／absolute／credential version 失效在 operation lookup 前拒绝；actor／action／金额／方式／expectedRevision 冲突保持。原 business rejection／revision conflict 可在撤权和后续状态变化后重放。

同 key 重试与不同 key 旧 revision 竞争均核对两条独立 CONNECTION_ID；只追加一次申请、一个成功 revision／audit，不同 key 另一条是 revision conflict。未知异常在追加申请后完整回滚；实际 audit CHECK 中途 SQL 失败确认 head UPDATE／operation INSERT 已到达，再核对 state／revision／operation／audit 均无残留，修复后原 key 可重试。公开 trusted credit 创建→独立 actor 审批→第三个 actor 提交回款申请也实际通过，仍不新增 payment 或扣余额。

复用受保护十一表 fixture，无新 schema／migration／生产依赖；不 CREATE／DROP database，不操作无关表。ledger application／store、fingerprint／operationKey／revision／terminal semantics、auth／attributes 实现及六项 Known Issues 均未改变。原 gate 测试只同步 repay 已迁移后的预期，其余动作测试保留。本批一个提交，parent 3a42360；main／origin/main 保持已同步基线，新提交不 push、不进入回款审批或下一批、不部署，无范围偏离。

## P0-1 Stage 2C.3 repayment approve／reject（2026-10-05）

先核实 57a8e08 的直接 parent 为 3a42360，ff-only 合入 main，无 merge commit；本次 main 完整 node --test --test-isolation=none：1159 / 1153 / 0 / 6，MySQL 全部真实执行，六项 Known Issues skip 与前批日志一致。fetch 确认远端仍为 3a42360 后普通 push，main = origin/main = 57a8e08、0/0、clean。随后从此 HEAD 创建 codex/p0-1-stage2c-repayment-review，起点等于当前 main；旧分支及其他工作树未改动。

本批只新增 approveRepayment／rejectRepayment，trusted-enabled 共三十三项，其余十二个 eligible action 仍 fail closed。rules.js 在 demo 身份／clock 求值前进入 sales.js:decideRepayment 的显式 trusted 分支。审批事实只取锁内本次 repaymentRequest；submittedByPrincipalId 与 session principal 相等时，credit.repay.approve 之外另需 review.self，不使用原 credit 经办人、其他申请、姓名、旧演示 ID 或 payload 判本人。缺失或无效 applicant principal 的 legacy 两动作都授权拒绝、不占 key；无 employee resolver、manager／boss 属性条件或新 schema。

决定保存 decidedByPrincipalId；decidedBy 只为可信显示快照（当前 null），decidedAt 取冻结 dbNow。批准的一笔 payment 同额进入 credit.repayments 和 order.payments，并保存 approvedByPrincipalId；person 保留本次申请提交人的显示快照，approvedBy 只为审核人显示快照。原金额、方式、余额扣减及归零转已回款、驳回原因必填／截断和状态规则共用原命令体；驳回不生成 payment、不减少余额。payment 沿用 time 字段，不加 occurredAt 或新资金日口径，不修改 reporting 或跨日 Known Issue。

实际证据（total / pass / fail / skip）：

- 首个公共 trusted 用例先真实因 trusted-action-not-enabled 失败，最小分流后通过；新增 repayment review 单元 28 / 28 / 0 / 0，覆盖两个动作、当前申请自审、legacy／伪造、只一笔资金效果、驳回无资金、原业务拒绝／付款字段和整体原子性。直接领域 getter 验证不读 state.user／permissions／clock，也不调用 demo 审核回调。
- JavaScript 修改后实际尝试 npm test（包括最终集成用例修正后）；PowerShell 报 The term 'npm' is not recognized，未取得 npm 执行证据。DEVELOPMENT_ENVIRONMENT 的七文件定向 Node 回归：172 / 172 / 0 / 0。
- 首轮新 MySQL legacy 夹具误用 undefined 字段，被既有 JSON 编码器拒绝；重放用例误将被拒的领域尝试计入成功次数。只修正新夹具：缺失字段显式删除，并验证 replay 前后执行计数不增加；没有放宽生产 JSON 校验或业务规则。
- 最终四文件真实 MySQL 回归：485 / 485 / 0 / 0；每文件含 guard／根测试：auth 47/47（原 revalidation 13 保留）、employee 30/30、ledger 11/11、trusted 397/397（新增 repayment review 25/25）。MySQL 8.4.11 / jbhh_ktv_test / InnoDB 全部实际执行，无数据库 skip。
- 最终完整 node --test --test-isolation=none：1212 / 1206 / 0 / 6，退出码 0；上述四套 MySQL 在完整运行中再次全部真实执行。六项 Known Issues 的名称和 skip 与本次 main 日志逐项完全一致。

真实 DB 验证同一 connection 的 head → account → session → 当前 grants／attributes → 一次 DB UTC → operation → domain → state／result／audit／COMMIT；不 touch session activity、不查 employee。新 trusted repay 由独立 session 创建申请，审核人可恰为原 credit 经办人但不是本次申请人，仍按非自审处理。批准恰新增一笔 payment、余额只扣一次，驳回保持资金／余额原值。撤 credit.repay.approve 或 review.self 后新 pool 重连取原终态，不重新决定或扣款；新 key 当前资格不足不写回执，重新授权后原 key 可用。失效认证在 operation 查询前拒绝；actor／action／请求 ID／原因／expectedRevision 冲突保持，business rejection／revision conflict 仍为可重放终态。

四种竞争均核对两条真实不同 CONNECTION_ID：approve 与 reject 分别同 key 只决定一次；两位审核人不同 key 对同 request 的 approve／approve 或 approve／reject 在旧 revision 最多一个成功，另一条 revision conflict；批准最多一笔资金效果。刷新 revision 后再批准已处理申请为原 business rejection，不再扣款。未知故障在领域决定后全回滚；实际 audit CHECK 中途 SQL 失败确认 head UPDATE／operation INSERT 已到达，再核对申请、payment、余额、历史、revision、operation、audit 完整无残留，修复后原 key 能重试。

仅复用原受保护十一表 fixture，不 CREATE／DROP database，不碰无关表；测试完成后只读核对十一张 fixture 表已全部清理。Stage 1 application／store、指纹／revision／终态流程、auth／policy attributes／employee 实现、其他业务动作与六项 Known Issues 不改。一个提交，parent 57a8e08；main／origin/main 保持已同步基线。新提交不 push、不进入下一批、不部署，无范围偏离。

## 门店规则调整：小额免零上限 10 元（2026-10-05）

基线为已 ff-only 合入、完整 1212／1206／0／6 实际回归且普通 push 的 repayment review 27e2349；main／origin/main 同步后独立建立 codex/p0-1-rounding-ten-yuan。本批只调整免零额度，不迁移任何新 trusted action。

sales.js:validateSettlementPayments 以 SMALL_ROUNDING_LIMIT_CENTS=1000 表达 ≤10 元直接免零；>10 元沿既有 roundingReview 待审核路径，显式特殊情况仍需理由并进入原审批。不修改结账权限、审核人员、review.self／rounding.self.excess、付款／挂账／营业日或目标凑整方式；例如 168 元收 160 元保留真实付款 160 元和免零 8 元。免零从实际未收金额与本次正数付款之差计算，仍拒绝负数／零付款和超收。

当前代码此前没有 500 分生产阈值，只对特殊情况创建审核；此次最小补入小额／超额分流，未修复 K01 的审批前订单已关闭，也未修复 K06 的 outstanding 差额。旧六项 Known Issues 保持 skip；现有 skipped 数据无 >5 元阈值需要迁移，168／0.01 元仍超出新额度。

rounding-limit.test.js 从 10.01 元必须有待审核记录的实际失败开始，覆盖 0／5／9.99／10.00／10.01 元、168→160、已收款后余额、无效金额、结账权限与原特殊审批。真实 MySQL 使用 ledger 原三表 guarded fixture 调用 ledger/rounding-limit.integration.js；原 11 项加新增 9 项实际 20／20／0／0，通过 JSON 往返、replay 单次付款及审核／SQL 全回滚。已尝试 npm test，PowerShell 找不到 npm，未取得 npm 运行证据；四文件定向 Node 回归 91／86／0／5（原五项 Known Issue 子集）；完整 node --test --test-isolation=none 实际 1231／1225／0／6，退出码 0，四套 MySQL 全部执行；六项 skip 名称与本轮 27e2349 main 回归完全一致。

## P0-1 Stage 2C.3：incident 可信创建（2026-10-05）

本轮先完成 repayment review 27e2349 的 ff-only 合入、完整实际 1212／1206／0／6、fetch 无新增后普通 push；再独立完成小额免零 10 元提交 9e2535c，真实 MySQL 边界与完整 1231／1225／0／6 通过后 ff-only 合入并普通 push。main／origin/main=9e2535c、0／0、clean；从该 main HEAD 直接创建 codex/p0-1-stage2c-incident，本批 parent 必须为 9e2535c。

只新增 incident 到 trusted-enabled，共三十四动作、其余十一项 eligible 仍 fail closed；resolveIncident、两项恢复审核及付款、免零审批、采购、开房、交班仍关闭。创建链沿用 session 重验→已存终态→新 key 策略／revision→同 connection employee resolver→trusted transact；actor／权限／createdAt 只来自 branded context，person 仅显示快照（当前 null），submittedByPrincipalId／actualActorPrincipalId 稳定。

负责人显式 assigneeEmployeeId 或 assignee UUID；同事务读取 employee 存在且 enabled 后，withTrustedAssigneeEmployee 保存独立 assigneeEmployeeId／assigneeEmployeeNameSnapshot，不将负责人当成销售 credited employee，也不以关联 principal 授予 actor 权限。新记录保留 assignee／assigneeId 显示兼容；无账号员工合法，同名按 UUID 区分，员工与账号 enabled 各自独立。unknown／disabled 和不一致 UUID 属明确业务拒绝，只留原 terminal，不留 incident、revision 或 audit。SQL／未知异常不占 key；authorization denied 同样不占 key。

incidents.js:submitIncident 显式 demo／trusted 身份壳，原 date、房号存在、类型、描述截断和待处理／空 resolutionReviews 不变；正式分支不读取 USERS／state.user／state.permissions／state.clock。demo 继续原规则；处理结果和恢复审批函数与 main 逐字一致。ledger fingerprint／终态/revision、MySQL schema/store、员工管理、其他领域及六项 Known Issues 未改变；不新增生产依赖，不建真人账号／映射。

测试从未迁移 gate 的实际失败开始。新增单元 18／18；五文件定向 Node 回归 118／118／0／0。新测试曾将 demo 名称写成真人称呼，已按现有 USERS 显示快照纠正；首轮 MySQL 仅一个子用例因 fixture 的 incident-unknown ledger ID 重复而失败（合计 511／509／2／0，含根失败），已改为独立 incident-program-fault，未修改生产代码或放宽断言。修正后四文件真实 MySQL 511／511／0／0，其中 incident 新增 17／17；MySQL 8.4.11／jbhh_ktv_test／InnoDB，原 auth／revalidation／employees／ledger／所有 trusted 批次均实际执行。

独立 CONNECTION_ID 实测 revision／同 key 竞争只一笔创建；同 connection 的员工 FOR SHARE 与独立员工 disable 明确先后，停用后新 key 拒绝。有效原 actor 撤权并重连后重放旧结果，不再查员工、不因改名／停用改变姓名快照；失效认证禁止读取既有结果。真实 resolver SELECT 故障、audit INSERT 约束故障及未知异常全部 rollback，原 key 可在故障修复后重试。revalidation 冻结数据库时间，不 touch session 活动。fixture 只操作原十一张已知表，无 CREATE／DROP DATABASE；最终只读检查确认这些 fixture 表剩余 0 张。

修改 JavaScript 后实际尝试 npm test（含最终夹具修正后），PowerShell 找不到 npm，未取得 npm 执行证据。最终完整 node --test --test-isolation=none 实际 1266／1260／0／6，退出码 0；四套 MySQL 全部再次真实执行，新 incident 单元 18／18、MySQL 17／17，原六项 Known Issues 的名称／skip 与本轮 repayment review main 日志完全一致。本批只一个 incident 提交，不合入／push 该提交、不进入下一批、不部署。

## P0-1 Stage 2C.3：principal → employee 同事务解析（2026-10-05）

先核实 incident 51b722a 直接 parent=9e2535c，ff-only 合入 main；本轮实际完整 1266／1260／0／6，四套 MySQL 实际执行。fetch 后 origin 未新增，普通 push；main=origin/main=51b722a、0／0、clean。从该 HEAD 直接创建 codex/p0-1-stage2c-incident-resolution，基础设施提交 parent 必须为 51b722a。

新独立 factory／方法 resolvePrincipalEmployeeInTransaction({trustedContext}) 只接受 branded session context。当前 connection 的 principal_id FOR SHARE 读取显式关联启用 employee，冻结 employeeId／displayName；无关联和停用均 fail closed，不以姓名、旧 USERS 或 payload 猜身份，actor principal 不变。原 creditedEmployee 解析完整保留；无新 migration、业务动作、真实账号／关联或生产依赖。锁序为调用方 auth account → session／grants → employee；不借连接、不管理事务、不写 session activity。

实现前新增契约因缺 export 实际失败；实现后新增单元 8／8，五文件定向实际 80／80／0／0。原员工 MySQL fixture 加十项实际 40／40／0／0；两个真实 CONNECTION_ID 覆盖解析先／停用先，在 account 锁上真实等待，随后读取停用事实；实际 SQL 字段故障与调用方未提交更新均完整 rollback。测试只清理本次创建八张 auth／employee 表，不操作 database 或 ledger 表。已实际尝试 npm test，PowerShell 找不到 npm，未取得 npm 证据。

本轮完整 node --test --test-isolation=none 实际 1284／1278／0／6，退出码 0；四套 MySQL 全部再次执行，六项 skip 名称与本轮 incident main 日志完全一致。基础设施单独提交，不开放 resolveIncident 或其他动作，不 push、不部署。

## P0-1 Stage 2C.3：resolveIncident 可信处理结果提交（2026-10-05）

基于本轮独立 infrastructure 提交 e2f4d72 继续第二个提交，main／origin/main 仍在已同步 51b722a。只新增 resolveIncident 到 trusted-enabled，共三十五项；其他十项 eligible 仍关闭，尤其 approveIncidentResolution／rejectIncidentResolution、免零审批、付款、开房、采购和交班。

session 重验→existing operation→新 key policy／revision→同 connection principal→employee resolver→trusted transact 原链保持；actor／permission／时间只取 context。当前 actor employee 与锁定 incident.assigneeEmployeeId 比较，无关联／停用／不匹配／legacy 未证明均 AuthorizationDenied，不写 terminal／audit／revision，不占 key；不从 payload、姓名、旧 USERS 或 viewAll 加管理者绕过。demo 保留原负责人／incident.viewAll 判断；批准／驳回函数与 main 逐字一致。

新 resolutionReviews 保存 submittedByPrincipalId、submittedByEmployeeId、可信当前姓名显示快照及 dbNow；原结果／备注必填及 300 字符限制、待审核、提醒复位与历史保持，不直接完成 incident。撤权及解除员工关联后，有效原 actor 同 key 重连返回原终态，不再解析员工；新 key 用当前资格。失效 session 仍在读取 operation 前拒绝，指纹／actor 冲突、终态拒绝及 revision 协议不变。

新增单元先在 trusted gate 实际失败；迁移后新增单元 21／21，五文件定向实际 127／127／0／0。已按项目规则尝试 npm test，PowerShell 找不到 npm，未取得该证据。首轮真实数据库实际 544／540／4／0（含根失败）：两项用例夹具误用当前 auth 不接受的旧 incident.viewAll grant，另一个用例未捕获同步 constructor 配置拒绝。仅修正测试为正式具体权限、保留 payload／demo 管理者伪造拒绝，并捕获同步拒绝；生产权限及业务实现未因此改变。修正后四文件 MySQL 实际 544／544／0／0；auth 47／47（原 16＋revalidation 13 继续执行）、employee 40／40（新增 principal resolver 十项）、ledger 20／20（原 11＋10 元边界九项）、trusted 437／437（新增 resolveIncident 23／23）。实际 MySQL 8.4.11／jbhh_ktv_test／InnoDB，无数据库 skip。最终完整 node --test --test-isolation=none 实际 1328／1322／0／6，退出码 0；四套 MySQL 再次全部实际执行，六项 skip 名称与本轮 incident main 回归完全一致。两种 revision／同 key 竞争验证真实独立 CONNECTION_ID，最多一个待审请求效果；独立员工 disable 在 account 锁后按序发生。SQL resolver／audit 中途故障与未知异常全部 rollback，原 key 可修复重试；reconnect 旧终态不重复提交。fixture 仍只操作并清理原十一张已知表，最终只读核对全部清理。本批不改变员工名册、数据库 schema、¥10 小额免零规则、六项 Known Issues 或其他业务 action，不建真人映射；仅第二个独立提交，不合入／push 新提交、不部署。

## P0-1 Stage 2C.3：incident resolution 可信恢复审核（2026-10-05）

先核实线性链 51b722a → e2f4d72 → df02a93，按顺序两次 ff-only 合入 main，无 merge commit。本轮收尾完整 node --test --test-isolation=none 实际 1328／1322／0／6，四套 MySQL 实际执行；fetch 后 origin 未新增，普通 push，main=origin/main=df02a93、0／0、clean。从该 HEAD 直接创建 codex/p0-1-stage2c-incident-resolution-review，本批独立提交 parent 必须为 df02a93，不合入／push 新提交、不部署。

只新增 approveIncidentResolution／rejectIncidentResolution，trusted-enabled 共三十七项；其余八项 open、collect、settle、pay、approveRounding、rejectRounding、procurement、handover 仍 fail closed。既有 application／MySQL store／command-policy 的 session 重验、既有终态查找、新 key 验权与 revision、原子提交协议不改；无新 permission、schema、依赖或真人映射。

rules.js 在 demo operator／clock 求值前委托 incidents.js:decideIncidentResolution 的显式 trusted 分支。两动作从锁定 state 选择本次 resolutionReviews；只读该 request 的 submittedByPrincipalId，与 session principal 相等则需既有 incident.resolve.approve＋review.self，非本人仍需 incident.resolve.approve。不用 incident 创建人、assignee、employee 关联、旧 ID、姓名或 payload 代替申请人；legacy 缺可信 principal 两动作均 AuthorizationDenied，全回滚、不写终态、不占 key。决定保存 request.decidedByPrincipalId；decidedBy／reviewedBy 只用 context 的显示快照（当前 null），decidedAt／批准 resolvedAt 取冻结 dbNow。原批准复制结果／备注、已完成与提醒复位、驳回必填原因并回流待处理、其他历史数据保持，demo 原行为不变。审批不调用 employee resolver。

测试先在未迁移 gate 实际失败，再加入上述两动作及最小身份壳；新增单元实际 25／25，六文件定向回归 152／152／0／0。JavaScript 修改及最终夹具修正后均实际尝试 npm test，PowerShell 找不到 npm，未取得 npm 执行证据，使用当前 package 脚本对应 Node 内置测试。

首轮四文件真实 MySQL 实际 570／564／6／0（五个子用例失败＋根失败）：新夹具误用认证服务不接受的旧混合大小写 grant，以及三个竞争夹具 ledger ID 超过既有列长度。只修正测试 permission 和 ID，不修改生产校验或 schema、不放宽业务断言。修正后四文件真实 MySQL 实际 570／570／0／0：auth 47／47（原 16＋revalidation 13 继续实际执行）、employee 40／40、ledger 20／20（原 11＋¥10 规则九项）、trusted 463／463（新增恢复审核 26／26）。MySQL 8.4.11／jbhh_ktv_test／InnoDB，无数据库 skip。

完整 trusted 登记→负责人提交处理结果→独立无员工关联 reviewer 决定链实测同一 connection 的 head→account→session→grants→一次 DB 时间→operation→domain→state／result／audit→COMMIT；不 touch session activity。三个不同 key 决定竞争及两种同 key 重试，均验证两个不同 CONNECTION_ID、第二连接实际等待 head 锁，最多一次业务决定。两动作的 audit INSERT 约束故障在 head／operation 写入后完整 rollback，未知异常同样不占 key，修复后原 key 成功。撤审核／自审权限并重新建立连接后原 key 返回原终态，新 key 拒绝；disabled／revoked／idle／absolute／credential 失效均在读取 operation 前拒绝。

最终完整 node --test --test-isolation=none 实际 1379／1373／0／6，退出码 0；四套 MySQL 全部再次真实执行，新增恢复审核数据库用例 26／26。原六项 skip 名称与本轮前置提交收尾日志完全一致；¥10 免零规则、sales／reporting、Known Issues、ledger 指纹／revision／terminal、auth／employee store、HTTP／UI 均未修改。fixture 只使用并清理原十一张已知表，最终只读核对剩余 0 张，不 CREATE／DROP DATABASE、不清理其他工作树。仅本批一个提交，不进入下一批。

## Stage 2C.3 procurement trusted 采购创建（2026-10-05）

先核实 5e4f1ef 的直接 parent 为 df02a93，main 与原 origin/main 仍在 df02a93；以 ff-only 前进到 5e4f1ef，无 merge commit。收尾完整 node --test --test-isolation=none 实际 1379／1373／0／6，四套 MySQL 全部实际执行；fetch 确认远端未新增后普通 push，main＝origin/main＝5e4f1ef、0／0、clean。新分支 codex/p0-1-stage2c-procurement 直接从该 HEAD 创建，本批提交 parent 必须为 5e4f1ef，新提交不合入／push。

当前 procurement／expenses 源文件的旧 Bug #5 注释不能覆盖运行事实：现行 expenses.js:decideExpense 已同步关联采购状态，bugs-evidence.test.js 与原 operations 回归已明确验证修复；六项 Known Issues 不包含采购联动。本批保持该既有逻辑，仅纠正采购模块的过期注释。

只新增 procurement 到 trusted-enabled，共三十八项；其余七项 open、collect、settle、pay、approveRounding、rejectRounding、handover 保持 fail closed。rules.js 在 demo operator／clock 求值前分流到 procurement.js:submitProcurement 的显式 trusted 模式；具体采购权限、principal 与记录时间只从同事务 session context 读取。采购和关联 expense 同写 submittedByPrincipalId，person 仅可信显示快照（当前 null），关联 expense 的 submittedById 留空，不用 payload 或演示身份补造。原采购无 employee 归属，不增加员工解析、expense.create 或审批属性要求。

原整数金额／数量、显式 date、付款方式／性质、商品／单位／说明截断、空说明 fallback、报销严格超过 500 元的待审状态和 expenseId 关联保持。两条记录在同一隔离 transact 克隆中生成，再与 state／revision／operation／audit 同一 MySQL 事务提交；不入库、不创建订单 payment、不改写历史。授权拒绝不占 key；原领域拒绝保留终态；未知异常／SQL 故障全部回滚。旧终态早于新 key 验权，撤权后有效原 actor 可重连重放，失效账号／session 禁止读取。ledger application／store、auth／employees、fingerprint、revision、terminal 与 schema 均未修改。

新增首条单元测试先在未迁移 gate 实际失败，最小实现后通过；采购新增单元 16／16，DEVELOPMENT_ENVIRONMENT 所列六文件定向 150／150／0／0。修改 JavaScript 后实际尝试 npm test：PowerShell 找不到 npm，未取得 npm 执行证据。四文件真实 MySQL 回归 589／589／0／0：auth 47／47、employee 40／40、ledger 20／20、trusted 482／482（采购新增 19／19）。实际 MySQL 8.4.11／jbhh_ktv_test／InnoDB，原 auth 16、revalidation 13、ledger 11 均真实执行，无数据库 skip。

采购两种竞争实测独立 CONNECTION_ID 且第二连接等待 head 行锁，旧 revision 命令最多一组采购＋expense，相同 key 只执行一次。重连撤权重放不重建两条记录。真实 operation INSERT 与 audit INSERT CHECK 故障、expense append 后采购 append 的实际 TypeError、两条记录生成后的未知异常均全回滚；可修复故障的原 key 保持可重试。既有 approveExpense／rejectExpense 对新关联费用读取同一可信申请人，并保持原采购状态同步；没有修改该审批 action。

首次本批完整回归时 MySQL84 已停止，实际 833／823／4／6；四项失败均 ECONNREFUSED，不能替代真实验收。尝试启动服务被 Windows 拒绝（Cannot open MySQL84 service），用户随后恢复服务；重新只读确认 MySQL 8.4.11／jbhh_ktv_test／InnoDB 后继续。

恢复后的最终完整 node --test --test-isolation=none 实际 1414／1408／0／6，退出码 0；四套 MySQL 再次全部实际执行，新增采购单元 16／16、数据库 19／19。六项 skip 名称与本轮 incident resolution review 收尾基线完全一致；只读核对原十一张 fixture 表剩余 0 张，不 CREATE／DROP DATABASE，不操作其他表／工作树。最终 JavaScript 测试标题同步后再次尝试 npm test，仍找不到 npm。¥10 免零、sales／reporting、费用审批、Known Issues、ledger 指纹／revision／terminal 与 auth／employees 均未改动。仅本批一个独立提交，不合入／push 新提交，不进入下一批，不部署，无范围偏离。

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

只读快照预检器、Stage 1A／1A.1／1A.2 协议、Stage 1B-MySQL 适配器、Stage 2A 纯命令策略及 Stage 2B 独立认证基础已完成；Stage 1B.1 和 Stage 2B 已分别在专用 MySQL 8.4 测试库取得真实验收证据。Stage 2C.1 同事务认证、2C.2 clean 及 2C.3 房间异常、目录维护、取消预约、存取酒、reserve、sale／retailSale、serveExtra／otherCharge、exchange、房间恢复 approve／reject、stock／consumableStock、approveInventory／rejectInventory、gift 提交／approveGift／rejectGift 及 expense 申请／approveExpense／rejectExpense、credit 申请／approve／reject、repay 申请／approveRepayment／rejectRepayment 已通过真实数据库验收；其他未列动作仍未迁移，各批及线性整合验收见上节；员工名册、关联审计与事务内归属解析已真实验收，resolver 已仅接 trusted reserve／sale／retailSale，其余正式 action 和审核尚未迁移，policy attributes 配置／审计与同事务当前读已完成，属性基础自身不开放业务动作；HTTP／客户端及 2D 未开始，当前停止在本批。正式营业日和班次规则已确认的部分见 [REQUIREMENTS](./REQUIREMENTS.md)，运行实现仍属后续任务。

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
