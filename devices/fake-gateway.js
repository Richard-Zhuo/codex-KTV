import { KtvRoomControlGateway } from './gateway.js';
// Explicit isolated-test simulator. No real transport and no production fallback.
export class FakeKtvRoomControlGateway extends KtvRoomControlGateway {
  get testOnly() { return true; }
  constructor({ online=true, open=false, outcomes={} }={}) {
    super();this.room={online,open,countdownTargetEndAt:null};this.outcomes=outcomes;this.calls=[];this.steps=new Map();
  }
  async invoke(method,input,normal) {
    this.calls.push({method,workflowId:input.workflowId,stepId:input.stepId,
      ...(input.targetEndAt?{targetEndAt:input.targetEndAt,durationMinutes:input.durationMinutes,countdownSeconds:input.countdownSeconds}:{})});
    const outcome=this.outcomes[method];
    const selected=Array.isArray(outcome)?outcome.shift():outcome;
    if(typeof selected==='function') return selected(input,this,normal);
    if(selected instanceof Error)throw selected;
    return selected??normal();
  }
  evidence(input,extra={}) {
    return {provider:input.provider,externalDeviceId:input.externalDeviceId,workflowId:input.workflowId,
      stepId:input.stepId,kind:'STATE',room:{...this.room},...extra};
  }
  async ensureSession(input) { return this.invoke('ensureSession',input,()=>({ready:true})); }
  async getRoomStatus(input) { return this.invoke('getRoomStatus',input,()=>this.evidence(input)); }
  async mutate(method,input,apply) {
    return this.invoke(method,input,()=>{
      if(!this.room.online)return this.evidence(input,{kind:'OFFLINE'});
      if(!this.steps.has(input.stepId)){apply();this.steps.set(input.stepId,'APPLIED');}
      return this.evidence(input,{kind:'APPLIED',settled:true});
    });
  }
  async closeRoom(input) { return this.mutate('closeRoom',input,()=>{this.room.open=false;this.room.countdownTargetEndAt=null;}); }
  async openRoom(input) {
    if(!Number.isSafeInteger(input.countdownSeconds) || input.countdownSeconds<=0 || !input.targetEndAt)throw TypeError('Combined open countdown required');
    return this.mutate('openRoom',input,()=>{this.room.open=true;this.room.countdownTargetEndAt=input.targetEndAt;});
  }
  async queryRoomState(input) {
    return this.invoke('queryRoomState',input,()=>this.evidence(input,{stepResult:this.steps.get(input.stepId)??'UNKNOWN',settled:this.steps.has(input.stepId)}));
  }
}
