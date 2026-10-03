# 系统架构

本文件描述已集成的 Track A＋B 单机演示运行边界，以及尚未接入客户端的 P0-1 账本、Stage 2A 命令策略、Stage 2B 认证基础和 Stage 2C.1 同连接重验、2C.2 clean 与 2C.3 房间异常／目录维护／取消预约／存取酒小批的可信执行能力。具体入口见 [MODULE_MAP](./MODULE_MAP.md)，验证结果见 [CURRENT_STAGE](./CURRENT_STAGE.md)。

## 系统边界

```mermaid
flowchart TD
  E[员工入口 index.html] --> APP[app.js 启动与事件分发]
  A[系统管理入口 admin.html] --> APP
  APP --> UI[ui/ 页面、表单与弹窗]
  APP --> P[persistence.js]
  P --> M[migrations.js]
  P --> LS[(浏览器 localStorage)]
  UI --> TX[rules.js transact]
  TX --> D[销售、房间、库存及运营领域模块]
  UI --> REP[reporting.js 只读报表投影]
  D --> C[state.catalog 商品与套餐]
  D --> ID[shared/identity.js 权限选择器]
  T[theme.js] --> PREF[(主题偏好 localStorage)]
  S[server.js 静态白名单] --> E
  S --> A
  L[ledger/application.js 独立命令入口] -->|legacy demo| TX
  L --> DB[(MySQL 8.4 InnoDB 过渡账本)]
  AUTH[auth/service.js 独立认证] --> AUTHDB[(MySQL auth 五表)]
  L -->|trusted 已迁移九动作| RV[同连接 session revalidation]
  RV --> AUTHDB
  RV --> CP[当前 grants command-policy]
  CP --> TX
  DB -. 未接入页面 .-> APP
```

当前演示的营业事实和演示权限仍由单浏览器状态持有。演示身份可切换；页面权限校验不能视作真实认证或服务端授权。`server.js` 只供应静态文件，不提供业务 API。

## 模块与依赖

- `app.js` 负责入口判断、持久化装配和浏览器事件分发。`ui/context.js` 持有页面上下文，`ui/shell.js` 在保存成功后才替换当前状态并渲染；`ui/pages/`、`ui/dialogs/` 和 `ui/forms.js` 负责展示与输入。
- `rules.js` 的 `transact` 克隆原状态、校验操作键和目录价格，再调领域命令；失败不返回新状态。它仍保留身份、目录、赠酒和部分订单事务分支。页面隐藏不代替领域权限检查。
- `sales.js` 负责销售行、收款、免零、挂账、回款及金额选择器。`rooms.js` 负责报价、开房、房态、预约和房间异常；结账及挂账后的房间释放由两域通过 `transact` 协调。`inventory.js` 负责期初、盘点、审核与库存流水。
- `catalog.js` 管商品目录、销售规格、套餐查询和价格一致性校验；`packages.js` 构造默认套餐。运行时以 `state.catalog` 为唯一当前目录，`DEFAULT_CATALOG` 只供初始化与迁移。报价、更新事务及加载路径会拒绝价格不等于基础房费加赠饮参考值的套餐。
- `deposits.js`、`expenses.js`、`procurement.js`、`incidents.js`、`handover.js` 拥有各自业务记录；`reviewInbox.js` 只读汇总审核待办与历史。挂账和大额报销审核同时检查具体权限、指定岗位及本人审核附加权限，已授权自审留标记。
- `reporting.js` 以状态快照生成日、周、月报表选择器和视图模型，`ui/pages/reports.js` 仅渲染。销售历史名称、分类、数量和成交额优先读订单快照；未知旧值不以当前目录补造。
- `shared/identity.js`、`shared/money.js`、`shared/time.js` 提供身份、整数分与演示时段基础。`theme.js` 与业务状态使用不同存储键。

## 数据流与失败边界

