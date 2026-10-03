# 数据库边界

正式数据库方向现为 MySQL 8.4 LTS + InnoDB。既有 `schema.sql`、`seed.sql` 和历史导入映射保留为旧 PostgreSQL 关系型设计参考，不作为当前可执行的正式数据库结构。现有页面仍使用 localStorage；本目录 SQL 不会自动迁移或覆盖演示数据。

## 当前方向：MySQL 8.4 LTS／InnoDB 过渡账本

`migrations/001_mysql_ledger_core.sql` 只建立 `ledger_heads`、`ledger_operations`、`ledger_success_audit`，三表均指定 `ENGINE=InnoDB`。`ledger/mysql-store.js:createMySqlLedgerStore` 由可信调用方显式注入 `mysql2` promise Pool、稳定 ledgerId 和已迁移的数据库名，沿用 Stage 1A 的 `runAtomic` 端口。独立 Node trusted 入口只对已迁移房间五动作、目录三动作、存取酒两动作及销售两动作接入同事务 session 重验，具体集合见 [ARCHITECTURE](../docs/ARCHITECTURE.md)；没有真人账号、HTTP、UI 切换或正式数据导入，已有静态演示仍只用浏览器 localStorage。

`ledger_heads.state_json` 保存版本化 MySQL JSON 快照，`state_checksum` 是按 JSON 值规范化后的 SHA-256；读回会核对。MySQL JSON 会调整文本表示，它和原始 `jbhh-demo-v1` 文本不是同一备份。未来正式导入必须另存原始 JSON 字节和原文校验和，本阶段不执行导入。此过渡账本不代表最终领域关系模型已完成。

Migration 只能在已核实的空目标数据库执行一次。MySQL DDL 每条语句独立提交，三表脚本不能当作单个可回滚事务；重复执行会因首表已存在而失败，部分失败需停下核查后处理。集成测试仅在 `LEDGER_MYSQL_TEST_URL` 明确指向 `jbhh_ktv_test`，且连接实际选中的数据库、MySQL 8.4 版本和默认 InnoDB 引擎均通过检查后运行。开始和结束时只按外键顺序清理该库的 `ledger_success_audit`、`ledger_operations`、`ledger_heads` 三张测试表；不会创建或删除数据库，也不会清理其他表。未配置连接 URL 时明确跳过。

## Stage 2B：独立认证表

`migrations/002_mysql_auth_core.sql` 依次建立 `auth_accounts`（稳定 principal ID、启用状态、凭据版本）、`auth_credentials`（唯一不透明登录标识、scrypt 版本、salt、派生值）、`auth_grants`（具体 permission）、`auth_sessions`（仅 token digest、凭据版本、闲置／绝对过期、撤销时间）和 `auth_events`（事件类型、主体／session 引用、数据库时间）。均指定 InnoDB；不插入真人账号或旧演示 ID。账号只停用，不提供删除和 ID 重用入口。`auth_events` 不保存密码、token、salt、派生值或业务 payload。

`auth/mysql-store.js` 对组合写入使用一条连接和单个事务；凭据校验及成功 session／审计写入在此事务内完成，SQL 失败回滚。session 每次认证重读启用状态、凭据版本和 grants；权限不写入 token 或 session。`auth/rate-limit.js` 的单进程实现仅是显式限流 port 的当前实现，未来多进程 HTTP 入口须换共享限流器。正式登录标识、初始密码发放与恢复仍待门店决定。

真实测试可使用 `AUTH_MYSQL_TEST_URL`，未设时复用已明确的 `LEDGER_MYSQL_TEST_URL`；连接必须实际选中 `jbhh_ktv_test`，且为 MySQL 8.4／默认 InnoDB。若 auth 表已存在，测试拒绝执行；测试只删除该次成功创建的五张 auth 表，不创建／删除数据库，不碰 ledger 表。DDL 每条独立提交，部分失败须检查后处理。

