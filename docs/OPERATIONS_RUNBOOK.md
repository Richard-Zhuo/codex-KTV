# 金碧辉煌 KTV 运行故障处理手册

适用：Stage 5D 候选，正式生产部署和真人初始化尚未执行。真实告警渠道未配置；无人值守不能只依赖本机监控。各事件定义见 [监控契约](STAGE5D_MONITORING_RUNBOOK.md)。

## 员工共同规则

1. 保留页面提示、查询编号和 incidentId，记下房间、时间与原操作。恢复后先重新读取服务器状态。
2. 不重复开房、付款或录入；结果待确认时保留原 operationKey。不用 demo/localStorage 替代营业，不建立离线补写队列。
3. 不运行 SQL，不改密码文件，不删数据，不绕过证书警告。未经老板确认，不反复重启电脑或设备。
4. 必须应急营业时，先联系老板。仅在老板明确批准后用独立人工应急单记录时间、房间、顾客付款证据、经办人和原操作编号；这不是系统订单，恢复后由授权人员逐笔核对原记录再决定如何处理，不能整批自动补录。

## 老板远程共同规则

打开可信 HTTPS 的 /admin，重新读取服务器状态，查看运维状态和 incidentId。数据库中断时后台登录也可能不可用；改看受保护的服务输出与 health/ready，由技术核对。不向员工索取 Cookie/token，不把完整日志、账号资料或付款详情转发给告警服务。明确决定暂停营业、受影响房间或人工应急流程；记录授权人和时间。

## 技术维护共同规则

以同一 incidentId 关联脱敏日志、原 operationKey 和 workflowId。先确认主机/数据库/门店/账本目标。只读检查先行；备份与恢复使用 [Stage 5B 契约](STAGE5B_BACKUP_RECOVERY.md) 的明确确认、verify、resume。不得用自动删除、修账、restore、重发设备控制来消除告警。凭据只通过保护的外部文件管理。

监控状态位于配置的 Git 外日志目录，文件 operational-state.json；只允许一个运行服务写入。校验失败必须保留原文件与证据、停止并由技术处理，不能删文件当“重置”。进程完全停止后才可迁移此文件。日志轮转只清理其生成的 ktv-时间-UUID.jsonl，不触碰账本、auth audit 或备份。

## 分场景处理