1. `persistence.js` 从 `jbhh-demo-v1` 读取原文，`migrations.js` 校验结构、套餐价格并补齐旧字段。已知历史成交金额保留；缺少旧名称或价格时标未知。
2. 原文损坏或旧套餐金额不一致时，`persistence.js` 保留原 key，并在不覆盖已有不同备份的前提下尝试复制到 `jbhh-demo-v1-recovery`。所有异常加载都停写；可解析的旧记录只在内存迁移供历史订单和付款核对，页面进入只读核对页，可展开查看并复制原文。备份成功也不解除停写；人工修正主记录并点击“重新检查本机记录”通过完整校验后才恢复保存。迁移不按当前目录重算历史成交金额。
3. 页面把输入交给 `transact`。房间和无房零售共用 `orders`；`retail.room` 为 `null`。房间增购和零售共用销售规格与基础库存数量校验；未建账或余额不足时整笔不提交。
4. `ui/shell.js` 调用 `persistence.save`，成功后才替换页面状态。挂账驳回时原申请及决定进入订单的 `creditHistory`，原房间不被重新占用；游离旧单的完整处置流程尚未实现。
5. 主题偏好使用 `jbhh-appearance-v1`，不随业务练习状态重置。

这仍是单机快照事务，没有服务端并发控制、可靠备份或真实资金事件。跨设备、正式支付、退款、撤单、冲正、营业日、班次和渠道对账须另行实现，目标见 [脱岗 P0 契约](./OFFSITE_CONTRACTS.md)。

## P0-1 Stage 1A 账本核心事务协议（独立 Node 入口）

`ledger/application.js:createLedgerApplication` 从可信调用方显式接收 `principal.id`，从适配器取得 `ledgerId`；业务命令只含 `{operationKey, expectedRevision, action, payload}`，额外传输字段不进入命令。按 JSON 值规范化动作、期望版本和业务输入并计算 SHA-256 指纹，属性插入顺序不影响结果。`runAtomic` 内先按该 ledger 的操作键查终态，再核对 actor 与指纹：同 actor／同请求返回原终态，不同 actor 或改了动作、版本、payload 返回 `idempotency-conflict`，不得泄露原回执。

新键若 `expectedRevision` 已过期，原子记录 `revision-conflict` 终态；现有领域规则显式抛出 `BusinessRejection` 时，原子记录 `business-rejected` 终态。两者均不改变业务 state、revision 或成功审计。刷新后要重新判断并发起业务动作，必须使用新操作键，付款不能用旧键改写版本后重提。首次有效命令仍调用 `rules.js:transact`，业务判断与提示保持原样；成功时状态、含 actor 的成功回执、`command.succeeded` 审计和递增一次的 revision 同事务提交。已存在 `state.processed` 键却没有可信回执时停在冲突，不伪造结果。其他普通 `Error`、程序错误和存储错误均向外传播并回滚，不占用操作键；故障修复后可用原键重试。错误分类不根据文案猜测。此段描述保留的 Stage 1 legacy／demo 入口，actor 是注入的测试值；session-derived trusted 入口见下方 2C.2／2C.3。

`ledger/memory-store.js:createMemoryLedgerStore` 通过单实例串行队列实现 `runAtomic` 的 `read`、`findOperationResult`、成功 `commit` 和拒绝 `recordTerminal`；每笔操作只公开一个终态。它**不是**跨进程共享或断电可恢复的账本。Stage 1B-MySQL 适配器已按同一端口在数据库事务中锁定账本版本，并把成功时的 state／revision／终态结果／审计一起提交；真实 MySQL 集成证据见 [CURRENT_STAGE](./CURRENT_STAGE.md)。当前 UI、`persistence.js`、`migrations.js` 及报表均未连接此协议。

## P0-1 Stage 1B-MySQL 过渡账本（独立 Node 入口）

`ledger/mysql-store.js:createMySqlLedgerStore` 实现冻结的 `runAtomic` 端口；调用方显式提供 `mysql2` promise Pool、ledgerId 与已迁移的 MySQL 数据库名。每条命令只借用一个 connection，在 `START TRANSACTION` 后按主键 `SELECT ledger_heads ... FOR UPDATE`，向 application 提供同键终态查询及可选的同连接认证能力，再由显式 execution mode 决定执行顺序。成功时将 MySQL JSON state、revision、语义快照校验和、operation result 和成功审计同事务提交；旧 revision 或明确业务拒绝只保存终态 operation。未知异常和 SQL 写入失败回滚，提交结果不明时保留原 key 供查询，不自动生成新 key。成功时间由数据库 `UTC_TIMESTAMP(6)` 生成，未知或损坏快照停写。

