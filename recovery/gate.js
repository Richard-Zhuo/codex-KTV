import { randomUUID } from 'node:crypto';
import { fail,digest } from '../backup/format.js';
export const dispatchLock=database=>'recovery-dispatch:'+digest(database).slice(0,40);
export async function recoveryMode(connection,{lock=false}={}) {
 const [[row]]=await connection.query('SELECT mode FROM recovery_control WHERE control_id=1'+(lock?' FOR SHARE':''));
 return row?.mode??'NORMAL';
}
export const bindRecoveryWriteGuard=async connection=>{if(await recoveryMode(connection,{lock:true})!=='NORMAL')throw fail('RECOVERY_WRITE_FROZEN');};
export async function withRecoveryDispatch(pool,database,work) {
 const c=await pool.getConnection();let locked=false;
 try{const [[claim]]=await c.execute('SELECT GET_LOCK(?,10) AS acquired',[dispatchLock(database)]);if(Number(claim.acquired)!==1)throw fail('RECOVERY_DISPATCH_BUSY');locked=true;
  if(await recoveryMode(c)!=='NORMAL')throw fail('RECOVERY_WORKER_PAUSED');return await work();
 }finally{try{if(locked)await c.execute('SELECT RELEASE_LOCK(?)',[dispatchLock(database)]);}finally{c.release();}}
}
export function recoveryApiGate(api,{pool}) {
 return Object.freeze({...api,async handle(req,res){
  if(!new URL(req.url,'http://localhost').pathname.startsWith('/api/'))return api.handle(req,res);
  let c,ready=false;try{c=await pool.getConnection();ready=await recoveryMode(c)==='NORMAL';}catch{}finally{c?.release();}
  if(ready)return api.handle(req,res);
  const requestId=req.ktvRequestId??randomUUID();res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-Id':requestId});res.end(JSON.stringify({error:{code:'recovery_in_progress',message:'Service is paused for recovery',requestId}}));return true;
 }});
}
