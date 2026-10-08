export function assertFixtureEnvironment(env=process.env) {
  if(env.NODE_ENV==='production'||env.KTV_HTTP_ENV==='production'||env.KTV_DEPLOYMENT_ENV==='production') {
    throw Object.assign(Error('Destructive fixtures are forbidden in production'),{code:'PRODUCTION_FIXTURE_DENIED'});
  }
}
