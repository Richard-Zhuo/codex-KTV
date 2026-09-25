-- 金碧辉煌 KTV 关系型数据库基线
-- 目标数据库：PostgreSQL 16+
-- 金额统一使用整数分；时间统一使用 timestamptz；营业归属另存 business_date。

BEGIN;

CREATE TABLE schema_metadata (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(32) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
  business_day_cutoff time NOT NULL DEFAULT '06:00',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id varchar(40) PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  display_name varchar(80) NOT NULL,
  title varchar(80) NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, display_name)
);

CREATE TABLE roles (
  code varchar(40) PRIMARY KEY,
  label varchar(80) NOT NULL UNIQUE,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE permissions (
  code varchar(80) PRIMARY KEY,
  label varchar(120) NOT NULL,
  permission_group varchar(80) NOT NULL,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE employee_roles (
  employee_id varchar(40) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role_code varchar(40) NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by varchar(40) REFERENCES employees(id),
  PRIMARY KEY (employee_id, role_code)
);

CREATE TABLE employee_permissions (
  employee_id varchar(40) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  permission_code varchar(80) NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by varchar(40) REFERENCES employees(id),
  PRIMARY KEY (employee_id, permission_code)
);

CREATE TABLE role_permissions (
  role_code varchar(40) NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code varchar(80) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE room_types (
  code varchar(20) PRIMARY KEY,
  day_base_price_cents integer NOT NULL CHECK (day_base_price_cents >= 0),
  night_base_price_cents integer NOT NULL CHECK (night_base_price_cents >= 0),
  night_gift_dozens smallint NOT NULL CHECK (night_gift_dozens >= 0),
  fruit_portions smallint NOT NULL CHECK (fruit_portions >= 0),
  nuts_portions smallint NOT NULL CHECK (nuts_portions >= 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE rooms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  code varchar(20) NOT NULL,
  room_type_code varchar(20) NOT NULL REFERENCES room_types(code),
  status varchar(30) NOT NULL DEFAULT '空闲'
    CHECK (status IN ('空闲', '营业中', '待清洁', '故障/维护中')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, code)
);

CREATE TABLE room_status_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id bigint NOT NULL REFERENCES rooms(id),
  from_status varchar(30),
  to_status varchar(30) NOT NULL,
  reason text NOT NULL DEFAULT '',
  operator_id varchar(40) REFERENCES employees(id),
  occurred_at timestamptz NOT NULL,
  source varchar(30) NOT NULL DEFAULT 'app'
);

CREATE TABLE room_issues (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id bigint NOT NULL REFERENCES rooms(id),
  issue_type varchar(20) NOT NULL CHECK (issue_type IN ('故障', '维护中')),
  note varchar(500) NOT NULL,
  status varchar(20) NOT NULL DEFAULT '处理中'
    CHECK (status IN ('处理中', '已恢复')),
  opened_by varchar(40) REFERENCES employees(id),
  opened_at timestamptz NOT NULL,
  resolved_by varchar(40) REFERENCES employees(id),
  resolved_at timestamptz,
  CHECK ((status = '处理中' AND resolved_at IS NULL) OR status = '已恢复')
);

CREATE TABLE products (
  code varchar(40) PRIMARY KEY,
  name varchar(100) NOT NULL UNIQUE,
  category varchar(50) NOT NULL,
  inventory_class varchar(20) NOT NULL
    CHECK (inventory_class IN ('酒水', '消耗品', '不管理')),
  inventory_unit varchar(20) NOT NULL DEFAULT '支',
  exchange_level smallint,
  managed boolean NOT NULL DEFAULT true,
  gift_eligible boolean NOT NULL DEFAULT false,
  sale_dozen boolean NOT NULL DEFAULT false,
  single_price_cents integer CHECK (single_price_cents IS NULL OR single_price_cents >= 0),
  half_price_cents integer CHECK (half_price_cents IS NULL OR half_price_cents >= 0),
  dozen_price_cents integer CHECK (dozen_price_cents IS NULL OR dozen_price_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_aliases (
  alias varchar(100) PRIMARY KEY,
  product_code varchar(40) NOT NULL REFERENCES products(code),
  source varchar(50) NOT NULL DEFAULT 'manual'
);

CREATE TABLE inventory_balances (
  store_id bigint NOT NULL REFERENCES stores(id),
  product_code varchar(40) NOT NULL REFERENCES products(code),
  unopened_quantity numeric(12,3),
  opened_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (opened_quantity >= 0),
  warning_threshold numeric(12,3) NOT NULL DEFAULT 0 CHECK (warning_threshold >= 0),
  established_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_code),
  CHECK (unopened_quantity IS NULL OR unopened_quantity >= 0)
);

CREATE TABLE inventory_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  product_code varchar(40) NOT NULL REFERENCES products(code),
  quantity_delta numeric(12,3) NOT NULL,
  opened_before numeric(12,3),
  opened_after numeric(12,3),
  movement_type varchar(40) NOT NULL,
  source_type varchar(40) NOT NULL,
  source_id varchar(80),
  reason text NOT NULL DEFAULT '',
  counted boolean NOT NULL DEFAULT true,
  operator_id varchar(40) REFERENCES employees(id),
  occurred_at timestamptz NOT NULL,
  idempotency_key varchar(100),
  UNIQUE (store_id, idempotency_key)
);

CREATE TABLE reservations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  room_id bigint NOT NULL REFERENCES rooms(id),
  business_date date NOT NULL,
  session varchar(20) NOT NULL CHECK (session IN ('afternoon', 'night')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source varchar(20) NOT NULL CHECK (source IN ('线下', '手机', '座机', '美团', '抖音', '历史导入')),
  note varchar(500) NOT NULL DEFAULT '',
  status varchar(20) NOT NULL DEFAULT '已预订'
    CHECK (status IN ('已预订', '已到店', '已取消', '已过期')),
  owner_employee_id varchar(40) REFERENCES employees(id),
  recorded_by varchar(40) REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX reservations_unique_active_slot
  ON reservations(room_id, starts_at)
  WHERE status = '已预订';

CREATE TABLE room_orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  display_no varchar(40) NOT NULL,
  room_id bigint NOT NULL REFERENCES rooms(id),
  reservation_id bigint REFERENCES reservations(id),
  business_date date NOT NULL,
  period varchar(20) NOT NULL CHECK (period IN ('day', 'night', 'legacy')),
  status varchar(30) NOT NULL
    CHECK (status IN ('营业中', '已结账', '待审批挂账', '已挂账', '已回款', '历史已结')),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  owner_employee_id varchar(40) REFERENCES employees(id),
  opened_by varchar(40) REFERENCES employees(id),
  recorded_by varchar(40) REFERENCES employees(id),
  open_source varchar(20) NOT NULL DEFAULT '线下',
  reservation_source varchar(20) NOT NULL DEFAULT '',
  package_base_cents integer NOT NULL DEFAULT 0 CHECK (package_base_cents >= 0),
  package_drink_cents integer NOT NULL DEFAULT 0 CHECK (package_drink_cents >= 0),
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  rounding_cents integer NOT NULL DEFAULT 0 CHECK (rounding_cents >= 0),
  minimum_spend_cents integer NOT NULL DEFAULT 0 CHECK (minimum_spend_cents >= 0),
  imported_receivable_cents integer CHECK (imported_receivable_cents IS NULL OR imported_receivable_cents >= 0),
  imported_received_cents integer CHECK (imported_received_cents IS NULL OR imported_received_cents >= 0),
  notes text NOT NULL DEFAULT '',
  imported boolean NOT NULL DEFAULT false,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, display_no),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE TABLE platform_vouchers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL UNIQUE REFERENCES room_orders(id) ON DELETE CASCADE,
  provider varchar(20) NOT NULL CHECK (provider IN ('美团', '抖音')),
  covered_cents integer NOT NULL CHECK (covered_cents >= 0),
  status varchar(20) NOT NULL DEFAULT '待验券',
  external_voucher_no varchar(100),
  verified_at timestamptz,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES room_orders(id) ON DELETE CASCADE,
  line_type varchar(30) NOT NULL
    CHECK (line_type IN ('套餐酒水', '套餐配品', '增购酒水', '其他消费', '赠送酒水', '历史汇总')),
  product_code varchar(40) REFERENCES products(code),
  item_name varchar(120) NOT NULL,
  category varchar(50) NOT NULL,
  sale_spec varchar(20) NOT NULL DEFAULT 'single',
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit varchar(20) NOT NULL,
  base_units numeric(12,3) NOT NULL DEFAULT 0 CHECK (base_units >= 0),
  unit_price_cents integer NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  batch_no varchar(80),
  served boolean NOT NULL DEFAULT false,
  served_at timestamptz,
  served_by varchar(40) REFERENCES employees(id),
  owner_employee_id varchar(40) REFERENCES employees(id),
  recorded_by varchar(40) REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_exchanges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES room_orders(id) ON DELETE CASCADE,
  from_product_code varchar(40) NOT NULL REFERENCES products(code),
  to_product_code varchar(40) NOT NULL REFERENCES products(code),
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  scope varchar(20) NOT NULL CHECK (scope IN ('套餐', '增购', '赠送')),
  operator_id varchar(40) REFERENCES employees(id),
  occurred_at timestamptz NOT NULL
);

CREATE TABLE gift_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES room_orders(id) ON DELETE CASCADE,
  product_code varchar(40) NOT NULL REFERENCES products(code),
  half_dozen_count integer NOT NULL CHECK (half_dozen_count > 0),
  bottle_count integer NOT NULL CHECK (bottle_count > 0),
  status varchar(20) NOT NULL CHECK (status IN ('待确认', '已批准', '已驳回')),
  requested_by varchar(40) REFERENCES employees(id),
  requested_at timestamptz NOT NULL,
  decided_by varchar(40) REFERENCES employees(id),
  decided_at timestamptz
);

CREATE TABLE payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES room_orders(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  method varchar(30) NOT NULL
    CHECK (method IN ('微信', '支付宝', '现金', '美团', '抖音', '历史汇总未分类')),
  charge_type varchar(30) NOT NULL
    CHECK (charge_type IN ('开房', '增购酒水', '其他消费', '结账', '挂账回款', '历史汇总')),
  charge_batch_no varchar(80),
  received_by varchar(40) REFERENCES employees(id),
  received_at timestamptz NOT NULL,
  external_reference varchar(120),
  imported boolean NOT NULL DEFAULT false
);

CREATE TABLE rounding_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL UNIQUE REFERENCES room_orders(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  difference_type varchar(20) NOT NULL CHECK (difference_type IN ('免零', '特殊情况')),
  note varchar(500) NOT NULL DEFAULT '',
  status varchar(20) NOT NULL DEFAULT '待审核' CHECK (status IN ('待审核', '已审核')),
  submitted_by varchar(40) REFERENCES employees(id),
  submitted_at timestamptz NOT NULL,
  decided_by varchar(40) REFERENCES employees(id),
  decided_at timestamptz
);

CREATE TABLE credits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL UNIQUE REFERENCES room_orders(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  remaining_cents integer NOT NULL CHECK (remaining_cents >= 0),
  customer_phone varchar(20) NOT NULL DEFAULT '',
  customer_name varchar(80) NOT NULL DEFAULT '',
  note varchar(500) NOT NULL,
  signature_ref text NOT NULL,
  status varchar(20) NOT NULL DEFAULT '待审批'
    CHECK (status IN ('待审批', '已批准', '已驳回', '已回款')),
  approval_level varchar(20) NOT NULL CHECK (approval_level IN ('店长', '老板')),
  handled_by varchar(40) REFERENCES employees(id),
  submitted_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  decided_by varchar(40) REFERENCES employees(id),
  decided_at timestamptz,
  CHECK (customer_phone <> '' OR customer_name <> ''),
  CHECK (remaining_cents <= amount_cents)
);

CREATE TABLE credit_repayments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credit_id bigint NOT NULL REFERENCES credits(id) ON DELETE RESTRICT,
  payment_id bigint NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  operator_id varchar(40) REFERENCES employees(id),
  repaid_at timestamptz NOT NULL
);