Stage 2C.1 另提供 `bindSessionRevalidation(connection)`，复用调用方已开启的事务，不管理连接生命周期或活动更新时间；account-first 锁序、当前 grants、单次 DB UTC 时间和未配置属性的接口契约见 [ARCHITECTURE](../docs/ARCHITECTURE.md)。未新增表或 migration；已迁移房间、目录、存取酒、预约、销售及配品／其他消费动作已消费此能力，精确执行顺序与 demo 隔离见 [ARCHITECTURE](../docs/ARCHITECTURE.md)，真实验收状态见 [CURRENT_STAGE](../docs/CURRENT_STAGE.md)。

2C.2 建立的独立房间命令集成 fixture 原用以上两个 migration；2C.3 的房间异常、目录维护、取消预约、存取酒、reserve、销售及配品／其他消费复用同一 fixture，现为 reserve 另执行 003_mysql_employee_core.sql；目录用例由 ledger/trusted-catalog.integration.js 承载，取消预约用例由 ledger/trusted-cancel-reservation.integration.js 承载，存取酒用例由 ledger/trusted-deposits.integration.js 承载，reserve 用例由 ledger/trusted-reserve.integration.js 承载；销售用例由 ledger/trusted-sales.integration.js 承载；配品／其他消费用例由 ledger/trusted-order-additions.integration.js 承载；六个 helper 均不负责 DDL／清理；严格验证 URL 与实际库为 `jbhh_ktv_test`、版本 8.4、引擎 InnoDB；拒绝预存 auth／employee 表，结束仅按外键顺序删除本次创建的十张 auth／ledger／employee 表。原 auth fixture 仍只操作其五表，原 ledger fixture 仍只操作其三表。三套 fixture 以 setup connection 的具名锁串行 DDL，连接结束释放；命令并发仍用真实 InnoDB 行锁，测试锁不进入生产 adapter。不创建／删除数据库，不操作其他表。

## 员工名册与显式关联

`migrations/003_mysql_employee_core.sql` 在已存在 auth_accounts 的目标库新建 employees 与 employee_events，均 InnoDB；不含 seed。可同名／无账号员工使用稳定 UUID，nullable unique principal_id FK 支持可选一对一；显示名不是登录名或映射依据。created_at、updated_at 默认 UTC_TIMESTAMP(6)，store 更新显式使用同一数据库函数；audit occurred_at 默认数据库 UTC。关联前后 principal、操作者及 employee 均受 FK 保护，关联事件有 shape CHECK。只能运行一次，重复执行首表明确拒绝；DDL 部分失败需人工核查，不自动删表或猜测修复。

内部接口及锁序见 [ARCHITECTURE](../docs/ARCHITECTURE.md)。关系变更和事件在一条 connection／事务提交；员工停用、账号停用互不联动，不提供硬删除或 ID 重用。事务内归属解析当前仅被 trusted reserve／sale／retailSale 调用；bindEmployeeResolver(connection) 只在调用方活动事务内按 UUID 做 FOR SHARE 当前读取，返回启用员工的 ID／显示名快照，不读取 principal 关联或管理事务。接口、锁序与证据见 ARCHITECTURE／CURRENT_STAGE；预约／销售新记录的快照字段与精确链见 ARCHITECTURE；历史姓名、旧 USERS 及其他业务 action 保持。

真实名册 fixture 从 LEDGER_MYSQL_TEST_URL 取得已指定 jbhh_ktv_test，验证 URL／实际库／MySQL 8.4／InnoDB，拒绝预存的五张 auth 表及两张 employee 表。与原 fixture 共用具名测试锁，只清理本次创建的七表，按 employee_events → employees → auth_events → auth_sessions → auth_grants → auth_credentials → auth_accounts 顺序；不操作 ledger 三表，不 CREATE／DROP database。SQL 故障注入只将 employee_events INSERT 列名改为不存在列，实际数据库拒绝后验证此前 employee 写入回滚。证据见 [CURRENT_STAGE](../docs/CURRENT_STAGE.md)。

## 文件

