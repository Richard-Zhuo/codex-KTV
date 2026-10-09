import test from 'node:test';import assert from 'node:assert/strict';
test('formal direct room sale requires an explicit server employee UUID; demo keeps its existing form',async()=>{
 const savedWindow=globalThis.window,savedDocument=globalThis.document;globalThis.window??={addEventListener(){}};globalThis.document={querySelector:()=>({textContent:''})};
 const {ctx}=await import('./context.js');const {saleDialog}=await import('./dialogs/orders.js');
 const old={state:ctx.state,formalEnabled:ctx.formalEnabled,modal:ctx.modal,formal:ctx.formal,salePricePlanId:ctx.salePricePlanId};
 let html='';
 const form={dataset:{form:'sale'},querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},elements:{}};
 const modal={set innerHTML(v){html=v;},get innerHTML(){return html;},showModal(){},querySelector(selector){if(selector==='form')return form;return null;},querySelectorAll(){return [];}};
 try{
  const {initialState}=await import('../rules.js');ctx.state=initialState();ctx.state.orders=[];
  ctx.state.employees=[{employeeId:'12345678-1234-4234-8234-123456789abc',displayName:'REHEARSAL employee',enabled:true}];ctx.modal=modal;ctx.formalEnabled=true;ctx.formal={};
  // bindSaleForm needs a real DOM; capture the constructed form before that binding.
  saleDialog('test-order');
  assert.match(html,/name="creditedEmployeeId" required/);assert.match(html,/value="">请选择归属员工/);assert.match(html,/12345678-1234-4234-8234-123456789abc/);
  ctx.formalEnabled=false;ctx.formal=null;saleDialog('test-order');
  assert.doesNotMatch(html,/name="creditedEmployeeId"/);
 }finally{Object.assign(ctx,old);if(savedWindow===undefined)delete globalThis.window;else globalThis.window=savedWindow;if(savedDocument===undefined)delete globalThis.document;else globalThis.document=savedDocument;}
});
