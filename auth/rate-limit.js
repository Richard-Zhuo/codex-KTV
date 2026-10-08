// Single-process implementation of the required login rate-limit port.
// A future multi-process HTTP deployment must inject a shared implementation.
export function createMemoryLoginRateLimiter({
  maxFailures = 5, windowMs = 15 * 60 * 1000, maxKeys=2048, now = () => Date.now()
} = {}) {
  if (!Number.isSafeInteger(maxKeys)||maxKeys<1||!Number.isSafeInteger(maxFailures) || maxFailures < 1 ||
      !Number.isSafeInteger(windowMs) || windowMs < 1 || typeof now !== 'function') {
    throw TypeError('登录限流参数无效');
  }
  const failures = new Map();
  const recent = key => {
    const cutoff = now() - windowMs;
    const entries = (failures.get(key) ?? []).filter(time => time > cutoff);
    if (entries.length) failures.set(key, entries);
    else failures.delete(key);
    return entries;
  };
  return Object.freeze({
    canAttempt(key) { for(const k of failures.keys())recent(k);return (failures.has(key)||failures.size<maxKeys)&&recent(key).length < maxFailures; },
    recordFailure(key) { if(failures.has(key)||failures.size<maxKeys)failures.set(key, [...recent(key), now()].slice(-maxFailures)); },
    recordSuccess(key) { failures.delete(key); }
  });
}
