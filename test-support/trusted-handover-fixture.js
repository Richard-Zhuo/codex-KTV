import { initialState, transact } from '../rules.js';
import { createMemoryLedgerStore } from '../ledger/memory-store.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { revalidateSessionInTransaction } from '../auth/session-revalidation.js';

export const handoverCommand=(key='handover',revision=0,actualCash=50000,changes={})=>({operationKey:key,expectedRevision:revision,action:'handover',payload:{actualCash,...changes}});
export const drawerPay=(order='drawer-1',key='pay',revision=1,method='现金')=>({operationKey:key,expectedRevision:revision,action:'pay',payload:{order,payments:[{method,amount:10000}]}});
export function seedHandover(state){
 state.orders.push({id:'legacy-payment',kind:'retail',room:null,payments:[{method:'现金',amount:90000,time:'1900-01-01'}],sales:[]});
 for(let i=1;i<=3;i++){
  const room=state.rooms[i-1];room.status='营业中';room.order='drawer-'+i;
  state.orders.push({id:room.order,kind:'room',room:room.id,status:'营业中',base:10000,gift:0,time:'2026-01-01T20:00:00Z',
   payments:[],sales:[],otherCharges:[],giftRequests:[],rounding:0,roundingReview:null});
 }
 state.handovers.push({id:123,person:'Historical demo name',time:'2099-01-01',expected:999999,actual:999999,drawerCash:1});
}
export function handoverFixture({permissions=['handover','payment.settle','payment.collect','deposit.manage','expense.create','procurement.create'],prepare=()=>{},execute=transact,bind=true}={}){
 const state=initialState();state.user='unmapped-demo';state.clock='invalid-demo';state.administrator=true;
 state.permissions={administrator:['*']};state.capabilities={administrator:['*']};seedHandover(state);prepare(state);
 const memory=createMemoryLedgerStore(state,{ledgerId:'handover-unit'}),digest=Buffer.alloc(32,31);
 const auth={id:'synthetic-handover-actor',permissions,enabled:true,revoked:false,version:1,sessionVersion:1,
  idle:'2099-01-01T00:00:00.000000Z',absolute:'2099-01-02T00:00:00.000000Z'};
 let dbNow='2026-10-05T03:00:00.123456Z',context,executions=0;
 const port={locateSessionByDigest:async()=>({principalId:auth.id,sessionId:'synthetic-handover-session'}),
  lockAccount:async()=>({principalId:auth.id,enabled:auth.enabled,credentialVersion:auth.version,policyAttributesConfigured:false}),
  lockSessionById:async()=>({principalId:auth.id,sessionId:'synthetic-handover-session',tokenDigest:digest,revoked:auth.revoked,
   credentialVersion:auth.sessionVersion,idleExpiresAt:auth.idle,absoluteExpiresAt:auth.absolute}),
  listGrants:async()=>auth.permissions,listPolicyAttributes:async()=>[],readDbNow:async()=>dbNow};
 const store={ledgerId:memory.ledgerId,runAtomic:work=>memory.runAtomic(tx=>{
  if(bind)tx.sessionRevalidation={revalidateSessionInTransaction:c=>revalidateSessionInTransaction({port,...c})};return work(tx);
 })};
 const app=createTrustedLedgerApplication({store,transactCommand:(...args)=>{context=args[4].context;executions++;return execute(...args);}});
 return {state,memory,app,auth,credential:{tokenDigest:digest},context:()=>context,executions:()=>executions,setClock:value=>{dbNow=value;}};
}
