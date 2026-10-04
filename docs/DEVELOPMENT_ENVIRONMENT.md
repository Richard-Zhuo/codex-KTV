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
| repayment 审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-repayment-review.test.js ledger/trusted-repay.test.js ledger/trusted-credit-review.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js sales.test.js operations.test.js` | 本次执行 | 本次申请人自审、legacy／伪造拒绝、一笔 payment 与余额原子性、驳回无资金、拒绝不占键、撤权重放和未知异常；真实 MySQL helper 使用既有 guarded fixture，实际结果见 CURRENT_STAGE |
| expense 审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-expense-review.test.js ledger/trusted-expense.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js auth/policy-attributes.test.js auth/session-revalidation.test.js operations.test.js` | 本次执行 | 锁内本人／金额阈值、当前 boss 属性、legacy／伪造拒绝、稳定决定 principal、不占键／撤权重放及原业务矩阵；真实 MySQL 用例由 trusted fixture 承载，005 repeat／属性 SQL 回滚由 auth fixture 承载，结果见 CURRENT_STAGE |
| gift 审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-gift-review.test.js ledger/trusted-gift.test.js ledger/trusted-clean.test.js rules.test.js inventory.test.js ledger/command-policy.test.js` | 本次执行 | 锁内稳定申请人、本人双权限、legacy／伪造拒绝、稳定决定 principal、不占键／撤权重放、原批准／驳回、数量／库存及 demo 对照；保留原 rules 平台券 skip，结果见 CURRENT_STAGE |
| 房间恢复审批 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-room-issue-review.test.js ledger/trusted-clean.test.js rooms.test.js rules.test.js ledger/command-policy.test.js` | 本次执行 | 锁内稳定申请人、本人双权限、legacy 拒绝不占键、决定 principal、原房态规则与 demo 对照；结果见 CURRENT_STAGE |
| 换酒 trusted 定向与原领域回归 | `node --test --test-isolation=none ledger/trusted-exchange.test.js ledger/trusted-clean.test.js rules.test.js inventory.test.js sales.test.js` | 本次执行 | 三类换酒来源、库存两步原子性、快照／金额、actor／权限／DB 时间、不占键／replay；结果见 CURRENT_STAGE，不连接数据库，保留该集合原平台券 skip |
| 存取酒单元与原领域回归 | `node --test --test-isolation=none ledger/trusted-clean.test.js operations.test.js` | 本次执行 | 新存取酒 trusted 契约与原业务矩阵；不连接数据库 |
| trusted 命令 MySQL 集成测试 | `node --test --test-isolation=none ledger/trusted-clean.integration.test.js` | 本次执行 | repay 申请／审批、credit 申请／决定、expense 申请／审批、gift 提交／审批、库存申请与审核、房间恢复 approve／reject、换酒、配品／其他消费、销售／预约及既有房间／目录／存取酒用例共用专用库 fixture；沿用原十张已知 fixture 表并迁移／创建 auth_policy_attributes，共十一张，拒绝预存 auth／employee 表，不操作其他表 |
| incident trusted／员工／原领域回归 | `node --test --test-isolation=none ledger/trusted-incident.test.js ledger/trusted-reserve.test.js ledger/trusted-clean.test.js ledger/command-policy.test.js operations.test.js` | 本次执行 | 负责人同事务解析与操作者独立；真实数据库附加在原 trusted 十一表 fixture；结果见 CURRENT_STAGE |
| 小额免零边界与原业务回归 | `node --test --test-isolation=none rounding-limit.test.js sales.test.js rules.test.js offsite.contract.test.js` | 本次执行 | 10 元包含边界；真实 MySQL 边界附加在原 ledger fixture，K01／K06 不扩修；结果见 CURRENT_STAGE |
| principal 员工解析定向回归 | `node --test --test-isolation=none employees/principal-employee-resolver.test.js employees/employee-resolver.test.js employees/mysql-store.test.js employees/roster.test.js employees/mysql-roster.integration.test.js` | 本次执行 | 新八项契约与真实 MySQL 十项附加在原 guarded roster fixture；不创建／删除 database，无关联／停用／同名、调用方事务及双连接锁序 |
| 员工名册定向单元测试 | `node --test --test-isolation=none employees/employee-resolver.test.js employees/mysql-store.test.js employees/roster.test.js` | 本次执行 | UUID、关联／停用／审计、事务内 resolver、connection 所有权和 rollback／提交结果不明；不连接数据库 |
| 员工名册 MySQL 集成测试 | `LEDGER_MYSQL_TEST_URL` 指向专用库后运行 `node --test --test-isolation=none employees/mysql-roster.integration.test.js` | 本次执行 | 仅本轮创建的八张 auth／employee 表（含 attributes）；原 migration／关联用例及 resolver 当前读取、调用方回滚、双连接停用锁竞争；未配置不得宣称通过 |
| MySQL 账本集成测试 | `LEDGER_MYSQL_TEST_URL` 明确指向 `jbhh_ktv_test` 后运行 `node --test --test-isolation=none ledger/mysql-store.integration.test.js` | 本次执行 | 本轮真实复验结果见 [CURRENT_STAGE](./CURRENT_STAGE.md)；仅清理该库三张已知账本表，不创建或删除数据库；未配置时跳过且不得当作集成通过 |
| MySQL 认证／重验集成测试 | `AUTH_MYSQL_TEST_URL` 或已确认的 `LEDGER_MYSQL_TEST_URL` 指向 `jbhh_ktv_test` 后运行 `node --test --test-isolation=none auth/mysql-auth.integration.test.js` | 本次执行 | 保留原 Stage 2B 16 项，并在同一 auth fixture 调用 2C.1 重验／锁竞争及 attributes 用例；本轮数据库证据见 CURRENT_STAGE。拒绝预存 auth 表，只删除本次创建的六张 auth 表（含 attributes），不动 ledger 表或数据库本身 |
| 隔离浏览器恢复演练 | `node docs/verification/browser-recovery-harness.mjs` | 历史执行 | 上轮仅绑定 `127.0.0.1` 的随机端口，使用合成已付款订单演练停写、复制、人工修正及显式重检；本轮未重跑，见 [浏览器记录](./verification/track-a-b-browser-recovery-2026-09-29.md) |
| 单文件语法诊断 | `node --check app.js` 等 | 历史使用／诊断 | 不能替代 `npm test` |
| 旧 PostgreSQL 基线命令 | `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql` | 历史参考 | 不是当前 MySQL 方向的执行入口；不要对正式库运行 |
| 旧 PostgreSQL seed 命令 | `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/seed.sql` | 历史参考 | 不适用于 MySQL 过渡账本 |

独立 clean、原 auth、原 ledger 和 employee 集成 fixture 共用 `test-support/mysql-fixture-lock.js`，具名锁只串行建表／清理的 fixture 生命周期，不串行或替代生产命令的 InnoDB 行锁。各套 SQL 只作用于已约定的专用测试表，绝不创建或删除数据库。

修改 JavaScript 后，项目约定的正式自动验证命令是 `npm test`。存取酒、员工名册、预约、销售、配品／其他消费、换酒、库存申请／审核及 gift 提交／审批实现均已实际尝试，但 PowerShell 找不到 `npm`，进程未启动；本次使用 `node --test --test-isolation=none` 执行完整 Node 测试集合，结果见上表。此前阶段测试数均为历史证据。

## 入口与端口

- 员工系统：`http://localhost:4173/`
- 系统管理后台：`http://localhost:4173/admin`
- 局域网访问：`http://<电脑局域网IPv4>:4173/`
- `server.js` 仅允许入口、`app.js`、各领域与 `ui/` 模块、主题与样式等白名单静态路径，不提供业务 API。

`localhost` 与局域网 IP 是不同浏览器来源，对应的 `localStorage` 数据不会自动共享。

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
