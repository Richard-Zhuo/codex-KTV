import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createProductionRestorePlan,candidateName} from '../recovery/production-plan.js';
import {canonical,digest} from '../backup/format.js';

const journal=process.argv[2];
const template=JSON.parse(await readFile(join(journal,'synthetic-plan-template.json'),'utf8'));
const loaded={
 config:{storeId:template.storeId,ledgerId:template.ledgerId,
  applicationCommit:template.applicationCommit,serviceAccountSid:template.operatorSid},
 apiEnv:{KTV_MYSQL_URL:'mysql://synthetic:synthetic@'+template.currentHost+
  ':'+template.currentPort+'/'+template.currentDatabase}
};
process.on('message',async message=>{
 if(message!=='go')return;
 try{
  const result=await createProductionRestorePlan({
   runtimeConfigFile:'synthetic',artifactDirectory:'synthetic'
  },{
   inspect:async(_args,id)=>{
    const {planDigest,...body}=template;
    body.recoveryOperationId=id;body.targetDatabase=candidateName(id);
    return {...body,planDigest:digest(canonical(body))};
   },
   load:async()=>loaded,pathCheck:async()=>({journal}),
   harden:async()=>{},fileAcl:async()=>{}
  });
  process.send({type:'result',status:'success',operationId:result.recoveryOperationId},
   ()=>process.disconnect());
 }catch(error){
  process.send({type:'result',status:'error',code:error?.code??'UNKNOWN'},
   ()=>process.disconnect());
 }
});
process.send({type:'ready'});