`database/migrations/001_mysql_ledger_core.sql` 的三表均为 InnoDB，并以主键、唯一约束及外键保护操作与审计。MySQL JSON 规范化后的快照校验和只验证状态 JSON 值；它不是原始 localStorage 文本备份，未来正式导入必须另留原文及原文 SHA-256。此为单门店版本化 snapshot 过渡模型，最终领域关系模型尚未完成。真实 MySQL 8.4.11／InnoDB 的 migration、行锁竞争、重连持久性和回滚证据见 [CURRENT_STAGE](./CURRENT_STAGE.md)；适配器未接入浏览器或 HTTP；独立 Node trusted 入口仅对已迁移的九个房间／目录／存取酒动作使用 session 身份，具体集合见下文。

旧 `database/schema.sql`、`seed.sql` 和 `codex/p0-1-trusted-ledger@7d3c23c` PostgreSQL 适配器只保留历史设计／实验参考。PostgreSQL 实验未取得真实数据库验收，也未推送或部署；它不是当前正式数据库方向。

## P0-1 Stage 2A 可信命令策略（已迁移九动作接入）

`ledger/command-policy.js` 位于服务端 ledger/application 邻近边界，但不改变 `createLedgerApplication`、`runAtomic` 或领域事务。它仅以显式注入且经工厂隔离的可信 principal 判断 action 是否在 45 个现有非演示命令清单内，以及该动作的具体权限资格；未知与演示专用动作默认拒绝。它不读取 MySQL、房态、库存、付款或审批状态，也不计算金额。允许结果始终标明下一阶段须在账本锁内重验当前账号／权限和业务相关事实，不是一次可提交授权。

`trustedExecutionContext.actualActorPrincipalId` 只取自注入 principal；`attribution.creditedEmployeeId` 只是客户端请求的业务归属候选，尚未核实员工名册，不能替代操作者或授予权限。审核动作须在将来从锁定账本读取申请人的真实 principal ID 后，再同时检查具体审核权限和 `review.self`；超额免零本人审核还需显式 `rounding.self.excess` 授权属性。当前没有真人账号映射，不能按姓名或历史演示 ID 赋权。浏览器 DEMO 路径继续保留原规则。clean、房间异常提交、目录维护三动作、取消预约及存取酒在 ledger transaction 中调用该策略；其他 36 个 eligible action 尚未获 trusted execution enablement，2D 未接入。

## P0-1 Stage 2B 认证基础（独立 Node 入口）

`auth/service.js:createAuthService` 编排合成账号创建、登录、会话认证、退出、撤销、停用、凭据轮换和具体权限变更；`auth/mysql-store.js:createMySqlAuthStore` 将关联写入放在同一 MySQL connection／事务。`auth/password.js` 用 Node 内置异步 scrypt 和每条凭据独立随机 salt；`auth/session-token.js` 产生 256-bit 随机 token，数据库只存 SHA-256 digest。`auth/rate-limit.js` 是显式注入的登录限流端口的单进程实现，默认阈值为 15 分钟内 5 次失败；多进程正式入口须注入共享实现。没有新增生产依赖。

`auth_accounts` 的随机 UUID principal ID 由服务端生成，模块不提供删除或重用账号的方法；停用保留账号与审计历史。`auth_grants` 只存具体 permission，不存管理员通配捷径。每次认证都在数据库中重新核对账号启用状态、凭据版本、session 撤销与过期状态，并读取当下 grants；session/token 不携带权限。登录成功的 session 和 `login-success` 事件同事务；失败登录、退出、停用与撤销事件使用数据库时间。不存在账号和密码错误对外同为 `invalid-credentials`。独立认证服务不暴露 HTTP 或 UI；已迁移的九动作使用 2C.1 同连接重验。账号与权限管理方法仍是可信内部能力，尚未经过 command 授权，不得对客户端暴露。

`database/migrations/002_mysql_auth_core.sql` 的五张 InnoDB 表已在专用 MySQL 测试库中验证；脚本执行一次，重复执行首表报已存在。集成测试只在 URL、实际库名、MySQL 版本与默认引擎均符合条件且五张 auth 表预先不存在时建表，结束只删除本次建的 auth 表。测试证据见 [CURRENT_STAGE](./CURRENT_STAGE.md)。真人 account ID、登录标识与凭据发放等仍见 [OPEN BUSINESS DECISIONS](./OPEN_BUSINESS_DECISIONS.md)。

