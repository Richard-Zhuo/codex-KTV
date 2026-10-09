# Stage 5E cutover rehearsal — 2026-10-10

## 判定与证据边界

**FIXED, NEEDS HUMAN RE-ACCEPTANCE。整体演练 BLOCKED：真实 Edge 收款确认超时，修复后的 payment → settlement → clean 尚未补验。**

本轮只使用全新 synthetic 环境。没有真实部署、真人初始化、真实库存、真实 mapping 或 provider mutation；V06 未使用。源码审查、自动化 HTTP 营业与真实浏览器证据分别记录，不能互相替代。

稳定基线是 main=origin/main=c1502c0fb0713ef040b210e5ea35f6c31079b7ee。历史 Stage5D 2157 不是本轮测试结果。当前候选不 merge、不 push，须人工重新接受。

## 实现提交

| Commit | Parent | 用途 |
|---|---|---|
| 4b45a9c407b8fcfd462919d9aa63fe8cc3a38361 | c1502c0fb0713ef040b210e5ea35f6c31079b7ee | 正式直接加单 employee UUID；收款 batch 投影；两项回归 |
| 9200f55d0306c3835921ca4ad7c9a20787527654 | 4b45a9c407b8fcfd462919d9aa63fe8cc3a38361 | fresh rehearsal、artifact/GO/rollback gates、真实 MySQL 验证 |
| 35f538a28b801ee7dfd6e2b2ab19a061ea3a3ce7 | 9200f55d0306c3835921ca4ad7c9a20787527654 | audit-fix：异步证据异常必经 cleanup；旧 synthetic child 的 owned server 校验 |

其后的证据扫描补齐与文档提交，以本分支 Git 历史为准；不把候选当 accepted release。

## 环境与版本

Windows；Node24.19.0；MySQL8.4.11 / InnoDB；官方 migrations001–011，20表；backup format1。环境不是开发数据库拷贝：随机 UID、新 datadir、独立 server UUID、新配置/凭据/TLS/log/backup/部署目录。MySQL仅loopback；HTTP为私有 HTTPS listener。

自动化生产入口使用 accepted package 的 production/start.js、正式 TLS/config/auth/ledger/recovery，测试 required-device/alert 使用独立 rehearsal/runtime-child.js composition，固定 FakeGateway / FakeAlertTransport / live=false。正式入口不导入 Fake。private server clock只在 synthetic child使用；浏览器不能指定 clock。

SCM模板已有自动化；本轮未安装 Windows Service。SERVICE PROCESS LIFECYCLE = PASS；ACTUAL SCM INSTALL = BLOCKED。没有实际重启用户电脑，只验证新进程恢复。

## Artifact / schema / 初始化

部署制品来自干净的稳定 main clone中的精确已接受 Git blobs；不是工作树快照。依赖从本机已安装版本复制，并校对锁文件；没有安装 latest 或新增依赖。

| Artifact | Accepted commit | SHA-256 |
|---|---|---|
| current | c1502c0fb0713ef040b210e5ea35f6c31079b7ee | fadc23ddc1243a8b981348b1d86d7541d71e84ee8fff4517bd5af0985378915e |
| previous | e57af99dd49a46771ff20dd495f71f22d9db97ff | 5ba6a6f38fd66e7f53173a6409dfe778443da0882e07159a4f9da3c97dc522b7 |

拒绝 unaccepted commit、dirty source、依赖版本冲突、错误包 checksum、路径穿越、重复文件与内容改动。只打包受允许 runtime路径，排除 fixture/tests/真实 secrets/备份/临时文件。

fresh migration只执行官方 checksum-bound SQL；故意在002后失败时 schema 保持部分状态，bootstrap拒绝、readiness503；不自动 DROP/DOWN。初始化前 production preflight准确拒绝20项 OPENING_INVENTORY_REQUIRED与PRODUCTION_IDENTITIES_REQUIRED；bootstrap后仍有库存 blockers；正式盘点/审批后revision40，初始化 readiness通过；映射后再次检查。

六个 synthetic UUID身份（owner/manager/operator/limited/viewer/booking），正式 bootstrap dry-run/apply/repeat already_satisfied。limited不能结账或读后台；backend.view不授予审批。商品与耗材正式盘点/审核；null没有变0。Fake映射 source=rehearsal-confirmed，显式确认且冲突安全；不以房号猜MAC，排除V06。

