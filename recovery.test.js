import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= { addEventListener() {} };
const { recoveryPage } = await import('./ui/shell.js');

test('停写核对页可查看原文及历史笔数，不提供普通营业或重置动作', () => {
  const raw = '{"note":"</textarea><script>unsafe</script>"}';
  const html = recoveryPage({ raw, readable: true, backupSaved: true,
    problem: '已有套餐价格不一致，已停止写入。', key: 'jbhh-demo-v1',
    backupKey: 'jbhh-demo-v1-recovery' }, {
    orders: [{ payments: [{ amount: 100 }, { amount: 200 }] }]
  });
  assert.match(html, /历史订单 1 笔，付款 2 笔/);
  assert.match(html, /查看并复制原始记录/);
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>unsafe<\/script>/);
  assert.match(html, /data-action="retryRecovery"/);
  assert.doesNotMatch(html, /data-action="reset"|data-action="open"/);
});