## P0-1 员工名册基础（独立内部接口）

`employees/service.js:createEmployeeService` 使用数据库无关名册 port，公开 createEmployee、getEmployee、disableEmployee、linkPrincipal、unlinkPrincipal。写方法的第二参数必须显式提供可信内部调用方的 actorPrincipalId；它只用于审计、需存在且账号启用，不从输入姓名、关联对象或演示身份推导。此能力尚未接 session／command 授权入口，不能向客户端直接暴露；不改变 existing command policy、trusted-enabled 或任何业务 action。

`employees/mysql-store.js:createMySqlEmployeeStore` 只操作新 employees／employee_events 和当前 auth_accounts 依赖；每次组合写入借一条连接、BEGIN／COMMIT，SQL／未知异常回滚。先非锁定定位员工旧关联，将 actor／旧 principal／目标 principal 按 UUID 升序锁住 account，再 FOR UPDATE 锁 employee 并复核关联；定位结果变化时拒绝，不在 employee 锁后追加 account 锁。重复同一关联、重复解除或重复停用返回 changed:false，不增加事件；不同目标需先解除，唯一 principal 碰撞明确拒绝。COMMIT 回执不明时销毁连接，错误带 employeeId 供核查，不能自动重新创建。

`database/migrations/003_mysql_employee_core.sql` 新建两个 InnoDB 表，需先执行 auth migration。employees 只含稳定 employee_id、可同名 display_name、enabled、nullable unique principal_id FK、数据库 UTC created_at／updated_at。employee_events 追加 employee-created、employee-disabled、principal-linked、principal-unlinked，保存 actor 与关联前后 ID，event shape／FK 保证引用与事件类型一致；接口不提供硬删除、ID 重用或审计改写。停用员工保留关联且不改 auth；停用账号不自动停用员工。关联管理与事务内归属解析分别提供独立接口，真实员工及账号配置仍未创建，历史 state 的人员快照不改写。

事务内归属解析由 employees/employee-resolver.js:createTransactionBoundEmployeeResolver 定义数据库无关 port；MySQL store 的 bindEmployeeResolver(connection) 绑定调用方已开启的事务，提供 resolveCreditedEmployeeInTransaction({creditedEmployeeId}) → 冻结 {employeeId,displayName}。明确拒绝 pool 参数，先以 DO 0 的事务状态位拒绝非活动事务，并核实目标库；只按 employee_id 做 SELECT employee_id／display_name／enabled ... FOR SHARE 当前读取，不读取 principal 关联、actor、权限或演示数据。不存在／停用分别抛 EMPLOYEE_NOT_FOUND／EMPLOYEE_DISABLED，未知 SQL／port 异常原样传播，未接 ledger 终态分类。不会借连接、BEGIN／COMMIT／ROLLBACK／release，也不更新员工、审计或 session 活动。

共享 employee 锁由调用方持有到提交／回滚：解析先取得锁时，disable 的 employee FOR UPDATE 必须等待；disable 先取得锁并提交后，解析看到停用并拒绝，旧 REPEATABLE READ 快照不能代替当前读取。resolver 不追加 account 锁；管理路径继续 account UUID 升序 → employee → event。未来 command 调用方需先完成 ledger／auth 前序锁，再解析 employee，不在 employee 锁后倒退加 auth 锁；本批未接任何业务 action，actualActorPrincipalId 仍独立于 creditedEmployeeId。

## P0-1 Stage 2C.1 同事务认证能力

`auth/session-revalidation.js:revalidateSessionInTransaction({port, tokenDigest})` 是数据库无关的只读认证函数。MySQL 组合入口为 `authStore.bindSessionRevalidation(connection).revalidateSessionInTransaction({tokenDigest})`：只使用显式注入的当前连接，检查已有事务，绝不借新连接、BEGIN／COMMIT／ROLLBACK／release，也不更新 `last_seen_at` 或闲置期限。无效 session 返回 null；SQL／未知异常向调用方传播，由事务所有者回滚。普通 `authenticateSession` 仍管理独立事务并更新活动，不可用来替代此 port。

