# Production cutover plan — Stage 5E
本计划是未来操作手册，**不是生产执行授权**。当前只允许隔离 synthetic rehearsal；正式切换、真人初始化、真实库存、真实 mapping 和 KTVSky live control 均未执行。
当前验收依据见 [演练记录](verification/STAGE5E_CUTOVER_REHEARSAL.md)；逐项门禁见 [Readiness checklist](PRODUCTION_READINESS_CHECKLIST.md)。

## 行为用例与停止点
| 用例 | 前置资源 / 允许发起条件 | 操作 | 成功证据 | 停止点 |
|---|---|---|---|---|
| 干净部署 | 独占目录、已接受 commit、锁定依赖、独立 MySQL、私有配置 | 打包、迁移、preflight | artifact SHA、schema001–011、20 InnoDB tables、明确 blockers | dirty / 未接受 commit / 版本不符立即停止 |
| 初始化 | OWNER CONFIRMATION REQUIRED；目标、人员 UUID、权限、盘点表与映射逐项复核 | dry-run，再明确 apply | 正式 audit、重复 already_satisfied、冲突拒绝 | 不猜权限、库存 null、MAC 或房间占用 |
| GO | 十二门禁逐项有证据，真实项目不能使用 Fake 证据 | 报告 readiness，由负责人另行明确 GO | 人工记录、操作人、时间、版本、checkpoint | 缺项、N/A、无证据或没有 human GO 均 NO-GO |
| 故障恢复 | 已验证备份、唯一写入者、源冻结、目标独立 | restore → inspect → verify → explicit resume → restart | 旧 session 失效、历史 replay 无新副作用、新交易 R+1 | 不覆盖源、不自动重试 UNKNOWN、不静默丢新交易 |

## Checkpoints / point of no return
| Checkpoint | 保留证据 | 回退边界 |
|---|---|---|
| C0 | migration 前：接受 commit、artifact SHA、配置指纹、空目标与原环境事实；已有系统须有 verified backup | 尚无生产变化，可中止 |
| C1 | migration 后：正式 schema/checksum、表/engine 与 schema/application 兼容矩阵 | MySQL DDL forward-only；没有通用 DOWN |
| C2 | 初始化后、首笔营业前 verified backup、revision、身份/库存/mapping复核 | 仅在确认无任何新业务写入时，可向独立目标恢复并验证 |
| C3 | service ready：HTTPS、健康检查、登录、十二门禁与人工 GO 记录 | 尚无新业务写入时才允许中止返回原系统 |
| C4 | first business transaction：首笔业务 operationKey/revision、订单/支付/库存证据 | **第一笔新业务写入是 point of no return**；禁止恢复 C2 丢掉后续支付/订单/库存 |
| FROZEN | 故障后冻结的最新 verified backup、完整对账、唯一写入者证据 | 必须保留全部新交易，优先修复向前或使用已验证兼容版本 |

回退不是自动执行器。rehearsal/gates.js 的 rollbackDecision 只报告；businessWrites>0 或 currentRevision>backupRevision 一律 PRESERVE_NEW_TRANSACTIONS。缺 verified backup / 不兼容 schema 一律拒绝。相同 schema 版本不自动意味着旧 app 可运行；本轮仅验证 c1502c0 与 e57af99 在 schema001–011 启动，旧 app 必须使用其支持的旧配置（不能把 Stage5D monitoring 配置传给 Stage5C）。

## 逐步操作
每步必须先核对 PRECONDITION，再记录 ACTION、VALIDATION、门禁及负责人。任何失败保留现场，不自动删除不明资源。

### STEP 1 — release
- PRECONDITION：已人工接受 commit；Node24.19.x；锁文件依赖；源码 clean；构建和输出目录与 Git 分离。
- ACTION：从固定接受 commit 构建受限 runtime package，校验 SHA-256，解包到新的发布目录。操作模板另行放置，不夹带测试/日志/备份/秘密。
- VALIDATION：commit、hash、Node、依赖版本、完整模块资源与内容哈希；不从 dirty 工作区发布。
- GO / NO-GO：任何版本/哈希/依赖差异 NO-GO。
- ROLLBACK：停止，保留旧版本。不得在线 git pull。
- OWNER：技术负责人；店主确认接受版本。

### STEP 2 — target / C0
- PRECONDITION：OWNER CONFIRMATION REQUIRED；服务器 UUID、数据库、store/ledger、磁盘、备份保管位置双人复核。
- ACTION：建立受控目录、专用服务身份、外部 secrets/log/backup 目录；记录 C0。
- VALIDATION：私有 listener、MySQL loopback/private、ACL、空间与权限；生产资源不得由 rehearsal 命名推断。
- GO / NO-GO：目标不明、现有营业数据或权限过宽 NO-GO。
- ROLLBACK：仅撤销本次明确拥有的新资源。
- OWNER：技术负责人＋店主。

