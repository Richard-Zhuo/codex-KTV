import { ctx, esc, btn } from './context.js';
import { deviceProgressLabel, isDevicePending } from './device-progress.js';
import { openDialog } from './shell.js';
export function openingProgressMarkup(room) {
  const detail=room.businessState==='FAILED'?'请联系管理员核对设备。订单和已记录业务仍保留，请勿重新开房。':
    isDevicePending(room)?'房间已保留，设备状态由服务器继续确认。请勿重复开房；刷新页面后可继续查看。':'设备已由服务器确认，可继续营业。';
  return '<p role="status">'+esc(deviceProgressLabel(room))+'</p><p>'+detail+'</p>'+
    (!isDevicePending(room)&&room.order?btn('查看账单','order','data-id="'+esc(room.order)+'"','secondary full'):'');
}
export function showOpeningProgress(room) {
  openDialog(esc(room.id)+' · 开房进度','<section data-device-progress="'+esc(room.id)+'">'+openingProgressMarkup(room)+'</section>');
}
export function refreshOpeningProgress() {
  const node=ctx.modal?.querySelector?.('[data-device-progress]');if(!node)return;
  const room=ctx.state.rooms.find(r=>r.id===node.dataset.deviceProgress);
  if(room){const markup=openingProgressMarkup(room);if(node.innerHTML!==markup)node.innerHTML=markup;}
}
