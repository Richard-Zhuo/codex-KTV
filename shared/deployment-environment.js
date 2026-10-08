// Only canonical, explicit environment names may select a safety boundary.
export function isProductionEnvironment(env) {
  const values=['NODE_ENV','KTV_HTTP_ENV','KTV_DEPLOYMENT_ENV'].map(key=>env[key]);
  if(values.some(value=>value!==undefined&&!['development','test','production'].includes(value))) {
    throw Object.assign(Error('Invalid deployment environment'),{code:'ENVIRONMENT_INVALID'});
  }
  return values.includes('production');
}
