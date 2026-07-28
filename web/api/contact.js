const { ethers } = require('ethers');
const { prisma } = require('../lib/prisma');
const { rateLimit, clientKey } = require('../lib/rateLimit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000; // 10 minutes

// Must byte-for-byte match buildContactMessage() in web/app.js — the
// frontend signs this exact string, this endpoint recovers the signer from
// it. There's no shared module between browser and serverless function here
// (no build step ties them together), so keep both in sync by hand.
function contactMessage(email, timestamp) {
  return `Set my Influence notification email to: ${email}\n\nTimestamp: ${timestamp}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const { ok } = rateLimit('contact:' + clientKey(req), { limit: 10, windowMs: 60_000 });
  if (!ok) {
    res.status(429).json({ error: 'too many requests' });
    return;
  }

  const { address, email, signature, timestamp } = req.body || {};

  if (typeof address !== 'string' || !ethers.isAddress(address)) {
    res.status(400).json({ error: 'invalid address' });
    return;
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254) {
    res.status(400).json({ error: 'invalid email' });
    return;
  }
  if (typeof timestamp !== 'number' || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
    res.status(400).json({ error: 'stale or invalid timestamp, please retry' });
    return;
  }
  if (typeof signature !== 'string') {
    res.status(400).json({ error: 'missing signature' });
    return;
  }

  let recovered;
  try {
    recovered = ethers.verifyMessage(contactMessage(email, timestamp), signature);
  } catch (err) {
    res.status(400).json({ error: 'could not verify signature' });
    return;
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    res.status(401).json({ error: 'signature does not match address' });
    return;
  }

  try {
    await prisma.creatorContact.upsert({
      where: { address: address.toLowerCase() },
      update: { email },
      create: { address: address.toLowerCase(), email },
    });
  } catch (err) {
    console.error('contact upsert failed', err);
    res.status(500).json({ error: 'internal error' });
    return;
  }

  res.status(200).json({ ok: true });
};
