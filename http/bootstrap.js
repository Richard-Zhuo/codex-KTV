import { readinessPool } from '../production/readiness-pool.js';
import { recoveryApiGate,bindRecoveryWriteGuard } from '../recovery/gate.js';
import { isProductionEnvironment } from '../shared/deployment-environment.js';
import { validateProductionConfig } from '../production/config.js';
import { readProductionReadiness, productionApiGate } from '../production/readiness.js';
import { createRoomControlRuntime } from '../devices/runtime.js';
import { KtvSkyRoomControlGateway } from '../devices/gateway.js';
import { readDeviceHead } from '../devices/mysql-port.js';
import mysql from 'mysql2/promise';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { createMySqlEmployeeStore } from '../employees/mysql-store.js';
import { createMySqlLedgerStore } from '../ledger/mysql-store.js';
import { createTrustedLedgerApplication } from '../ledger/application.js';
import { createMySqlVoucherStore } from '../vouchers/mysql-store.js';
import { createCurrentSessionReader } from './query.js';
import { createHttpApi } from './api.js';

export function createHttpApiFromEnv(env = process.env, logger = console, {managed=false,mysqlSsl,loginGate}={}) {
  const production = isProductionEnvironment(env) || (env.KTV_API_MODE === 'enabled' && env.KTV_HTTP_ENV !== 'development');
  const productionConfig = production ? validateProductionConfig(env) : null;
  const deviceControlMode=env.DEVICE_CONTROL_MODE??'disabled';
  if(!['disabled','required'].includes(deviceControlMode))throw TypeError('Invalid DEVICE_CONTROL_MODE');
  // Real KTVSky productionEnabled remains false. No live credentials or gate are read here.
  const mode = env.KTV_API_MODE ?? 'disabled';
  if (mode === 'disabled') return null;
  if (mode !== 'enabled') throw new TypeError('Invalid KTV_API_MODE');
  const raw = env.KTV_MYSQL_URL;
  if (typeof raw !== 'string' || !raw) throw new TypeError('KTV_MYSQL_URL is required');
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || !url.hostname || !/^[a-z][a-z0-9_]{0,63}$/.test(database)) {
    throw new TypeError('Invalid KTV_MYSQL_URL target');
  }
  const environment = env.KTV_HTTP_ENV ?? 'production';
  if (!['production', 'development'].includes(environment) ||
      ![undefined, 'true', 'false'].includes(env.KTV_INSECURE_COOKIE)) {
    throw new TypeError('Invalid HTTP environment');
  }
  const ledgerId = env.KTV_LEDGER_ID;
  const storeId = env.KTV_STORE_ID;
  const businessTimeZone = env.KTV_BUSINESS_TIME_ZONE;
  if (typeof ledgerId !== 'string' || !ledgerId || ledgerId.length > 64 ||
      typeof storeId !== 'string' || !storeId || storeId.length > 191 ||
      typeof businessTimeZone !== 'string' || !businessTimeZone) {
    throw new TypeError('KTV_LEDGER_ID, KTV_STORE_ID and KTV_BUSINESS_TIME_ZONE are required');
  }
  const pool = mysql.createPool({ uri: raw, database, connectionLimit: 10,
    waitForConnections: !managed, queueLimit:32, supportBigNumbers: true, bigNumberStrings: true,connectTimeout:2000,...(mysqlSsl?{ssl:mysqlSsl}:{}) });
  const authStore = createMySqlAuthStore({ pool, database, bindRecoveryGuard:bindRecoveryWriteGuard });
  const authService = createAuthService({
    store: authStore, rateLimiter: createMemoryLoginRateLimiter()
  });
  const employeeStore = createMySqlEmployeeStore({ pool, database, bindRecoveryGuard:bindRecoveryWriteGuard });
  const voucherStore = createMySqlVoucherStore({ pool, database, ledgerId,
    provider: 'meituan', storeId, bindRecoveryGuard:bindRecoveryWriteGuard, bindSessionRevalidation: authStore.bindSessionRevalidation });
  const store = createMySqlLedgerStore({ pool, ledgerId, database, bindRecoveryGuard:bindRecoveryWriteGuard,
    bindSessionRevalidation: authStore.bindSessionRevalidation,
    bindEmployeeResolver: employeeStore.bindEmployeeResolver,
    bindVoucherRedemptions: voucherStore.bindVoucherRedemptions, deviceControlMode });
  const application = createTrustedLedgerApplication({ store, businessTimeZone });
  const sessionReader = createCurrentSessionReader({ pool, authStore });
  const runtime=deviceControlMode==='required' ? createRoomControlRuntime({pool,database,ledgerId,authStore,gateway:new KtvSkyRoomControlGateway(),recoveryGuard:true}) : null;
  const api=createHttpApi({ authService, application, store, sessionReader, employeeStore,
    deviceSnapshot: (connection,head)=>readDeviceHead(connection,database,head),
    businessTimeZone, origin: env.KTV_PUBLIC_ORIGIN, environment,
    allowInsecureCookie: env.KTV_INSECURE_COOKIE === 'true', logger,loginGate });
  if(!production&&!managed) runtime?.start().catch(()=>logger.error({code:'RECOVERY_WORKER_START_FAILED'}));
  const composed=recoveryApiGate({...api,async close(){await runtime?.stop();await pool.end();}},{pool});
  if(managed){if(!production)throw TypeError('Managed runtime requires production');return Object.freeze({...composed,readiness:async()=>{const report=await readProductionReadiness({pool:readinessPool(pool),config:productionConfig});const c=await readinessPool(pool).getConnection();try{const {recoveryMode}=await import('../recovery/gate.js');const mode=await recoveryMode(c);return {...report,ready:report.ready&&mode==='NORMAL',blockers:[...report.blockers,...(mode==='NORMAL'?[]:[{code:'RECOVERY_PAUSED'}])]};}finally{c.release();}},startWorker:()=>runtime?.start(),stopWorker:()=>runtime?.stop()});}
  return production ? productionApiGate(composed,()=>readProductionReadiness({pool,config:productionConfig,
    credentialFile:env.KTVSKY_CREDENTIALS_FILE}),{logger,start:()=>runtime?.start()}) : composed;
}
