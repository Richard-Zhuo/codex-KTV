# 最小代码阅读地图

本文件回答“改某类内容时从哪里开始读”。符号名优先于行号；入口、测试路线或边界变化时同步更新。

| 改动目标 | 入口文件／稳定符号 | 相关测试 | 对应契约 | 关联边界 |
|---|---|---|---|---|
| 员工／系统管理入口和静态路由 | `index.html`、`admin.html` 的 `data-app-entry`；`server.js` 的静态 `files` 映射 | `entry.test.js` | [需求：身份、入口与权限](./REQUIREMENTS.md#已确认身份入口与权限) | `/` 承载日常营业；`/admin` 只承载系统管理；服务器没有 API |
| 页面导航、待办、弹窗与本机状态 | `app.js`：`APP_ENTRY`、`render`、`taskCenterPage`、`systemManagementPage`、`migrateDemoState`、`persist`、`commit` | `entry.test.js`；业务权限变化还需 `rules.test.js` | [架构：数据流](./ARCHITECTURE.md#数据流与事务边界) | 待办只聚合本人待办、业务审核和本人处理记录；主动营业操作留在所属模块 |
| 商品、房型、计价和业务事务 | `rules.js`：`initialState`、`transact` 及领域导出函数 | `rules.test.js` | [REQUIREMENTS](./REQUIREMENTS.md) | 金额使用整数分；事务失败不回写原状态；操作键防重复 |
| 身份与具体权限 | `rules.js`：`PERMISSION_DEFINITIONS`、`defaultCapabilities`、`effectiveUser`、`hasPermission`、`businessReviewSections` | `rules.test.js` | [需求：身份、入口与权限](./REQUIREMENTS.md#已确认身份入口与权限) | `backend.view` 不授予业务审核；`review.self` 只是自审附加条件 |
| 主题与自动切换 | `theme.js`：`refresh`、`window.ktvAppearance`；`style.css` 主题选择器 | `theme.test.js` | [需求：报表、主题与数据边界](./REQUIREMENTS.md#已确认报表主题与数据边界) | 使用设备时间和独立键 `jbhh-appearance-v1`，不跟随练习时间 |
| 房卡、表单、弹窗和报表视觉 | `style.css`；对应 `app.js` 渲染函数 | 没有独立视觉自动测试；规则行为由现有测试覆盖 | [店员练习手册](../店员练习手册.md) | 视觉通过必须使用约定浏览器或真机证据，不能由规则测试替代 |
| PostgreSQL 关系模型 | `database/schema.sql`、`database/seed.sql` | `database.test.js` | [数据库说明](../database/README.md) | 当前页面未连接数据库；SQL 是未来后端契约基线 |
| 金山日报／支出导入 | `database/kdocs-import.md`、`database/templates/`、schema 中 `import_*` 表 | `database.test.js` | [导入映射](../database/kdocs-import.md) | 先暂存后校验；未知支付方式不猜测；未实际导入 |
| 运行和测试命令 | `package.json` 的 `scripts`；`server.js` 的 `PORT` | Node 内置测试发现全部 `*.test.js` | [开发与验证环境](./DEVELOPMENT_ENVIRONMENT.md) | 项目无正式构建、打包或生产产物 |
| 操作练习说明 | `店员练习手册.md` | 历史证据见 `docs/archive/` | [REQUIREMENTS](./REQUIREMENTS.md) | 手册只说明流程，不成为第二套需求 |

## 常见任务的最短阅读顺序

### 改业务规则

1. 在 `REQUIREMENTS.md` 找到已确认行为。
2. 读 `rules.js` 中对应事务分支和领域函数。
3. 读 `rules.test.js` 中同一行为的测试。
4. 只有界面输入或展示变化时再读 `app.js` 和 `style.css`。

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