required真实 alert channel缺失时仍NO-GO；production/start.js不静默插入Fake。合成backup policy不是生产schedule/retention/offsite policy。

## 真实 MySQL 营业及故障证据

最新完整日志与唯一 UID见下方最终测试记录；以下事实由真实 MySQL/HTTPS自动化断言，不是浏览器 PASS。

- DAY：ordinary half/dozen=50/100，beverage=50/100，premium=60/120；目标当天18:00。NIGHT保留原价，百威half=59，目标次日02:00。
- 开房、加单、支付、结账、clean、零售均复用正式 trusted commands。丢弃已提交支付响应后使用原operationKey replay，revision及支付/库存副作用不重复。
- direct免零10元；超额11元正式审批。挂账<=1000经理通过；>1000经理拒绝、owner通过。
- 现金交接：previousActual0 + intervalCashIn200 - intervalCashOut0 = expected200分；非现金排除。当前没有新增cash-out业务。
- 17:59:59DAY、18:00NIGHT、01:59:59NIGHT、02:00CLOSED；businessDate11:59:59前一日、12:00当日。sessionDate与businessDate分离。
- OFFLINE等待后继续同一订单/workflow。UNKNOWN先应用Fake open并模拟响应丢失，保持UNKNOWN跨进程 crash；随后query-only恢复。open尝试1；mutation retry0。
- DB故障只锁定本轮最小权限runtime用户、关闭其连接；写入停止、revision保持；DATABASE_UNAVAILABLE同一incident恢复并有Fake实际投递。
- process crash/新进程启动保留业务、session遵循既有规则、workflow保持；FakeExternalHeartbeatMonitor检测失联，不声称异机监控已配置。
- TLS不匹配拒绝，无insecure bypass。实际无效backup destination拒绝且保留last successful backup；Fake alert throw/timeout发生于业务commit后，不回滚业务；重启后重试。
- 对账覆盖revision、orders/payments、库存、房态、credit、rounding、handover、workflow、operations；自动化最终revision70、orders11、payments9、workflows6、operations70。

## Recovery / rollback

初始备份走正式 backupDatabase。恢复库再次导出使用严格限制 owned TEST 库的只读 rehearsal helper，复用正式format1；不是生产备份/恢复工具扩权。restoreDatabase → verifyRecovery → session invalidation → explicit resume沿用正式引擎。

冻结最新revision69备份，停止源runtime并锁定源runtime账号，恢复到新DB；完整state deepEqual。撤销7个session；旧session401，新login后历史operationKey replay无副作用，新零售revision70。

C0 before migration；C1 after migration；C2 after initialization；C3 service ready；C4 first business transaction。首笔业务写入为point of no return。无新交易时可中止返回原系统；已有交易时拒绝恢复C2旧备份（PRESERVE_NEW_TRANSACTIONS），保留全部新交易，freeze后向前恢复/修复。DDL forward-only，无DOWN或覆盖源。旧app兼容证明仅限e57af99/c1502c0与schema001–011及各自支持的配置；不是任意旧版本兼容保证。当前生产restore tooling仍有TEST-only限制，列为真实上线阻塞。

## Edge HTTPS — 实际浏览器记录

浏览器使用本轮早期中间版本已持有的 owned MySQL33314（UID bff693d753f9ec0c）；最终自动化另建33313/33315，不把旧hold runner输出当最新自动化。

record **dcab9edcacbd4**，Edge154，正常信任临时CA，无绕过证书校验。浏览器部分使用accepted c150包，另显式复制两份候选文件用于最小修复验证；不能将包SHA视为这两份overlay的证明：

| Overlay | SHA-256 |
|---|---|
| ui/dialogs/orders.js | ec4495d7480b5aeb87d55eb532f6fbf4528c2f36f76d2b66746ba035020558a2 |
| http/staff-query.js | d2601ada3e97501d211d64b717dff1c3ea0949f14889c95fbb56283445dea1dd |

