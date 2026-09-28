// Phase 0：app.js 层现存缺陷与启动迁移链的源码级证据（沿 entry.test.js 既有模式，
// 对 app.js 做源文本断言——app.js 为 DOM 绑定脚本，无法在 Node 直接 import，
// 行为级测试需等 Phase 6 抽取后补上）。
//
// 覆盖：BUG#6 存酒页用当前目录名、BUG#7 报表聚合 credit 布尔（源码位置证据，
// 行为级冻结见 characterization-report.test.js）、BUG#8 损坏 localStorage
// 静默回退 initialState（覆盖风险）、以及启动迁移链关键步骤的锚点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

test('BUG#6 证据：存酒页取当前目录名而非存酒时的名称快照', () => {
  // 存酒记录 d 本身写入 productNameSnapshot（rules.js deposit），但渲染时未使用
  const start = app.indexOf('客人的酒，记得清楚');
  const end = app.indexOf('function repaymentReviewMarkup', start);
  const depositPage = app.slice(start, end);
  assert.match(depositPage, /<h3>\$\{product\(d\.product\)\.name\}<\/h3>/, '存酒页渲染当前目录名（缺陷）');
  assert.doesNotMatch(depositPage, /d\.productNameSnapshot/, '未使用存酒记录自带的名称快照');
  // 取酒对话框同样使用当前目录名
  assert.ok(app.includes("核对并取酒',`<p>${product(d.product).name} · 余 ${d.count} 支"), '取酒对话框也用当前目录名（缺陷）');
});

test('BUG#7 证据：同房多单报表聚合把 credit 压缩成单个布尔值', () => {
  assert.match(app, /credit:orders\.some\(order=>order\.credit\)/, '聚合行 credit 为 some() 布尔（缺陷：丢失每笔挂账详情）');
});

test('BUG#8 证据：损坏的 localStorage 静默回退 initialState，原始数据面临被覆盖', () => {
  // 启动读取：JSON.parse 或结构校验失败 → catch 静默换成 initialState
  assert.match(app, /catch \{ state = initialState\(\); storageProblem = '本机练习记录无法读取，已进入新练习。'; \}/);
  assert.doesNotMatch(app, /本机练习记录无法读取[\s\S]{0,200}raw/, '未保留原始损坏数据供恢复');
  // 之后 persist() 会把新状态写回同一 key → 原始数据被覆盖
  assert.match(app, /function persist\(next\) \{ try \{ localStorage\.setItem\(KEY, JSON\.stringify\(next\)\)/);
  assert.doesNotMatch(app, /persist[\s\S]{0,80}storageProblem/, 'persist 不区分「数据曾被判损坏」的场景');
});

test('启动迁移链锚点：目录合并、历史订单定价迁移、能力模式升级按顺序执行', () => {
  assert.match(app, /state\.catalog = mergeCatalog\(state\.catalog\)/);
  assert.match(app, /next\.orders = migrateLegacyOrderPricing\(next\.orders\)/);
  assert.match(app, /state = migrateDemoState\(state\)/);
  assert.match(app, /if \(state\.version !== 1 \|\| !Array\.isArray\(state\.rooms\) \|\| !state\.inventory\) throw Error\(\)/);
  assert.match(app, /for \(const item of inventoryProducts\(state\.catalog\)\) state\.inventory\[item\.id\] \?\?= \{ count: null, threshold: item\.inventoryThreshold \?\? 10, unit: item\.baseUnit \}/);
});
