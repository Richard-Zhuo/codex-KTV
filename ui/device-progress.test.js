import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceProgressLabel,isDevicePending,shouldPollDevice,progressReadKey,deviceOpeningRejectionText} from './device-progress.js';
const pending=(status='DEVICE_PENDING',businessState='OPENING')=>({id:'V01',businessState,deviceControl:{mode:'required',status}});
test('formal progress labels distinguish waiting, resetting, opening, verifying, active and exception',()=>{
 for(const [status,label,state] of [['DEVICE_PENDING','正在开房','OPENING'],['DEVICE_OFFLINE_WAIT','等待设备上线','WAITING_DEVICE'],['DEVICE_CLOSING','正在重置点歌设备','OPENING'],['DEVICE_OPENING','正在开台','OPENING'],['DEVICE_VERIFYING','正在确认','OPENING'],['ACTIVE','营业中','ACTIVE'],['DEVICE_FAILED','设备异常','FAILED']]){
  assert.equal(deviceProgressLabel(pending(status,state)),label);assert.equal(isDevicePending(pending(status,state)),state!=='ACTIVE');
 }
 assert.equal(deviceProgressLabel(pending('untrusted-internal-code')),'设备状态待确认');
 assert.equal(isDevicePending({deviceControl:{mode:'disabled',status:'DISABLED'}}),false);
});
test('polling reads stop on logout, stale network, pending write or edited form',()=>{
 const model={phase:'ready',session:{principalId:'synthetic'},snapshot:{view:{workspace:{rooms:[pending()]}}}};
 assert.equal(shouldPollDevice(model,'idle'),true);
 for(const changed of [{phase:'login'},{stale:true},{session:null},{snapshot:{view:{workspace:{rooms:[pending('ACTIVE','ACTIVE')]}}}}])assert.equal(shouldPollDevice({...model,...changed},'idle'),false);
 assert.equal(shouldPollDevice(model,'sending'),false);assert.equal(shouldPollDevice(model,'unknown'),false);
 assert.equal(shouldPollDevice(model,'idle',{editing:true}),false);assert.equal(shouldPollDevice(model,'idle',{busy:true}),false);
});
test('pending room card offers progress, never another opening or service mutation',async()=>{
 const original=globalThis.window;globalThis.window??={addEventListener(){}};
 const {ctx}=await import('./context.js'),before={state:ctx.state,formal:ctx.formal};
 try{const {initialState}=await import('../rules.js');const {roomCard}=await import('./pages/rooms.js');ctx.state=initialState();ctx.formal={session:{permissionIds:['room.open','order.serveExtra']}};
  const room={...ctx.state.rooms[0],...pending('DEVICE_OFFLINE_WAIT','WAITING_DEVICE'),status:'等待设备上线',order:'opening-order'};
  ctx.state.orders=[{id:'opening-order',extras:[{product:'nuts',served:false}]}];
  const html=roomCard(room);assert.match(html,/等待设备上线/);assert.match(html,/查看开房进度/);assert.doesNotMatch(html,/点这里开房|data-action="serveExtra"/);
 }finally{ctx.state=before.state;ctx.formal=before.formal;if(original===undefined)delete globalThis.window;else globalThis.window=original;}
});

test('progress polling retains focused DOM on time-only reads, but renders readiness or permission changes',()=>{
 const a={session:{principalId:'one',permissionIds:['room.open']},snapshot:{revision:1,view:{workspace:{serverNow:'first',rooms:[pending()]}}}};
 const b=structuredClone(a);b.snapshot.view.workspace.serverNow='later';b.snapshot.view.workspace.rooms[0].deviceControl.version=42;assert.equal(progressReadKey(a),progressReadKey(b));
 b.snapshot.view.workspace.rooms[0].businessState='ACTIVE';assert.notEqual(progressReadKey(a),progressReadKey(b));
 b.snapshot=structuredClone(a.snapshot);b.session.permissionIds=[];assert.notEqual(progressReadKey(a),progressReadKey(b));
});

test('missing device mapping has accurate employee guidance without exposing arbitrary server details',()=>{
 assert.match(deviceOpeningRejectionText({code:'business_rejection',result:{reasonCode:'device_mapping_required'}}),/该房间设备尚未完成系统绑定/);
 assert.equal(deviceOpeningRejectionText({code:'internal_error',result:{reasonCode:'device_mapping_required',reason:'SQL secret'}}),null);
 assert.equal(deviceOpeningRejectionText({code:'business_rejection',result:{reason:'arbitrary detail'}}),null);
});
