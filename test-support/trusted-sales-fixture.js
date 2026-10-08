// Synthetic business state shared by unit and guarded MySQL sales tests.
export const SALES_TEST_ACTIONS = Object.freeze(['sale', 'retailSale']);
export function seedTrustedSalesState(state) {
  state.rooms[0].status = '营业中'; state.rooms[0].order = 'synthetic-room';
  state.inventory.bw.count = 100; state.inventory.water.count = 100; state.inventory.xl.count = 0;
  state.catalog.products.push({id:'synthetic_service',name:'Synthetic Service',category:'service',baseUnit:'unit',
    saleOptions:[{id:'single',name:'One service',baseQuantity:1,priceCents:250}],
    inventoryManaged:false,sellable:true,manualPriceAllowed:false,active:true,sortOrder:900});
  state.orders.push({id:'synthetic-room',kind:'room',room:'V01',status:'营业中',time:'2026-01-01T12:00:00.000000Z',
    packageBaseCents:29000,packageGiftValueCents:0,person:'Historical Employee',recordedBy:'Historical Recorder',
    sales:[{id:9001,batch:9000,product:'bw',productId:'bw',productNameSnapshot:'Historical Beer',
      saleOptionNameSnapshot:'Historical Dozen',saleQuantity:1,baseQuantityPerSaleUnit:12,totalBaseQuantity:12,
      pricePerSaleUnitCents:null,amountCents:7000,person:'Historical Employee'}],
    payments:[{method:'现金',amount:100},{method:'微信',amount:200}],otherCharges:[],credit:null});
}
// Legacy transaction/locking tests assert fixed 5900-cent half-dozen payments.
// Explicit OTHER test classification removes their DB wall-clock dependence.
// Dedicated DAY/NIGHT tests retain the ordinary beer classification.
export function seedFixedPriceSalesState(state) {
  seedTrustedSalesState(state);
  state.catalog.products.find(p=>p.id==='bw').priceCategory='OTHER';
}
export function salesPayload(action, employeeId, changes = {}) {
  return {creditedEmployeeId:employeeId,...(action==='sale'?{order:'synthetic-room'}:{}),
    items:[{product:'bw',spec:'half',count:1},{product:'water',spec:'single',count:2}],
    ...(action==='retailSale'?{payments:[{method:'微信',amount:3000},{method:'现金',amount:3300}]}:{}),...changes};
}
export function salesCommand(action, employeeId, key='first', revision=0, changes={}) {
  return {operationKey:key,expectedRevision:revision,action,payload:salesPayload(action,employeeId,changes)};
}
export function soldOrder(state, action) {
  return action==='sale'?state.orders.find(order=>order.id==='synthetic-room'):state.orders.at(-1);
}
