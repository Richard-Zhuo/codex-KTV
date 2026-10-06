import mysql from 'mysql2/promise';
import { createMySqlAuthStore } from '../auth/mysql-store.js';
import { createAuthService } from '../auth/service.js';
import { createMemoryLoginRateLimiter } from '../auth/rate-limit.js';
import { createHttpApi } from './api.js';

export function createHttpApiFromEnv(env = process.env, logger = console) {
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
  const pool = mysql.createPool({ uri: raw, database, connectionLimit: 10,
    waitForConnections: true, supportBigNumbers: true, bigNumberStrings: true });
  const authService = createAuthService({
    store: createMySqlAuthStore({ pool, database }),
    rateLimiter: createMemoryLoginRateLimiter()
  });
  return createHttpApi({ authService, origin: env.KTV_PUBLIC_ORIGIN,
    environment, allowInsecureCookie: env.KTV_INSECURE_COOKIE === 'true', logger });
}
