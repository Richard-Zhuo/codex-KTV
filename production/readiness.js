import { randomUUID } from 'node:crypto';
import { PRICE_CATEGORIES, pricedSaleOptions } from '../catalog-pricing.js';
import { DAY_PRICE_PLAN } from '../shared/business-session.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { initialState } from '../rules.js';
import { decodeLedgerJson } from '../ledger/mysql-snapshot.js';
import { validateSchema } from './schema.js';
import { readExternalSecret } from './secret-file.js';
import { exact, text, refused } from './plan.js';
export function catalogReadiness(state) {
  const blockers=[],products=[];
  if(state?.catalog?.schemaVersion!==2||!Array.isArray(state.catalog.products)||!state.catalog.products.length)blockers.push({code:'CATALOG_NOT_CONFIGURED'});
  for(const p of state?.catalog?.products??[]) {
    if(p.active===false)continue;
    const codes=[];
    if(!PRICE_CATEGORIES.includes(p.priceCategory))codes.push('PRICE_CATEGORY_MISSING_OR_UNKNOWN');
    const options=p.saleOptions;
    if(p.sellable&&(!Array.isArray(options)||!options.length))codes.push('SALE_OPTIONS_MISSING');
    if(p.sellable&&Array.isArray(options)&&options.some(o=>!Number.isSafeInteger(o.priceCents)||o.priceCents<0||!Number.isSafeInteger(o.baseQuantity)||o.baseQuantity<=0))codes.push('SALE_OPTION_INVALID');
    let day=[];
    if(p.sellable&&PRICE_CATEGORIES.includes(p.priceCategory)) {
      try {
        day=pricedSaleOptions(p,DAY_PRICE_PLAN);
        if(p.priceCategory!=='OTHER') {
          const dozen=day.find(o=>o.id==='dozen'),half=day.find(o=>o.id==='half');
          const expected=p.priceCategory==='PREMIUM_BEER'?12000:10000;
          if(dozen?.priceCents!==expected||dozen?.baseQuantity!==12||half?.priceCents!==expected/2||half?.baseQuantity!==6)codes.push('DAY_PRICE_INCOMPLETE');
        }
      }catch{codes.push('DAY_PRICE_INCOMPLETE');}
    }
    const stock=p.kind==='consumable'?state.consumables?.[p.id]:state.inventory?.[p.id];
    if(p.inventoryManaged&&(!stock||stock.count===null||stock.count===undefined))codes.push('OPENING_INVENTORY_REQUIRED');
    else if(p.inventoryManaged&&(!Number.isSafeInteger(stock.count)||stock.count<0))codes.push('INVENTORY_INVALID');
    for(const code of codes)blockers.push({code,productId:p.id});
    products.push({productId:p.id,priceCategory:p.priceCategory??null,sellable:Boolean(p.sellable),
      night:options??[],day,inventoryManaged:Boolean(p.inventoryManaged),count:stock?.count??null,blockers:codes});
  }
  return {products,blockers};
}
export function mappingReadiness(rooms,mappings,confirmations,required=false) {
  const checklist=rooms.map(room=>{
    const m=mappings.find(m=>m.internal_room_id===room.id);
    const confirmed=m&&confirmations.some(c=>c.internalRoomId===room.id&&c.provider===m.provider&&c.externalDeviceId===m.external_device_id&&c.enabled===Boolean(m.enabled)&&c.source==='human-confirmed');
    return {internalRoomId:room.id,provider:m?.provider??null,deviceSuffix:m?.external_device_id?.slice(-4)??null,
      enabled:Boolean(m?.enabled),confirmed:Boolean(confirmed),status:!m?'UNMAPPED':!confirmed?'NEEDS_CONFIRMATION':!m.enabled?'CONFIRMED_DISABLED':'CONFIRMED_ENABLED'};
  });
  return {checklist,blockers:required?checklist.filter(r=>!r.enabled||!r.confirmed).map(r=>({code:'ROOM_MAPPING_REQUIRED',internalRoomId:r.internalRoomId})):[]};
}
export async function readProductionReadiness({pool,config,credentialFile}) {
  const connection=await pool.getConnection();
  try {
    const schema=await validateSchema(connection,config.database);
    const [heads]=await connection.execute('SELECT ledger_id FROM ledger_heads');
    if(heads.length>1 || heads.some(h=>h.ledger_id!==config.ledgerId))throw refused('PRODUCTION_STORE_MISMATCH');
    const head=heads.length ? await createMySqlLedgerStore({pool,database:config.database,ledgerId:config.ledgerId}).read() : null;
    const state=head?.state??initialState();
    const [identities]=await connection.query('SELECT a.principal_id,e.employee_id,e.enabled AS employee_enabled FROM auth_accounts a LEFT JOIN employees e ON e.principal_id=a.principal_id WHERE a.enabled=1');
    const [events]=await connection.execute('SELECT store_id,ledger_id,environment,plan_digest,facts FROM production_bootstrap_events');
    if(events.some(e=>e.store_id!==config.storeId||e.ledger_id!==config.ledgerId||e.environment!==(config.environment??'production')))throw refused('PRODUCTION_STORE_MISMATCH');
    const facts=events.map(e=>({...e,facts:decodeLedgerJson(e.facts)}));
    const [[server]]=await connection.query('SELECT @@server_uuid AS server_uuid');
    const formal=facts.filter(e=>e.facts.source==='first-install-ledger');
    const [[recovery]]=await connection.execute('SELECT mode,store_id,ledger_id,environment,backup_digest,facts FROM recovery_control WHERE control_id=1');
    const recoveryFacts=recovery ? decodeLedgerJson(recovery.facts) : null;
    const verifiedRestore=Boolean(recovery?.mode==='NORMAL' &&
      recovery.store_id===config.storeId && recovery.ledger_id===config.ledgerId &&
      recovery.environment===(config.environment??'production') &&
      /^[0-9a-f]{64}$/.test(recovery.backup_digest??'') &&
      /^[0-9a-f]{64}$/.test(recoveryFacts?.preparedDigest??'') &&
      typeof recoveryFacts?.verifiedAt==='string' &&
      recoveryFacts?.source?.database===formal[0]?.facts.database &&
      recoveryFacts?.source?.serverUuid===formal[0]?.facts.serverUuid);
    const receiptDatabaseMatches=formal[0]?.facts.database===config.database ||
      (verifiedRestore && formal[0]?.facts.database!==config.database);
    const ledgerInitialized=Boolean(head)&&formal.length===1&&
      formal[0].facts.serverUuid===server.server_uuid&&receiptDatabaseMatches&&
      formal[0].facts.storeId===config.storeId&&formal[0].facts.ledgerId===config.ledgerId&&
      formal[0].facts.initialRevision===0&&formal[0].facts.schemaMigration===schema.migrations.at(-1)&&
      /^[0-9a-f]{64}$/.test(formal[0].plan_digest);
    const [mappings]=await connection.execute('SELECT internal_room_id,provider,external_device_id,enabled FROM room_device_mappings WHERE ledger_id=?',[config.ledgerId]);
    const reviewedIdentities=facts.filter(e=>e.facts.source==='identity-bootstrap').flatMap(e=>e.facts.identities??[]);
    const confirmations=facts.flatMap(e=>e.facts.mappings??[]);
    const catalog=catalogReadiness(state),mapping=mappingReadiness(state.rooms,mappings,confirmations,config.deviceControlMode==='required');
    const blockers=[...catalog.blockers,...mapping.blockers];
    if(!ledgerInitialized)blockers.push({code:'LEDGER_NOT_INITIALIZED'});
    if(catalog.blockers.some(b=>b.code==='OPENING_INVENTORY_REQUIRED'))blockers.push({code:'INVENTORY_NOT_INITIALIZED'});
    if(!reviewedIdentities.length||!identities.some(i=>i.employee_enabled===1))blockers.push({code:'PRODUCTION_IDENTITIES_REQUIRED'});
    if(identities.some(i=>i.employee_enabled!==1||!reviewedIdentities.some(r=>r.principalId===i.principal_id&&r.employeeId===i.employee_id)))blockers.push({code:'UNREVIEWED_ACTIVE_ACCOUNT'});
    if(config.deviceControlMode==='required')blockers.push({code:'DEVICE_REQUIRED_PROVIDER_PRODUCTION_DISABLED'});
    if(credentialFile) {
      const secret=await readExternalSecret(credentialFile);
      exact(secret,['telno','password']);text(secret.telno);text(secret.password,1024);
    }
    return {ready:blockers.length===0,database:config.database,storeId:config.storeId,ledgerId:config.ledgerId,
      schema,revision:head?.revision??null,config,catalog,mapping,providerCredentialsPresent:Boolean(credentialFile),blockers};
  }finally{connection.release();}
}
export function productionApiGate(api,readiness,{logger=console,start=()=>{}}={}) {
  const ready=Promise.resolve().then(readiness).then(async report=>{
    if(report.ready){await start();return true;}
    logger.error({code:'PRODUCTION_NOT_READY',blockers:report.blockers.map(b=>b.code)});return false;
  }).catch(()=>{logger.error({code:'PRODUCTION_READINESS_FAILED'});return false;});
  return Object.freeze({...api,async handle(req,res){
    if(!(await ready)) {
      if(!new URL(req.url,'http://localhost').pathname.startsWith('/api/'))return false;
      const requestId=randomUUID();
      res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-Id':requestId});
      res.end(JSON.stringify({error:{code:'service_unavailable',message:'Production readiness checks failed',requestId}}));return true;
    }
    return api.handle(req,res);
  },async close(){await ready;await api.close?.();}});
}