CREATE TABLE stored_wine_lots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  group_no varchar(40) NOT NULL,
  customer_phone varchar(20) NOT NULL DEFAULT '',
  customer_name varchar(80) NOT NULL DEFAULT '',
  source_room_id bigint REFERENCES rooms(id),
  product_code varchar(40) NOT NULL REFERENCES products(code),
  initial_quantity integer NOT NULL CHECK (initial_quantity > 0),
  remaining_quantity integer NOT NULL CHECK (remaining_quantity >= 0),
  stored_by varchar(40) REFERENCES employees(id),
  stored_at timestamptz NOT NULL,
  expires_at timestamptz,
  CHECK (customer_phone <> '' OR customer_name <> ''),
  CHECK (remaining_quantity <= initial_quantity),
  UNIQUE (store_id, group_no, product_code)
);

CREATE TABLE stored_wine_withdrawals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id bigint NOT NULL REFERENCES stored_wine_lots(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  identity_kind varchar(20) NOT NULL CHECK (identity_kind IN ('手机尾号', '姓名')),
  verified_value varchar(80) NOT NULL,
  withdrawn_by varchar(40) REFERENCES employees(id),
  withdrawn_at timestamptz NOT NULL
);

CREATE TABLE expense_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  expense_date date NOT NULL,
  record_type varchar(20) NOT NULL CHECK (record_type IN ('支出', '报销')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  payment_method varchar(30) NOT NULL
    CHECK (payment_method IN ('微信', '支付宝', '现金', '美团', '抖音', '历史汇总未分类')),
  nature varchar(30) NOT NULL CHECK (nature IN ('一次性支出', '固定支出', '资金周转')),
  description varchar(500) NOT NULL,
  proof_ref text NOT NULL DEFAULT '',
  status varchar(30) NOT NULL DEFAULT '已记录'
    CHECK (status IN ('已记录', '待老板审批', '已审批', '已驳回')),
  source_type varchar(30) NOT NULL DEFAULT '手工' CHECK (source_type IN ('手工', '采购', '历史导入')),
  handled_by varchar(40) REFERENCES employees(id),
  approver_id varchar(40) REFERENCES employees(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE procurement_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  expense_id bigint NOT NULL UNIQUE REFERENCES expense_records(id) ON DELETE RESTRICT,
  procurement_date date NOT NULL,
  item_name varchar(120) NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit varchar(20) NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  description varchar(500) NOT NULL DEFAULT '',
  status varchar(30) NOT NULL,
  handled_by varchar(40) REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  incident_date date NOT NULL,
  room_id bigint REFERENCES rooms(id),
  incident_type varchar(30) NOT NULL,
  description varchar(1000) NOT NULL,
  assignee_id varchar(40) REFERENCES employees(id),
  status varchar(20) NOT NULL DEFAULT '待处理' CHECK (status IN ('待处理', '已完成')),
  result varchar(1000) NOT NULL DEFAULT '',
  result_note varchar(1000) NOT NULL DEFAULT '',
  reported_by varchar(40) REFERENCES employees(id),
  reported_at timestamptz NOT NULL,
  resolved_by varchar(40) REFERENCES employees(id),
  resolved_at timestamptz,
  last_reminded_on date
);

CREATE TABLE handovers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  expected_cents integer NOT NULL CHECK (expected_cents >= 0),
  actual_cents integer NOT NULL CHECK (actual_cents >= 0),
  front_desk_cash_cents integer NOT NULL CHECK (front_desk_cash_cents >= 0),
  difference_cents integer NOT NULL,
  handled_by varchar(40) REFERENCES employees(id),
  handed_over_at timestamptz NOT NULL
);