锁顺序：ledger head → auth account → auth session → grants → 后续 operation／state／audit。token digest 的非锁定定位不构成认证；锁住 account 后锁 session，并重新核对 ID、digest、principal、撤销与凭据版本。grants 使用 `ORDER BY permission_id FOR UPDATE` 当前读，避免旧 REPEATABLE READ 快照。auth 独立事务不取 head，统一 account 在前、既存 session 在后，多个 session 按 ID 排序，然后处理 grants／credentials／event；新账号／新 session 在其 account 锁保护下插入。退出及按 session ID 撤销也先定位、再锁 account／session。

锁定上述事实后，单次 `UTC_TIMESTAMP(6)` 得到规范 UTC 六位小数时间；同一值用于 idle／absolute 判断并作为冻结 `dbNow` 返回。上下文含 `mode:'trusted'`、Stage 2A 工厂生成的 `principal`、`principalId`、`sessionId`、当前 `permissionIds`、`dbNow`、`actorSnapshot:null`。当前 schema 无正式属性模型，明确返回 `policyAttributesConfigured:false`／`policyAttributeIds:null`；`requireConfiguredPolicyAttributes` 以 `AUTH_POLICY_ATTRIBUTES_UNCONFIGURED` 拒绝，不能把未配置当成已配置空集合。复制／JSON 伪造的 context 不通过可信 context 工厂标记检查；payload 无法覆盖这些事实。

`createMySqlLedgerStore` 仅接受可选的内部 `bindSessionRevalidation` 组合函数，head 已锁定时把同一连接的能力放在 `transaction.sessionRevalidation`。store 不自动调用认证或 action policy。2C.1 当时只建立能力，2C.2 trusted application 现以此消费新鲜 context：有效 session／enabled account → existing operation → 原 actor／原指纹返回已存终态 → 只有新 key 使用当前 action 权限。权限撤销不改写旧终态；停用、撤销、过期拒绝访问；actor／fingerprint 冲突保持 Stage 1 语义。2C.1 以测试组合冻结该顺序；2C.2 首次将它用于 clean。真实验证状态见 [CURRENT_STAGE](./CURRENT_STAGE.md)。

## P0-1 Stage 2C.2／2C.3 房间、目录与存取酒可信执行（独立 Node 入口）

`createTrustedLedgerApplication({store})` 接收 `execute(command, {tokenDigest})`；认证材料与 Stage 1 指纹命令分开，不能传 principal、权限或时钟配置。命令 schema／指纹 → BEGIN／head FOR UPDATE → 同连接认证（account／session／当前 grants／一次 dbNow）→ 查 existing operation → actor／fingerprint 校验。已有终态只要求当前账号和 session 有效，直接返回原终态，不再次检查当前 action permission；新 key 才执行 trusted-enabled → Stage 2A policy → revision → trusted transact → state／result／audit 原子提交。

`ledger/trusted-execution.js:TRUSTED_ENABLED_ACTIONS` 是独立、冻结的已迁移清单，只含 clean、markRoomIssue、clearRoomIssue、createCatalogProduct、updateCatalogProduct、updateCatalogPackage、cancelReservation、deposit、withdraw。其余 eligible、demo 与未知 action 对新 key 默认拒绝；`rules.js:transact` 的 trusted 分支也只支持这九项。授权不足以 `AuthorizationDenied`（code AUTHORIZATION_DENIED、status authorization-denied）向外传播，不属于 BusinessRejection，不写终态或占用 key；缺失 port／伪造 context 同样不执行。revision conflict 与明确领域拒绝仍保留 Stage 1 terminal 语义。

transact 第五参数显式区分 `{mode:'demo'}` 与 `{mode:'trusted', context}`，旧调用缺省为 demo。trusted 在演示 operator／clock 求值前分流，cleanRoom 只从 branded context.permissionIds 检查 room.clean，继续只允许待清洁 → 空闲。旧 snapshot 的 user／clock／capabilities 等字段只作为原样快照数据保留，不作可信事实。markRoomIssue／clearRoomIssue 只从同一 context 检查 room.issue、取 principalId 与 dbNow；标记立即生效、恢复只提交待审核及原证据／房态规则保持。新 trusted 提交记录增加 submittedByPrincipalId，旧演示 submittedById 留空，不推断账号映射；显示字段 submittedBy／issueBy 当前使用 principalId，因 actorSnapshot 尚无显示名。历史记录和 demo 字段保持，approve／reject 尚未迁移。业务 dbNow 来自 revalidation；成功审计的基础设施提交时间继续由 MySQL store 生成。

