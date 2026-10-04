import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createEmployeeService } from './service.js';
import { createMySqlEmployeeStore } from './mysql-store.js';
import { EmployeeRosterError } from './errors.js';
import { runEmployeeResolverIntegrationTests } from './employee-resolver.integration.js';
import { runPrincipalEmployeeResolverIntegrationTests } from './principal-employee-resolver.integration.js';
import { applyPolicyAttributeMigration, policyAttributeTables } from '../test-support/mysql-policy-attributes-fixture.js';
import { acquireMySqlFixtureLock } from '../test-support/mysql-fixture-lock.js';
import { createAuthService } from '../auth/service.js';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';

const testUrl = process.env.LEDGER_MYSQL_TEST_URL;
const database = 'jbhh_ktv_test';
const authTables = ['auth_accounts','auth_credentials','auth_grants','auth_sessions','auth_events'];
const employeeTables = ['employees','employee_events'];
const tables = [...authTables, ...employeeTables, ...policyAttributeTables];
const quote = String.fromCharCode(96);
const table = name => quote + database + quote + '.' + quote + name + quote;
const isCode = code => error => error instanceof EmployeeRosterError && error.code === code;
function assertDedicatedTestTarget(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'mysql:' || decodeURIComponent(url.pathname.slice(1)) !== database ||
      !url.hostname || raw === process.env.DATABASE_URL) throw Error('employee 测试必须使用 jbhh_ktv_test');
}
function ownedPool(connection, calls, { failEvent = null, failAfterAudit = false, onLocator = null } = {}) {
  let located = false;
  return { getConnection: async () => ({
    async query(sql, params) { calls.push(['query',sql]); return connection.query(sql,params); },
    async execute(sql, params) {
      const audit = sql.startsWith('INSERT INTO ') && sql.includes('employee_events');
      const actual = audit && params[2] === failEvent ? sql.replace('(employee_id,', '(missing_employee_test_column,') : sql;
      calls.push(['sql',actual,params]);
      const result = await connection.execute(actual,params);
      if (audit && failAfterAudit) throw Error('synthetic unknown failure after audit insert');
      if (onLocator && !located && sql.startsWith('SELECT employee_id') && !sql.endsWith('FOR UPDATE')) {
        located = true; await onLocator();
      }
      return result;
    },
    async beginTransaction() { calls.push(['begin']); return connection.beginTransaction(); },
    async commit() { calls.push(['commit']); return connection.commit(); },
    async rollback() { calls.push(['rollback']); return connection.rollback(); },
    release() { calls.push(['release']); }, destroy() { calls.push(['destroy']); connection.destroy(); }
  }) };
}

test('employee MySQL fixture rejects unknown databases and encoded alternate names', () => {
  for (const raw of ['mysql://localhost/mysql','mysql://localhost/unknown','mysql://localhost/jbhh_ktv_test_extra',
    'mysql://localhost/jbhh_ktv_test%2Funknown','postgres://localhost/jbhh_ktv_test']) assert.throws(()=>assertDedicatedTestTarget(raw), /jbhh_ktv_test/);
});