| 场景 / 机器码 | 症状与员工操作 | 老板远程判断 | 技术操作与恢复证据 |
|---|---|---|---|
| 系统打不开 / READINESS_LOST、MONITORING_FAILURE | 检查同店另一终端，保留提示；不反复重启、不清浏览器营业数据 | 区分一台终端与全店故障，确认是否暂停写入 | 检查服务、health/live 与 health/ready；NOT_READY 不等于进程退出。修复根因后 ready 恢复，原 incident RESOLVED |
| 数据库不可用 / DATABASE_UNAVAILABLE | 写入暂停，勿离线补写，勿换 operationKey 再付款 | 查看影响范围，批准应急记录须另行明确 | 只读检查数据库服务/连接/权限，不能自动 restore；恢复后 DATABASE_RESTORED 关联原 incident，重新读取 snapshot |
| 设备持续离线 / DEVICE_OFFLINE | 检查物理通电、网线与网络；等待原 workflow，不重复开房或手工多次开关 | 核对现场无人误操作及受影响房间 | 读取原 workflow/evidence；上线后原流程继续，不能因 OFFLINE 自动换测试目标 |
| 设备结果未知 / DEVICE_UNKNOWN | 不再次点击开/关，不重复发送控制；保留房间与查询编号 | 联系技术，核对现场设备实际状态 | 只 query 原 workflow，依据证据恢复；timeout 后禁止盲目重发。只有正式契约证明未执行才可继续，UNKNOWN 解除须有设备事实 |
| 设备验证久未完成 / DEVICE_VERIFYING、DEVICE_FAILED、PROVIDER_AUTH_FAILURE | 等待验证，暂不继续该房营业命令；不要重复登录探测 provider | 查看故障类型，不能把 ACK/HTTP200 当完成 | 查询设备状态与认证机器码，不输出 X-TOKEN/Cookie；独立查询证明后解决 incident |
| 付款异常 / DATA_INVARIANT_FAILURE | 顾客称已付但系统异常：保留原付款证据，不创建第二笔付款“补一下” | 授权人员查询原 payment/operationKey，必要时暂停相关交易 | 使用既有 invariant/recovery 检查；严重不一致暂停写入，保留证据，禁止自动修账 |
| 库存异常 / DATA_INVARIANT_FAILURE | 停止受影响销售，联系老板，不直接改成“看起来正确” | 核对实物与原销售/库存记录 | 走正式盘点/审核契约；契约不足时冻结受影响销售，禁止直接 SQL 修改库存 |
| 恢复维护 / RECOVERY_IN_PROGRESS、RECOVERY_READY_FOR_RESUME | 停止写入，保持页面，等待明确恢复；不能重启绕过 | 确认恢复目标和负责人；READY_FOR_RESUME 还不能营业 | verify 完成后由授权技术 explicit resume，再重启目标服务，检查 ready 和新 session；RECOVERY_RESUMED 只是确认状态恢复 |
| 服务重启 / PROCESS_FAILURE、PROCESS_CRASH_LOOP、UNCAUGHT_EXCEPTION、UNHANDLED_REJECTION | 等待服务恢复后刷新，不重录、不重复付款/开房 | 连续重启时联系技术，暂停重复手动重启 | Windows service-style restart 后重读 readiness；保留原 incident ID，检查原操作/设备 evidence，不能重复副作用 |
| 证书问题 / TLS_EXPIRING | 隐私/证书错误时停止访问；不点继续、不关校验、不改 HTTP | 安排技术在到期前更新，核对真实域名 | 核对 SAN、notBefore/notAfter、信任链；本轮不自动续证。替换受保护配置并受控重启后，可信 HTTPS 和恢复事件才是证据 |
| 备份失败 / BACKUP_FAILURE、BACKUP_OVERDUE、BACKUP_POLICY_MISSING | 通知老板，不删备份，不自动 restore | 看最后成功备份时间和风险窗口；是否继续营业由老板决定 | 核对目标目录、容量、权限和实际已验证产物；失败不得更新成功时间；修复后真实 verified backup 才解决 failure/overdue |
| 断电 / PROCESS_FAILURE、DATABASE_UNAVAILABLE | 检查现场电源安全，联系老板；不运行数据库命令 | 确认机器恢复和应急记录 | 顺序：Windows/机器 → MySQL → KTV service → readiness → 员工登录 → 核对原操作；数据疑点先维护/verify，不自动补写 |
| 网络断开 / READINESS_LOST、DEVICE_OFFLINE | 区分本终端/门店局域网；禁止回退 demo 或重复提交 | 老板远程 VPN 不通不等于店里系统挂了；向现场核实 | 分别检查门店 LAN、互联网/provider、远程 VPN。服务器可用而 provider 不通时保留原 workflow，只做正式查询恢复 |
| 磁盘或日志故障 / DIRECTORY_UNWRITABLE、DISK_CAPACITY_LOW、LOG_WRITE_FAILURE | 保留页面与编号，联系老板，勿删业务数据腾空间 | 确认备份和安全日志是否受影响 | 检查服务 stderr 保底信号、空间与 ACL；日志写入失败受控停止，不能静默继续；修复后受控重启并验证写入 |
| 登录异常 / AUTH_RATE_LIMITED、AUTH_REPEATED_FAILURES | 停止反复尝试并联系老板，不公开密码 | 按脱敏 account/source 指纹区分单账号与来源攻击 | 检查现有 auth 审计与限流；不公开账号/IP 明文。窗口消退或明确账号成功后按证据解决 |
| 通知异常 / ALERT_CHANNEL_MISSING、ALERT_DELIVERY_FAILED | 通过现有人工联系老板，不依赖未配置通知 | 决定渠道、接收人、值班及响应责任 | 只检查本地队列/固定码；required 渠道缺失必须 blocker。发送重试有界，不因告警失败重做交易 |

## 无效运维报告（仅技术）

MONITORING_FAILURE 若指向报告读取，保留原始证据并停止服务后核对日志目录内精确生成的 backup-report／invariant-report 文件。每轮最多读取50个；大量无效文件可能延迟后续报告。仅将确认无效的报告移到受保护的外部 incident 证据目录，再受控启动和核对状态。不要删除业务、认证或恢复审计，不让员工操作这些文件。其他采集继续，监控会明确显示降级。

## 远程值守的真实边界

本机进程或机器完全停止时，内部监控不能实时通知。重启后记录异常退出；停机期间发现故障需要老板决定独立外部监控主机/服务。生产告警渠道、接收人、备份计划/保留期、异地备份和加密/密钥管理尚未决定。本轮没有真实发送、部署、切换或设备控制。
