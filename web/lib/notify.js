const { Resend } = require('resend');
const { prisma } = require('./prisma');
const { getEscrow, chainConfig } = require('./chain');
const { hiredEmail, releasedEmail } = require('./emailTemplates');

const LOGO_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'influence-orpin.vercel.app'}/logo.png`;
const SITE_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'influence-orpin.vercel.app'}`;

function shortAddr(a) {
  return a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
}
function fromWei(wei) {
  return Number(wei) / 1e18;
}

/**
 * The single choke point both the instant client-triggered notify calls and
 * the cron backstop go through. Never trusts the caller's claim about what
 * happened — always re-reads the deal from the contract itself, and relies
 * on NotificationLog's unique (dealId, kind) constraint so the same email
 * can never go out twice no matter which path gets there first.
 *
 * @param {number} dealId
 * @param {'HIRED'|'RELEASED'} kind
 * @param {{txHash?: string|null, auto?: boolean}} [opts]
 */
async function tryNotify(dealId, kind, opts = {}) {
  const { txHash = null, auto = false } = opts;
  const escrow = getEscrow();
  let deal;
  try {
    deal = await escrow.deals(dealId);
  } catch (err) {
    return { sent: false, reason: 'deal not found' };
  }

  const status = Number(deal.status); // 0 Active, 1 ProofSubmitted, 2 Completed, 3 Cancelled
  if (kind === 'HIRED' && deal.amount === 0n) {
    // deals() returning a real (non-reverting) result with zero amount would
    // mean dealId was never actually created via createDeal() — shouldn't
    // happen, since createDeal requires msg.value > 0, but check anyway.
    return { sent: false, reason: 'deal does not exist' };
  }
  if (kind === 'RELEASED' && status !== 2) {
    return { sent: false, reason: 'deal is not actually Completed on-chain' };
  }

  const creatorAddress = String(deal.creator).toLowerCase();
  const contact = await prisma.creatorContact.findUnique({ where: { address: creatorAddress } });
  if (!contact) return { sent: false, reason: 'creator has no notification email on file' };

  let logRow;
  try {
    logRow = await prisma.notificationLog.create({ data: { dealId, kind } });
  } catch (err) {
    // P2002 = unique constraint violation on (dealId, kind) -> genuinely
    // already sent, expected under races between the instant trigger and
    // the cron backstop, not an error. Anything else (DB unreachable, etc.)
    // is a real failure and must propagate — silently swallowing it here
    // would masquerade as "already sent" and the cron backstop would never
    // know to retry, so the notification would just never go out.
    if (err.code === 'P2002') {
      return { sent: false, reason: 'already sent' };
    }
    throw err;
  }

  const dealsUrl = `${SITE_URL}/`;
  const explorerTxUrl = txHash ? `${chainConfig.explorer}/tx/${txHash}` : null;

  let templateResult;
  if (kind === 'HIRED') {
    templateResult = hiredEmail({
      logoUrl: LOGO_URL,
      dealsUrl,
      explorerTxUrl,
      brandShort: shortAddr(deal.brand),
      brief: deal.brief,
      amount: fromWei(deal.amount),
      dealId,
    });
  } else {
    const creatorAmount = (deal.amount * 99n) / 100n;
    templateResult = releasedEmail({
      logoUrl: LOGO_URL,
      dealsUrl,
      explorerTxUrl,
      brandShort: shortAddr(deal.brand),
      amount: fromWei(creatorAmount),
      dealId,
      auto,
    });
  }

  try {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.NOTIFY_FROM_EMAIL || 'Influence <onboarding@resend.dev>',
      to: contact.email,
      subject: templateResult.subject,
      html: templateResult.html,
      text: templateResult.text,
    });
  } catch (err) {
    // Sending failed after we already wrote the log row — roll it back so a
    // retry (next cron run) can try again instead of treating this as sent.
    await prisma.notificationLog.delete({ where: { id: logRow.id } }).catch(() => {});
    throw err;
  }

  return { sent: true };
}

module.exports = { tryNotify };
