// Bug 修复任务（2026-09-28）：原 Bug #6/#7 证据断言改写为回归保护。
// #6：存酒页与取酒对话框改为优先用存酒记录的名称快照；
// #7：reportNotes 日分支改为逐笔挂账备注，不再用聚合 credit 布尔。
// 原有持久化边界回归保护（原 Bug #8）保持不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const reporting = readFileSync(new URL('./reporting.js', import.meta.url), 'utf8');
const depositsPageModule = readFileSync(new URL('./ui/pages/deposits.js', import.meta.url), 'utf8');
const shell = readFileSync(new URL('./ui/shell.js', import.meta.url), 'utf8');

test('回归（Bug#6 已修）：存酒页与取酒对话框优先用存入时的名称快照', () => {
  // 存酒页渲染优先用 d.productNameSnapshot，旧数据缺失才回退当前目录
  const start = depositsPageModule.indexOf('客人的酒，记得清楚');
  const depositPage = start >= 0 ? depositsPageModule.slice(start) : '';
  assert.ok(start >= 0, '存酒页实现应在 ui/pages/deposits.js');
  assert.match(depositPage, /depositName\(d\)/, '存酒页渲染快照名');
  assert.match(depositsPageModule, /d\.productNameSnapshot \|\| product\(d\.product\)\.name/, '快照优先，仅旧数据回退当前目录');
  assert.doesNotMatch(depositPage, /<h3>\$\{product\(d\.product\)\.name\}<\/h3>/, '不再无条件用当前目录名');
  // 取酒对话框同样快照优先（app.js 点击分发）
  assert.ok(app.includes("核对并取酒',`<p>${d.productNameSnapshot || product(d.product).name} · 余 ${d.count} 支"), '取酒对话框快照优先');
});

test('回归（Bug#7 已修）：日报备注逐笔列出周期内挂账，不用聚合 credit 布尔', () => {
  // reportNotes 日分支按 periodOrders 逐笔生成挂账备注
  assert.doesNotMatch(reporting, /credit:orders\.some\(order=>order\.credit\)/, 'reportOrder 聚合行不再压缩 credit 布尔');
  assert.match(reporting, /reportPeriod === 'day'[\s\S]{0,400}periodOrders \|\| \[order\]/, '日分支逐笔挂账备注');
  assert.match(reporting, /挂账\$\{reportMoney\(item\.credit\.amount\)\}/, '每笔挂账显示金额');
  assert.doesNotMatch(app, /credit:orders\.some\(order=>order\.credit\)/, 'app.js 不内嵌报表聚合');
});

test('回归保护（原 BUG#8，Phase 1 已修）：损坏数据不再静默覆盖，原文有备份出口', () => {
  // app.js 不再内联 JSON.parse + catch initialState 的旧模式
  assert.doesNotMatch(app, /catch \{ state = initialState\(\); storageProblem = '本机练习记录无法读取，已进入新练习。'; \}/, '旧的静默回落模式已移除');
  // 唯一载入入口是 persistence.load()
  assert.match(app, /const persistence = createDemoPersistence\(\{ storage: localStorage \}\)/);
  assert.match(app, /const loaded = persistence\.load\(\)/);
  // 保存唯一经 persistence.save（Phase 7 起在 ui/shell.js）
  assert.match(shell, /ctx\.persistence\.save\(next\)/);
  assert.doesNotMatch(app + shell, /localStorage\.setItem\(KEY/, '不得再直接写账本 key');
  assert.doesNotMatch(app + shell, /localStorage\.getItem\(KEY/, '不得再直接读账本 key');
});

test('持久化边界结构：迁移链移入 migrations.js，app.js 不再内嵌迁移实现', () => {
  // 旧的迁移函数已不在 app.js
  for (const symbol of ['legacyOrderProductSnapshot', 'migrateLegacyCatalogFacts', 'migrateDemoState']) {
    assert.doesNotMatch(app, new RegExp(`function ${symbol}`), `${symbol} 不应再定义在 app.js`);
  }
  // 跨标签页事件改经 persistence.loadExternal（Phase 7 起为 ctx.persistence）
  assert.match(app, /(?:ctx\.)?persistence\.loadExternal\(e\.newValue\)/);
  assert.match(app, /e\.key===DEMO_STATE_KEY/);
});

test('server.js 静态映射提供新模块', () => {
  assert.match(server, /'\/migrations\.js': \['migrations\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/persistence\.js': \['persistence\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/reporting\.js': \['reporting\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/ui\/shell\.js': \['ui\/shell\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/ui\/context\.js': \['ui\/context\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/ui\/forms\.js': \['ui\/forms\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/ui\/pages\/rooms\.js': \['ui\/pages\/rooms\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/ui\/dialogs\/orders\.js': \['ui\/dialogs\/orders\.js', 'text\/javascript'\]/);
});
