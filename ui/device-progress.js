const labels=Object.freeze({DEVICE_PENDING:'正在开房',DEVICE_OFFLINE_WAIT:'等待设备上线',
  DEVICE_CLOSING:'正在重置点歌设备',DEVICE_OPENING:'正在开台',DEVICE_VERIFYING:'正在确认',
  DEVICE_UNKNOWN:'设备状态待确认',DEVICE_FAILED:'设备异常',ACTIVE:'营业中'});
export function deviceProgressLabel(value) {
  return value?.deviceControl?.mode==='required' ? labels[value.deviceControl.status]??'设备状态待确认' : value?.status??'';
}
export function isDevicePending(value) {
  return value?.deviceControl?.mode==='required' && value.businessState!=='ACTIVE';
}
export function shouldPollDevice(model,phase,{busy=false,editing=false}={}) {
  return model?.phase==='ready' && !model.stale && !!model.session && phase==='idle' && !busy && !editing &&
    (model.snapshot?.view?.workspace?.rooms??[]).some(r=>isDevicePending(r)&&r.businessState!=='FAILED');
}

// Poll time changes alone must not replace focused room cards or edited controls.
export function progressReadKey(model) {
  if(!model?.snapshot)return null;
  const snapshot=structuredClone(model.snapshot);
  if(snapshot.view?.workspace)delete snapshot.view.workspace.serverNow;
  for(const rows of [snapshot.view?.rooms,snapshot.view?.orders,snapshot.view?.workspace?.rooms,snapshot.view?.workspace?.orders])
    for(const item of rows??[])if(item.deviceControl)delete item.deviceControl.version;
  return JSON.stringify({snapshot,principalId:model.session?.principalId,
    permissions:model.session?.permissionIds,attributes:model.session?.policyAttributeIds});
}
