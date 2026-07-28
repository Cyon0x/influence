const { tryNotify } = require('../../lib/notify');
const { rateLimit, clientKey } = require('../../lib/rateLimit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const { ok } = rateLimit('notify:' + clientKey(req), { limit: 30, windowMs: 60_000 });
  if (!ok) {
    res.status(429).json({ error: 'too many requests' });
    return;
  }

  const dealId = Number(req.body?.dealId);
  const txHash = typeof req.body?.txHash === 'string' ? req.body.txHash : null;
  if (!Number.isInteger(dealId) || dealId < 0) {
    res.status(400).json({ error: 'invalid dealId' });
    return;
  }

  try {
    const result = await tryNotify(dealId, 'RELEASED', { txHash, auto: req.body?.auto === true });
    res.status(200).json(result);
  } catch (err) {
    console.error('notify/released failed', err);
    res.status(500).json({ error: 'internal error' });
  }
};
