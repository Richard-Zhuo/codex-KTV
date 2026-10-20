// Real Windows processes/Jobs, synthetic files only. This is NOT SCM/SID/ACL acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createServiceBackupExecution} from './backup-execution.js';
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const uuid='11111111-1111-4111-8111-111111111111';
async function until(work) {for(let n=0;n<100;n++){const value=await work();if(value)return value;await sleep(30);}throw Error('NATIVE_OBSERVATION_TIMEOUT');}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
test('B2-A actual native backup supervisor and nested Job lifecycle on owned synthetic files',
 {skip:process.platform!=='win32',timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'ktv-b2-native-')),pids=new Set(),hosts=[];
  const app=join(root,'application space 测试'),entry=join(app,'production','start.js');
  const cli=join(app,'backup','cli.js'),configPath=join(root,'runtime.json'),backupPath=join(root,'backup.json');
  const host=join(root,'service-host.exe'),record=join(root,'owned-processes.json'),nodeRecord=join(root,'outer-node.json');
  await mkdir(dirname(entry),{recursive:true});await mkdir(dirname(cli));
  // Not a substitute backup implementation: exposes only native Job lifecycle.
  await writeFile(cli,[
    "import{readFile,writeFile}from'node:fs/promises';import{spawn}from'node:child_process';",
    "const a=process.argv.slice(2),config=JSON.parse(await readFile(a[a.indexOf('--config-file')+1],'utf8'));",
    "if(config.mode==='simple'){console.log(JSON.stringify({action:a[0],args:a,env:{NODE_ENV:process.env.NODE_ENV,NODE_OPTIONS:process.env.NODE_OPTIONS},label:'测试'}));}",
    "else if(config.mode==='overflow'){console.log('x'.repeat(18000));}",
    "else if(config.mode==='fail'){console.error('synthetic-secret');process.exitCode=2;}",
    "else{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});",
    "await new Promise(r=>child.once('spawn',r));await writeFile(config.record,JSON.stringify({cli:process.pid,grandchild:child.pid}));",
    "if(config.mode==='tree-exit')process.exit(0);else setInterval(()=>{},1000);}"].join('\n'));
  await writeFile(entry,[
    "import{readFile,writeFile}from'node:fs/promises';import{spawn}from'node:child_process';",
    "const c=JSON.parse(await readFile(process.argv.at(-1),'utf8'));await writeFile(c.nodeRecord,JSON.stringify({pid:process.pid}));spawn(c.host,c.args,{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000);"].join('\n'));
  await writeFile(configPath,'{}');
  const args=['--backup-child','--node',process.execPath,'--entry',entry,'--config',configPath,
    '--output-dir',join(root,'output 测试'),'--confirm',uuid+'/synthetic/store/ledger'];
  async function config(mode){await writeFile(backupPath,JSON.stringify({mode,record}));await rm(record,{force:true});}
  async function observe(){
    return until(async()=>{let value;try{value=JSON.parse(await readFile(record,'utf8'));}catch{return false;}
      pids.add(value.cli);pids.add(value.grandchild);return value;});
  }
  async function start(argv=args){
    const child=spawn(host,argv,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_OPTIONS:'--trace-warnings'}});
    hosts.push(child);child.stdout.resume();child.stderr.resume();return child;
  }
  try {
    await exec('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ['/nologo','/target:exe','/platform:x64','/reference:System.ServiceProcess.dll','/out:'+host,
        fileURLToPath(new URL('../deployment/KtvServiceHost.cs',import.meta.url))],
      {windowsHide:true,timeout:15000,maxBuffer:65536});
    await t.test('fixed native backup action quotes paths and preserves UTF8 without inherited Node flags',async()=>{
      await config('simple');
      const result=JSON.parse((await exec(host,args,{windowsHide:true,timeout:10000,env:{...process.env,NODE_OPTIONS:'--trace-warnings'}})).stdout);
      assert.equal(result.action,'backup');assert.equal(result.args[2],backupPath);
      assert.equal(result.args[4],join(root,'output 测试'));assert.equal(result.label,'测试');
      assert.equal(result.env.NODE_ENV,'production');assert.equal(result.env.NODE_OPTIONS,undefined);
    });
    await t.test('nonzero CLI and oversized output return failure without raw diagnostics',async()=>{
      for(const mode of ['fail','overflow']) {
        await config(mode);
        await assert.rejects(exec(host,args,{windowsHide:true,timeout:10000}),e=>{
          assert.equal(e.code,1);assert.equal(e.stdout,'');assert.equal(e.stderr.includes('synthetic-secret'),false);return true;
        });
      }
      await assert.rejects(exec(host,['--backup-child','--command','restore'],{windowsHide:true,timeout:10000}),{code:1});
    });
    await t.test('killing per-run supervisor kills CLI and its grandchild',async()=>{
      await config('hang');const child=await start(),observed=await observe(),closed=once(child,'close');
      child.kill('SIGKILL');await closed;
      await until(()=>!alive(observed.cli)&&!alive(observed.grandchild));
    });
    await t.test('normal CLI exit still reaps a leftover grandchild',async()=>{
      await config('tree-exit');const child=await start(),closed=once(child,'close'),observed=await observe();await closed;
      await until(()=>!alive(observed.cli)&&!alive(observed.grandchild));
    });
    await t.test('CLI abnormal exit closes its supervisor Job and reaps descendants',async()=>{
      await config('hang');const child=await start(),closed=once(child,'close'),observed=await observe();
      process.kill(observed.cli,'SIGKILL');const [code]=await closed;assert.equal(code,1);
      await until(()=>!alive(observed.grandchild));
    });
    await t.test('outer service-host crash contains Node plus nested backup supervisor tree',async()=>{
      await config('hang');await writeFile(configPath,JSON.stringify({host,args,nodeRecord}));
      const outer=await start(['--console','--node',process.execPath,'--entry',entry,'--config',configPath]);
      const observed=await observe(),closed=once(outer,'close');outer.kill('SIGKILL');await closed;
      await until(()=>!alive(observed.cli)&&!alive(observed.grandchild));
    });
    await t.test('service Node crash makes original host exit and contain nested backup descendants',async()=>{
      await config('hang');await writeFile(configPath,JSON.stringify({host,args,nodeRecord}));
      const outer=await start(['--console','--node',process.execPath,'--entry',entry,'--config',configPath]);
      const observed=await observe(),main=JSON.parse(await readFile(nodeRecord,'utf8')),closed=once(outer,'close');
      pids.add(main.pid);process.kill(main.pid,'SIGKILL');await closed;
      await until(()=>!alive(observed.cli)&&!alive(observed.grandchild));
    });
    await t.test('real original CLI inside native supervisor cannot bypass S4 with a synthetic caller config',async()=>{
      // Only the parent's SCM observation is simulated; child runs untouched S4.
      await writeFile(backupPath,JSON.stringify({databaseUrl:'mysql://synthetic:synthetic-secret@127.0.0.1:1/synthetic',
        environment:'production',storeId:'store',ledgerId:'ledger',serverUuid:uuid}));
      const logs=[];
      const loaded={config:{backupExecution:{enabled:true,timeoutMs:30000},applicationCommit:'a'.repeat(40),
        storeId:'store',ledgerId:'ledger',monitoring:{backupDirectory:root}},logDirectory:root};
      const binding={host,node:process.execPath,entry:fileURLToPath(new URL('./start.js',import.meta.url)),
        runtimeConfigFile:configPath,backupConfigFile:backupPath};
      const runner=createServiceBackupExecution({loaded,runtimeConfigFile:configPath,logger:{info:r=>logs.push(r)}},
        {deployment:async()=>binding,report:async()=>{}});
      try{assert.equal((await runner.runOnce()).code,'BACKUP_EXECUTION_FAILED');}finally{await runner.stop();}
      assert.equal(JSON.stringify(logs).includes('synthetic-secret'),false);
    });
  } finally {
    for(const child of hosts)if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}
    for(const pid of pids)if(alive(pid))process.kill(pid,'SIGKILL');
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('ktv-b2-native-'));
    await rm(root,{recursive:true,force:true});
  }
});
