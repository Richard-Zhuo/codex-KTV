// Single-process implementation of the required login rate-limit port.
// A future multi-process HTTP deployment must inject a shared implementation.
export function createMemoryLoginRateLimiter({
  maxFailures = 5, windowMs = 15 * 60 * 1000, now = () => Date.now()
} = {}) {
  if (!Number.isSafeInteger(maxFailures) || maxFailures < 1 ||
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
    canAttempt(key) { return recent(key).length < maxFailures; },
    recordFailure(key) { failures.set(key, [...recent(key), now()]); },
    recordSuccess(key) { failures.delete(key); }
  });
}