### STEP 3 — backup / C1 / schema
- PRECONDITION：真实备份 schedule/retention、异机副本、加密与密钥托管、恢复资源已获批准；迁移前备份 checksum 已独立保管。
- ACTION：按 [Stage5B](STAGE5B_BACKUP_RECOVERY.md) 备份；单独审核并执行 database/migrations/001…011（升级只执行缺少且已审核的部分）。
- VALIDATION：schema manifest、20 InnoDB tables、当前数据不变；迁移失败环境保持 not ready，bootstrap 拒绝。
- GO / NO-GO：partial DDL、未知 schema、无 verified backup 均 NO-GO。
- ROLLBACK：停止应用；无自动 DOWN 或 wipe。按实际兼容矩阵选择独立恢复或 forward fix。
- OWNER：数据库操作员＋技术负责人。

### STEP 4 — identity / formal first-install ledger / inventory
- PRECONDITION：OWNER CONFIRMATION REQUIRED；逐一签字确认真实 employee/principal UUID、binding、权限/policy、目标 MySQL server UUID、DB、store/ledger、应用提交及期初实盘数量；岗位名称不授予能力。
- ACTION：先用 production/bootstrap-cli.js 完成正式身份 dry-run 和明确 apply；再按 [S1 正式首装合同](S1_FIRST_INSTALL.md) 依次执行 production/first-install-cli.js 的 ledger、stock、approve 计划。每个计划先 dry-run，人工核对其目标和确认串，再 apply；库存只通过正式可信命令写入。
- VALIDATION：正式 auth/employee/S1 ledger audit；原计划重放为 already_initialized 或原 operationKey 结果；库存调整与审核 audit、revision、全部受管商品实盘数量明确，null 不自动转 0；readiness 不再有 LEDGER_NOT_INITIALIZED / INVENTORY_NOT_INITIALIZED。
- GO / NO-GO：目标、身份、backend.view、审核、review.self、policy 或任一商品盘点缺失即 NO-GO；S1 blocker 消失也不替代其他生产门槛或人工 GO。
- ROLLBACK：停止初始化；不自动重绑、扩权、覆盖已完成盘点或换 operationKey；提交结果不明时先用原计划核对/重放。
- OWNER：店主＋盘点/账号操作员。

### STEP 5 — mapping / provider
- PRECONDITION：OWNER CONFIRMATION REQUIRED；每房人工确认 internalRoomId/provider/externalDeviceId/enabled。
- ACTION：正式 mapping dry-run/apply；先以 approved disabled 模式营业，真实控制是独立后续 gate。
- VALIDATION：唯一约束、audit、repeat/conflict；不能以 ONLINE/OFFLINE 或无本地订单推断无人。
- GO / NO-GO：未确认房间不得启用；V06 历史确认不构成本次控制授权。
- ROLLBACK：保持 live OFF；UNKNOWN 只 query。
- OWNER：店主＋现场设备负责人。

### STEP 6 — secrets / HTTPS / network
- PRECONDITION：正式 TLS 与 private VPN/DNS/firewall 已配置；证书链、hostname、有效期与 Windows ACL 双人核对。
- ACTION：外部 config/secrets 文件通过 production/runtime-config.js；运行 production/preflight.js。
- VALIDATION：真实客户端信任，禁止 insecure bypass；HttpOnly/Secure/Strict/Path=/；MySQL 不对公网开放。
- GO / NO-GO：失效/错配证书、ACL 不可核对、网络未限制即 NO-GO。
- ROLLBACK：服务不启动；修复材料后重新 preflight，不降级 HTTP。
- OWNER：技术负责人。

### STEP 7 — service / monitoring
- PRECONDITION：实际服务身份/注册已批准；真实告警渠道和异机 heartbeat 配置并验证。
- ACTION：按 [Stage5C service template](STAGE5C_DEPLOYMENT_RUNTIME.md) 注册受控服务，验证 delayed auto-start、crash recovery、stop/restart；按 [运维手册](OPERATIONS_RUNBOOK.md) 验证告警。
- VALIDATION：实际 SCM 状态、fresh process、/health/live 和 /health/ready、告警送达/恢复/重试及外部失联检测。
- GO / NO-GO：模板、console 模拟和同机 Fake checker 不能替代真实 SCM/异机监控。
- ROLLBACK：停止自己注册的服务，不停止无关进程。
- OWNER：技术负责人＋接警人。

### STEP 8 — C2 / NO-GO / human GO
- PRECONDITION：十二类 checklist 有真实证据，最新 C2 backup verified，旧 app/schema/config 兼容已证明。
- ACTION：逐项 preflight；故意缺失 gate 必须 NO-GO。全绿也只报告 readiness，由店主另行明确 GO。
- VALIDATION：人工 GO 时间、版本/hash、负责人、备份 revision；没有自动 cutover。
- GO / NO-GO：任何 BLOCKED/N/A/无证据/无 human GO 均 NO-GO。
- ROLLBACK：尚无新业务写入可中止；独立目标 restore/verify/resume 仍需复核。
- OWNER：店主＋技术负责人。

