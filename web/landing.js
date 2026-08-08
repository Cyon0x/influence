/* ══════════════════════════════════════════════════════════════
   Influence landing page — deliberately separate from app.js.
   Only reads chain state (creator count + roster for the ticker),
   never connects a wallet or writes anything. Keeps this page light
   and keeps the marketing site's code from depending on wallet/deal
   logic it will never use.
   ══════════════════════════════════════════════════════════════ */

const CFG = window.INFLUENCE_CONFIG;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatFollowers(n) {
  n = Number(n);
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'K';
  return String(n);
}

/* Same rate-limit reality as the app: the public Arc testnet RPC throws
   generic network errors (sometimes surfaced as CORS failures) under load
   rather than clean JSON-RPC error codes, so this retries on anything, not
   just the -32011 code — see app.js for the fuller writeup. */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function withRetry(fn, retries = 4, baseDelay = 500) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(baseDelay * Math.pow(1.6, attempt));
    }
  }
}

function buildReadProvider() {
  const primary = new ethers.JsonRpcProvider(CFG.rpcUrl, { chainId: CFG.chainId, name: 'arc-testnet' }, { staticNetwork: true });
  if (!CFG.rpcUrlFallback) return primary;
  const fallback = new ethers.JsonRpcProvider(CFG.rpcUrlFallback, { chainId: CFG.chainId, name: 'arc-testnet' }, { staticNetwork: true });
  return new ethers.FallbackProvider(
    [
      { provider: primary, priority: 1, weight: 1, stallTimeout: 3000 },
      { provider: fallback, priority: 2, weight: 1, stallTimeout: 3000 },
    ],
    undefined,
    { quorum: 1 }
  );
}

/* ── Theme (shared localStorage key with app.js, so the choice persists
   across the landing page <-> app boundary) ── */
function toggleTheme() {
  const html = document.documentElement;
  const isLight = html.getAttribute('data-theme') === 'light';
  html.setAttribute('data-theme', isLight ? 'dark' : 'light');
  document.querySelector('#themeToggle .icon').textContent = isLight ? '🌙' : '☀️';
  localStorage.setItem('influence_theme', isLight ? 'dark' : 'light');
}
(function initTheme() {
  const saved = localStorage.getItem('influence_theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    const icon = document.querySelector('#themeToggle .icon');
    if (icon) icon.textContent = saved === 'light' ? '☀️' : '🌙';
  }
})();

/* ── Mobile nav ── */
function toggleMobileNav() {
  document.getElementById('mobilePanel').classList.toggle('show');
}
function closeMobileNav() {
  document.getElementById('mobilePanel').classList.remove('show');
}

/* ── Brand/Creator segmented toggle ── */
function showAudience(who) {
  document.getElementById('segBrandBtn').classList.toggle('active', who === 'brand');
  document.getElementById('segCreatorBtn').classList.toggle('active', who === 'creator');
  document.getElementById('segBrandPanel').classList.toggle('active', who === 'brand');
  document.getElementById('segCreatorPanel').classList.toggle('active', who === 'creator');
}

/* ── FAQ accordion ── */
function toggleLFaq(btn) {
  btn.closest('.lfaq-item').classList.toggle('open');
}

/* ── Footer: real explorer links to the live contracts ── */
function wireFooterContractLinks() {
  const set = (id, addr) => {
    const el = document.getElementById(id);
    if (el && addr) el.href = `${CFG.explorer}/address/${addr}`;
  };
  set('footerRegistryLink', CFG.registryAddress);
  set('footerEscrowLink', CFG.escrowAddress);
  set('footerReviewsLink', CFG.reviewsAddress);
}

/* ── Live stats + ticker — real on-chain reads, same shape as the app's
   marketplace loader, trimmed to just what this page needs. Fails
   gracefully (a dash, or an empty ticker) rather than blocking the page:
   this is a marketing page, it should never look broken because a
   testnet RPC is having a moment. ── */
async function loadLiveStats() {
  try {
    const provider = buildReadProvider();
    const registry = new ethers.Contract(CFG.registryAddress, CFG.registryAbi, provider);

    const count = Number(await withRetry(() => registry.getCreatorCount()));
    document.getElementById('statCreators').textContent = count;

    if (count === 0) return;

    const addresses = [];
    for (let i = 0; i < count; i++) {
      addresses.push(await withRetry(() => registry.creatorAddresses(i)));
      await sleep(200);
    }
    const profiles = [];
    for (const addr of addresses) {
      const [p, socials] = await withRetry(() => registry.getCreator(addr));
      profiles.push({ name: p.name, niche: p.niche, socials });
      await sleep(200);
    }

    const items = profiles.map((c) => {
      const top = [...c.socials].sort((a, b) => Number(b.followers) - Number(a.followers))[0];
      const handle = top ? '@' + top.url.replace(/\/$/, '').replace(/^.*\//, '').replace(/^@/, '') : c.name;
      const count = top ? formatFollowers(top.followers) : '';
      return { handle, count, niche: c.niche };
    });
    if (!items.length) return;
    const doubled = [...items, ...items, ...items, ...items];
    document.getElementById('lTickerTrack').innerHTML = doubled
      .map((d) => `<span class="lticker-item"><span class="h">${escapeHtml(d.handle)}</span><span class="c">${escapeHtml(d.count)}</span><span class="d"></span><span>${escapeHtml(d.niche)}</span></span>`)
      .join('');
  } catch (err) {
    document.getElementById('statCreators').textContent = '—';
  }
}

wireFooterContractLinks();
loadLiveStats();
