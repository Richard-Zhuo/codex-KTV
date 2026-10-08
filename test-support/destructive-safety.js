import { isProductionEnvironment } from '../shared/deployment-environment.js';
export function assertFixtureEnvironment(env=process.env) {
  let denied;
  try { denied=isProductionEnvironment(env); } catch { denied=true; }
  if(denied) throw Object.assign(Error('Destructive fixtures are forbidden in this environment'),{code:'PRODUCTION_FIXTURE_DENIED'});
}