### STEP 9 — first business / C4
- PRECONDITION：明确 human GO、员工培训与现场支持；真实 provider gate 仍 OFF，除非另获独立授权。
- ACTION：正式登录 → snapshot → 小额开房/商品/收款/结账/清洁；后台核对业务与设备状态。
- VALIDATION：server revision、operationKey、订单/支付/库存/归属/现金对账。响应丢失先确认，原 key 重试；revision conflict 不自动重做。
- GO / NO-GO：未知结果暂停同笔业务；不得回退 demo/localStorage。
- ROLLBACK：首笔业务之后禁止旧备份覆盖；冻结、保留全部新交易，选择兼容 app 或 forward fix。
- OWNER：营业操作员＋店主。

### STEP 10 — incident / FROZEN / recovery
- PRECONDITION：incident 和当前 pending 操作已记录；OWNER CONFIRMATION REQUIRED；源唯一写入者已冻结/停止；目标独立且空。
- ACTION：freeze → 最新 verified backup → separate restore → inspect → verify → explicit resume → target restart → new login。
- VALIDATION：全部历史 cell/revision/operation 保留，旧 sessions revoked，device query-first；新 command R+1；旧操作 replay 不产生副作用；同 incident 恢复。
- GO / NO-GO：当前 restore 工具只允许 TEST，**真实 production restore/cutover 仍需另行评审与实现授权**。不可将本清单变成已经可执行的生产恢复支持。
- ROLLBACK：源保持冻结；失败目标保留诊断；不自动 wipe、切回或再次 device mutation。
- OWNER：数据库操作员＋技术负责人＋店主。

### STEP 11 — observation / owner absence
- PRECONDITION：接警联系人、远程访问、外部监控和离线操作指引已实际验证。
- ACTION：运行一个受监督营业窗口，核对现金、信用/免零、库存、待办和备份新鲜度。
- VALIDATION：员工能按 [运维手册](OPERATIONS_RUNBOOK.md) 停止重复操作并联系负责人；老板远程可读业务和 incident。
- GO / NO-GO：未经真实场地与人员验证，不宣称 14-day offsite MVP ready。
- ROLLBACK：保留新交易，按 FROZEN 恢复；不得删除订单以制造通过。
- OWNER：店主＋值班负责人。

## 操作命令清单（模板，当前禁止生产执行）
命令中的 ABSOLUTE_* 必须替换为经审核的 Git 外受保护文件；密码/token/Cookie 不放 argv。bootstrap/mapping exact 参数见 [Stage5A](STAGE5A_PRODUCTION_BOOTSTRAP.md)；服务注册完整模板见 [Stage5C](STAGE5C_DEPLOYMENT_RUNTIME.md)。迁移和真人 apply 不自动化。
- [ ] 固定接受 commit + artifact SHA / lock / Node / MySQL。
- [ ] verified backup + 独立保存 checksum + 恢复可行性。
- [ ] official migration complete + partial failure not ready。
- [ ] 每步 preflight：migration / bootstrap / inventory / mapping / before start / after start / before GO。
- [ ] node production/preflight.js --config-file ABSOLUTE_CONFIG（三个 production environment selector 必须显式一致）。
- [ ] node production/start.js --config-file ABSOLUTE_CONFIG（实际服务应由受控 native host 启动）。
- [ ] TEST drill: node backup/cli.js backup --config-file ABSOLUTE_SOURCE_CONFIG --output-dir ABSOLUTE_NEW_DIRECTORY --confirm SERVER_UUID/DATABASE/STORE/LEDGER。
- [ ] TEST drill: node recovery/cli.js freeze --config-file ABSOLUTE_SOURCE_CONFIG --confirm SERVER_UUID/DATABASE/STORE/LEDGER。
- [ ] TEST drill: node backup/cli.js restore --config-file ABSOLUTE_TARGET_CONFIG --artifact-dir ABSOLUTE_ARTIFACT --checksum TRUSTED_SHA256 --confirm SERVER_UUID/TARGET_DATABASE/STORE/LEDGER/SHA256 --restore-to-new-db。
- [ ] TEST drill: node recovery/cli.js inspect / verify（分别执行）--config-file ABSOLUTE_TARGET_CONFIG --artifact-dir ABSOLUTE_ARTIFACT --checksum TRUSTED_SHA256 --confirm SERVER_UUID/TARGET_DATABASE/STORE/LEDGER/SHA256。
- [ ] TEST drill: node recovery/cli.js resume --config-file ABSOLUTE_TARGET_CONFIG --checksum TRUSTED_SHA256 --confirm SERVER_UUID/TARGET_DATABASE/STORE/LEDGER/SHA256/RESUME。
- [ ] 重启目标、重新登录、snapshot、历史 replay、新命令与所有账目对账。
- [ ] human GO 明确记录，独立 provider live enable decision。
