import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { transact } from '../rules.js';
import { total } from '../sales.js';
import { AuthorizationDenied } from '../shared/identity.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createMySqlEmployeeStore } from '../employees/mysql-store.js';
import { SALES_TEST_ACTIONS, seedFixedPriceSalesState as seedTrustedSalesState, salesCommand, soldOrder } from '../test-support/trusted-sales-fixture.js';

// Shares the existing guarded ten-table fixture; owns no DDL/cleanup lifecycle.
export async function testTrustedSales({t,pool,setup,auth,table,provision,seed,inspect,application,roster,
  assertUnchanged,wrapConnection,poolOptions,database}) {
  const grants=action=>action==='sale'?['staff.record']:['retail.sale','staff.record'];
  const denied=e=>e instanceof AuthorizationDenied&&e.status==='authorization-denied';
  const createEmployee=login=>roster.createEmployee({displayName:'Synthetic Sales Employee'},{actorPrincipalId:login.principalId});
  const sqlAt=(run,name,clause)=>run.calls.findIndex(c=>c.kind==='sql'&&c.sql.includes(name)&&
    (clause.startsWith('FOR ')?c.sql.endsWith(clause):c.sql.startsWith(clause+' ')));

  for(const action of SALES_TEST_ACTIONS) {
    await t.test(action+': same-connection employee/actor/time, snapshots, stock and audit commit together',async()=>{
      const login=await provision(grants(action)),employee=await createEmployee(login),id='sales-first-'+action;
      assert.equal(employee.principalId,null);assert.notEqual(employee.employeeId,login.principalId);
      const original=await seed(id,seedTrustedSalesState),connection=await pool.getConnection();let borrows=0;
      const [[activity]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);
      try {
        const run=application(id,{connectionPool:{getConnection:async()=>{borrows++;return wrapConnection(connection,[],false);}}});
        const cmd=salesCommand(action,employee.employeeId,'first',0,{actorId:'administrator',principalId:'forged',user:'administrator',
          permissions:['*','staff.record','retail.sale'],role:'administrator',clock:'1900-01-01',person:'forged',recordedBy:'forged',
          actualActorPrincipalId:'forged',creditedEmployeeNameSnapshot:'forged'});
        if(action==='retailSale')for(const payment of cmd.payload.payments)Object.assign(payment,{person:'forged',time:'1900-01-01',actualActorPrincipalId:'forged'});
        const result=await run.app.execute(cmd,login.credential),actual=await inspect(id),order=soldOrder(actual.head.state,action),lines=order.sales.slice(-2);
        assert.equal(result.status,'committed');assert.equal(result.actorId,login.principalId);assert.equal(actual.head.revision,1);assert.equal(run.executions(),1);
        for(const line of lines){assert.equal(line.actualActorPrincipalId,login.principalId);assert.equal(line.recordedBy,login.principalId);
          assert.equal(line.creditedEmployeeId,employee.employeeId);assert.equal(line.employeeId,employee.employeeId);
          assert.equal(line.person,employee.displayName);assert.equal(line.creditedEmployeeNameSnapshot,employee.displayName);assert.equal(line.time,run.context().dbNow);}
        assert.deepEqual(lines.map(l=>[l.productId,l.saleOptionId,l.saleQuantity,l.baseQuantityPerSaleUnit,l.totalBaseQuantity,l.pricePerSaleUnitCents,l.amountCents]),
          [['bw','half',1,6,6,5900,5900],['water','single',2,1,2,200,400]]);
        assert.equal(actual.head.state.inventory.bw.count,94);assert.equal(actual.head.state.inventory.water.count,98);
        assert.equal(actual.head.state.inventory.qd.count,null);assert.equal(actual.head.state.inventory.xl.count,0);
        assert.deepEqual(actual.head.state.orders[0],original.orders[0]);assert.deepEqual(actual.head.state.rooms,original.rooms);
        assert.deepEqual(actual.head.state.ledger.map(l=>[l.baseQuantityDelta,l.counted]),[[-6,true],[-2,true]]);
        for(const row of actual.head.state.ledger){assert.equal(row.actualActorPrincipalId,login.principalId);assert.equal(row.person,login.principalId);
          assert.equal(row.time,run.context().dbNow);assert.equal(row.orderId,order.id);assert.ok(lines.some(l=>l.id===row.saleLineId));}
        if(action==='sale'){assert.equal(order.kind,'room');assert.equal(order.room,'V01');assert.equal(order.status,'营业中');assert.equal(total(order),42300);
          assert.deepEqual(order.sales[0],original.orders[1].sales[0]);assert.deepEqual(order.payments,original.orders[1].payments);}
        else {assert.equal(order.kind,'retail');assert.equal(order.room,null);assert.equal(order.status,'已结账');assert.equal(total(order),6300);
          assert.equal(order.actualActorPrincipalId,login.principalId);assert.equal(order.creditedEmployeeId,employee.employeeId);
          assert.equal(order.createdAt,run.context().dbNow);assert.equal(order.paidAt,order.createdAt);assert.equal(order.closedAt,order.createdAt);
          assert.deepEqual(order.payments.map(p=>[p.method,p.amount,p.chargeId]),[['微信',3000,'retail'],['现金',3300,'retail']]);
          assert.ok(order.payments.every(p=>p.person===login.principalId&&p.time===run.context().dbNow&&p.actualActorPrincipalId===login.principalId));
          assert.deepEqual(actual.head.state.orders[1],original.orders[1]);}
        assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
        assert.equal(actual.operations[0].actor_principal_id,login.principalId);assert.deepEqual(actual.operations[0].terminal_result,result);
        assert.equal(actual.audit[0].actor_principal_id,login.principalId);assert.equal(actual.audit[0].action,action);
        const sequence=[run.calls.findIndex(c=>c.kind==='begin'),sqlAt(run,'ledger_heads','FOR UPDATE'),
          sqlAt(run,'auth_accounts','FOR UPDATE'),sqlAt(run,'auth_sessions','FOR UPDATE'),sqlAt(run,'auth_grants','FOR UPDATE'),
          sqlAt(run,'AS db_now','SELECT'),sqlAt(run,'ledger_operations','SELECT'),sqlAt(run,table('employees'),'FOR SHARE'),
          run.calls.findIndex(c=>c.kind==='transact'),sqlAt(run,'ledger_heads','UPDATE'),sqlAt(run,'ledger_operations','INSERT'),
          sqlAt(run,'ledger_success_audit','INSERT'),run.calls.findIndex(c=>c.kind==='commit')];
        assert.ok(sequence.every(i=>i>=0));assert.deepEqual(sequence,[...sequence].sort((a,b)=>a-b));assert.equal(borrows,1);
        assert.equal(run.calls.filter(c=>c.kind==='begin').length,1);assert.equal(run.calls.filter(c=>c.kind==='commit').length,1);
        assert.equal(run.calls.filter(c=>c.kind==='db-now').length,1);assert.equal(run.context().dbNow,run.calls.find(c=>c.kind==='db-now').value);
        const [[after]]=await pool.execute('SELECT last_seen_at,idle_expires_at FROM '+table('auth_sessions')+' WHERE session_id=?',[login.sessionId]);assert.deepEqual(after,activity);
      } finally {await connection.rollback();connection.release();}
    });

    await t.test(action+': same-name UUIDs and employee linked to another disabled principal remain independent attribution',async()=>{
      const login=await provision(grants(action)),other=await provision([]),a=await createEmployee(login),b=await createEmployee(login),id='sales-names-'+action;
      await roster.linkPrincipal({employeeId:b.employeeId,principalId:other.principalId},{actorPrincipalId:login.principalId});
      await auth.disableAccount({principalId:other.principalId});await seed(id,seedTrustedSalesState);const run=application(id);
      assert.equal((await run.app.execute(salesCommand(action,a.employeeId,'a'),login.credential)).status,'committed');
      const alias=salesCommand(action,b.employeeId,'b',1);alias.payload.employee=b.employeeId;delete alias.payload.creditedEmployeeId;
      assert.equal((await run.app.execute(alias,login.credential)).status,'committed');const {head}=await inspect(id);
      const lines=action==='sale'?head.state.orders[1].sales.slice(1):head.state.orders.slice(2).flatMap(o=>o.sales);
      assert.deepEqual(lines.map(l=>l.creditedEmployeeId),[a.employeeId,a.employeeId,b.employeeId,b.employeeId]);
      assert.ok(lines.every(l=>l.person===a.displayName&&l.actualActorPrincipalId===login.principalId));
    });

    await t.test(action+': no actor grant from employee/demo/payload; authorization denial never consumes key',async()=>{
      const insufficient=action==='sale'?[['order.sale','backend.view']]:[['retail.sale'],['staff.record']];
      for(let i=0;i<insufficient.length;i++){
        const login=await provision(insufficient[i]),other=await provision(grants(action)),employee=await createEmployee(login),id='sales-denied-'+action+i;
        await roster.linkPrincipal({employeeId:employee.employeeId,principalId:other.principalId},{actorPrincipalId:login.principalId});
        await seed(id,s=>{seedTrustedSalesState(s);s.user='administrator';s.clock='2099-01-01';s.permissions={administrator:['管理员']};});
        const before=await inspect(id),run=application(id),cmd=salesCommand(action,employee.employeeId,'denied',0,
          {permissions:grants(action),role:'administrator',principalId:other.principalId,actorId:other.principalId});
        await assert.rejects(run.app.execute(cmd,login.credential),denied);await assertUnchanged(id,before);assert.equal(run.executions(),0);
        assert.equal(sqlAt(run,table('employees'),'FOR SHARE'),-1);
        for(const permissionId of grants(action))await auth.grantPermission({principalId:login.principalId,permissionId});
        assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const actual=await inspect(id);
        assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);assert.equal(actual.head.revision,1);
        assert.equal(actual.operations[0].actor_principal_id,login.principalId);
      }
    });

    await t.test(action+': disabled/unknown/invalid employee produces terminal rejection without state or inventory effects',async()=>{
      const login=await provision([...new Set([...grants(action),'order.sale'])]),employee=await createEmployee(login);
      for(const invalid of ['disabled','unknown','legacy','missing','alias-conflict']){
        const id='sales-employee-'+action+'-'+invalid;
        if(invalid==='disabled')await roster.disableEmployee({employeeId:employee.employeeId},{actorPrincipalId:login.principalId});
        const original=await seed(id,seedTrustedSalesState),run=application(id),cmd=salesCommand(action,employee.employeeId,'reject');
        if(invalid==='unknown')cmd.payload.creditedEmployeeId=randomUUID();if(invalid==='legacy')cmd.payload.creditedEmployeeId='staff';
        if(invalid==='missing')delete cmd.payload.creditedEmployeeId;if(invalid==='alias-conflict')cmd.payload.employee=randomUUID();
        const result=await run.app.execute(cmd,login.credential);assert.equal(result.status,'business-rejected');const actual=await inspect(id);
        assert.deepEqual(actual.head.state,original);assert.equal(actual.head.revision,0);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,0);
        assert.equal(run.executions(),0);assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,actual);
      }
    });

    await t.test(action+': revoke, rename/disable employee, reconnect replay exact terminal without duplicate stock/payments',async()=>{
      const login=await provision(grants(action)),employee=await createEmployee(login),id='sales-replay-'+action;await seed(id,seedTrustedSalesState);
      const run=application(id),cmd=salesCommand(action,employee.employeeId,'original'),first=await run.app.execute(cmd,login.credential),before=await inspect(id);
      await pool.execute('UPDATE '+table('employees')+' SET display_name=?,updated_at=UTC_TIMESTAMP(6) WHERE employee_id=?',['Changed Name',employee.employeeId]);
      await roster.disableEmployee({employeeId:employee.employeeId},{actorPrincipalId:login.principalId});
      for(const permissionId of grants(action))await auth.revokePermission({principalId:login.principalId,permissionId});
      const reconnect=mysql.createPool(poolOptions);
      try {const again=application(id,{connectionPool:reconnect,bind:createMySqlAuthStore({pool:reconnect,database}).bindSessionRevalidation,employeeBind:null});
        assert.deepEqual(await again.app.execute(cmd,login.credential),first);assert.equal(again.executions(),0);assert.equal(sqlAt(again,table('employees'),'FOR SHARE'),-1);
        await assert.rejects(again.app.execute({...cmd,operationKey:'new',expectedRevision:1},login.credential),denied);await assertUnchanged(id,before);
      } finally {await reconnect.end();}
    });

    await t.test(action+': disabled/revoked/idle/absolute/credential invalidation blocks receipt access',async()=>{
      for(const invalid of ['disabled','revoked','idle','absolute','credential']){
        const login=await provision(grants(action)),employee=await createEmployee(login),id='sales-auth-'+action+'-'+invalid;await seed(id,seedTrustedSalesState);
        const run=application(id),cmd=salesCommand(action,employee.employeeId,'private');await run.app.execute(cmd,login.credential);const before=await inspect(id);
        if(invalid==='disabled')await auth.disableAccount({principalId:login.principalId});
        else if(invalid==='revoked')assert.equal(await auth.logout(login.token),true);
        else if(invalid==='credential')await auth.rotateCredential({principalId:login.principalId,password:'synthetic-sales-rotation'});
        else if(invalid==='idle')await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at WHERE session_id=?',[login.sessionId]);
        else await pool.execute('UPDATE '+table('auth_sessions')+' SET idle_expires_at=created_at,absolute_expires_at=created_at+INTERVAL 1 MICROSECOND WHERE session_id=?',[login.sessionId]);
        run.calls.length=0;await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='AUTHENTICATION_REQUIRED');await assertUnchanged(id,before);
        assert.equal(sqlAt(run,'ledger_operations','SELECT'),-1);assert.equal(sqlAt(run,table('employees'),'FOR SHARE'),-1);
      }
    });

    await t.test(action+': original actor/payload/revision conflicts precede revoked permission or employee lookup',async()=>{
      const login=await provision(grants(action)),other=await provision([]),employee=await createEmployee(login),id='sales-conflicts-'+action;await seed(id,seedTrustedSalesState);
      const run=application(id),cmd=salesCommand(action,employee.employeeId,'same');await run.app.execute(cmd,login.credential);const before=await inspect(id);
      for(const permissionId of grants(action))await auth.revokePermission({principalId:login.principalId,permissionId});
      assert.equal((await run.app.execute(cmd,other.credential)).reason,'actor-mismatch');
      for(const change of [{...cmd,expectedRevision:1},{...cmd,payload:{...cmd.payload,creditedEmployeeId:randomUUID()}},
        {...cmd,payload:{...cmd.payload,items:[{product:'bw',spec:'half',count:2}]}},{...cmd,action:'open'}])assert.equal((await run.app.execute(change,login.credential)).reason,'request-mismatch');
      assert.equal(run.executions(),1);await assertUnchanged(id,before);
    });

    await t.test(action+': stale revision remains terminal before employee resolution',async()=>{
      const login=await provision(grants(action)),id='sales-stale-'+action;await seed(id,seedTrustedSalesState);const run=application(id),cmd=salesCommand(action,randomUUID(),'stale',99);
      const result=await run.app.execute(cmd,login.credential);assert.equal(result.status,'revision-conflict');assert.equal(run.executions(),0);
      assert.equal(sqlAt(run,table('employees'),'FOR SHARE'),-1);const before=await inspect(id);assert.equal(before.head.revision,0);assert.equal(before.audit.length,0);
      for(const permissionId of grants(action))await auth.revokePermission({principalId:login.principalId,permissionId});
      assert.deepEqual(await run.app.execute(cmd,login.credential),result);await assertUnchanged(id,before);
    });

    await t.test(action+': original amount/product/stock/order/payment rejection keeps sales and inventory wholly unchanged',async()=>{
      const login=await provision(grants(action)),employee=await createEmployee(login);
      const cases=[['null',s=>s.inventory.bw.count=null,{},/未建账/],['zero',s=>s.inventory.bw.count=0,{},/库存不足/],
        ['aggregate',s=>s.inventory.bw.count=7,{items:[{product:'bw',spec:'half',count:1},{product:'bw',spec:'half',count:1}]},/库存不足/],
        ['inactive',s=>s.catalog.products.find(p=>p.id==='water').active=false,{},/不可销售/],
        ['quantity',()=>{},{items:[{product:'bw',spec:'single',count:0}]},/数量/],
        ['price',s=>s.catalog.products.find(p=>p.id==='bw').saleOptions.find(o=>o.id==='half').priceCents=0,{},/价格/]];
      if(action==='sale')cases.push(['closed',s=>s.orders[1].status='已结账',{},/账单已变化/]);
      else cases.push(['payment-amount',()=>{},{payments:[{method:'现金',amount:1}]},/之和必须等于/],['payment-method',()=>{},{payments:[{method:'invalid',amount:6300}]},/收款方式/]);
      for(const [label,prepare,changes,message]of cases){const id='sales-domain-'+action+'-'+label;const original=await seed(id,s=>{seedTrustedSalesState(s);prepare(s);});
        const run=application(id),result=await run.app.execute(salesCommand(action,employee.employeeId,'rejected',0,changes),login.credential);assert.equal(result.status,'business-rejected');assert.match(result.reason,message);
        const actual=await inspect(id);assert.deepEqual(actual.head.state,original);assert.equal(actual.head.revision,0);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,0);}
    });

    await t.test(action+': missing resolver and real employee SELECT failure roll back without consuming operation key',async()=>{
      const login=await provision(grants(action)),employee=await createEmployee(login),id='sales-resolver-fault-'+action;await seed(id,seedTrustedSalesState);
      const before=await inspect(id),cmd=salesCommand(action,employee.employeeId,'retry'),missing=application(id,{employeeBind:null});
      await assert.rejects(missing.app.execute(cmd,login.credential),TypeError);await assertUnchanged(id,before);
      const store=createMySqlEmployeeStore({pool,database});
      const bind=connection=>store.bindEmployeeResolver({query:(...args)=>connection.query(...args),execute:(sql,values)=>connection.execute(
        sql.startsWith('SELECT employee_id, display_name, enabled')?sql.replace('employee_id,','missing_sales_column,'):sql,values)});
      const failure=application(id,{employeeBind:bind});await assert.rejects(failure.app.execute(cmd,login.credential),e=>e.code==='ER_BAD_FIELD_ERROR');
      assert.ok(failure.calls.some(c=>c.kind==='rollback'));await assertUnchanged(id,before);
      assert.equal((await application(id).app.execute(cmd,login.credential)).status,'committed');
    });

    await t.test(action+': program exception after sale/inventory/payment mutation rolls back and repaired original key succeeds',async()=>{
      const login=await provision(grants(action)),employee=await createEmployee(login),id='sales-domain-fault-'+action;await seed(id,seedTrustedSalesState);
      const before=await inspect(id),cmd=salesCommand(action,employee.employeeId,'retry');let fail=true;
      const run=application(id,{transactCommand:(...args)=>{const next=transact(...args);if(fail)throw Error('synthetic sales unknown fault');return next;}});
      await assert.rejects(run.app.execute(cmd,login.credential),/synthetic sales unknown fault/);await assertUnchanged(id,before);
      assert.ok(run.calls.some(c=>c.kind==='rollback'));fail=false;assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');
    });

    await t.test(action+': SQL failure after state and operation writes rolls back state/revision/result/audit and all sales effects',async()=>{
      const login=await provision(grants(action)),employee=await createEmployee(login),id='sales-sql-fault-'+action;await seed(id,seedTrustedSalesState);
      const before=await inspect(id),key='sales-sql-after-state-'+action,cmd=salesCommand(action,employee.employeeId,key),run=application(id);
      await setup.query('ALTER TABLE '+table('ledger_success_audit')+" ADD CONSTRAINT trusted_sales_fault CHECK (operation_key <> '"+key+"')");
      try {await assert.rejects(run.app.execute(cmd,login.credential),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
        assert.ok(sqlAt(run,'ledger_heads','UPDATE')>=0);assert.ok(sqlAt(run,'ledger_operations','INSERT')>=0);assert.ok(run.calls.some(c=>c.kind==='rollback'));
        await assertUnchanged(id,before);
      } finally {await setup.query('ALTER TABLE '+table('ledger_success_audit')+' DROP CHECK trusted_sales_fault');}
      assert.equal((await run.app.execute(cmd,login.credential)).status,'committed');const actual=await inspect(id);
      assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,1);assert.equal(actual.audit.length,1);
      assert.equal(actual.head.state.inventory.bw.count,94);assert.equal(actual.head.state.ledger.length,2);
      if(action==='retailSale')assert.equal(soldOrder(actual.head.state,action).payments.length,2);
    });

    await t.test(action+': two independent InnoDB connections commit at most once for old revision and same-key retry',async()=>{
      const login=await provision(grants(action)),employee=await createEmployee(login),a=await pool.getConnection(),b=await pool.getConnection();
      try {const [[aId]]=await a.query('SELECT CONNECTION_ID() AS id'),[[bId]]=await b.query('SELECT CONNECTION_ID() AS id');assert.notEqual(aId.id,bId.id);
        const aPool={getConnection:async()=>wrapConnection(a,[],false)},bPool={getConnection:async()=>wrapConnection(b,[],false)};
        const id='sales-race-'+action;await seed(id,seedTrustedSalesState);const first=application(id,{connectionPool:aPool}),second=application(id,{connectionPool:bPool});
        const results=await Promise.all([first.app.execute(salesCommand(action,employee.employeeId,'a'),login.credential),second.app.execute(salesCommand(action,employee.employeeId,'b'),login.credential)]);
        assert.deepEqual(results.map(r=>r.status).sort(),['committed','revision-conflict']);const actual=await inspect(id);
        assert.equal(actual.head.revision,1);assert.equal(actual.operations.length,2);assert.equal(actual.audit.length,1);
        assert.equal(actual.head.state.inventory.bw.count,94);assert.equal(actual.head.state.ledger.length,2);assert.equal(first.executions()+second.executions(),1);
        const sameId='sales-same-key-'+action;await seed(sameId,seedTrustedSalesState);const retryA=application(sameId,{connectionPool:aPool}),retryB=application(sameId,{connectionPool:bPool}),cmd=salesCommand(action,employee.employeeId,'same');
        const repeated=await Promise.all([retryA.app.execute(cmd,login.credential),retryB.app.execute(cmd,login.credential)]);assert.deepEqual(repeated[0],repeated[1]);assert.equal(repeated[0].status,'committed');
        assert.equal(retryA.executions()+retryB.executions(),1);const saved=await inspect(sameId);assert.equal(saved.head.revision,1);assert.equal(saved.operations.length,1);assert.equal(saved.audit.length,1);
        assert.equal(saved.head.state.inventory.bw.count,94);assert.equal(saved.head.state.ledger.length,2);
        if(action==='retailSale'){assert.equal(saved.head.state.orders.filter(o=>o.actualActorPrincipalId===login.principalId).length,1);assert.equal(soldOrder(saved.head.state,action).payments.length,2);}
        t.diagnostic(action+' races verified two independent CONNECTION_ID values');
      } finally {try {await a.rollback();await b.rollback();}finally{a.release();b.release();}}
    });
  }
}
