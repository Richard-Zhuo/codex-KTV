// Independent-process verifier only. This never claims a production monitor exists.
export class FakeExternalHeartbeatMonitor{
 constructor(request){this.request=request;this.history=[];}
 async probe(){let live,ready;try{live=await this.request('/health/live');ready=await this.request('/health/ready');}catch{}
  const result={at:new Date().toISOString(),live:live?.status===200,ready:ready?.status===200,scope:'rehearsal',productionConfigured:false};
  this.history.push(result);return result;
 }
}
