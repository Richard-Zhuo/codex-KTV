-- 当前演示配置的基础主数据。先执行 schema.sql。
BEGIN;

INSERT INTO stores(code, name)
VALUES ('jbhh', '金碧辉煌 KTV')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

INSERT INTO room_types(code, day_base_price_cents, night_base_price_cents, night_gift_dozens, fruit_portions, nuts_portions)
VALUES
  ('小房', 6800, 5000, 1, 1, 1),
  ('中房', 6800, 5000, 1, 1, 1),
  ('大房', 8800, 5400, 2, 1, 2),
  ('VIP房', 10800, 8400, 2, 2, 2)
ON CONFLICT (code) DO UPDATE SET
  day_base_price_cents = EXCLUDED.day_base_price_cents,
  night_base_price_cents = EXCLUDED.night_base_price_cents,
  night_gift_dozens = EXCLUDED.night_gift_dozens,
  fruit_portions = EXCLUDED.fruit_portions,
  nuts_portions = EXCLUDED.nuts_portions;

INSERT INTO rooms(store_id, code, room_type_code, status)
SELECT store.id, item.code, item.room_type, '空闲'
FROM stores store
CROSS JOIN (VALUES
  ('V01', '小房'), ('V02', '小房'), ('V03', '小房'),
  ('V05', '中房'), ('V06', '中房'),
  ('333', '大房'), ('666', '大房'), ('999', '大房'),
  ('888', 'VIP房')
) AS item(code, room_type)
WHERE store.code = 'jbhh'
ON CONFLICT (store_id, code) DO UPDATE SET room_type_code = EXCLUDED.room_type_code;

INSERT INTO employees(id, store_id, display_name, title)
SELECT item.id, store.id, item.display_name, item.title
FROM stores store
CROSS JOIN (VALUES
  ('administrator', '管理员', '后台总管理'),
  ('zhuBoss', '卓老板', '老板'),
  ('wife', '老板娘', '店长'),
  ('shaoBoss', '邵老板', '大堂经理'),
  ('xiongBoss', '雄老板', '外联经理'),
  ('zhuYi', '卓益', '订房服务专员'),
  ('meiJiao', '美娇', '订房专员')
) AS item(id, display_name, title)
WHERE store.code = 'jbhh'
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  title = EXCLUDED.title,
  active = true,
  updated_at = now();

INSERT INTO roles(code, label)
VALUES
  ('admin', '管理员'), ('owner', '老板'), ('manager', '店长'), ('finance', '财务'),
  ('procurement', '采购'), ('clerk', '开单员'), ('waiter', '服务员'),
  ('cashier', '收银员'), ('keeper', '库管')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

INSERT INTO employee_roles(employee_id, role_code)
VALUES
  ('administrator', 'admin'),
  ('zhuBoss', 'owner'), ('zhuBoss', 'finance'),
  ('wife', 'manager'), ('wife', 'procurement'), ('wife', 'clerk'), ('wife', 'waiter'), ('wife', 'cashier'),
  ('shaoBoss', 'manager'), ('shaoBoss', 'finance'), ('shaoBoss', 'procurement'), ('shaoBoss', 'clerk'), ('shaoBoss', 'waiter'), ('shaoBoss', 'cashier'),
  ('xiongBoss', 'manager'), ('xiongBoss', 'finance'), ('xiongBoss', 'procurement'), ('xiongBoss', 'clerk'), ('xiongBoss', 'waiter'), ('xiongBoss', 'cashier'),
  ('zhuYi', 'clerk'), ('zhuYi', 'waiter'),
  ('meiJiao', 'clerk')
ON CONFLICT DO NOTHING;

INSERT INTO permissions(code, label, permission_group)
VALUES
  ('identity.manage', '调整身份权限', '身份与员工'),
  ('staff.record', '代员工登记订房与增购', '身份与员工'),
  ('room.open', '开房', '房间与订单'),
  ('room.reserve', '预订与取消预订', '房间与订单'),
  ('room.clean', '完成清洁', '房间与订单'),
  ('room.issue', '提交房间故障／维护状态变更', '房间与订单'),
  ('room.issue.approve', '审核房间故障／维护状态变更', '审核与后台'),
  ('order.sale', '加酒水／其他消费', '房间与订单'),
  ('order.exchange', '换酒水', '房间与订单'),
  ('order.gift', '登记赠酒水', '房间与订单'),
  ('order.serveExtra', '标记小吃／果盘已上', '房间与订单'),
  ('payment.collect', '收钱', '收款与挂账'),
  ('payment.settle', '结账', '收款与挂账'),
  ('credit.apply', '申请挂账', '收款与挂账'),
  ('credit.approve', '审批挂账', '收款与挂账'),
  ('credit.repay', '登记挂账回款', '收款与挂账'),
  ('gift.approve', '审批超额赠酒水', '审核与后台'),
  ('rounding.approve', '审核特殊差额', '审核与后台'),
  ('inventory.opening', '库存期初建账', '库存与交班'),
  ('inventory.adjust', '库存盘点与调整', '库存与交班'),
  ('deposit.manage', '登记与取酒', '库存与交班'),
  ('handover', '交班核对', '库存与交班'),
  ('expense.view', '查看支出与报销', '经营后台'),
  ('expense.create', '新增支出与报销', '经营后台'),
  ('expense.viewAll', '查看他人支出与报销', '经营后台'),
  ('expense.approve', '审批大额报销', '经营后台'),
  ('procurement.create', '登记采购并关联支出／报销', '采购与库存'),
  ('procurement.viewAll', '查看全部采购记录', '采购与库存'),
  ('incident.create', '登记客诉／异常', '现场管理'),
  ('incident.viewAll', '查看全部客诉／异常', '现场管理'),
  ('incident.resolve', '填写客诉／异常处理结果', '现场管理'),
  ('report.view', '查看经营报表', '审核与后台'),
  ('backend.view', '进入管理后台', '审核与后台')
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  permission_group = EXCLUDED.permission_group;