| 步骤 | 实际证据 | 结论 |
|---|---|---|
| login/session/snapshot | n72/n73/n74均200；真实工作区渲染 | PASS |
| open V01 | DOM表单提交n84=200，R70→71，Fake workflow ACTIVE | PASS |
| 加单原缺陷 | n89=422，缺employee UUID，无写入 | 发现并修复P1 |
| 加单修复 | DOM选择server employee UUID，n165=200，R71→72 | PASS |
| 收款原缺陷 | n168/n169/n170=422，batch缺失导致charge标识不一致 | 发现并修复P1 |
| 收款修复后 | 新snapshot n172=200；人工确认超时，无新的成功collect | BLOCKED |
| settlement / clean | 未取得修复后的真实DOM成功证据 | BLOCKED |
| /admin | n189=200，经营数据、设备worker、incident、backup字段可见 | PASS |
| logout | n205=200，实际返回后台登录页 | PASS |

最后只读账本：revision72，浏览器订单总额17800分、待收17800分、payments0、百威stock747。**因此用户看到待收¥178是正确的；¥10从未入账，不能声称剩余¥168。** 没有重复收款，也没有为完成验收而绕过人工确认。

后台实际显示DATABASE AVAILABLE、recovery NORMAL、worker ENABLED；可见BACKUP_OVERDUE、TLS_EXPIRING、已恢复PROCESS_FAILURE。重启后的隔离log目录尚无backup report，UI准确显示NOT_OBSERVED；不能声称浏览器验证了成功备份时效。测试页面“真实告警渠道 CONFIGURED”来自Fake测试composition，实际真实渠道=NO。

console9条：未登录session401一条；旧sale422一条；旧collect422三条；favicon404一条（已知P2，不修改）；chrome-extension://invalid/三条（扩展，不归因应用）。没有捕获到uncaught exception/unhandled rejection/模块加载失败；capture无dropped evidence，worker targets不在捕获范围。不把这些运行观察升级为完整Browser PASS。

原始浏览器导出位于owned临时目录，随清理删除；仅保留白名单字段摘要于Git外stage5e-browser-sanitized.json和本文，未保留完整snapshot、Cookie/CSRF/密码。

## 定向高风险审计

### Standards

初审P0=0、P1=1、P2=1。P1：readline异步JSON异常绕过cleanup。35f538a增加Promise rejection、固定字段及回归；窄范围复核确认已解决，新增P0/P1=0。P2为局部命名/密集控制流维护性建议，本轮不大规模格式化。

### Spec

初审P0=0、P1=0、P2=1。P2：C3/C4编号与§59不一致，文档已对齐；首笔写入后保留交易的执行规则未改变。两轴审查均为只读，不能替代自动化/浏览器。

另有浏览器发现的两项P1已作最小修复并有回归；收款修复仍需真人浏览器重新验收。整体 **NEEDS HUMAN RE-ACCEPTANCE**，不因审计源码无剩余P0/P1而宣称已接受。

## Tests / failure history

Focused最终命令：

```text
node --test --test-isolation=none --test-reporter=tap rehearsal/browser-evidence.test.js rehearsal/tooling.test.js rehearsal/gates.test.js http/staff-query.test.js ui/sale-attribution.test.js
```

22 total /22 pass /0 fail /0 skip；测试进程exit0。npm test已尝试，npm命令不存在，未取得npm证据；直接Node结果单独记录。

真实MySQL独立focused曾1/1通过，完整自动化重新包含该真实演练。前两轮full失败如实保留：第一轮13fail（12项旧fixture硬编码历史datadir不兼容；1项异步UNKNOWN告警未等待），第二轮1fail（旧incident子进程同一历史datadir限制）。最小适配保留owner根目录、server UUID、33313、精确DB限制，并有错误目标负向回归；没有放开生产fixtures。

最终完整执行（Git外日志 stage5e-full-evidence-final.tap）：

```text
node --test --test-isolation=none --test-reporter=tap
2172 total
2172 pass
0 fail
0 skip
exit 0
```

通过 rehearsal/regression.js 创建 owned33313，再执行上面原命令；其中 Stage5E integration 创建独立33315。最终 UID：fixture92ae493e7180ef31，rehearsal19b78f395f0feb54。实际秘密扫描 456 files / 53 markers / leakage 0。新生产代码未安装依赖。

完整演练 2026-10-09T19:00:36.344Z 至 2026-10-09T19:02:18.913Z（UTC；北京时间次日03:00–03:02）。合成营业dbNow另设DAY/NIGHT，不是墙钟。

