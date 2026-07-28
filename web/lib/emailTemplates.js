// Table-based layout, inline styles only — the usual constraints for HTML
// email, where CSS grid/flexbox and external stylesheets are unreliable
// across clients (especially Outlook). Light body background rather than
// the app's dark theme, since dark-background emails are the ones most
// likely to get mangled by a client's own dark-mode color inversion.

const BRAND = {
  ink: '#241A2E',
  muted: '#8A7C74',
  coral: '#E8623A',
  coral2: '#C8492E',
  gold: '#FFB86B',
  mint: '#1F9D63',
  paper: '#FAF6EF',
  border: '#E5D8C2',
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtUsdc(n) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shell({ preheader, logoUrl, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Influence</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paper};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};padding:24px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid ${BRAND.border};">
        <tr>
          <td style="background-color:${BRAND.coral2};background-image:linear-gradient(135deg,#2E1B3D 0%,#C8492E 55%,#FFB86B 100%);padding:28px 28px 24px;" bgcolor="${BRAND.coral2}">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="padding-right:10px;"><img src="${logoUrl}" width="40" height="40" alt="Influence" style="display:block;border-radius:11px;" /></td>
              <td style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;color:#FBF4EA;vertical-align:middle;">Influence<span style="color:${BRAND.mint};">.</span></td>
            </tr></table>
          </td>
        </tr>
        <tr><td style="padding:28px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:0 28px 28px;">
          <div style="border-top:1px solid ${BRAND.border};padding-top:16px;font-size:11px;line-height:1.6;color:${BRAND.muted};">
            Sent because this address is set as the notification email on an Influence creator profile on Arc Testnet. Influence never asks for your seed phrase or private key.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function infoBox(rows) {
  const rowsHtml = rows.map(([label, value]) => `
    <tr>
      <td style="padding:6px 0;font-size:12px;color:${BRAND.muted};white-space:nowrap;">${escapeHtml(label)}</td>
      <td style="padding:6px 0 6px 16px;font-size:13px;color:${BRAND.ink};font-weight:600;text-align:right;word-break:break-word;">${value}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};border:1px solid ${BRAND.border};border-radius:10px;padding:14px 16px;margin:18px 0;">${rowsHtml}</table>`;
}

function button(href, label, color = BRAND.coral) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;"><tr>
    <td style="border-radius:9px;background-color:${color};">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-size:13px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td>
  </tr></table>`;
}

function hiredEmail({ logoUrl, dealsUrl, explorerTxUrl, brandShort, brief, amount, dealId }) {
  const subject = `You've been hired — ${fmtUsdc(amount)} USDC locked in escrow`;
  const preheader = `${brandShort} locked ${fmtUsdc(amount)} USDC in escrow for deal #${dealId}. Deliver the work and submit proof to get paid.`;
  const bodyHtml = `
    <div style="font-size:12px;font-weight:700;color:${BRAND.coral2};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">New deal · Arc Testnet</div>
    <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${BRAND.ink};">You've been hired 🎉</h1>
    <p style="margin:0 0 4px;font-size:14px;line-height:1.6;color:${BRAND.ink};"><strong>${escapeHtml(brandShort)}</strong> just locked funds in escrow to hire you on Influence. The USDC is held by the smart contract until you deliver and they approve — it's already committed, they can't take it back once you've submitted proof (they can only reclaim it if you never submit anything).</p>
    ${infoBox([
      ['Deal', '#' + dealId],
      ['Brand', escapeHtml(brandShort)],
      ['Amount in escrow', fmtUsdc(amount) + ' USDC'],
      ['Brief', escapeHtml(brief)],
    ])}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">Next: complete the work, then submit your proof of performance from the deal in your dashboard. Once the brand approves — or after 48 hours automatically — the funds release straight to your wallet.</p>
    ${button(dealsUrl, 'View this deal →')}
    ${explorerTxUrl ? `<div style="margin-top:8px;font-size:11px;"><a href="${escapeHtml(explorerTxUrl)}" style="color:${BRAND.muted};">View transaction on Arcscan ↗</a></div>` : ''}
  `;
  return { subject, html: shell({ preheader, logoUrl, bodyHtml }), text: `You've been hired on Influence.\n\n${brandShort} locked ${fmtUsdc(amount)} USDC in escrow for deal #${dealId}.\n\nBrief: ${brief}\n\nDeliver the work, then submit proof from your dashboard to get paid: ${dealsUrl}` };
}

function releasedEmail({ logoUrl, dealsUrl, explorerTxUrl, brandShort, amount, dealId, auto }) {
  const subject = `Funds released — ${fmtUsdc(amount)} USDC is in your wallet`;
  const preheader = `${fmtUsdc(amount)} USDC from deal #${dealId} has been released to your wallet.`;
  const bodyHtml = `
    <div style="font-size:12px;font-weight:700;color:${BRAND.mint};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Payment released · Arc Testnet</div>
    <h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:${BRAND.ink};">Funds are in your wallet 💸</h1>
    <p style="margin:0 0 4px;font-size:14px;line-height:1.6;color:${BRAND.ink};">${auto
      ? `Deal #${dealId} auto-released after 48 hours with no response from the brand — the escrow contract paid you automatically, exactly as designed.`
      : `<strong>${escapeHtml(brandShort)}</strong> approved your work on deal #${dealId} and the escrow contract released your payment.`}</p>
    ${infoBox([
      ['Deal', '#' + dealId],
      ['Brand', escapeHtml(brandShort)],
      ['You received', fmtUsdc(amount) + ' USDC'],
    ])}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">This was a direct on-chain transfer to your wallet — nothing further to claim. If you haven't already, consider leaving a review on the deal.</p>
    ${button(dealsUrl, 'View this deal →', BRAND.mint)}
    ${explorerTxUrl ? `<div style="margin-top:8px;font-size:11px;"><a href="${escapeHtml(explorerTxUrl)}" style="color:${BRAND.muted};">View transaction on Arcscan ↗</a></div>` : ''}
  `;
  return { subject, html: shell({ preheader, logoUrl, bodyHtml }), text: `${fmtUsdc(amount)} USDC from deal #${dealId} has been released to your wallet on Influence.\n\nView it: ${dealsUrl}` };
}

module.exports = { hiredEmail, releasedEmail };