目录三动作由 rules.js 私有 executeCatalogCommand 共用原命令体和 normalizeSaleOptions；demo 仍用原 need，trusted 只检查 context.permissionIds 中的 catalog.manage。在演示身份／时钟求值前分流，不依赖员工映射或审批。目录记录原本没有业务 actor／时间字段，保持该事实；actual actor 保存于已有 operation／audit，dbNow 仍由同连接重验冻结。名称、价格、规格、套餐总价一致性校验原样保留；新增库存商品 count 仍为 null，当前改名改价不改写历史订单快照。

`cancelReservation` 只从同一 context 检查 `room.reserve`，以冻结的 `dbNow` 判断其他预约是否仍在原下午四小时／夜间六小时窗口内；不读取 demo 时钟或 payload 身份。原按 ID 选择、唯一预约的缺省选择、取消状态和房态释放判断保持；不新增员工映射、审核或营业日语义。预约原 person／employeeId／recordedBy 等历史字段不改写，实际操作者仅由现有 operation／audit 的 session principal 记录。

`deposit`／`withdraw` 经 `deposits.js:submitDeposit`／`withdrawDeposit` 的显式 trusted 模式，只从 context 检查 `deposit.manage`、取 `principalId` 与冻结 `dbNow`；存入／取出记录的原 `person` 字段保存该 principal ID，原 `time` 字段保存数据库时间，历史记录不改写。顾客 name／phone、存取酒 identity、房号、商品和数量继续是业务输入，不能授予权限或替代操作者。demo 保留原 need／person／time 调用；手机号或姓名至少一个、一次多酒、基础数量、取酒核对及余额规则原样保留，存取酒不扣商品库存。未建立 employee 映射，历史未知商品名称不从当前目录补造。

context 的 WeakSet 标记和 permission guard 放在已存在的、浏览器兼容的 `shared/identity.js`，注册只在 Node auth revalidation 创建 Stage 2A principal 后发生；auth 保留原 guard 导出。JSON 复制不能生成标记，领域模块不用导入 Node crypto／auth，也无需修改静态 server 白名单。未配置真人账号或真实员工关联，独立名册接口见上文；没有 HTTP／cookie／UI 接入，也未迁移其他业务 action。

## 状态所有权

| 事实 | 当前 owner | 持久化 |
|---|---|---|
| 当前商品、规格、套餐 | `state.catalog`；`catalog.js` 查询，`rules.js` 维护 | `persistence.js` 的完整状态快照 |
| 房间、预约、异常 | `rooms.js` | 同上 |
| 订单、销售快照、付款、挂账与回款 | `sales.js`；`rules.js` 协调跨域 | 同上 |
| 库存余额、期初及流水 | `inventory.js` | 同上 |
| 支出、采购、客诉、存取酒、交班 | 对应领域模块 | 同上 |
| 演示权限配置 | `shared/identity.js` 定义，状态中 `capabilities` 保存覆盖 | 同上；不是真实认证 |
| 报表 | `reporting.js` 只读派生 | 不单独存第二份事实 |
| MySQL 8.4／InnoDB | 独立 `ledger/mysql-store.js` 过渡账本 | 专用测试库已真实验收；当前页面未接入 |
| 正式员工名册与关联审计 | 独立 `employees/` 服务与 MySQL store | employees／employee_events，独立内部能力，未接业务 action 或客户端 |
| MySQL auth 账号、凭据、grants、session、事件 | 独立 `auth/` 服务与存储适配器 | 专用测试库已真实验收；已迁移九动作的 Node trusted 命令取 session 身份，浏览器尚未接入 |

旧 PostgreSQL `database/schema.sql` 的 `room_orders.room_id` 仍要求非空，不能直接承载当前无房零售。正式系统需要受信任的 API、真实身份、服务端事务、审计、并发版本、支付与退款证据、可验证备份及数据库迁移。
