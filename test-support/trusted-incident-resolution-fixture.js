export const resolutionEmployeeId='10000000-0000-4000-8000-000000000001';
export const otherResolutionEmployeeId='10000000-0000-4000-8000-000000000002';
export const resolutionPrincipalId='20000000-0000-4000-8000-000000000001';
export const otherResolutionPrincipalId='20000000-0000-4000-8000-000000000002';
export const resolutionDbNow='2026-10-05T12:00:00.123456Z';
export function seedIncidentResolution(state,employeeId=resolutionEmployeeId){
 state.serial=Math.max(state.serial,41);state.incidents=[{id:41,date:'2026-10-03',room:'V01',type:'设备异常',description:'Historical description',
  assigneeEmployeeId:employeeId,assigneeEmployeeNameSnapshot:'Historical Assignee',assigneeId:employeeId,assignee:'Historical Assignee',
  person:'Historical Creator',submittedByPrincipalId:'30000000-0000-4000-8000-000000000001',actualActorPrincipalId:'30000000-0000-4000-8000-000000000001',
  createdAt:'2026-10-03T12:00:00.000000Z',result:'',note:'',status:'待处理',lastReminderDate:'2026-10-04',resolutionReviews:[]}];
}
export const resolutionCommand=(key='resolution-1',revision=0,changes={})=>({operationKey:key,expectedRevision:revision,action:'resolveIncident',
 payload:{id:41,result:' Synthetic result ',note:' Synthetic note ',...changes}});
