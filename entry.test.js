import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const admin = readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

test('店员系统与后台管理使用独立入口并共享同一业务应用', () => {
  assert.match(index, /data-app-entry="staff"/);
  assert.match(admin, /data-app-entry="admin"/);
  assert.match(admin, /后台管理系统/);
  assert.match(server, /'\/admin': \['admin\.html', 'text\/html'\]/);
  assert.match(server, /'\/admin\.html': \['admin\.html', 'text\/html'\]/);
  assert.match(app, /const APP_ENTRY = document\.body\.dataset\.appEntry === 'admin'/);
  assert.match(app, /APP_ENTRY === 'admin'[\s\S]*\[\['manage','▧','管理'\]/);
  assert.match(app, /canManage \? '<a class="entry-link" href="\/admin">后台管理<\/a>'/);
});
