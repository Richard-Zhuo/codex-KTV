import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('./database/schema.sql', import.meta.url), 'utf8');
const seed = readFileSync(new URL('./database/seed.sql', import.meta.url), 'utf8');
const mapping = readFileSync(new URL('./database/kdocs-import.md', import.meta.url), 'utf8');
const dailyTemplate = readFileSync(new URL('./database/templates/kdocs-daily-report.csv', import.meta.url), 'utf8').trim();
const expenseTemplate = readFileSync(new URL('./database/templates/kdocs-expense-report.csv', import.meta.url), 'utf8').trim();

test('关系型基线覆盖当前核心业务实体', () => {
  const tables = [...schema.matchAll(/CREATE TABLE\s+([a-z_]+)/g)].map(match => match[1]);
  assert.equal(new Set(tables).size, tables.length, '表名不应重复');
  for (const table of [
    'employees', 'employee_permissions', 'rooms', 'room_issues', 'room_issue_change_requests', 'reservations',
    'room_orders', 'order_items', 'payments', 'credits', 'credit_repayment_requests', 'stored_wine_lots',
    'inventory_balances', 'inventory_movements', 'inventory_count_requests', 'expense_records',
    'procurement_records', 'incidents', 'incident_resolution_requests', 'handovers'
  ]) {
    assert.ok(tables.includes(table), `缺少业务表 ${table}`);
  }
  assert.ok(tables.length >= 35, '数据库应覆盖业务表、审计表和导入暂存表');
  assert.match(schema, /CHECK \(evidence_text <> '' OR evidence_image_ref <> ''\)/);
  assert.match(schema, /change_type varchar\(20\) NOT NULL CHECK \(change_type = '恢复空房'\)/);
  assert.match(schema, /requested_status varchar\(30\) NOT NULL CHECK \(requested_status = '空闲'\)/);
  assert.match(schema, /self_review_authorized boolean NOT NULL DEFAULT false/);
  assert.match(schema, /status IN \('已批准', '已驳回'\) AND decided_by IS NOT NULL AND decided_at IS NOT NULL/);
  assert.match(schema, /CREATE UNIQUE INDEX room_issue_change_requests_one_pending_per_room/);
  assert.match(schema, /CREATE UNIQUE INDEX inventory_count_requests_one_pending_per_product/);
  assert.match(schema, /CREATE UNIQUE INDEX incident_resolution_requests_one_pending_per_incident/);
  assert.match(schema, /request_id bigint NOT NULL UNIQUE REFERENCES credit_repayment_requests/);
  assert.ok((schema.match(/CHECK \(decided_by IS NULL OR decided_by <> (?:requested_by|submitted_by) OR self_review_authorized\)/g) || []).length >= 6, '六类复核记录都应只在授权时允许本人自审');
  assert.ok((schema.match(/CHECK \(NOT self_review_authorized OR decided_by = (?:requested_by|submitted_by)\)/g) || []).length >= 6, '自审标记必须与提交人和审核人一致');
});

test('金额、营业日、房间并发和幂等约束已写入数据库', () => {
  assert.match(schema, /business_date date NOT NULL/);
  assert.match(schema, /row_version integer NOT NULL DEFAULT 1/);
  assert.match(schema, /CREATE UNIQUE INDEX reservations_unique_active_slot/);
  assert.match(schema, /CREATE TABLE idempotency_keys/);
  assert.match(schema, /amount_cents integer NOT NULL CHECK \(amount_cents > 0\)/);
  assert.match(schema, /历史汇总未分类/);
});

test('金山日报先进入原始暂存区再关联正式记录', () => {
  assert.match(schema, /CREATE TABLE import_batches/);
  assert.match(schema, /CREATE TABLE import_daily_report_rows/);
  assert.match(schema, /CREATE TABLE import_expense_rows/);
  assert.match(schema, /CREATE TABLE import_row_errors/);
  assert.match(schema, /CREATE TABLE import_source_links/);
  for (const column of [
    'raw_date', 'raw_shift', 'raw_room_code', 'raw_room_type', 'raw_opened_at',
    'raw_closed_at', 'raw_food_drink_receivable', 'raw_revenue_total',
    'raw_notes', 'raw_room_issue_reason', 'row_checksum'
  ]) {
    assert.match(schema, new RegExp(`\\b${column}\\b`), `缺少暂存列 ${column}`);
  }
  assert.match(mapping, /整批校验通过后/);
  assert.match(mapping, /历史日报只建立营业与财务记录，不倒扣今天的库存/);
});

test('种子数据与当前房间、员工说明和历史商品别名一致', () => {
  for (const room of ['V01', 'V02', 'V03', 'V05', 'V06', '333', '666', '999', '888']) {
    assert.match(seed, new RegExp(`'${room}'`));
  }
  for (const employee of [
    ['卓老板', '老板'], ['老板娘', '店长'], ['邵老板', '大堂经理'],
    ['雄老板', '外联经理'], ['卓益', '订房服务专员'], ['美娇', '订房专员']
  ]) {
    assert.ok(seed.includes(`'${employee[0]}', '${employee[1]}'`));
  }
  assert.match(seed, /legacy_yanjing/);
  assert.match(seed, /legacy_new_heineken/);
  assert.match(seed, /INSERT INTO employee_permissions/);
  assert.match(seed, /room\.issue\.approve/);
  assert.match(seed, /credit\.repay\.approve/);
  assert.match(seed, /inventory\.approve/);
  assert.match(seed, /incident\.resolve\.approve/);
  assert.match(seed, /review\.self/);
});

test('CSV 模板固定金山日报与支出表字段顺序', () => {
  assert.deepEqual(dailyTemplate.split(','), [
    '日期', '班次', '房号', '包间类型', '开房时间', '结束时间', '使用时长',
    '零食饮料', '饮料/打', '燕京/打', '青岛/打', '百威/打', '喜力/打',
    '新喜力/打', '蓝妹/打', '酒水食品应收', '优惠合计', '酒水食品实收',
    '包间低消', '包间价格', '其他实收', '低消补差', '收入合计', '备注', '房间故障原因'
  ]);
  assert.deepEqual(expenseTemplate.split(','), ['日期', '支出金额', '付款方式', '性质', '说明', '图片']);
});