INSERT INTO role_permissions(role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code)
VALUES
  ('owner','staff.record'), ('owner','room.open'), ('owner','room.reserve'), ('owner','room.clean'), ('owner','room.issue'), ('owner','room.issue.approve'),
  ('owner','order.sale'), ('owner','order.exchange'), ('owner','order.gift'), ('owner','order.serveExtra'),
  ('owner','payment.collect'), ('owner','payment.settle'), ('owner','credit.apply'), ('owner','credit.approve'), ('owner','credit.repay'),
  ('owner','gift.approve'), ('owner','inventory.opening'), ('owner','inventory.adjust'), ('owner','deposit.manage'), ('owner','handover'),
  ('owner','expense.view'), ('owner','expense.create'), ('owner','expense.viewAll'), ('owner','expense.approve'),
  ('owner','procurement.create'), ('owner','procurement.viewAll'), ('owner','incident.create'), ('owner','incident.viewAll'), ('owner','incident.resolve'),
  ('owner','report.view'), ('owner','backend.view'),
  ('manager','staff.record'), ('manager','room.clean'), ('manager','room.issue'), ('manager','room.issue.approve'), ('manager','credit.apply'), ('manager','credit.approve'),
  ('manager','gift.approve'), ('manager','rounding.approve'), ('manager','inventory.opening'), ('manager','inventory.adjust'), ('manager','handover'),
  ('manager','expense.view'), ('manager','expense.create'), ('manager','expense.viewAll'), ('manager','procurement.create'), ('manager','procurement.viewAll'),
  ('manager','incident.create'), ('manager','incident.viewAll'), ('manager','incident.resolve'), ('manager','report.view'), ('manager','backend.view'),
  ('finance','staff.record'), ('finance','credit.repay'), ('finance','handover'), ('finance','expense.view'), ('finance','expense.create'),
  ('finance','expense.viewAll'), ('finance','procurement.create'), ('finance','procurement.viewAll'), ('finance','incident.create'),
  ('finance','incident.viewAll'), ('finance','incident.resolve'), ('finance','report.view'), ('finance','backend.view'),
  ('procurement','inventory.opening'), ('procurement','inventory.adjust'), ('procurement','expense.view'), ('procurement','expense.create'),
  ('procurement','procurement.create'), ('procurement','incident.create'), ('procurement','incident.resolve'), ('procurement','backend.view'),
  ('clerk','room.open'), ('clerk','room.reserve'), ('clerk','order.sale'), ('clerk','order.exchange'), ('clerk','order.gift'),
  ('clerk','order.serveExtra'), ('clerk','credit.apply'), ('clerk','expense.view'), ('clerk','expense.create'),
  ('clerk','incident.create'), ('clerk','incident.resolve'),
  ('waiter','room.clean'), ('waiter','order.sale'), ('waiter','order.exchange'), ('waiter','order.gift'), ('waiter','order.serveExtra'),
  ('waiter','credit.apply'), ('waiter','deposit.manage'), ('waiter','expense.view'), ('waiter','expense.create'),
  ('waiter','incident.create'), ('waiter','incident.resolve'),
  ('cashier','payment.collect'), ('cashier','payment.settle'), ('cashier','credit.apply'), ('cashier','credit.repay'),
  ('cashier','handover'), ('cashier','expense.view'), ('cashier','expense.create'), ('cashier','incident.create'),
  ('cashier','incident.resolve'), ('cashier','report.view'),
  ('keeper','credit.apply'), ('keeper','inventory.adjust'), ('keeper','expense.view'), ('keeper','expense.create'),
  ('keeper','incident.create'), ('keeper','incident.resolve'), ('keeper','backend.view')
ON CONFLICT DO NOTHING;

INSERT INTO employee_permissions(employee_id, permission_code, enabled)
SELECT DISTINCT employee_role.employee_id, role_permission.permission_code, true
FROM employee_roles employee_role
JOIN role_permissions role_permission ON role_permission.role_code = employee_role.role_code
ON CONFLICT (employee_id, permission_code) DO NOTHING;

