# 金山营业报表导入映射

来源文档：`KTV每日营业报表.dbt`（金山文档）。2026-09-25 已读取到以下数据区：日报、月报、包间明细表、包间酒水价格表、收银对账表、支出对账表、库存表、存酒表、成本&利润表、客诉&异常表、活动&团购表。

首批导入以“日报”和“支出对账表”为准。其他表先保留源文件，等实际导出文件到位后再按主键和数据口径补映射，避免把汇总表重复计入明细。

## 日报字段

| 金山字段 | 暂存列 | 正式目标 | 处理规则 |
| --- | --- | --- | --- |
| 日期 | `raw_date` | `room_orders.business_date` | 必填；按门店营业日保存 |
| 班次 | `raw_shift` | `room_orders.period` | 日间映射 `day`，夜间映射 `night`，无法识别映射 `legacy` 并报提示 |
| 房号 | `raw_room_code` | `rooms.code` / `room_orders.room_id` | 必须匹配 V01、V02、V03、V05、V06、333、666、999、888 |
| 包间类型 | `raw_room_type` | `room_types.code` | 与房号主数据交叉校验；冲突时不自动覆盖房型 |
| 开房时间 | `raw_opened_at` | `room_orders.opened_at` | 与日期、时区组合为完整时间 |
| 结束时间 | `raw_closed_at` | `room_orders.closed_at` | 夜间跨日时允许晚于次日 00:00 |
| 使用时长 | `raw_duration` | 校验字段 | 由开始和结束时间重新计算；原文保留在 `raw_payload` |
| 零食饮料 | `raw_snack_beverage` | `order_items` | 拆成“其他消费”或“历史汇总”明细；不能识别的文字不丢弃 |
| 饮料/打 | `raw_drink_dozens` | `order_items` → `drink` | 打数乘 12 转为基础支数，同时保留打数 |
| 燕京/打 | `raw_yanjing_dozens` | `order_items` → `legacy_yanjing` | 当前菜单没有此商品，按停用历史商品保存 |
| 青岛/打 | `raw_qingdao_dozens` | `order_items` → `qd` | 打数乘 12 |
| 百威/打 | `raw_budweiser_dozens` | `order_items` → `bw` | 打数乘 12 |
| 喜力/打 | `raw_heineken_dozens` | `order_items` → `xl` | 打数乘 12 |
| 新喜力/打 | `raw_new_heineken_dozens` | `order_items` → `legacy_new_heineken` | 当前菜单没有此商品，按停用历史商品保存 |
| 蓝妹/打 | `raw_lowenbrau_dozens` | `order_items` → `lm` | 打数乘 12 |
| 酒水食品应收 | `raw_food_drink_receivable` | `room_orders.imported_receivable_cents` | 去除人民币符号、逗号后转整数分 |
| 优惠合计 | `raw_discount_total` | `room_orders.discount_cents` | 正数保存优惠金额，不以负数入库 |
| 酒水食品实收 | `raw_food_drink_received` | `payments` | 缺少渠道时使用“历史汇总未分类” |
| 包间低消 | `raw_room_minimum_spend` | `room_orders.minimum_spend_cents` | 仅保留历史口径，不改写当前套餐规则 |
| 包间价格 | `raw_room_price` | `room_orders.package_base_cents` | 按原报表金额入库 |
| 其他实收 | `raw_other_received` | `payments` / `order_items` | 生成历史汇总明细，渠道未知时不猜测 |
| 低消补差 | `raw_minimum_spend_difference` | `order_items` | 作为“其他消费·低消补差” |
| 收入合计 | `raw_revenue_total` | 导入核对值 | 必须等于各实收分项之和；不一致时阻止整行导入 |
| 备注 | `raw_notes` | `room_orders.notes` | 原样保留，后续再识别挂账、免零等结构 |
| 房间故障原因 | `raw_room_issue_reason` | `room_issues` | 生成已恢复的历史异常，不修改当前房态 |

每行正式订单编号建议使用 `IMP-{batch_id}-{source_row_number}`，确保可追溯且不会与现场订单号冲突。

## 支出对账表字段

| 金山字段 | 暂存列 | 正式目标 | 处理规则 |
| --- | --- | --- | --- |
| 日期 | `raw_date` | `expense_records.expense_date` | 必填 |
| 支出金额 | `raw_amount` | `expense_records.amount_cents` | 去符号、逗号后转整数分，必须大于 0 |
| 付款方式 | `raw_payment_method` | `expense_records.payment_method` | 微信、支付宝、现金、美团、抖音；未知值映射“历史汇总未分类”并提示 |
| 性质 | `raw_nature` | `expense_records.nature` | 一次性支出、固定支出、资金周转 |
| 说明 | `raw_description` | `expense_records.description` | 必填，原文保留 |
| 图片 | `raw_image_ref` | `expense_records.proof_ref` | 保存引用；不在导入阶段下载或内嵌图片 |

## 校验与幂等

- 源文件 SHA-256 相同且已经成功导入时，拒绝再次建立导入批次。
- 同一批次通过“源行号 + 行校验和”双重去重。
- 房号、日期、金额和收入勾稽任一失败时，整行保持在暂存区，不生成半张账单。
- 整批校验通过后，正式写入、来源链接和批次状态必须在同一个数据库事务中提交。
- 历史日报只建立营业与财务记录，不倒扣今天的库存；库存只从明确的期初盘点开始。
- 导入完成后仍保留所有 `raw_*` 字段和 `raw_payload`，便于审计和修正映射。
