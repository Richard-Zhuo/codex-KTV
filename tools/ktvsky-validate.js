import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKtvSkyValidationConfig, denyValidation } from '../devices/ktvsky-safety.js';
import { createKtvSkyValidationBoundary, summarizeValidation } from '../devices/ktvsky-validation.js';

export async function runValidationCli(args=process.argv.slice(2),env=process.env) {
  const values={},allowed=new Set(['--config','--action','--room','--countdown-seconds','--target-end-at']);
  for(let i=0;i<args.length;i+=2) {
    if(!allowed.has(args[i])||!args[i+1]||Object.hasOwn(values,args[i]))denyValidation('INVALID_VALIDATION_ACTION');
    values[args[i]]=args[i+1];
  }
  if(!values['--config'])denyValidation('INVALID_CONFIG');
  const config=await loadKtvSkyValidationConfig(values['--config']);
  const boundary=createKtvSkyValidationBoundary({config,env});
  const result=await boundary.run({action:values['--action']??'query',internalRoomId:values['--room'],
    countdownSeconds:values['--countdown-seconds']===undefined?undefined:Number(values['--countdown-seconds']),
    targetEndAt:values['--target-end-at']});
  return summarizeValidation(result);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(await runValidationCli()));}
  catch(error){
    const known=new Set(['INVALID_CONFIG','EXTERNAL_CONFIG_REQUIRED','INVALID_VALIDATION_ACTION','MAPPING_REQUIRED',
      'LIVE_CONTROL_DISABLED','SAFE_TEST_TARGET_REQUIRED','SAFE_APPROVAL_EXPIRED','SAFE_COUNTDOWN_REQUIRED',
      'EXTERNAL_JOURNAL_REQUIRED','INVALID_PENDING_RECORD','JOURNAL_IO_ERROR','SAFE_VALIDATION_REQUIRED']);
    console.log(JSON.stringify({code:known.has(error.code)?error.code:'VALIDATION_ERROR',message:'Validation could not continue'}));
    process.exitCode=1;
  }
}
