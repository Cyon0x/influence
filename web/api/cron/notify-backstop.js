const { prisma } = require('../../lib/prisma');
const { getEscrow, getProvider } = require('../../lib/chain');
const { tryNotify } = require('../../lib/notify');

const MAX_RANGE_PER_QUERY = 9500; // stay under Arc testnet RPC's 10,000-block eth_getLogs limit
const SINGLETON_ID = 'escrow';

async function queryChunked(contract, filter, fromBlock, toBlock) {
  let all = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_RANGE_PER_QUERY) {
    const end = Math.min(start + MAX_RANGE_PER_QUERY - 1, toBlock);
    const events = await contract.queryFilter(filter, start, end);
    all = all.concat(events);
  }
  return all;
}

// Catches anything that happened outside the app's own instant-notify calls
// (e.g. a direct contract interaction, or a case where the client-side call
// after tx.wait() never fired). The instant path covers the common case
// near-instantly; this is the backstop, not the primary path — same pattern
// already proven out in the sibling FinFlow project's cron reconciliation.
module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  try {
    const provider = getProvider();
    const escrow = getEscrow();
    const latest = await provider.getBlockNumber();

    let cursor = await prisma.syncCursor.findUnique({ where: { id: SINGLETON_ID } });
    const fromBlock = cursor ? cursor.lastBlock + 1 : Math.max(0, latest - 200_000);

    if (fromBlock > latest) {
      res.status(200).json({ ok: true, scanned: 0, note: 'already caught up' });
      return;
    }

    const [created, released] = await Promise.all([
      queryChunked(escrow, escrow.filters.DealCreated(), fromBlock, latest),
      queryChunked(escrow, escrow.filters.DealReleased(), fromBlock, latest),
    ]);

    let sent = 0;
    for (const ev of created) {
      const result = await tryNotify(Number(ev.args.dealId), 'HIRED', { txHash: ev.transactionHash });
      if (result.sent) sent += 1;
    }
    for (const ev of released) {
      const result = await tryNotify(Number(ev.args.dealId), 'RELEASED', {
        txHash: ev.transactionHash,
        auto: Boolean(ev.args.autoReleased),
      });
      if (result.sent) sent += 1;
    }

    await prisma.syncCursor.upsert({
      where: { id: SINGLETON_ID },
      update: { lastBlock: latest },
      create: { id: SINGLETON_ID, lastBlock: latest },
    });

    res.status(200).json({
      ok: true,
      scannedBlocks: [fromBlock, latest],
      dealCreatedEvents: created.length,
      dealReleasedEvents: released.length,
      emailsSent: sent,
    });
  } catch (err) {
    console.error('cron notify-backstop failed', err);
    res.status(500).json({ error: 'internal error' });
  }
};
