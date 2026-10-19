import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../rules.js';

const previousWindow=globalThis.window;
globalThis.window??={addEventListener(){}};
const {ctx}=await import('./context.js');
const {taskCenterPage}=await import('./pages/tasks.js');
if(previousWindow===undefined)delete globalThis.window;

const request=(id,changes={})=>({requestId:id,kind:'CASH_OUT',status:'\u5f85\u5ba1\u6838',amount:100,
 reason:'Count test',submittedByPrincipalId:'applicant',submittedByDisplayName:'Applicant',
 submittedAt:'2026-10-20T00:00:00Z',canApprove:true,canReject:true,canExecute:false,...changes});
function setup(requests=[]){
 ctx.state=initialState();ctx.state.user='reviewer';ctx.state.orders=[];ctx.state.expenses=[];ctx.state.incidents=[];
 ctx.state.roomIssueReviews=[];ctx.state.inventoryReviews=[];
 ctx.formal={session:{principalId:'reviewer',permissionIds:['financial.approve']},reviewSections:[],
 workspace:{financial:{requests,capabilities:{},orders:[],payments:[],results:[],drawer:null}}};
}
function count(){
 const html=taskCenterPage(),match=html.match(/<strong>(\d+)<\/strong><span>\u5f85\u5ba1\u6838\u4e8b\u9879<\/span>/u);
 assert.ok(match,'task header renders a pending-review count');return Number(match[1]);
}
test('C3B-P2-01: task header follows zero, one and two authorized pending financial requests',()=>{
 const oldState=ctx.state,oldFormal=ctx.formal;
 try {setup();assert.equal(count(),0);
 ctx.formal.workspace.financial.requests=[request('one')];assert.equal(count(),1);
 ctx.formal.workspace.financial.requests.push(request('two'));assert.equal(count(),2);
 }finally{ctx.state=oldState;ctx.formal=oldFormal;}
});

test('C3B-P2-01: repeated financial references count once; own, unauthorized and terminal requests do not count',()=>{
 const oldState=ctx.state,oldFormal=ctx.formal;
 try {setup([request('same'),request('same'),request('own',{submittedByPrincipalId:'reviewer',canApprove:false,canReject:false}),
 request('denied',{canApprove:false,canReject:false}),request('approved',{status:'\u5df2\u6279\u51c6'}),
 request('rejected',{status:'\u5df2\u9a73\u56de'}),request('executed',{status:'\u5df2\u6267\u884c'})]);
 assert.equal(count(),1);
 }finally{ctx.state=oldState;ctx.formal=oldFormal;}
});
test('C3B-P2-01: existing authorized business reviews and financial reviews add without losing either',()=>{
 const oldState=ctx.state,oldFormal=ctx.formal;
 try {setup([request('one'),request('two')]);
 ctx.formal.reviewSections=['expense.approve'];ctx.formal.session.permissionIds.push('expense.approve');
 ctx.state.expenses=[{id:'expense-one',status:'\u5f85\u8001\u677f\u5ba1\u6279',amount:60000,description:'Existing expense',
 person:'Applicant',date:'2026-10-20',method:'\u5fae\u4fe1'}];
 assert.equal(count(),3);ctx.formal.workspace.financial.requests=[];assert.equal(count(),1);
 }finally{ctx.state=oldState;ctx.formal=oldFormal;}
});
test('C3B-P2-01: decision and refreshed permission projections update the heading immediately',()=>{
 const oldState=ctx.state,oldFormal=ctx.formal;
 try {setup([request('one'),request('two')]);assert.equal(count(),2);
 ctx.formal.workspace.financial.requests[0]={...request('one'),status:'\u5df2\u6279\u51c6',canApprove:false,canReject:false};
 assert.equal(count(),1);
 ctx.formal.workspace.financial.requests[1]={...request('two'),status:'\u5df2\u9a73\u56de',canApprove:false,canReject:false};
 assert.equal(count(),0);
 ctx.formal.workspace.financial.requests=[request('fresh')];assert.equal(count(),1);
 ctx.formal.session.permissionIds=[];delete ctx.formal.workspace.financial;assert.equal(count(),0);
 }finally{ctx.state=oldState;ctx.formal=oldFormal;}
});