CREATE TABLE idempotency_keys (
  store_id bigint NOT NULL REFERENCES stores(id),
  operation_key varchar(120) NOT NULL,
  operation_type varchar(80) NOT NULL,
  result_entity_type varchar(80),
  result_entity_id varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, operation_key)
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  actor_id varchar(40) REFERENCES employees(id),
  action varchar(100) NOT NULL,
  entity_type varchar(80) NOT NULL,
  entity_id varchar(80) NOT NULL,
  before_data jsonb,
  after_data jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id varchar(120)
);

-- 导入批次和原始暂存区：先保留报表原文，校验完成后再写上面的业务表。
CREATE TABLE import_batches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES stores(id),
  source_type varchar(40) NOT NULL CHECK (source_type IN ('kdocs_dbt', 'csv', 'xlsx', 'manual')),
  source_name varchar(255) NOT NULL,
  source_url text NOT NULL DEFAULT '',
  source_sha256 char(64),
  status varchar(30) NOT NULL DEFAULT '待校验'
    CHECK (status IN ('待校验', '校验失败', '可导入', '导入中', '已导入', '已撤销')),
  total_rows integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows integer NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  invalid_rows integer NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  imported_by varchar(40) REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  notes text NOT NULL DEFAULT ''
);

CREATE TABLE import_daily_report_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_row_number integer NOT NULL CHECK (source_row_number > 0),
  source_record_id varchar(120),
  raw_date text,
  raw_shift text,
  raw_room_code text,
  raw_room_type text,
  raw_opened_at text,
  raw_closed_at text,
  raw_duration text,
  raw_snack_beverage text,
  raw_drink_dozens text,
  raw_yanjing_dozens text,
  raw_qingdao_dozens text,
  raw_budweiser_dozens text,
  raw_heineken_dozens text,
  raw_new_heineken_dozens text,
  raw_lowenbrau_dozens text,
  raw_food_drink_receivable text,
  raw_discount_total text,
  raw_food_drink_received text,
  raw_room_minimum_spend text,
  raw_room_price text,
  raw_other_received text,
  raw_minimum_spend_difference text,
  raw_revenue_total text,
  raw_notes text,
  raw_room_issue_reason text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_checksum char(64) NOT NULL,
  validation_status varchar(20) NOT NULL DEFAULT '待校验'
    CHECK (validation_status IN ('待校验', '有效', '无效', '已导入')),
  imported_order_id bigint REFERENCES room_orders(id),
  UNIQUE (batch_id, source_row_number),
  UNIQUE (batch_id, row_checksum)
);

