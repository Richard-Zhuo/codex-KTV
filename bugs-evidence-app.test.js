// Phase 1 后：app.js 层持久化证据测试（原 BUG#6/#7/#8 证据文件的更新版）。
//
// 变化：Phase 1 建立 persistence/migration 边界后，Bug #8 的「损坏
// localStorage 静默覆盖」已在结构上被修复（失败不覆盖 + 原文备份到
// jbhh-demo-v1-recovery，见 persistence.test.js 的行为级测试）。
// 本文件相应改写为「回归保护」断言：确保 app.js 不再内嵌旧的风险模式。
// Bug #6（存酒页当前目录名）与 #7（报表 credit 布尔）未修复，证据保留。
// 迁移链锚点改为验证 app.js 只通过 persistence 模块读写账本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
// Phase 6 起报表聚合迁至 reporting.js；Bug #6/#7 的缺陷代码随迁，证据断言指向新 owner 模块。
const reporting = readFileSync(new URL('./reporting.js', import.meta.url), 'utf8');

test('BUG#6 证据（未修复）：存酒页取当前目录名而非存酒时的名称快照', () => {
  // 存酒记录 d 本身写入 productNameSnapshot（rules.js deposit），但渲染时未使用
  const start = app.indexOf('客人的酒，记得清楚');
  const end = app.indexOf('function repaymentReviewMarkup', start);
  const depositPage = app.slice(start, end);
  assert.match(depositPage, /<h3>\$\{product\(d\.product\)\.name\}<\/h3>/, '存酒页渲染当前目录名（缺陷）');
  assert.doesNotMatch(depositPage, /d\.productNameSnapshot/, '未使用存酒记录自带的名称快照');
  // 取酒对话框同样使用当前目录名
  assert.ok(app.includes("核对并取酒',`<p>${product(d.product).name} · 余 ${d.count} 支"), '取酒对话框也用当前目录名（缺陷）');
});

test('BUG#7 证据（未修复）：同房多单报表聚合把 credit 压缩成单个布尔值', () => {
  // Phase 6 起 reportOrder 迁入 reporting.js，缺陷代码逐字随迁
  assert.match(reporting, /credit:orders\.some\(order=>order\.credit\)/, '聚合行 credit 为 some() 布尔（缺陷：丢失每笔挂账详情）');
  assert.doesNotMatch(app, /credit:orders\.some\(order=>order\.credit\)/, 'app.js 不再内嵌报表聚合（Phase 6 抽取完成）');
});

test('回归保护（原 BUG#8，Phase 1 已修）：损坏数据不再静默覆盖，原文有备份出口', () => {
  // app.js 不再内联 JSON.parse + catch initialState 的旧模式
  assert.doesNotMatch(app, /catch \{ state = initialState\(\); storageProblem = '本机练习记录无法读取，已进入新练习。'; \}/, '旧的静默回落模式已移除');
  // 唯一载入入口是 persistence.load()
  assert.match(app, /const persistence = createDemoPersistence\(\{ storage: localStorage \}\)/);
  assert.match(app, /const loaded = persistence\.load\(\)/);
  // 保存唯一经 persistence.save
  assert.match(app, /persistence\.save\(next\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\(KEY/, '不得再直接写账本 key');
  assert.doesNotMatch(app, /localStorage\.getItem\(KEY/, '不得再直接读账本 key');
});

test('持久化边界结构：迁移链移入 migrations.js，app.js 不再内嵌迁移实现', () => {
  // 旧的迁移函数已不在 app.js
  for (const symbol of ['legacyOrderProductSnapshot', 'migrateLegacyCatalogFacts', 'migrateDemoState']) {
    assert.doesNotMatch(app, new RegExp(`function ${symbol}`), `${symbol} 不应再定义在 app.js`);
  }
  // 跨标签页事件改经 persistence.loadExternal
  assert.match(app, /persistence\.loadExternal\(e\.newValue\)/);
  assert.match(app, /e\.key===DEMO_STATE_KEY/);
});

test('server.js 静态映射提供新模块', () => {
  assert.match(server, /'\/migrations\.js': \['migrations\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/persistence\.js': \['persistence\.js', 'text\/javascript'\]/);
  assert.match(server, /'\/reporting\.js': \['reporting\.js', 'text\/javascript'\]/);
});