| Step | UTC开始 | 验证 |
|---|---|---|
| id | function at() { [native code] } | 自动化断言通过 |
| startedAt | function at() { [native code] } | 自动化断言通过 |
| checkpoints | function at() { [native code] } | 自动化断言通过 |
| formalEntry | 2026-10-09T19:00:42.107Z | 自动化断言通过 |
| tlsFailure | 2026-10-09T19:00:50.834Z | 自动化断言通过 |
| security | 2026-10-09T19:00:53.807Z | 自动化断言通过 |
| dayBusiness | 2026-10-09T19:00:54.175Z | 自动化断言通过 |
| nightBusiness | 2026-10-09T19:00:55.557Z | 自动化断言通过 |
| creditAndCash | 2026-10-09T19:00:57.344Z | 自动化断言通过 |
| timeBoundaries | 2026-10-09T19:01:01.143Z | 自动化断言通过 |
| deviceOfflineAndUnknown | 2026-10-09T19:01:01.146Z | 自动化断言通过 |
| runtimeCrashAndHostLoss | 2026-10-09T19:01:06.607Z | 自动化断言通过 |
| databaseOutage | 2026-10-09T19:01:09.480Z | 自动化断言通过 |
| backupAndAlertFailure | 2026-10-09T19:01:10.860Z | 自动化断言通过 |
| formalRecovery | 2026-10-09T19:02:15.624Z | 自动化断言通过 |
| goNoGo | 2026-10-09T19:02:18.901Z | 自动化断言通过 |
| finishedAt | function at() { [native code] } | 自动化断言通过 |

冻结最新备份：id a6316129-7bba-4400-82dc-3b170991e7f4；revision69；SHA-256 367bcbb1dc80b36813f7777a1625a2affd199adfc394f2c59947ddcb5e152b2e。恢复后revision70，orders11/payments9/workflows6/operations70；全部新交易deepEqual保留。

两台owned服务器各自cleanup：runtimeProcesses/mysqlProcess/databases/accounts/root均absent，sqlCleanup=true；未触碰非本轮实例。此前一轮2172/2172也通过，但只扫描artifact/log/backup的22文件；最终以456文件扫描这一轮为准。

## Secrets / cleanup

秘密随机生成并只写Git外ACL保护文件。实际扫描raw、JSON转义、base64标记，范围包括artifact/log/backup、当前sanitized evidence、Git管理文件和full TAP；最终计数见完整测试记录。没有输出raw session/CSRF/密码/私钥；公开的synthetic-only浏览器口令不是生产秘密。

浏览器UID bff693d753f9ec0c：
- owned浏览器session txno stopped；保留共享daemon。
- replacement runtime退出0；原hold runner退出0。
- certutil删除准确临时CA，随后Cert CurrentUser Root路径不存在（指纹末尾AD769995）。
- runner确认MySQL/runtime、登记DB/accounts、owned temp root全部absent；secrets/backups/raw capture随root删除。
- 没有安装Windows test service，所以无须卸载；不触碰其他服务/目录/证书。

其他自动化UID及sqlCleanup以最终full日志为准。cleanup异常不会被描述为成功；错误owner保留资源的负向测试通过。

## Gates / final production status

十二类状态见 [Production readiness checklist](../PRODUCTION_READINESS_CHECKLIST.md)；CODE/OPERATIONS仍BLOCKED（候选人工重新接受与完整浏览器营业补验）。TLS单项可信浏览器证据通过，不等于整体浏览器营业通过。human GO另行明确；系统只报告，不自动切换；所有Fake证据不能使production GO。

REAL PRODUCTION CUTOVER = NOT EXECUTED  
REAL DEPLOYMENT = NOT EXECUTED  
REAL ALERT CHANNEL = NOT CONFIGURED  
REAL EXTERNAL HEARTBEAT = NOT CONFIGURED  
KTVSKY LIVE PRODUCTION CONTROL = OFF  
PRODUCTION READY = NO  
14-DAY OFFSITE MVP READY = NO

真实门店仍缺：店主权限批准/真人bootstrap、期初盘点、人工确认mapping、真实alert/异机heartbeat、正式backup schedule/retention/异机备份/加密密钥、VPN/DNS/firewall、SCM安装/服务身份、正式TLS、production restore机制、安全live enable决策。

NEXT = 修复后的真实浏览器 payment / settlement / clean 补验及人工重新接受；之后仅 PRODUCTION READINESS DECISION / REAL-WORLD PREREQUISITES。
