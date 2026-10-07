import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../rules.js';
test('formal sale form shows server-selected DAY dozen, demo and existing plan retain current prices',async()=>{
 const previousWindow=globalThis.window;
 globalThis.window ??= {addEventListener(){}};
 const {ctx}=await import('./context.js');const {saleItemRow}=await import('./forms.js');
 const saved={state:ctx.state,formalEnabled:ctx.formalEnabled,salePricePlanId:ctx.salePricePlanId};
 try{
  ctx.state=initialState();ctx.formalEnabled=true;ctx.salePricePlanId='day-v1';
  assert.match(saleItemRow('drink','drink0','dozen'),/¥100</);
  assert.match(saleItemRow('beer','bw','dozen'),/¥100</);
  ctx.salePricePlanId='night-existing-v1';assert.match(saleItemRow('beer','bw','dozen'),/¥118</);
  ctx.formalEnabled=false;ctx.salePricePlanId='day-v1';assert.match(saleItemRow('beer','bw','dozen'),/¥118</);
 }finally{Object.assign(ctx,saved);if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;}
});

test('formal DAY form total uses the same server-projected plan as option labels',async()=>{
 const savedWindow=globalThis.window,savedDocument=globalThis.document;globalThis.window??={addEventListener(){}};
 const {ctx}=await import('./context.js');const {bindSaleForm}=await import('./forms.js');
 const saved={state:ctx.state,formalEnabled:ctx.formalEnabled,modal:ctx.modal,salePricePlanId:ctx.salePricePlanId};
 try{
  ctx.state=initialState();ctx.state.orders=[{id:'day-order',businessSession:{pricePlanId:'day-v1'}}];ctx.formalEnabled=true;
  const fields={'[name="saleCategory"]':{value:'beer'},'[name="saleProduct"]':{value:'bw'},'[name="saleSpec"]':{value:'dozen'},'[name="saleCount"]':{value:'1'},'.sale-line-total':{textContent:''}};
  const row={querySelector:key=>fields[key]},form={dataset:{form:'sale'},elements:{order:{value:'day-order'}},querySelectorAll:()=>[row],addEventListener(){}};
  ctx.modal={querySelector:()=>form};globalThis.document={querySelector:()=>({textContent:''})};
  assert.equal(bindSaleForm()(),10000);assert.match(fields['.sale-line-total'].textContent,/¥100/);
 }finally{Object.assign(ctx,saved);if(savedWindow===undefined)delete globalThis.window;else globalThis.window=savedWindow;if(savedDocument===undefined)delete globalThis.document;else globalThis.document=savedDocument;}
});
