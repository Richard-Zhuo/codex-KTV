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
    ['/ui/pending-command-journal.js']);
});

test('formal admin page and its JavaScript module graph are served without demo entry', async () => {
  const { html, visited } = await servedModuleGraph('/admin',
    '/ui/admin-app.js', ['/ui/admin-view.js', '/ui/api-client.js',
      '/ui/server-state.js']);
  assert.doesNotMatch(html, /type="module" src="\/app\.js"/);
  assert.doesNotMatch(html, /demo-banner|演示数据/);
  assert.equal(visited.has('/app.js'), false);
});