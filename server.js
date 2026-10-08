import http from 'node:http';
import { isProductionEnvironment } from './shared/deployment-environment.js';
import { createHttpApiFromEnv } from './http/bootstrap.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const files = { '/ui/device-progress.js':['ui/device-progress.js','text/javascript'], '/ui/opening-progress.js':['ui/opening-progress.js','text/javascript'], '/catalog-pricing.js': ['catalog-pricing.js', 'text/javascript'], '/shared/business-session.js': ['shared/business-session.js', 'text/javascript'], '/shared/business-day.js': ['shared/business-day.js', 'text/javascript'], '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/admin': ['admin.html', 'text/html'], '/admin.html': ['admin.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/rules.js': ['rules.js', 'text/javascript'], '/catalog.js': ['catalog.js', 'text/javascript'], '/packages.js': ['packages.js', 'text/javascript'], '/inventory.js': ['inventory.js', 'text/javascript'], '/sales.js': ['sales.js', 'text/javascript'], '/rooms.js': ['rooms.js', 'text/javascript'], '/deposits.js': ['deposits.js', 'text/javascript'], '/expenses.js': ['expenses.js', 'text/javascript'], '/procurement.js': ['procurement.js', 'text/javascript'], '/incidents.js': ['incidents.js', 'text/javascript'], '/handover.js': ['handover.js', 'text/javascript'], '/reviewInbox.js': ['reviewInbox.js', 'text/javascript'], '/reporting.js': ['reporting.js', 'text/javascript'], '/ui/context.js': ['ui/context.js', 'text/javascript'], '/ui/shell.js': ['ui/shell.js', 'text/javascript'], '/ui/forms.js': ['ui/forms.js', 'text/javascript'], '/ui/pages/rooms.js': ['ui/pages/rooms.js', 'text/javascript'], '/ui/pages/retail.js': ['ui/pages/retail.js', 'text/javascript'], '/ui/pages/deposits.js': ['ui/pages/deposits.js', 'text/javascript'], '/ui/pages/tasks.js': ['ui/pages/tasks.js', 'text/javascript'], '/ui/pages/admin.js': ['ui/pages/admin.js', 'text/javascript'], '/ui/pages/expenses.js': ['ui/pages/expenses.js', 'text/javascript'], '/ui/pages/procurement.js': ['ui/pages/procurement.js', 'text/javascript'], '/ui/pages/incidents.js': ['ui/pages/incidents.js', 'text/javascript'], '/ui/pages/reports.js': ['ui/pages/reports.js', 'text/javascript'], '/ui/pages/mine.js': ['ui/pages/mine.js', 'text/javascript'], '/ui/dialogs/rooms.js': ['ui/dialogs/rooms.js', 'text/javascript'], '/ui/dialogs/orders.js': ['ui/dialogs/orders.js', 'text/javascript'], '/ui/dialogs/retail.js': ['ui/dialogs/retail.js', 'text/javascript'], '/ui/dialogs/deposits.js': ['ui/dialogs/deposits.js', 'text/javascript'], '/ui/dialogs/operations.js': ['ui/dialogs/operations.js', 'text/javascript'], '/ui/dialogs/admin.js': ['ui/dialogs/admin.js', 'text/javascript'], '/ui/api-client.js': ['ui/api-client.js', 'text/javascript'], '/ui/server-state.js': ['ui/server-state.js', 'text/javascript'], '/ui/staff-app.js': ['ui/staff-app.js', 'text/javascript'], '/ui/admin-app.js': ['ui/admin-app.js', 'text/javascript'], '/ui/admin-view.js': ['ui/admin-view.js', 'text/javascript'], '/ui/admin-approval.js': ['ui/admin-approval.js', 'text/javascript'], '/ui/command-flow.js': ['ui/command-flow.js', 'text/javascript'], '/ui/pending-command-journal.js': ['ui/pending-command-journal.js', 'text/javascript'], '/ui/formal-workspace.js': ['ui/formal-workspace.js', 'text/javascript'], '/migrations.js': ['migrations.js', 'text/javascript'], '/persistence.js': ['persistence.js', 'text/javascript'], '/ledger/command-policy.js': ['ledger/command-policy.js', 'text/javascript'], '/shared/business-error.js': ['shared/business-error.js', 'text/javascript'], '/shared/money.js': ['shared/money.js', 'text/javascript'], '/shared/time.js': ['shared/time.js', 'text/javascript'], '/shared/identity.js': ['shared/identity.js', 'text/javascript'], '/theme.js': ['theme.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
export function createKtvRequestHandler({ api = createHttpApiFromEnv() } = {}) {
  return async (req, res) => {
  if (api && await api.handle(req, res)) return;
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(fileURLToPath(new URL(file[0], import.meta.url)));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch { res.writeHead(500); res.end('Unable to load demo'); }
  };
}
export function createKtvServer({api,env=process.env}={}) {
  if(isProductionEnvironment(env)||(env.KTV_API_MODE==='enabled'&&env.KTV_HTTP_ENV!=='development'))throw Object.assign(Error('PRODUCTION_HTTPS_ENTRY_REQUIRED'),{code:'PRODUCTION_HTTPS_ENTRY_REQUIRED'});
  if(api===undefined)api=createHttpApiFromEnv(env);
  const server=http.createServer(createKtvRequestHandler({api}));
  server.on('close',()=>{void api?.close?.();});
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  createKtvServer().listen(port, '0.0.0.0',
    () => console.log(`KTV demo: http://localhost:${port}`));
}
