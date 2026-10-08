// Isolated process fault injection. Only synthetic fixture arguments arrive over IPC.
import mysql from 'mysql2/promise';
import { restoreDatabase,backupDatabase,connect } from '../backup/mysql-backup.js';
import { verifyRecovery,resumeRecovery } from '../recovery/operator.js';
import { bindRecoveryWriteGuard,withRecoveryDispatch,recoveryApiGate,recoveryMode } from '../recovery/gate.js';
import { createRoomControlRuntime } from '../devices/runtime.js';
import { FakeKtvRoomControlGateway } from '../devices/fake-gateway.js';
process.once('message',async ({operation,args,checkpoint})=>{
 try{
  if(operation==='probe'){
   const pool=mysql.createPool({uri:args.databaseUrl,connectionLimit:4}),database=new URL(args.databaseUrl).pathname.slice(1);
   let status,delegated=false;const api=recoveryApiGate({handle(){delegated=true;}},{pool});
   await api.handle({url:'/api/v1/commands/clean'},{writeHead:s=>{status=s;},end(){}});
   const c=await pool.getConnection();let writeCode,dispatchCode;
   try{await c.beginTransaction();await bindRecoveryWriteGuard(c);}catch(e){writeCode=e.code;}finally{await c.rollback();c.release();}
   try{await withRecoveryDispatch(pool,database,()=>{throw Error('Unexpected dispatch');});}catch(e){dispatchCode=e.code;}
   const gateway=new FakeKtvRoomControlGateway(),runtime=createRoomControlRuntime({pool,database,ledgerId:args.ledgerId,authStore:{bindSessionRevalidation(){}},gateway,testOnly:true,recoveryGuard:true});
   await runtime.start();await runtime.worker.tick();await runtime.stop();
   const connection=await pool.getConnection();const mode=await recoveryMode(connection);connection.release();await pool.end();
   process.send({type:'result',result:{mode,status,delegated,writeCode,dispatchCode,providerCalls:gateway.calls.length}});
   await new Promise(resolve=>process.once('message',resolve));
  }else if(operation==='size'){
   const result=await backupDatabase({...args,connectSource:async raw=>{
    const c=await connect(raw),query=c.query.bind(c);
    c.query=async (...values)=>{
     const result=await query(...values);
     if(values[0]?.sql==='SELECT * FROM auth_events')result[0][0][0]='x'.repeat(128*1024*1024);
     return result;
    };
    return c;
   }});process.send({type:'result',result});
  }else{
   const original=mysql.createConnection.bind(mysql);let paused=false;
   mysql.createConnection=async (...values)=>{
    const c=await original(...values);
    for(const method of ['query','execute']){
     const originalCall=c[method].bind(c);
     c[method]=async (...values)=>{
      const result=await originalCall(...values),sql=typeof values[0]==='string'?values[0]:values[0].sql;
      if(!paused&&checkpoint&&sql.startsWith(checkpoint)){
       paused=true;process.send({type:'checkpoint'});
       await new Promise(resolve=>process.once('message',resolve));
      }
      return result;
     };
    }
    return c;
   };
   const run={restore:restoreDatabase,verify:verifyRecovery,resume:resumeRecovery}[operation];
   const result=await run(args);process.send({type:'result',result});
  }
 }catch(e){process.send({type:'error',code:e.code??'SYNTHETIC_PROCESS_FAILURE'});}
 process.disconnect();
});