test('MySQL 8.4 InnoDB employee roster foundation in jbhh_ktv_test',
  { skip: !testUrl && '未配置 LEDGER_MYSQL_TEST_URL；未取得员工名册真实集成证据' }, async t => {
    assertDedicatedTestTarget(testUrl);
    const setup = await mysql.createConnection(testUrl), created = [];
    let pool = null;
    try {
      const [[target]] = await setup.query('SELECT DATABASE() AS database_name, VERSION() AS version, @@default_storage_engine AS engine');
      assert.equal(target.database_name,database); assert.match(target.version,/^8\.4\./); assert.equal(target.engine.toLowerCase(),'innodb');
      t.diagnostic('MySQL '+target.version+'; database '+target.database_name+'; engine '+target.engine);
      await acquireMySqlFixtureLock(setup);
      const [existing] = await setup.execute('SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('+
        tables.map(()=>'?').join(',')+')',[database,...tables]);
      assert.equal(existing.length,0,'拒绝覆盖或清理预存 auth/employee 表');
      const migrations = [
        ['../database/migrations/002_mysql_auth_core.sql',authTables],
        ['../database/migrations/003_mysql_employee_core.sql',employeeTables]
      ];
      let employeeStatements;
      for (const [path,names] of migrations) {
        const source = await readFile(new URL(path,import.meta.url),'utf8');
        const statements = source.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>!line.trim().startsWith('--')).join('\n')
          .split(';').map(part=>part.trim()).filter(Boolean);
        assert.equal(statements.length,names.length);
        for (const [index,sql] of statements.entries()) { await setup.query(sql); created.push(names[index]); }
        if (names === authTables) await applyPolicyAttributeMigration(setup, created);
        if (names === employeeTables) employeeStatements = statements;
      }
      const poolOptions = {uri:testUrl,database,connectionLimit:5,waitForConnections:true,supportBigNumbers:true,bigNumberStrings:true};
      pool = mysql.createPool(poolOptions);
      const service = connectionPool => createEmployeeService({store:createMySqlEmployeeStore({pool:connectionPool,database})});
      const roster = service(pool);
      const auth = createAuthService({store:createMySqlAuthStore({pool,database}),rateLimiter:createMemoryLoginRateLimiter()});
      let accountCounter = 0;
      const account = async () => (await auth.createAccount({loginIdentifier:'synthetic-roster-'+(++accountCounter),password:'synthetic-roster-password'})).principalId;
      const actorPrincipalId = await account(), context = {actorPrincipalId};
      const create = displayName => roster.createEmployee({displayName},context);
      const readEvents = async employeeId => (await pool.execute('SELECT event_id, employee_id, actor_principal_id, event_type, before_principal_id, after_principal_id, '+
        "DATE_FORMAT(occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurred_at FROM "+table('employee_events')+
        ' WHERE employee_id = ? ORDER BY event_id',[employeeId]))[0];
      const snapshot = async () => ({
        employees:(await pool.query('SELECT * FROM '+table('employees')+' ORDER BY employee_id'))[0],
        events:(await pool.query('SELECT * FROM '+table('employee_events')+' ORDER BY event_id'))[0]
      });
      const utc = async connection => (await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%dT%H:%i:%s.%fZ') AS now"))[0][0].now;
      const within = (value,before,after) => {assert.ok(value>=before&&value<=after,'DB timestamp must lie within database UTC bounds');};

      await t.test('003 migration executes both empty InnoDB tables; repeat execution refuses existing tables; no seeds', async () => {
        const [engines] = await setup.execute('SELECT engine AS engine FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?,?)',[database,...employeeTables]);
        assert.equal(engines.length,2); assert.ok(engines.every(row=>row.engine==='InnoDB'));
        assert.deepEqual(await snapshot(),{employees:[],events:[]});
        await assert.rejects(setup.query(employeeStatements[0]),error=>error.code==='ER_TABLE_EXISTS_ERROR');
      });

      await t.test('same-name no-account employees get distinct stable UUIDs and database UTC timestamps', async () => {
        const before = await utc(pool), a = await create('Synthetic Same Name'), b = await create('Synthetic Same Name'), after = await utc(pool);
        assert.match(a.employeeId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.notEqual(a.employeeId,b.employeeId); assert.equal(a.principalId,null); assert.equal(b.principalId,null);
        assert.equal(a.displayName,b.displayName); assert.equal(a.enabled,true); assert.deepEqual(await roster.getEmployee({employeeId:a.employeeId}),a);
        within(a.createdAt,before,after); within(a.updatedAt,before,after);
        const events = await readEvents(a.employeeId); assert.equal(events.length,1); assert.equal(events[0].actor_principal_id,actorPrincipalId);
        assert.equal(events[0].event_type,'employee-created'); within(events[0].occurred_at,before,after);
      });

      await t.test('explicit link preserves actor versus target; same link is unchanged with one audit', async () => {
        const employee = await create('Synthetic Linked'), principalId = await account(), input = {employeeId:employee.employeeId,principalId};
        const linked = await roster.linkPrincipal(input,context); assert.equal(linked.changed,true); assert.equal(linked.employee.principalId,principalId);
        const before = await snapshot(); assert.equal((await roster.linkPrincipal(input,context)).changed,false); assert.deepEqual(await snapshot(),before);
        const events = await readEvents(employee.employeeId); assert.equal(events.length,2);
        assert.equal(events[1].actor_principal_id,actorPrincipalId); assert.notEqual(events[1].actor_principal_id,events[1].after_principal_id);
        assert.equal(events[1].before_principal_id,null); assert.equal(events[1].after_principal_id,principalId);
      });

      await t.test('nullable principal uniqueness is enforced by MySQL as well as the interface', async () => {
        const a = await create('Synthetic Capacity'), b = await create('Synthetic Capacity'), principalId = await account();
        await roster.linkPrincipal({employeeId:a.employeeId,principalId},context); const before = await snapshot();
        await assert.rejects(roster.linkPrincipal({employeeId:b.employeeId,principalId},context),isCode('EMPLOYEE_PRINCIPAL_ALREADY_LINKED'));
        await assert.rejects(pool.execute('UPDATE '+table('employees')+' SET principal_id = ? WHERE employee_id = ?',[principalId,b.employeeId]),error=>error.code==='ER_DUP_ENTRY');
        assert.deepEqual(await snapshot(),before);
      });

      await t.test('rebind requires explicit unlink; immutable association history remains after relink', async () => {
        const employee = await create('Synthetic Rebind'), a = await account(), b = await account(), input = {employeeId:employee.employeeId};
        await roster.linkPrincipal({...input,principalId:a},context); const before = await snapshot();
        await assert.rejects(roster.linkPrincipal({...input,principalId:b},context),isCode('EMPLOYEE_ALREADY_LINKED')); assert.deepEqual(await snapshot(),before);
        assert.equal((await roster.unlinkPrincipal(input,context)).changed,true); const unlinked = await snapshot();
        assert.equal((await roster.unlinkPrincipal(input,context)).changed,false); assert.deepEqual(await snapshot(),unlinked);
        await roster.linkPrincipal({...input,principalId:b},context);
        assert.deepEqual((await readEvents(employee.employeeId)).slice(1).map(row=>[row.event_type,row.before_principal_id,row.after_principal_id]),
          [['principal-linked',null,a],['principal-unlinked',a,null],['principal-linked',null,b]]);
        assert.equal((await roster.getEmployee(input)).employeeId,employee.employeeId);
      });

      await t.test('disabled employee is retained with association; account/grants/session/auth events are unchanged', async () => {
        const employee = await create('Synthetic Disabled'), principalId = await account(), input = {employeeId:employee.employeeId};
        await roster.linkPrincipal({...input,principalId},context); await auth.grantPermission({principalId,permissionId:'room.clean'});
        const login = await auth.login({loginIdentifier:'synthetic-roster-'+accountCounter,password:'synthetic-roster-password'});
        assert.equal(login.ok,true);
        const authState = async () => ({account:(await pool.execute('SELECT principal_id, enabled, credential_version, disabled_at FROM '+table('auth_accounts')+' WHERE principal_id = ?',[principalId]))[0],
          grants:(await pool.execute('SELECT permission_id FROM '+table('auth_grants')+' WHERE principal_id = ?',[principalId]))[0],
          sessions:(await pool.execute('SELECT session_id, credential_version, idle_expires_at, absolute_expires_at, last_seen_at, revoked_at FROM '+table('auth_sessions')+' WHERE principal_id = ?',[principalId]))[0],
          events:(await pool.execute('SELECT event_id FROM '+table('auth_events')+' WHERE principal_id = ?',[principalId]))[0]});
        const before = await authState(), disabled = await roster.disableEmployee(input,context);
        assert.equal(disabled.employee.enabled,false); assert.equal(disabled.employee.principalId,principalId);
        assert.equal(disabled.employee.displayName,employee.displayName); assert.deepEqual(await authState(),before);
        const state = await snapshot(); assert.equal((await roster.disableEmployee(input,context)).changed,false); assert.deepEqual(await snapshot(),state);
        assert.equal((await readEvents(employee.employeeId)).at(-1).event_type,'employee-disabled');
      });

      await t.test('account disable does not disable employee or remove existing principal association', async () => {
        const employee = await create('Synthetic Account Disabled'), principalId = await account(), input = {employeeId:employee.employeeId};
        await roster.linkPrincipal({...input,principalId},context); const before = await roster.getEmployee(input), audit = await readEvents(employee.employeeId);
        await auth.disableAccount({principalId}); assert.deepEqual(await roster.getEmployee(input),before); assert.deepEqual(await readEvents(employee.employeeId),audit);
        assert.equal((await roster.getEmployee(input)).enabled,true);
      });

      await t.test('employee and audit FK constraints reject missing references and preserve referenced history', async () => {
        const employee = await create('Synthetic FK'), principalId = await account(), input = {employeeId:employee.employeeId}, missing = randomUUID();
        const before = await snapshot();
        await assert.rejects(pool.execute('UPDATE '+table('employees')+' SET principal_id = ? WHERE employee_id = ?',[missing,employee.employeeId]),error=>error.code==='ER_NO_REFERENCED_ROW_2');
        for (const [employeeId,actorId,targetId] of [[missing,actorPrincipalId,principalId],[employee.employeeId,missing,principalId],[employee.employeeId,actorPrincipalId,missing]]) {
          await assert.rejects(pool.execute('INSERT INTO '+table('employee_events')+
            " (employee_id,actor_principal_id,event_type,before_principal_id,after_principal_id) VALUES (?,?,'principal-linked',NULL,?)",[employeeId,actorId,targetId]),error=>error.code==='ER_NO_REFERENCED_ROW_2');
        }
        assert.deepEqual(await snapshot(),before);
        await roster.linkPrincipal({...input,principalId},context); await roster.unlinkPrincipal(input,context);
        await assert.rejects(pool.execute('DELETE FROM '+table('employees')+' WHERE employee_id = ?',[employee.employeeId]),error=>error.code==='ER_ROW_IS_REFERENCED_2');
        await assert.rejects(pool.execute('DELETE FROM '+table('auth_accounts')+' WHERE principal_id = ?',[principalId]),error=>error.code==='ER_ROW_IS_REFERENCED_2');
      });

      await t.test('created/updated/audit timestamps stay UTC even on a connection with a non-UTC session timezone', async () => {
        const connection = await pool.getConnection(), calls = [], principalId = await account();
        try {
          await connection.query("SET SESSION time_zone = '+09:00'");
          const scoped = service(ownedPool(connection,calls));
          const before = await utc(connection), employee = await scoped.createEmployee({displayName:'Synthetic UTC'},context);
          const linked = await scoped.linkPrincipal({employeeId:employee.employeeId,principalId},context), after = await utc(connection);
          within(employee.createdAt,before,after); within(linked.employee.updatedAt,before,after);
          assert.equal(linked.employee.createdAt,employee.createdAt);
          for (const event of await readEvents(employee.employeeId)) within(event.occurred_at,before,after);
          assert.equal(calls.filter(row=>row[0]==='begin').length,2); assert.equal(calls.filter(row=>row[0]==='commit').length,2);
          const locks = calls.filter(row=>row[0]==='sql'&&row[1].startsWith('SELECT principal_id')).slice(1).map(row=>row[2][0]);
          assert.deepEqual(locks,[actorPrincipalId,principalId].sort());
        } finally {await connection.query("SET SESSION time_zone = '+00:00'");connection.release();}
      });

      await t.test('new pool reconnect reads the durable employee and association; repeat link adds no audit', async () => {
        const employee = await create('Synthetic Reconnect'), principalId = await account(), input = {employeeId:employee.employeeId,principalId};
        const linked = await roster.linkPrincipal(input,context), audit = await readEvents(employee.employeeId), reconnect = mysql.createPool(poolOptions);
        try {
          const again = service(reconnect); assert.deepEqual(await again.getEmployee({employeeId:employee.employeeId}),linked.employee);
          assert.equal((await again.linkPrincipal(input,context)).changed,false); assert.deepEqual(await readEvents(employee.employeeId),audit);
        } finally {await reconnect.end();}
      });

      await t.test('two independent connections competing for one principal produce one link and one conflict', async () => {
        const employees = [await create('Synthetic Race'),await create('Synthetic Race')], principalId = await account();
        const a = await pool.getConnection(), b = await pool.getConnection();
        try {
          const [[aId]] = await a.query('SELECT CONNECTION_ID() AS id'), [[bId]] = await b.query('SELECT CONNECTION_ID() AS id');
          assert.notEqual(aId.id,bId.id); await a.query('SET SESSION innodb_lock_wait_timeout = 5'); await b.query('SET SESSION innodb_lock_wait_timeout = 5');
          const attempts = await Promise.allSettled([service(ownedPool(a,[])).linkPrincipal({employeeId:employees[0].employeeId,principalId},context),
            service(ownedPool(b,[])).linkPrincipal({employeeId:employees[1].employeeId,principalId},context)]);
          assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);
          const failure = attempts.find(row=>row.status==='rejected'); assert.equal(failure.reason.code,'EMPLOYEE_PRINCIPAL_ALREADY_LINKED');
          const rows = await Promise.all(employees.map(row=>roster.getEmployee({employeeId:row.employeeId})));
          assert.equal(rows.filter(row=>row.principalId===principalId).length,1);
          const audits = await Promise.all(employees.map(row=>readEvents(row.employeeId)));
          assert.equal(audits.flat().filter(row=>row.event_type==='principal-linked').length,1);
          t.diagnostic('employee uniqueness race used two verified independent CONNECTION_ID values');
        } finally {a.release();b.release();}
      });

      await t.test('locator association changes are rejected after account-first current reads without reverse FK locks', async () => {
        const employee = await create('Synthetic Locator'), a = await account(), b = await account(), input = {employeeId:employee.employeeId};
        await roster.linkPrincipal({...input,principalId:a},context);
        const connection = await pool.getConnection(), calls = [];
        try {
          const scoped = service(ownedPool(connection,calls,{onLocator:async()=>{
            await roster.unlinkPrincipal(input,context); await roster.linkPrincipal({...input,principalId:b},context);
          }}));
          await assert.rejects(scoped.unlinkPrincipal(input,context),isCode('EMPLOYEE_ASSOCIATION_CHANGED'));
          assert.equal((await roster.getEmployee(input)).principalId,b);
          assert.equal((await readEvents(employee.employeeId)).length,4);
          assert.ok(calls.some(row=>row[0]==='rollback')); assert.ok(!calls.some(row=>row[0]==='sql'&&row[1].startsWith('INSERT')));
        } finally {connection.release();}
      });

      await t.test('real mid-transaction audit SQL failure rolls back create/link/unlink/disable and all metadata', async () => {
        for (const eventType of ['employee-created','principal-linked','principal-unlinked','employee-disabled']) {
          const employee = await create('Synthetic SQL Rollback'), principalId = await account(), input = {employeeId:employee.employeeId};
          if (['principal-unlinked','employee-disabled'].includes(eventType)) await roster.linkPrincipal({...input,principalId},context);
          const before = await snapshot(), connection = await pool.getConnection(), calls = [];
          try {
            const scoped = service(ownedPool(connection,calls,{failEvent:eventType}));
            const execute = () => eventType==='employee-created' ? scoped.createEmployee({displayName:'Synthetic Aborted Create'},context) :
              eventType==='principal-linked' ? scoped.linkPrincipal({...input,principalId},context) :
              eventType==='principal-unlinked' ? scoped.unlinkPrincipal(input,context) : scoped.disableEmployee(input,context);
            await assert.rejects(execute(),error=>error.code==='ER_BAD_FIELD_ERROR');
            assert.ok(calls.some(row=>row[0]==='sql'&&/^(INSERT|UPDATE) /.test(row[1])&&row[1].includes(table('employees'))));
            assert.ok(calls.some(row=>row[0]==='sql'&&row[1].includes('missing_employee_test_column')));
            assert.ok(calls.some(row=>row[0]==='rollback')); assert.ok(!calls.some(row=>row[0]==='commit'));
            assert.deepEqual(await snapshot(),before);
          } finally {connection.release();}
        }
      });

      await t.test('unknown exception after an actual audit insert rolls back both the association and audit', async () => {
        const employee = await create('Synthetic Unknown Rollback'), principalId = await account(), before = await snapshot(), connection = await pool.getConnection(), calls = [];
        try {
          const scoped = service(ownedPool(connection,calls,{failAfterAudit:true}));
          await assert.rejects(scoped.linkPrincipal({employeeId:employee.employeeId,principalId},context),error=>error.message==='synthetic unknown failure after audit insert'&&!(error instanceof EmployeeRosterError));
          assert.ok(calls.some(row=>row[0]==='rollback')); assert.deepEqual(await snapshot(),before);
        } finally {connection.release();}
      });

      await t.test('invalid or disabled audit actors and absent targets reject without partial employees or events', async () => {
        const employee = await create('Synthetic Rejected'), missing = randomUUID(), disabled = await account();
        await auth.disableAccount({principalId:disabled}); const before = await snapshot();
        await assert.rejects(roster.createEmployee({displayName:'Synthetic Missing Actor'},{actorPrincipalId:missing}),isCode('EMPLOYEE_ACCOUNT_NOT_FOUND'));
        await assert.rejects(roster.createEmployee({displayName:'Synthetic Disabled Actor'},{actorPrincipalId:disabled}),isCode('EMPLOYEE_ACTOR_DISABLED'));
        await assert.rejects(roster.linkPrincipal({employeeId:employee.employeeId,principalId:missing},context),isCode('EMPLOYEE_ACCOUNT_NOT_FOUND'));
        await assert.rejects(roster.unlinkPrincipal({employeeId:missing},context),isCode('EMPLOYEE_NOT_FOUND'));
        assert.equal(await roster.getEmployee({employeeId:missing}),null); assert.deepEqual(await snapshot(),before);
      });

      await t.test('employee audit stores only IDs/change metadata/DB time and enforces event shape', async () => {
        const [columns] = await setup.execute('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',[database,'employee_events']);
        assert.deepEqual(columns.map(row=>row.name),['event_id','employee_id','actor_principal_id','event_type','before_principal_id','after_principal_id','occurred_at']);
        const employee = await create('Synthetic Audit Shape');
        await assert.rejects(pool.execute('INSERT INTO '+table('employee_events')+
          " (employee_id,actor_principal_id,event_type) VALUES (?,?,'principal-linked')",[employee.employeeId,actorPrincipalId]),error=>error.code==='ER_CHECK_CONSTRAINT_VIOLATED');
      });
      await runEmployeeResolverIntegrationTests(t,{pool,database,roster,context,create,account,snapshot,readEvents,makeRoster:service,ownedPool});
      await runPrincipalEmployeeResolverIntegrationTests(t,{pool,database,roster,context,create,auth,snapshot,makeRoster:service,ownedPool});
    } finally {
      try {if(pool) await pool.end();}
      finally {
        try {for(const name of [...created].reverse()) await setup.query('DROP TABLE '+table(name));}
        finally {await setup.end();}
      }
    }
  });
