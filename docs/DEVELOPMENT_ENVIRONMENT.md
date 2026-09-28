# 开发与验证环境

本文件是项目命令、工具链、端口、数据位置和验证路线的唯一维护位置。命令状态分为：

- **配置确认**：本轮从实际配置或代码读取，未执行。
- **历史执行**：过去有记录，本轮没有重跑。
- **本次执行**：只有确实在当前任务运行后才能标记。

## 工具链

- Node.js，ES module 项目（`package.json` 的 `type` 为 `module`）。
- 原生 HTML、CSS、JavaScript；没有生产依赖，也没有框架构建步骤。
- 测试使用 Node 内置 `node:test`，由 `node --test` 自动发现测试文件。
- 新增依赖时优先使用 `pnpm`；新增生产依赖必须先取得用户确认。
- 当前仓库含 `pnpm-lock.yaml`，但现有运行和测试不要求先安装项目依赖。

## 命令

| 用途 | 命令 | 状态 | 说明 |
|---|---|---|---|
| 启动静态服务 | `npm start` | 配置确认 | `package.json` 映射到 `node server.js` |
| 直接启动 | `node server.js` | 配置确认 | 默认监听 `0.0.0.0:4173` |
| 使用其他端口（PowerShell） | `$env:PORT = 4174; npm start` | 配置确认 | `server.js` 读取 `PORT`，本轮未执行 |
| 完整自动测试 | `npm test` | 配置确认 | `package.json` 映射到 `node --test` |
| 2026-09-28 历史替代测试 | `$env:NODE_OPTIONS = '--test-isolation=none'; pnpm test` | 历史执行 | 历史记录为 73/73；不能当作本轮结果 |
| 本轮同脚本自动测试 | `node --test` | 本次执行 | 2026-09-29 浏览器验收及标题修整后共 223 项，217 通过、6 条已知问题复现跳过、0 失败、退出码 0；与 `package.json` 的 test 脚本相同。初始集成及最新原始输出见 [阶段记录](./CURRENT_STAGE.md) |
| 隔离浏览器恢复演练 | `node docs/verification/browser-recovery-harness.mjs` | 本次执行 | 仅绑定 `127.0.0.1` 的随机端口；打开打印出的 `/__seed`，用合成已付款订单走停写、复制、人工修正及显式重检，结果见 [浏览器记录](./verification/track-a-b-browser-recovery-2026-09-29.md) |
| 单文件语法诊断 | `node --check app.js` 等 | 历史使用／诊断 | 不能替代 `npm test` |
| 初始化数据库基线 | `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql` | 仅契约命令 | 项目运行时尚未连接 PostgreSQL，本轮未执行 |
| 写入主数据 | `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/seed.sql` | 仅契约命令 | 只应在明确的目标数据库和授权下执行 |

修改 JavaScript 后，项目约定的正式自动验证命令是 `npm test`。本轮 PowerShell 无法启动 `npm`；`pnpm test` 回退包装器因尝试写临时文件报 EPERM，因此直接执行同一脚本 `node --test`。这些结果均在阶段记录中分别标明。

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
| 数据库设计 | `database/schema.sql`、`database/seed.sql` | 设计基线，非当前运行数据 |
| 历史导入模板 | `database/templates/` | CSV 表头模板，不是已导入结果 |
| 测试文件 | 根目录 `*.test.js` | Node 内置测试 |
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
