# 已知业务问题与隔离边界

状态：2026-10-06，K01／K06 已解决，offsite.contract.test.js 对应两个 test.skip 已转为正式正向回归；K05 也已修复并转正式回归；K04 连续 trusted 交班也已修复并转正式回归，K07 平台券门禁已修并转正式测试，仅 K10 旧 SQL retail 草案保留 skip。Meituan production redemption = NOT ENABLED；K07 关闭不代表真实美团核销上线。K02／K03 为历史已修项目，其他部分解决项不因此变为完成。真实 MySQL 及完整本轮结果见 [CURRENT_STAGE](./CURRENT_STAGE.md)。目标规则见 [OFFSITE_CONTRACTS](./OFFSITE_CONTRACTS.md) 与 [P0 矩阵](./OFFSITE_P0_MATRIX.md)。

| ID | 当前状态与证据 | 脱岗 P0 剩余要求 |
|---|---|---|
| K01 大额免零 | 已修；settle 的 pending review 保持营业／占房，批准余额为零才与决定一同关单／转待清洁，驳回保留付款和余额。原 168 元／0.01 元 test.skip 转正，rounding-finality.test.js 及 trusted MySQL 覆盖重放、双连接和整体 rollback | ¥10、具体权限／review.self／rounding.self.excess 不改；不重开或推断历史错误订单，不宣称真人映射／正式运营已完成 |
| K02 套餐不等式 | 演示规则已修；报价和事务拒绝不一致价格，旧数据加载进入只读核对页并保留历史订单、付款及原文，`offsite.contract.test.js`、`persistence.test.js` 有正向断言 | 正式价格版本、审批、生效时间仍未实现 |
| K03 高额挂账越层批准 | 演示规则已修；`sales.js` 同查具体权限与指定岗位，Track B 测试改为拒绝越层的断言 | 真人身份、远程审批与权限审计仍未实现 |
| K04 全历史累计交班 | 已修（trusted 路径）：首条实点 bootstrap，后续以上次 actualCash 加新现金 payment；稳定 payment ID 快照划区间。offsite.contract.test.js 原 skip 转正，trusted-handover 单元及真实 MySQL 验同时间、跨 12:00、重放、双连接及回滚 | 仅已证明的抽屉 movement；存取酒非现金动作，expense／procurement 无资金来源故不推断支出。现金出流登记、接班签收和差异核销仍 OPEN；demo 旧交班隔离保留 |
| K05 跨日资金归属 | 已修：offsite.report.test.js 旧 skip 转正式；reporting-ledger.test.js 与真实 MySQL 验冻结日期、跨日多笔、回款不双计及 ambiguity | 营业额只按冻结 businessDate；资金只按 payment.occurredAt 的独立时间区间；旧 time 无可信来源不补造，结果明确不完整；open 已保存冻结日期；历史正式导入和营业日关账仍未完成 |
| K06 免零后 `outstanding` 差额 | 已修；outstanding 扣明确生效直免或已批准免零，pending／rejected／不明历史不扣，可选 roundingHistory 保留后续结算前的事实；原 test.skip 转正，覆盖多笔付款／多渠道／后续 pay 与 settle | 免零非付款，不改原付款／报表／businessDate；未知历史事实不回填 |
| K07 待验平台券覆盖房费 | 已修：rules.test.js 原 skip 转正式；trusted-open 单元/真实 MySQL 验服务端 REDEEMED 同店未绑定门禁、唯一绑定及失败保持 unlinked | Meituan production redemption = NOT ENABLED；真实授权、凭据、CLI 契约、幂等范围、安全测试券/环境、webhook 验签及产品/套餐配置仍未完成，不宣称已上线 |
| K08 挂账驳回 | 原申请及决定现保留在 `order.creditHistory`，审核历史可查；旧单仍可能在释放房后游离 | 给游离单可见异常队列及可执行收清、撤销流程 |
| K09 本机数据损坏 | 异常加载一律停写，原始主记录不覆盖；恢复页可查看原文，独立备份不覆盖已有不同备份；`persistence.test.js`、`recovery.test.js` 覆盖 | 正式共享账本仍需可验证备份、告警、隔离恢复与演练 |
| K10 数据库与零售 | 未解决；`room_orders.room_id` 仍非空，`offsite.contract.test.js` 标为问题 | 正式迁移须容纳 `retail.room=null` 且保留房单引用 |

K01／K06／K05／K04 已取得真实 MySQL 事务回归，历史演示修复证据仍按原范围解释；均不代表 14 天脱岗可运营。其他关键 P0 缺口包括可信共享账本、真人账号、撤单、退款、冲正、逐渠道对账、正式营业日和班次、可靠审计与异常恢复。