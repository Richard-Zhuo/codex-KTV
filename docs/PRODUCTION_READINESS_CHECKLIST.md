# Production readiness checklist
状态只使用 PASS / BLOCKED / NOT_APPLICABLE；十二类均必需，NOT_APPLICABLE 不能消除门禁。以下是 Stage5E synthetic 证据与真实门店状态的分离记录，当前不是生产 GO。
| Category | Synthetic rehearsal | Real production | 证据 / 剩余条件 |
|---|---|---|---|
| CODE | BLOCKED | BLOCKED | baseline package 已验证；两项浏览器 P1 与一项 cleanup P1 已修复；最终2172/2172通过，人工重新接受仍未完成 |
| DATABASE | PASS | BLOCKED | fresh MySQL8.4.11 / 001–011 /20 InnoDB tables；真实目标/迁移未执行 |
| IDENTITY | PASS | BLOCKED | 六个随机 UUID synthetic 身份、正式 bootstrap / repeat / permission denial；真人与权限未批准 |
| INVENTORY | PASS | BLOCKED | null blocker→正式盘点/审核；真实期初未盘点 |
| DEVICE | PASS | BLOCKED | Fake 映射、OFFLINE/UNKNOWN/query recovery；真实 mappings/live enable未批准，V06排除 |
| BACKUP | PASS | BLOCKED | checksum、独立恢复与全部新交易保留；真实计划/retention/异机/加密/密钥缺失，production restore仍禁用 |
| NETWORK | PASS | BLOCKED | loopback MySQL /私有 HTTPS listener；真实 VPN/DNS/firewall未配置 |
| TLS | PASS | BLOCKED | Edge154实际信任临时CA，无bypass；完整营业浏览器补验另行BLOCKED；正式TLS未安装 |
| SERVICE | PASS | BLOCKED | production/start.js stop/crash/fresh-start；actual SCM install BLOCKED、未实际重启机器 |
| ALERTING | PASS | BLOCKED | required Fake transport真实投递/异常/超时；真实渠道未配置 |
| EXTERNAL_MONITORING | PASS | BLOCKED | 独立进程 Fake checker检测失联；异机 heartbeat未配置 |
| OPERATIONS | BLOCKED | BLOCKED | runbook/定向审计已完成；浏览器payment/settlement/clean及人工重新接受未完成，真实值班演练未完成 |

human GO required = YES。cutoverDecision 只返回报告，不执行切换。所有 synthetic 证据即使 PASS，也不能令 scope=production GO。没有独立实证不得把 BLOCKED 改为 PASS。
逐步执行、C0–C4、point of no return、两人确认及回退见 [Cutover plan](PRODUCTION_CUTOVER_PLAN.md)。当前结果与清理证据见 [演练记录](verification/STAGE5E_CUTOVER_REHEARSAL.md)。
