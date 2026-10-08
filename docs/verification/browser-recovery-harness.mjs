import { assertFixtureEnvironment } from '../../test-support/destructive-safety.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, transact } from '../../rules.js';

assertFixtureEnvironment();
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const key = 'jbhh-demo-v1';
const backupKey = 'jbhh-demo-v1-recovery';
let state = initialState();
state.clock = '2026-09-29T20:00:00+08:00';
state.user = 'shaoBoss';
state = transact(state, 'open', { room: 'V01', beer: 'bw' }, 'isolated-browser-open');
state = transact(state, 'pay', { order: state.orders[0].id,
  payments: [{ method: '现金', amount: 16800 }] }, 'isolated-browser-pay');
const historicOrder = structuredClone(state.orders[0]);
const packageId = 'room.small.night';
state.catalog.packages.find(item => item.id === packageId).priceCents = 100;
const fixture = JSON.stringify(state);
const expectedOrder = JSON.stringify(historicOrder);
const js = value => JSON.stringify(value).replace(/</g, '\\u003c');
const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title><style>body{font:16px system-ui;max-width:820px;margin:32px auto;line-height:1.6}button,a{margin:8px;padding:8px}textarea{width:100%;height:180px}pre{white-space:pre-wrap}</style></head><body><h1>${title}</h1>${body}</body></html>`;
const seed = page('隔离测试：安装含付款订单的旧记录', `
  <p>仅在本次随机端口的浏览器来源写入合成测试数据。若主键已存在则拒绝覆盖。</p>
  <p id="status"></p><button id="seed">安装测试数据</button><a href="/">进入门店页面</a>
  <script>
    const key=${js(key)}, fixture=${js(fixture)};
    const existing=localStorage.getItem(key);
    document.querySelector('#status').textContent=existing===null?'主键为空，可以安装':'主键已有数据，拒绝覆盖';
    document.querySelector('#seed').disabled=existing!==null;
    document.querySelector('#seed').onclick=()=>{if(localStorage.getItem(key)!==null)throw Error('主键已有数据');localStorage.setItem(key,fixture);location.assign('/')};
  </script>`);
const repair = page('隔离测试：人工修正当前套餐', `
  <p>从应用的只读原文框复制全部内容，粘贴到下方；逐字匹配当前主键后，按钮才会启用。修正只改当前套餐配置。</p>
  <textarea id="copied" aria-label="粘贴复制的原文"></textarea>
  <button id="compare">核对复制内容</button><button id="repair" disabled>修正当前套餐价格</button>
  <p id="status"></p><a href="/">返回门店页面重新检查</a><a href="/__audit">查看核对结果</a>
  <script>
    const key=${js(key)}, packageId=${js(packageId)}, expectedOrder=${js(expectedOrder)};
    let verifiedRaw=null;
    document.querySelector('#compare').onclick=()=>{
      const current=localStorage.getItem(key);
      const copied=document.querySelector('#copied').value;
      const ok=current!==null&&copied===current;
      verifiedRaw=ok?current:null;
      document.querySelector('#repair').disabled=!ok;
      document.querySelector('#status').textContent=ok?'复制原文与主键逐字一致':'复制原文与主键不一致，禁止修正';
    };
    document.querySelector('#repair').onclick=()=>{
      if(verifiedRaw===null||localStorage.getItem(key)!==verifiedRaw)throw Error('记录已变化');
      const parsed=JSON.parse(verifiedRaw);
      if(JSON.stringify(parsed.orders[0])!==expectedOrder)throw Error('历史订单与原测试数据不同');
      const pack=parsed.catalog.packages.find(item=>item.id===packageId);
      if(!pack||pack.priceCents!==100)throw Error('当前套餐值不符合测试前置条件');
      pack.priceCents=pack.basePriceCents+pack.includedValueCents;
      if(JSON.stringify(parsed.orders[0])!==expectedOrder)throw Error('历史订单被改动');
      localStorage.setItem(key,JSON.stringify(parsed));
      document.querySelector('#status').textContent='仅当前套餐价格已修正；历史订单原文未改。请返回门店页面重新检查。';
      document.querySelector('#repair').disabled=true;
    };
  </script>`);
const audit = page('隔离测试：历史订单与付款核对', `
  <pre id="result"></pre><a href="/">返回门店页面</a><a href="/__repair">打开人工修正页</a>
  <script>
    const key=${js(key)}, backupKey=${js(backupKey)}, expectedOrder=${js(expectedOrder)}, fixture=${js(fixture)};
    const raw=localStorage.getItem(key);
    const saved=raw===null?null:JSON.parse(raw);
    const order=saved?.orders?.[0];
    const result={
      originalRawStillPrimary:raw===fixture,
      backupMatchesOriginal:localStorage.getItem(backupKey)===fixture,
      orderCount:saved?.orders?.length??null,
      historicOrderUnchanged:JSON.stringify(order)===expectedOrder,
      orderId:order?.id??null,
      historicPackagePriceCents:order?.packagePriceCents??null,
      paymentCount:order?.payments?.length??null,
      paidCents:order?.payments?.reduce((n,p)=>n+p.amount,0)??null,
      currentPackagePriceCents:saved?.catalog?.packages?.find(p=>p.id==='room.small.night')?.priceCents??null
    };
    document.querySelector('#result').textContent=JSON.stringify(result,null,2);
  </script>`);
const mime = path => extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'text/html';
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/__seed' || path === '/__repair' || path === '/__audit') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(path === '/__seed' ? seed : path === '/__repair' ? repair : audit);
    return;
  }
  const pathPart = path === '/' ? 'index.html' : path.slice(1);
  if (!/^(?:[A-Za-z][A-Za-z0-9-]*\.js|(?:ui|shared)\/[A-Za-z0-9_/-]+\.js|(?:index|admin)\.html|style\.css)$/.test(pathPart)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const target = resolve(root, pathPart);
  if (!target.startsWith(root + sep)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': `${mime(pathPart)}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log(`Isolated recovery harness: http://127.0.0.1:${server.address().port}`));