INSERT INTO products(
  code, name, category, inventory_class, inventory_unit, exchange_level,
  managed, gift_eligible, sale_dozen, single_price_cents, half_price_cents, dozen_price_cents, active
)
VALUES
  ('bw','百威','普通啤酒','酒水','支',2,true,true,true,1000,5900,11800,true),
  ('xl','喜力','普通啤酒','酒水','支',2,true,true,true,1000,5900,11800,true),
  ('qd','青岛','普通啤酒','酒水','支',2,true,true,true,1000,5900,11800,true),
  ('redqd','红青岛','普通啤酒','酒水','支',2,true,true,true,1000,5900,11800,true),
  ('lm','蓝妹','高端啤酒','酒水','支',1,true,true,true,1150,6900,13800,true),
  ('lm_can','蓝妹（罐装）','高端啤酒','酒水','支',1,true,true,true,1150,6900,13800,true),
  ('jbw','黑金百威','高端啤酒','酒水','支',1,true,true,true,1150,6900,13800,true),
  ('drink','饮料','饮料','酒水','支',2,true,true,false,1000,NULL,NULL,true),
  ('drink0','王老吉','饮料','酒水','支',2,true,false,false,1000,NULL,NULL,true),
  ('drink1','马蹄爽','饮料','酒水','支',2,true,false,false,1000,NULL,NULL,true),
  ('drink2','椰汁','饮料','酒水','支',2,true,false,false,1000,NULL,NULL,true),
  ('drink3','柠檬茶','饮料','酒水','支',2,true,false,false,1000,NULL,NULL,true),
  ('soda0','可口可乐','汽水','酒水','支',3,true,false,false,600,NULL,NULL,true),
  ('soda1','百事可乐','汽水','酒水','支',3,true,false,false,600,NULL,NULL,true),
  ('soda2','雪碧','汽水','酒水','支',3,true,false,false,600,NULL,NULL,true),
  ('soda3','芬达','汽水','酒水','支',3,true,false,false,600,NULL,NULL,true),
  ('water','瓶装水','瓶装水','酒水','支',4,true,false,false,200,NULL,NULL,true),
  ('fruit','果盘','套餐配品','不管理','份',NULL,false,false,false,0,NULL,NULL,true),
  ('nuts_extra','花生瓜子（套餐）','套餐配品','不管理','份',NULL,false,false,false,0,NULL,NULL,true),
  ('cons_nuts','瓜子','消耗品','包',NULL,true,false,false,NULL,NULL,NULL,true),
  ('cons_ice','冰块','消耗品','袋',NULL,true,false,false,NULL,NULL,NULL,true),
  ('cons_tissue','纸巾','消耗品','包',NULL,true,false,false,NULL,NULL,NULL,true),
  ('cons_straw','吸管','消耗品','包',NULL,true,false,false,NULL,NULL,NULL,true),
  ('legacy_yanjing','燕京','历史酒水','不管理','支',2,false,false,true,NULL,NULL,NULL,false),
  ('legacy_new_heineken','新喜力','历史酒水','不管理','支',2,false,false,true,NULL,NULL,NULL,false)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  inventory_class = EXCLUDED.inventory_class,
  inventory_unit = EXCLUDED.inventory_unit,
  exchange_level = EXCLUDED.exchange_level,
  managed = EXCLUDED.managed,
  gift_eligible = EXCLUDED.gift_eligible,
  sale_dozen = EXCLUDED.sale_dozen,
  single_price_cents = EXCLUDED.single_price_cents,
  half_price_cents = EXCLUDED.half_price_cents,
  dozen_price_cents = EXCLUDED.dozen_price_cents,
  active = EXCLUDED.active;

INSERT INTO product_aliases(alias, product_code, source)
VALUES
  ('百威','bw','kdocs_dbt'), ('金百威','jbw','legacy'), ('黑金百威','jbw','app'),
  ('喜力','xl','kdocs_dbt'), ('青岛','qd','kdocs_dbt'), ('红青岛','redqd','app'),
  ('蓝妹','lm','kdocs_dbt'), ('蓝妹（罐装）','lm_can','app'), ('蓝妹(罐装)','lm_can','alias'),
  ('饮料','drink','kdocs_dbt'), ('燕京','legacy_yanjing','kdocs_dbt'), ('新喜力','legacy_new_heineken','kdocs_dbt')
ON CONFLICT (alias) DO UPDATE SET product_code = EXCLUDED.product_code, source = EXCLUDED.source;

INSERT INTO inventory_balances(store_id, product_code, unopened_quantity, opened_quantity, warning_threshold)
SELECT store.id, product.code, NULL, 0,
  CASE
    WHEN product.code = 'cons_nuts' THEN 2
    WHEN product.code = 'cons_ice' THEN 2
    WHEN product.code = 'cons_tissue' THEN 5
    WHEN product.code = 'cons_straw' THEN 2
    WHEN product.sale_dozen THEN 250
    ELSE 10
  END
FROM stores store
CROSS JOIN products product
WHERE store.code = 'jbhh' AND product.managed
ON CONFLICT (store_id, product_code) DO NOTHING;

COMMIT;
