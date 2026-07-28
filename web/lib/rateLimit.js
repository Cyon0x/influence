// In-memory, per-instance rate limiter. A reasonable deterrent against naive
// spam, not a distributed guarantee across serverless instances — matches the
// same tradeoff already documented and accepted in the FinFlow project.
const buckets = new Map();

function rateLimit(key, { limit = 20, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now - entry.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return { ok: true };
  }
  entry.count += 1;
  if (entry.count > limit) return { ok: false };
  return { ok: true };
}

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

module.exports = { rateLimit, clientKey };
