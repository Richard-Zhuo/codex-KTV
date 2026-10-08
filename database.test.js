import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { encodeLedgerSnapshot, decodeLedgerSnapshot } from './ledger/mysql-snapshot.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const migrationNames = [
  '001_mysql_ledger_core.sql', '002_mysql_auth_core.sql', '003_mysql_employee_core.sql',
  '004_mysql_auth_policy_attributes.sql', '005_mysql_expense_approval_attribute.sql',
  '006_mysql_credit_approval_attributes.sql', '007_mysql_platform_vouchers.sql',
  '008_mysql_room_control.sql', '009_mysql_room_device_mapping.sql', '010_mysql_production_bootstrap.sql'
];
const migrations = migrationNames.map(name => read('./database/migrations/' + name));
const seed = read('./database/seed.sql'); // Legacy artifact integrity only; never account provisioning.
const dailyTemplate = read('./database/templates/kdocs-daily-report.csv').trim();
const expenseTemplate = read('./database/templates/kdocs-expense-report.csv').trim();

test('current schema authority is versioned MySQL migrations, with eighteen InnoDB tables and no business seed', () => {
  const files = readdirSync(new URL('./database/migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(files, migrationNames);
  assert.match(read('./database/README.md'), /Schema authority: versioned MySQL migrations/);
  const sql = migrations.join('\n');
  const tables = [...sql.matchAll(/CREATE TABLE\s+([a-z_]+)/g)].map(match => match[1]);
  assert.deepEqual(tables, [
    'ledger_heads','ledger_operations','ledger_success_audit',
    'auth_accounts','auth_credentials','auth_grants','auth_sessions','auth_events',
    'employees','employee_events','auth_policy_attributes',
    'voucher_redemptions','voucher_operations','provider_events','voucher_exceptions',
    'room_control_workflows','room_device_mappings','production_bootstrap_events'
  ]);
  assert.equal((sql.match(/ENGINE=InnoDB/g) || []).length, tables.length);
  assert.doesNotMatch(sql, /CREATE TABLE room_orders|GENERATED ALWAYS AS IDENTITY|INSERT INTO/i);
});

test('current ledger schema and snapshot codec preserve room versus retail and null versus zero', () => {
  const ddl = migrations[0];
  assert.match(ddl, /state_json JSON NOT NULL/);
  assert.match(ddl, /state_schema_version INT UNSIGNED NOT NULL/);
  assert.match(ddl, /state_checksum CHAR\(64\)/);
  assert.match(ddl, /PRIMARY KEY \(ledger_id, operation_key\)/);
  assert.match(ddl, /after_revision = before_revision \+ 1/);
  const state = {
    orders: [{id:'room-order',kind:'room',room:'V01'}, {id:'retail-order',kind:'retail',room:null}],
    inventory: {counted:{count:0},uncounted:{count:null}}
  };
  const encoded = encodeLedgerSnapshot(state);
  assert.deepEqual(decodeLedgerSnapshot(encoded.json,encoded.checksum),state);
  assert.throws(() => decodeLedgerSnapshot(encoded.json,'0'.repeat(64)), /校验和/);
});

test('current MySQL auth and employee identity are independent, without legacy named account seeds', () => {
  assert.match(migrations[1], /CREATE TABLE auth_accounts/);
  assert.match(migrations[1], /CREATE TABLE auth_credentials/);
  assert.match(migrations[1], /CREATE TABLE auth_grants/);
  assert.match(migrations[1], /CREATE TABLE auth_sessions/);
  assert.match(migrations[1], /CREATE TABLE auth_events/);
  assert.match(migrations[2], /principal_id CHAR\(36\)[^\n]*NULL/);
  assert.match(migrations[2], /UNIQUE KEY[^\n]*\(principal_id\)/);
  assert.match(migrations[2], /REFERENCES auth_accounts/);
  assert.match(migrations[3], /policy_attributes_configured/);
  for (const sql of migrations) assert.doesNotMatch(sql, /zhuBoss|shaoBoss|INSERT INTO employees|INSERT INTO auth_accounts/);
});

test('legacy PostgreSQL SQL is labelled inactive and absent from current runtime and startup paths', () => {
  for (const name of ['schema.sql','seed.sql']) {
    assert.match(read('./database/'+name).split('\n').slice(0,8).join('\n'), /LEGACY \/ NOT USED FOR CURRENT MYSQL/);
  }
  for (const path of ['./server.js','./ledger/mysql-store.js','./auth/mysql-store.js','./employees/mysql-store.js','./vouchers/mysql-store.js']) {
    assert.doesNotMatch(read(path), /schema\.sql|seed\.sql|\bpsql\b/);
  }
  const scripts = Object.values(JSON.parse(read('./package.json')).scripts).join('\n');
  assert.doesNotMatch(scripts, /schema\.sql|seed\.sql|\bpsql\b/);
  assert.match(read('./README.md'), /versioned MySQL migrations/);
});

test('LEGACY CSV 模板固定金山日报与支出表字段顺序', () => {
  assert.deepEqual(dailyTemplate.split(','), [
    '日期', '班次', '房号', '包间类型', '开房时间', '结束时间', '使用时长',
    '零食饮料', '饮料/打', '燕京/打', '青岛/打', '百威/打', '喜力/打',
    '新喜力/打', '蓝妹/打', '酒水食品应收', '优惠合计', '酒水食品实收',
    '包间低消', '包间价格', '其他实收', '低消补差', '收入合计', '备注', '房间故障原因'
  ]);
  assert.deepEqual(expenseTemplate.split(','), ['日期', '支出金额', '付款方式', '性质', '说明', '图片']);
});

test('LEGACY artifact 回归（Bug#9 已修）：种子商品行与列数一致，消耗品/套餐配品分类与运行时目录对齐', () => {
  // DDL 含 created_at DEFAULT now()（14 列），INSERT 列名行显式列出 13 列；逐行值个数应与 INSERT 列名数一致
  const insertColumnsStart = seed.indexOf('INSERT INTO products(');
  const insertColumnsEnd = seed.indexOf(')', insertColumnsStart);
  const insertColumns = seed.slice(insertColumnsStart + 'INSERT INTO products('.length, insertColumnsEnd)
    .split(',').map(name => name.trim()).filter(Boolean);
  assert.equal(insertColumns.length, 13, 'products INSERT 显式列出 13 列');
  const valuesStart = seed.indexOf("VALUES\n  ('bw'");
  // products 段的 ON CONFLICT 是其后第一个；不能从头 indexOf（KTV 名表等更早段落也有 ON CONFLICT (code)）
  const valuesEnd = seed.indexOf('ON CONFLICT (code)', valuesStart);
  assert.ok(valuesStart > 0 && valuesEnd > valuesStart, '商品种子段应存在');
  const rows = seed.slice(valuesStart, valuesEnd).split("\n  ").map(line => {
    const match = line.match(/^\('([a-z0-9_]+)',(.*)\),?$/);
    if (!match) return null;
    // 按顶层逗号计数（字符串内不含逗号，本种子为 ASCII/中文名）
    const fields = match[2].match(/'[^']*'|[^,]+/g).filter(token => token.trim() !== '');
    return { code: match[1], fieldCount: fields.length + 1 };
  }).filter(Boolean);
  assert.ok(rows.length >= 23, '种子商品应覆盖全部目录商品');
  for (const row of rows) {
    assert.equal(row.fieldCount, insertColumns.length, `商品 ${row.code} 种子值个数应等于 INSERT 列数 ${insertColumns.length}`);
  }
  // 消耗品与套餐配品的 inventory_class 与运行时 catalog.js 对齐
  assert.ok(seed.includes("('cons_nuts','瓜子','消耗品','消耗品','包'"), '瓜子：category=消耗品，inventory_class=消耗品，unit=包');
  assert.ok(seed.includes("('cons_ice','冰块','消耗品','消耗品','袋'"), '冰块：inventory_class=消耗品，unit=袋');
  assert.ok(seed.includes("('fruit','果盘','套餐配品','不管理','份'"), '果盘：套餐配品不管理库存');
  assert.ok(seed.includes("('water','瓶装水','瓶装水','酒水','支',4"), '瓶装水：exchange_level=4（不可换出）');
});
