## Stage 5D audit fix

[High-risk audit and current acceptance evidence](STAGE5D_HIGH_RISK_AUDIT.md): local audit-fix candidate awaiting human re-acceptance; no merge/push.

## Stage 5D monitoring candidate

Stable base is human-accepted Stage5C at e57af99dd49a46771ff20dd495f71f22d9db97ff. Stage5D is local, unmerged/unpushed. [Monitoring contract and gap analysis](STAGE5D_MONITORING_RUNBOOK.md); [employee / owner / technical runbook](OPERATIONS_RUNBOOK.md); [current verification evidence](STAGE5D_VERIFICATION.md). Earlier stage headings below are historical.

## Stage 5C deployment/runtime candidate

Accepted main=origin/main=25c95f1 (Stage5B). Stage5C is local only; [runtime contract](STAGE5C_DEPLOYMENT_RUNTIME.md). Earlier candidate descriptions below are historical.

## Stage 5B backup / recovery candidate

Stage 5A is accepted and closed out: main=origin/main=b188df811926bf4d6cf6c535d1a186ff270e699c. Stage 5B develops only on codex/p0-1-stage5b-backup-recovery. No production initialization, provider request, deployment, merge or push. [Contract](STAGE5B_BACKUP_RECOVERY.md).

## Stage 5A production bootstrap

Controlled initialization and production readiness: [Stage 5A](STAGE5A_PRODUCTION_BOOTSTRAP.md). Current formal schema authority is MySQL migrations 001–010; no production cutover or live-control activation.

# 项目文档导航

这里是项目事实的导航入口。先按“要做什么”选择文档，不要求通读全部材料。

## 最小阅读路线

所有任务先读根目录 [AGENTS.md](../AGENTS.md)，然后依次读取：

1. 如被指定角色，读取对应 [角色职责](./roles/README.md)。
2. [当前阶段](./CURRENT_STAGE.md)，确认正在维护什么、已有证据和未完成项。
3. 与任务相关的 [需求](./REQUIREMENTS.md)、数据库契约或操作手册。
4. 需要读代码时，再沿 [模块地图](./MODULE_MAP.md) 进入最少的代码和测试。

## 脱岗 MVP 契约入口

[29 项 P0 业务矩阵](./OFFSITE_P0_MATRIX.md) 列目标与停止点；[OFFSITE_CONTRACTS](./OFFSITE_CONTRACTS.md) 列跨模块不变量；[KNOWN_ISSUES](./KNOWN_ISSUES.md) 区分错误复现与已修项；[OPEN BUSINESS DECISIONS](./OPEN_BUSINESS_DECISIONS.md) 留门店待确认规则。Track B `3193635` 的正向测试现已适配 Track A 集成候选，状态以 [CURRENT_STAGE](./CURRENT_STAGE.md) 为准。

## 要做什么 → 读哪里

| 任务 | 必读 | 按需补充 |
|---|---|---|
| 修改业务行为或权限 | [REQUIREMENTS](./REQUIREMENTS.md)、[CURRENT_STAGE](./CURRENT_STAGE.md) | [OFFSITE_CONTRACTS](./OFFSITE_CONTRACTS.md)、[KNOWN_ISSUES](./KNOWN_ISSUES.md)、[MODULE_MAP](./MODULE_MAP.md)、相关测试 |
| 修改页面入口、状态或主题 | [CURRENT_STAGE](./CURRENT_STAGE.md)、[MODULE_MAP](./MODULE_MAP.md) | [ARCHITECTURE](./ARCHITECTURE.md)、[店员练习手册](../店员练习手册.md) |
| 修改运行、测试或构建方式 | [DEVELOPMENT_ENVIRONMENT](./DEVELOPMENT_ENVIRONMENT.md) | `package.json`、`server.js` |
| 修改数据库或历史导入 | [数据库说明](../database/README.md)、[导入映射](../database/kdocs-import.md) | [ARCHITECTURE](./ARCHITECTURE.md)、`database/migrations/` 的编号 MySQL migrations；旧 SQL 只读历史参考 |
| 规划正式系统 | [CURRENT_STAGE](./CURRENT_STAGE.md)、[ARCHITECTURE](./ARCHITECTURE.md) | [REQUIREMENTS](./REQUIREMENTS.md)、数据库说明 |
| 执行多任务协作 | [总控职责](./roles/PROJECT_CONTROLLER.md) 或 [模块负责人职责](./roles/MODULE_OWNER.md) | [启动模板](./roles/TASK_START_PROMPTS.md) |
| 查过去做过什么 | [历史记录](./archive/README.md) | 对应日期的交付或验证快照 |

## 唯一维护位置

| 信息 | 唯一维护位置 |
|---|---|
| 用户已确认的目标、行为、范围和非目标 | [REQUIREMENTS.md](./REQUIREMENTS.md) |
| 当前实现进度、有效证据、未完成项和下一步 | [CURRENT_STAGE.md](./CURRENT_STAGE.md) |
| 文件入口、稳定符号、相关测试和改动边界 | [MODULE_MAP.md](./MODULE_MAP.md) |
| 工具链、命令、端口、数据路径和验证层级 | [DEVELOPMENT_ENVIRONMENT.md](./DEVELOPMENT_ENVIRONMENT.md) |
| 系统边界、依赖、数据流和状态所有权 | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| 当前 MySQL 过渡账本与旧关系型历史基线 | [`database/`](../database/README.md) |
| 员工练习步骤 | [店员练习手册](../店员练习手册.md) |
| 已结束阶段和过去的验证结果 | [archive/](./archive/README.md) |
| 所有 AI 任务共同规则 | [AGENTS.md](../AGENTS.md) |

其他文档只摘要并链接这些位置，不再复制正文。发现冲突时，保留历史证据，但用当前权威文档替换执行入口。

## 当前没有建立的目录

- `contracts/`：当前没有独立网络 API；浏览器状态契约在代码和测试中，数据库契约在 `database/`。出现正式 API 或版本化协议后再建立。
- `plans/`：当前没有正在执行的产品阶段计划；新阶段达到多任务规模时再创建，结束后移入 `archive/`。
- `decisions/`：目前没有需要脱离需求与架构单独维护的重大取舍记录；不为普通小改动机械新增。

## 维护规则

- 需求说明“应该怎样”，当前阶段和证据说明“目前怎样”；两者不一致时明确记录差异。
- 命令只在开发环境文档维护，并标注“配置确认”“历史执行”或“本次执行”。
- 历史文档必须明确标记“不是当前执行指令”。
- 修改标题或移动文件后，检查所有本地链接；引用代码时使用稳定符号，不使用行号。

Stage5C runtime and deployment contract: [STAGE5C_DEPLOYMENT_RUNTIME](STAGE5C_DEPLOYMENT_RUNTIME.md). Current evidence remains in CURRENT_STAGE.md.
