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
  assert.match(admin, /系统管理后台/);
  assert.match(server, /'\/admin': \['admin\.html', 'text\/html'\]/);
  assert.match(server, /'\/admin\.html': \['admin\.html', 'text\/html'\]/);
  assert.match(app, /const APP_ENTRY = document\.body\.dataset\.appEntry === 'admin'/);
  assert.match(app, /canManage \? '<a class="entry-link" href="\/admin">系统管理<\/a>'/);
});

test('营业待办留在员工系统，系统后台不承载日常营业页面', () => {
  assert.match(app, /const adminPages = \['manage'\]/);
  assert.match(app, /\['tasks','✓','待办'\]/);
  assert.match(app, /page==='tasks'\?taskCenterPage\(\)/);
  assert.match(app, /canManage \? \[\['manage','▧','系统'\]\] : \[\]/);

  const taskStart = app.indexOf('function taskCenterPage()');
  const taskEnd = app.indexOf('function permissionCards()', taskStart);
  const systemStart = app.indexOf('function systemManagementPage()');
  const systemEnd = app.indexOf('function stockNotices()', systemStart);
  assert.ok(taskStart >= 0 && taskEnd > taskStart);
  assert.ok(systemStart >= 0 && systemEnd > systemStart);
  const taskPage = app.slice(taskStart, taskEnd);
  const systemPage = app.slice(systemStart, systemEnd);

  assert.match(taskPage, /businessReviewSections\(currentUser\(\)\)/);
  for (const renderer of ['creditApprovalCards', 'repaymentReviewCards', 'roundingReviewCards', 'giftRequestCards', 'roomIssueReviewCards', 'inventoryReviewCards', 'incidentResolutionReviewCards', 'expenseReviewCards']) assert.match(taskPage, new RegExp(renderer));
  assert.doesNotMatch(taskPage, /staffRecordingPanel|inventoryDialog|procurementDialog|handoverHistory/);

  assert.match(systemPage, /permissionCards\(\)/);
  assert.doesNotMatch(systemPage, /creditCards|ReviewCards|giftRequestCards|roomIssueReviewCards|stockNotices|handoverHistory|reportPage|staffRecordingPanel/);
  assert.match(app, /if\(a==='goReviewTasks'\)[\s\S]*?page='tasks'/);
  assert.doesNotMatch(app, /goRoomIssueReviews|window\.location\.assign\('\/admin'\)/);
});
