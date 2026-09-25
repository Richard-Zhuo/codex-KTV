# 关系型数据库基线

本目录把当前浏览器演示中的业务状态拆成 PostgreSQL 关系表，供正式后端和历史报表导入使用。现有页面仍使用 localStorage；这些 SQL 不会自动迁移或覆盖浏览器里的演示数据。

## 文件

- `schema.sql`：业务表、约束、索引，以及金山日报和支出表的原始暂存区。
- `seed.sql`：当前门店、9 个房间、员工岗位说明、具体权限、商品与库存项目。
- `kdocs-import.md`：金山文档字段与正式业务表的映射和导入规则。
- `templates/kdocs-daily-report.csv`：后续导出日报时使用的 UTF-8 表头模板。
- `templates/kdocs-expense-report.csv`：支出对账表表头模板。

## 执行顺序

目标数据库为 PostgreSQL 16 或更高版本：

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/seed.sql
```

项目目前没有数据库运行时依赖，也没有把静态服务器改造成正式 API。接入后端时，必须在服务端事务中执行房态、账单、库存和幂等校验，不能直接信任浏览器提交的数据。

## 核心关系

```text
stores
├─ employees ─ employee_roles / employee_permissions
├─ rooms ─ room_issues / room_issue_change_requests
│       ├─ reservations
│       └─ room_orders
│          ├─ order_items / order_exchanges / gift_requests
│          ├─ payments
│          ├─ credits ─ credit_repayments
│          └─ platform_vouchers / rounding_reviews
├─ products ─ inventory_balances / inventory_movements
├─ stored_wine_lots ─ stored_wine_withdrawals
├─ expense_records ─ procurement_records
├─ incidents
└─ handovers

import_batches
├─ import_daily_report_rows
├─ import_expense_rows
├─ import_row_errors
└─ import_source_links
```

金额字段都以 `_cents` 结尾并存整数分。营业记录同时保存 `business_date` 与实际时间，避免凌晨结账被错误归到下一自然日。历史订单使用 `历史已结` 状态，不改变当前房态。

房间故障／维护的标记与恢复均先写入 room_issue_change_requests，照片或文字证据至少一项；另一名具有审核权限的员工批准后才改变 rooms.status。

## 历史导入流程

1. 从金山文档分别导出“日报”和“支出对账表”为 CSV 或 XLSX，原文件计算 SHA-256。
2. 建立一条 `import_batches`，将每个单元格原文写入对应暂存表，金额暂不做浮点转换。
3. 校验日期、房号、房型、时段、金额、商品别名和重复行；错误写入 `import_row_errors`。
4. 整批校验通过后，在一个数据库事务里写入主数据、历史订单、明细与付款，并写 `import_source_links`。
5. 只有事务完成后才把批次和暂存行标为“已导入”。同一批次、行号和校验和不能重复导入。

## 导入边界

- 日报没有支付方式明细时，付款记为 `历史汇总未分类`，不能猜成微信或现金。
- “燕京”和“新喜力”在当前菜单中没有销售配置，种子数据保留为停用历史商品，原数量不会丢失。
- 历史日报只建立营业与财务记录，不倒扣今天的库存；库存必须从明确的期初盘点记录开始。
- “房间故障原因”可以生成已结束的历史异常说明，但不会把当前房间自动设为故障。
- 原报表值和整行 JSON 始终保存在暂存区，方便回查、修正规则和重新导入。
- 图片列只保存引用地址或文件标识；正式附件应进入对象存储，不把大图直接写进数据库。
