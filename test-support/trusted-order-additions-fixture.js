// Synthetic room facts; these two commands have no credited employee input.
export const ORDER_ADDITION_TEST_ACTIONS = Object.freeze(['serveExtra', 'otherCharge']);
export const orderAdditionPermission = action => action === 'serveExtra' ? 'order.serveExtra' : 'order.sale';
export function seedOrderAdditions(state) {
  state.rooms[0].status = '营业中'; state.rooms[0].order = 'synthetic-room';
  state.inventory.bw.count = 0; state.inventory.qd.count = null;
  state.ledger.push({id:900,product:'qd',delta:-2,counted:false,person:'Historical Actor',time:'2026-01-01T12:00:00Z'});
  state.orders.push({id:'synthetic-room',kind:'room',room:'V01',status:'营业中',time:'2026-01-01T12:00:00Z',
    packageBaseCents:29000,packageGiftValueCents:0,packageNameSnapshot:'Historical Package',
    person:'Historical Employee',recordedBy:'Historical Actor',
    sales:[{id:910,productId:'bw',productNameSnapshot:'Historical Beer',saleOptionNameSnapshot:'Historical Dozen',
      pricePerSaleUnitCents:null,baseQuantityPerSaleUnit:12,totalBaseQuantity:12,amountCents:7000}],
    otherCharges:[{id:920,batch:919,category:'其他',item:'Historical Charge',amount:300,person:'Historical Actor',time:'2026-01-01T12:00:00Z'}],
    extras:[{product:'water',productId:'water',count:2,productNameSnapshot:'Historical Water',baseUnitSnapshot:'瓶',referenceValueCents:null,served:false},
      {product:'removed-extra',count:1,productNameSnapshot:null,served:false},
      {product:'already-served',count:1,productNameSnapshot:'Historical Served',served:true,servedBy:'Historical Actor'}],
    resolvedComponents:[{productId:'water',productNameSnapshot:'Historical Water',baseUnitSnapshot:'瓶',totalBaseQuantity:2}],
    payments:[{method:'现金',amount:100},{method:'微信',amount:200}],credit:null});
}
export function orderAdditionCommand(action,key='first',revision=0,changes={}) {
  return {operationKey:key,expectedRevision:revision,action,payload:{order:'synthetic-room',
    ...(action==='serveExtra'?{product:'water'}:{category:'其他',item:'  Synthetic Room Service  ',amount:8800}),...changes}};
}
export const additionOrder = state => state.orders.find(order=>order.id==='synthetic-room');