- `migrations/001_mysql_ledger_core.sql`：当前 MySQL 过渡账本三表。
- `migrations/002_mysql_auth_core.sql`：独立认证与 session 基础五表；无真人 seed。
- `migrations/003_mysql_employee_core.sql`：employees／employee_events 名册与关联审计；无员工或账号 seed。
- `schema.sql`：旧 PostgreSQL 关系型业务表、约束、索引，以及金山日报和支出表的原始暂存区。
- `seed.sql`：旧 PostgreSQL 草案中的当前门店、9 个房间、员工岗位说明、具体权限、商品与库存项目。
- `kdocs-import.md`：旧关系型草案中的金山文档字段映射；正式 MySQL 导入尚未设计。
- `templates/kdocs-daily-report.csv`：后续导出日报时使用的 UTF-8 表头模板。
- `templates/kdocs-expense-report.csv`：支出对账表表头模板。

## 旧 PostgreSQL 设计基线（历史参考，不是当前执行入口）

下面的 psql 命令只是旧基线当时的设计示例，不用于当前 MySQL 方向：

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/seed.sql
```

当前仅为独立账本适配器增加 `mysql2` 生产依赖；静态服务器仍未改造成正式 API。接入后端时，必须在服务端事务中执行房态、账单、库存和幂等校验，不能直接信任浏览器提交的数据。

## 旧关系型草案

```text
stores
├─ employees ─ employee_roles / employee_permissions
├─ rooms ─ room_issues / room_issue_change_requests
│       ├─ reservations
│       └─ room_orders
│          ├─ order_items / order_exchanges / gift_requests
│          ├─ payments
│          ├─ credits ─ credit_repayments
│          └─ platform_vouchers / rounding_reviews
├─ products ─ inventory_balances / inventory_movements
├─ stored_wine_lots ─ stored_wine_withdrawals
├─ expense_records ─ procurement_records
├─ incidents
└─ handovers

import_batches
├─ import_daily_report_rows
├─ import_expense_rows
├─ import_row_errors
└─ import_source_links
```

金额字段都以 `_cents` 结尾并存整数分。营业记录同时保存 `business_date` 与实际时间，避免凌晨结账被错误归到下一自然日。历史订单使用 `历史已结` 状态，不改变当前房态。

审批行为以 [当前需求](../docs/REQUIREMENTS.md) 为准。旧 schema 在数据库层为房间恢复、挂账回款、特殊差额、超额赠酒水、库存盘点和客诉／异常恢复保留 `self_review_authorized` 约束：审核人等于提交人时该值必须为 `true`，且非本人审核不能误记为自审。房间故障／维护标记与恢复证据分别写入 `room_issues` 和 `room_issue_change_requests`。

## 旧历史导入草案（未实施）

1. 从金山文档分别导出“日报”和“支出对账表”为 CSV 或 XLSX，原文件计算 SHA-256。
2. 建立一条 `import_batches`，将每个单元格原文写入对应暂存表，金额暂不做浮点转换。
3. 校验日期、房号、房型、时段、金额、商品别名和重复行；错误写入 `import_row_errors`。
4. 整批校验通过后，在一个数据库事务里写入主数据、历史订单、明细与付款，并写 `import_source_links`。
5. 只有事务完成后才把批次和暂存行标为“已导入”。同一批次、行号和校验和不能重复导入。

## 导入边界

- 日报没有支付方式明细时，付款记为 `历史汇总未分类`，不能猜成微信或现金。
- “燕京”和“新喜力”在当前菜单中没有销售配置，种子数据保留为停用历史商品，原数量不会丢失。
- 历史日报只建立营业与财务记录，不倒扣今天的库存；库存必须从明确的期初盘点记录开始。
- “房间故障原因”可以生成已结束的历史异常说明，但不会把当前房间自动设为故障。
- 原报表值和整行 JSON 始终保存在暂存区，方便回查、修正规则和重新导入。
- 图片列只保存引用地址或文件标识；正式附件应进入对象存储，不把大图直接写进数据库。
