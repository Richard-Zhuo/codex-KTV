import { text, refused } from './plan.js';
import { BUSINESS_DAY_POLICY } from '../shared/business-day.js';
import { SESSION_RULE_VERSION } from '../shared/business-session.js';
export function validateProductionConfig(env) {
  const fail=()=>{throw refused('PRODUCTION_CONFIG_INVALID');};
  if(env.NODE_ENV&&env.NODE_ENV!=='production')fail();
  if(env.KTV_HTTP_ENV!=='production'||env.KTV_API_MODE!=='enabled'||![undefined,'false'].includes(env.KTV_INSECURE_COOKIE))fail();
  for(const key of ['KTV_STORE_ID','KTV_LEDGER_ID','KTV_BUSINESS_TIME_ZONE','KTV_MYSQL_URL','KTV_PUBLIC_ORIGIN'])text(env[key],key==='KTV_MYSQL_URL'?4096:191);
  if(env.KTV_LEDGER_ID.length>64)fail();
  const timeZone=env.KTV_BUSINESS_TIME_ZONE;
  if(timeZone!=='UTC'&&!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(timeZone))fail();
  try{new Intl.DateTimeFormat('en',{timeZone}).format(0);}catch{fail();}
  if(env.KTV_BUSINESS_DATE_CUTOFF!==BUSINESS_DAY_POLICY.cutoff||env.KTV_SESSION_RULE_VERSION!==SESSION_RULE_VERSION)fail();
  if(!['disabled','required'].includes(env.DEVICE_CONTROL_MODE)||env.KTVSKY_LIVE_CONTROL_ENABLED!=='false')fail();
  let url,origin;
  try{url=new URL(env.KTV_MYSQL_URL);origin=new URL(env.KTV_PUBLIC_ORIGIN);}catch{fail();}
  const database=decodeURIComponent(url.pathname.slice(1));
  if(url.protocol!=='mysql:'||!url.hostname||!url.username||!url.password||!/^[a-z][a-z0-9_]{0,63}$/.test(database)||/(?:^|_)test(?:_|$)/i.test(database))fail();
  if(origin.protocol!=='https:'||origin.origin!==env.KTV_PUBLIC_ORIGIN||origin.username||origin.password)fail();
  if(!['undefined','string'].includes(typeof env.KTVSKY_CREDENTIALS_FILE))fail();
  return Object.freeze({environment:'production',database,storeId:env.KTV_STORE_ID,ledgerId:env.KTV_LEDGER_ID,timeZone,
    businessCutoff:BUSINESS_DAY_POLICY.cutoff,sessionRuleVersion:SESSION_RULE_VERSION,
    sessions:{DAY:'14:00–18:00',NIGHT:'18:00–02:00',CLOSED:'02:00–14:00'},
    deviceControlMode:env.DEVICE_CONTROL_MODE,liveControlEnabled:false});
}
