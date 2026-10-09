const statuses=new Set(['PASS','FAIL','BLOCKED','NOT_RUN']);
const fields=new Set(['status','recordId','login','open','sale','payment','settlement','clean','admin','logout','runtime']);
export function parseBrowserEvidence(line){
 try{
  const value=JSON.parse(line);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'browser'))throw Error();
  const browser=value.browser;
  if(!browser||typeof browser!=='object'||Array.isArray(browser)||!statuses.has(browser.status))throw Error();
  for(const [key,v]of Object.entries(browser)){
   if(!fields.has(key)||!(key==='recordId'?typeof v==='string'&&/^[a-f0-9]{13}$/.test(v):statuses.has(v)))throw Error();
  }
  return browser;
 }catch{throw Error('REHEARSAL_BROWSER_EVIDENCE_INVALID');}
}
export function readBrowserEvidence(input){
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{input.removeListener('line',line);input.removeListener('close',close);input.removeListener('error',error);};
  const line=value=>{cleanup();try{resolve(parseBrowserEvidence(value));}catch(e){reject(e);}};
  const close=()=>{cleanup();resolve(undefined);};
  const error=()=>{cleanup();reject(Error('REHEARSAL_BROWSER_INPUT_FAILED'));};
  input.once('line',line);input.once('close',close);input.once('error',error);
 });
}
