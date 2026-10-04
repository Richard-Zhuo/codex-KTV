// Synthetic credit request and historical order facts; no employee attribution.
export const creditCommand = (key='first',revision=0,changes={}) => ({
  operationKey:key,expectedRevision:revision,action:'credit',
  payload:{order:'synthetic-credit-order',phone:'13800000000',name:'  Synthetic Customer  ',
    note:'  Synthetic credit note  ',signature:'data:image/png;base64,'+'s'.repeat(100),...changes}
});
export const creditOrder = state => state.orders.find(order=>order.id==='synthetic-credit-order');
export function seedTrustedCredit(state) {
  state.serial=1000;state.inventory.qd.count=null;state.inventory.bw.count=0;
  state.rooms[0].status='营业中';state.rooms[0].order='synthetic-credit-order';
  state.orders.push({id:'synthetic-credit-order',kind:'room',room:state.rooms[0].id,status:'营业中',
    time:'2026-01-01T12:00:00Z',packageBaseCents:90000,packageGiftValueCents:10000,
    openedBy:'Historical Opener',person:'Historical Employee',recordedBy:'Historical Recorder',openSource:'员工代订',
    reservedBy:'Historical Booker',reservationSource:'员工预订',
    sales:[{id:901,productId:'bw',productNameSnapshot:'Historical Beer',saleOptionNameSnapshot:'Historical Dozen',
      saleQuantity:1,baseQuantityPerSaleUnit:12,totalBaseQuantity:12,pricePerSaleUnitCents:null,amountCents:7000}],
    otherCharges:[{id:902,amount:500,description:'Historical charge'}],
    payments:[{amount:1000,method:'现金'},{amount:2000,method:'微信'}],
    giftRequests:[],credit:null,creditHistory:[{amount:123,person:'Legacy applicant',submittedById:'legacy',decisionStatus:'已驳回'}]});
}