CREATE TABLE import_expense_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_row_number integer NOT NULL CHECK (source_row_number > 0),
  source_record_id varchar(120),
  raw_date text,
  raw_amount text,
  raw_payment_method text,
  raw_nature text,
  raw_description text,
  raw_image_ref text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_checksum char(64) NOT NULL,
  validation_status varchar(20) NOT NULL DEFAULT '待校验'
    CHECK (validation_status IN ('待校验', '有效', '无效', '已导入')),
  imported_expense_id bigint REFERENCES expense_records(id),
  UNIQUE (batch_id, source_row_number),
  UNIQUE (batch_id, row_checksum)
);

CREATE TABLE import_row_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_table varchar(80) NOT NULL,
  source_row_number integer NOT NULL,
  field_name varchar(120) NOT NULL,
  error_code varchar(80) NOT NULL,
  message text NOT NULL,
  raw_value text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_source_links (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT,
  source_table varchar(80) NOT NULL,
  source_record_id varchar(120) NOT NULL,
  target_table varchar(80) NOT NULL,
  target_id varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_table, source_record_id, target_table)
);

CREATE UNIQUE INDEX import_batches_unique_success_source
  ON import_batches(store_id, source_sha256)
  WHERE source_sha256 IS NOT NULL AND status = '已导入';

CREATE INDEX room_orders_business_date_idx ON room_orders(store_id, business_date, status);
CREATE INDEX room_orders_room_time_idx ON room_orders(room_id, opened_at DESC);
CREATE INDEX order_items_order_type_idx ON order_items(order_id, line_type);
CREATE INDEX payments_order_time_idx ON payments(order_id, received_at);
CREATE INDEX inventory_movements_product_time_idx ON inventory_movements(store_id, product_code, occurred_at DESC);
CREATE INDEX expense_records_date_idx ON expense_records(store_id, expense_date DESC);
CREATE INDEX incidents_assignee_status_idx ON incidents(assignee_id, status, incident_date);
CREATE INDEX import_daily_validation_idx ON import_daily_report_rows(batch_id, validation_status);
CREATE INDEX import_expense_validation_idx ON import_expense_rows(batch_id, validation_status);

INSERT INTO schema_metadata(key, value)
VALUES
  ('schema_version', '1'),
  ('money_unit', 'cents'),
  ('timezone', 'Asia/Shanghai'),
  ('source_application', 'codex-KTV')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

COMMIT;
