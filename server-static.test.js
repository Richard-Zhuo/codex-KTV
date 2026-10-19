import { readFile } from 'node:fs/promises';
import { runtimePath } from './shared/release-artifact.js';
import { isHttpCommand } from './http/registry.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createKtvServer } from './server.js';

async function servedModuleGraph(pagePath, entry, required = []) {
  const server = createKtvServer({ api: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const page = await fetch(origin + pagePath);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, new RegExp('type="module" src="' +
      entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'));
    const queue = [entry];
    const visited = new Set();
    while (queue.length) {
      const path = queue.shift();
      if (visited.has(path)) continue;
      visited.add(path);
      assert.ok(visited.size < 100, 'Unexpectedly large module graph');
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path + ' must be served');
      assert.match(response.headers.get('content-type') ?? '',
        /^text\/javascript/, path);
      const source = await response.text();
      const imports = [
        ...source.matchAll(/^\s*import\s+(?:[^'"\n]*?\s+from\s*)?['"]([^'"]+)['"]/gm),
        ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)
      ];
      for (const match of imports) {
        if (!match[1].startsWith('.')) continue;
        queue.push(new URL(match[1], origin + path).pathname);
      }
    }
    for (const path of required) assert.ok(visited.has(path), path);
    return { html, visited };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('staff page and its JavaScript module graph are served by server.js', async () => {
  await servedModuleGraph('/', '/ui/staff-app.js',
    ['/ui/pending-command-journal.js', '/sales.js', '/rules.js', '/financial-adjustments.js']);
});

test('formal admin page and its JavaScript module graph are served without demo entry', async () => {
  const { html, visited } = await servedModuleGraph('/admin',
    '/ui/admin-app.js', ['/ui/admin-view.js', '/ui/api-client.js',
      '/ui/server-state.js']);
  assert.doesNotMatch(html, /type="module" src="\/app\.js"/);
  assert.doesNotMatch(html, /demo-banner|演示数据/);
  assert.equal(visited.has('/app.js'), false);
});

test('C1-A static financial module delivery preserves the explicit allowlist boundary', async t => {
  const server = createKtvServer({ api: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    await t.test('financial-adjustments.js is delivered as the exact JavaScript module', async () => {
      const response = await fetch(origin + '/financial-adjustments.js');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await response.text(), await readFile(new URL('./financial-adjustments.js', import.meta.url), 'utf8'));
      assert.equal(runtimePath('financial-adjustments.js'), true, 'existing artifact selection includes the module');
    });
    await t.test('unknown and private static paths still return 404', async () => {
      for (const path of ['/unlisted-financial.js', '/financial-adjustments.test.js', '/ledger/application.js', '/package.json', '/.git/config']) {
        const response = await fetch(origin + path);
        assert.equal(response.status, 404, path);
        assert.equal(await response.text(), 'Not found', path);
      }
    });
    await t.test('C3-A: financial HTTP commands require explicit registry entries', () => {
      for (const action of ['reversePayment', 'refundPayment', 'cashOut', 'cancelOrder', 'approveFinancialAdjustment', 'rejectFinancialAdjustment']) {
        assert.equal(isHttpCommand(action), true, action);
      }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
