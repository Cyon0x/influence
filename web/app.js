/* ══════════════════════════════════════════════════════════════
   Influence — Arc testnet escrow marketplace
   Real on-chain app: CreatorRegistry + InfluenceEscrow via ethers.js.
   No backend — every read/write goes straight to Arc testnet.
   ══════════════════════════════════════════════════════════════ */

const CFG = window.INFLUENCE_CONFIG;

const PALETTE = [
  ['#E91E8C', '#FF6B35'], ['#3ECF8E', '#0EA5E9'], ['#8B5CF6', '#EC4899'],
  ['#F59E0B', '#FF5C5C'], ['#0EA5E9', '#FFB86B'], ['#FF6B9D', '#FFB86B'],
  ['#22D3EE', '#6366F1'], ['#F472B6', '#FB923C'], ['#34D399', '#3B82F6'],
  ['#A78BFA', '#F43F5E'],
];

const PLATFORM_ICON = {
  Instagram: '📸', TikTok: '🎵', YouTube: '▶', Twitter: '𝕏',
  Facebook: 'f', LinkedIn: 'in',
};

// Base domain + path prefix used to build a full URL from a bare handle,
// e.g. TikTok handles are conventionally linked as tiktok.com/@handle.
const PLATFORM_BASE = {
  Instagram: { domain: 'instagram.com', handlePrefix: '' },
  TikTok: { domain: 'tiktok.com', handlePrefix: '@' },
  YouTube: { domain: 'youtube.com', handlePrefix: '@' },
  Twitter: { domain: 'x.com', handlePrefix: '' },
};

/* Turns whatever a creator typed into the social-link field — a bare handle
   ("adaeze_fashion"), an @handle ("@adaeze_fashion"), a protocol-less URL
   ("instagram.com/adaeze_fashion"), or a full URL — into one consistent,
   real https:// URL before it's ever sent to the contract. Returns '' if
   the input is empty or normalization can't produce something link-shaped,
   so callers can skip storing/rendering a bad entry instead of saving junk. */
function normalizeSocialUrl(platform, raw) {
  const s = String(raw || '').trim();
  if (!s) return '';

  if (/^https?:\/\//i.test(s)) {
    return /^https?:\/\/.+\..+/i.test(s) ? s : '';
  }

  const bare = s.replace(/^@/, '').trim();
  if (!bare) return '';

  // Already looks like "domain.tld/..." without a protocol.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(bare)) {
    return 'https://' + bare;
  }

  // Otherwise treat it as a bare handle for this platform.
  const base = PLATFORM_BASE[platform];
  if (!base) return '';
  const handle = bare.replace(/^@/, '');
  if (!handle) return '';
  return `https://${base.domain}/${base.handlePrefix}${handle}`;
}

const DEAL_STATUS = ['Active', 'ProofSubmitted', 'Completed', 'Cancelled'];
const AUTO_RELEASE_SECONDS = 48 * 3600;

/* ── State ── */
let readProvider = null;
let browserProvider = null;
let signer = null;
let userAddress = null;
let creatorsList = [];
let creatorsMap = new Map();
let selectedHireAddress = null;
let currentDealFilter = 'all';
let dealsCache = [];
let reviewRatingState = {}; // dealId -> selected stars for the "leave a review" form (default 5)

/* Reading through a single RPC leaves the whole marketplace dead if that one
   provider ever breaks — which happened in production (Arc's primary RPC
   started failing CORS preflight for all browser requests while still
   working fine from curl/servers, since CORS isn't enforced there). A
   FallbackProvider with quorum:1 tries the primary first and only spends
   the ~3s stall timeout falling through to the backup on genuine failure —
   it doesn't double every read against both providers on the happy path. */
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

/* ── Contracts ── */
function registryRead() { return new ethers.Contract(CFG.registryAddress, CFG.registryAbi, readProvider); }
function escrowReadC() { return new ethers.Contract(CFG.escrowAddress, CFG.escrowAbi, readProvider); }
function reviewsReadC() { return new ethers.Contract(CFG.reviewsAddress, CFG.reviewsAbi, readProvider); }
function registryWrite() { return new ethers.Contract(CFG.registryAddress, CFG.registryAbi, signer); }
function escrowWrite() { return new ethers.Contract(CFG.escrowAddress, CFG.escrowAbi, signer); }
function reviewsWrite() { return new ethers.Contract(CFG.reviewsAddress, CFG.reviewsAbi, signer); }

/* ── Small helpers ── */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }
function initialsFor(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}
function fmtUSDC(weiBig, decimals = 2) {
  const n = parseFloat(ethers.formatEther(weiBig));
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function formatFollowers(n) {
  n = Number(n);
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'K';
  return String(n);
}
function colorsFromAddress(addr) {
  let h = 0;
  for (const c of addr.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function relativeTime(date) {
  const secs = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  if (secs < 86400 * 30) return Math.floor(secs / 86400) + 'd ago';
  return Math.floor(secs / (86400 * 30)) + 'mo ago';
}
function safeLinkOrText(url) {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) {
    return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" style="color:var(--blue);text-decoration:none;word-break:break-all;">${escapeHtml(u)}</a>`;
  }
  return escapeHtml(u);
}
/* Real, clickable social badge — an <a> only when the stored url actually
   looks like an http(s) link (it always will for anything saved through
   normalizeSocialUrl, but this stays defensive against any future direct
   contract call that bypasses the frontend). stopPropagation keeps a click
   on the badge from also triggering the card's "open hire modal" handler. */
function socialBadgeHtml(s) {
  const icon = PLATFORM_ICON[s.platform] || '🔗';
  const label = `${icon} ${escapeHtml(s.platform)} <span class="count">${formatFollowers(s.followers)}</span>`;
  if (/^https?:\/\//i.test(s.url || '')) {
    return `<a class="platform-badge" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${label}</a>`;
  }
  return `<span class="platform-badge">${label}</span>`;
}

function starsHtml(rating) {
  const rounded = Math.round(rating);
  return '★★★★★'.slice(0, rounded) + '☆☆☆☆☆'.slice(0, 5 - rounded);
}
function txErrorMessage(err) {
  if (err?.code === 'ACTION_REJECTED' || err?.code === 4001) return 'Transaction rejected in wallet.';
  const reason = err?.reason || err?.shortMessage || err?.error?.message || err?.message || 'Transaction failed.';
  return reason.length > 160 ? reason.slice(0, 160) + '…' : reason;
}

/* The public Arc testnet RPC rate-limits aggressively (JSON-RPC code -32011,
   "request limit reached"); ethers.js surfaces that as a generic "missing
   revert data" CALL_EXCEPTION instead of a network error, so every read
   goes through this retry/backoff wrapper and reads are throttled below. */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isRateLimitError(err) {
  return err?.info?.error?.code === -32011 || /request limit/i.test(err?.info?.error?.message || err?.shortMessage || '');
}
async function withRetry(fn, retries = 6, baseDelay = 500) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= retries) throw err;
      await sleep(baseDelay * Math.pow(1.6, attempt));
    }
  }
}
async function mapSerial(items, fn, delayMs = 350) {
  const out = [];
  for (const item of items) {
    out.push(await withRetry(() => fn(item)));
    if (delayMs) await sleep(delayMs);
  }
  return out;
}

/* ── Toast ── */
function showToast(icon, msg, isError) {
  const t = document.getElementById('toast');
  document.getElementById('toastIcon').textContent = icon;
  document.getElementById('toastMsg').innerHTML = msg;
  t.style.borderColor = isError ? 'var(--red)' : 'var(--border)';
  t.classList.add('show');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), 5000);
}
function explorerTxLink(hash) {
  return `<a href="${CFG.explorer}/tx/${hash}" target="_blank" rel="noopener noreferrer">view tx ↗</a>`;
}

/* Pulls dealId out of a DealCreated receipt — createDeal()'s return value
   isn't directly readable from a mined tx, so it's decoded from the emitted
   event log instead. */
function findEventArgs(receipt, contract, eventName) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === eventName) return parsed.args;
    } catch (err) {
      // Not this contract's log (or not decodable) — expected for most logs, skip.
    }
  }
  return null;
}

/* Best-effort trigger for the near-instant notification email — fire and
   forget. If this fails silently (network blip, function cold-start error,
   whatever), the daily cron backstop in api/cron/notify-backstop.js will
   still catch it from the real on-chain event, so a failure here is never
   the difference between "notified" and "never notified," only "instant"
   vs "up to a day later." Never surfaced to the user — an email side effect
   isn't worth interrupting a successful on-chain transaction over. */
function triggerNotify(kind, dealId, txHash, extra = {}) {
  fetch(`/api/notify/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dealId, txHash, ...extra }),
  }).catch(() => {});
}

/* ── Theme ── */
function toggleTheme() {
  const html = document.documentElement;
  const isLight = html.getAttribute('data-theme') === 'light';
  html.setAttribute('data-theme', isLight ? 'dark' : 'light');
  document.querySelector('#themeToggle .theme-icon').textContent = isLight ? '🌙' : '☀️';
  localStorage.setItem('influence_theme', isLight ? 'dark' : 'light');
}
(function initTheme() {
  const saved = localStorage.getItem('influence_theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  }
})();

/* ── Mobile sidebar ── */
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
}

/* ── Nav switching ── */
function switchNav(el, viewId) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  el.classList.add('active');
  activateView(viewId);
}
function switchNavById(viewId) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const items = document.querySelectorAll('.nav-item');
  const map = { marketplace: 0, how: 1, register: 2, deals: 3, support: 4 };
  if (items[map[viewId]]) items[map[viewId]].classList.add('active');
  activateView(viewId);
}
function activateView(viewId) {
  ['marketplace', 'how', 'register', 'deals', 'support'].forEach((id) => {
    const v = document.getElementById('view-' + id);
    if (v) v.style.display = id === viewId ? 'block' : 'none';
  });
  closeSidebar();
  window.scrollTo(0, 0);
  if (viewId === 'deals') loadMyDeals();
  if (viewId === 'support') prefillSupportCenter();
}

/* ── Wallet connection ──────────────────────────────────────────
   Two independent auth paths that converge on the same downstream state
   (userAddress / signer / browserProvider): MetaMask (or any injected
   window.ethereum) and Privy (Twitter/email -> embedded wallet, via the
   auth-widget.js bridge script — see auth-widget/src/main.jsx). Once
   connected via either path, every contract call elsewhere in this file is
   identical — they only ever touch `signer`, never care where it came from.
   activeAuthMethod tracks which one is live, so disconnect and the
   MetaMask-only account/chain-change listeners know whether to act. */
let activeAuthMethod = null; // null | 'metamask' | 'privy'

function privyAvailable() {
  return typeof window.InfluenceAuth !== 'undefined' && !window.InfluenceAuth.failed;
}

async function onConnectClick() {
  const hasMetaMask = Boolean(window.ethereum);
  const hasPrivy = privyAvailable();

  if (hasMetaMask && hasPrivy) {
    document.getElementById('authChooserModal').classList.add('show');
    return;
  }
  if (hasPrivy) {
    closeAuthChooser();
    await connectViaPrivy();
    return;
  }
  if (hasMetaMask) {
    closeAuthChooser();
    await connectViaMetaMask(true);
    return;
  }
  showToast('⚠️', 'No wallet extension found, and social login is unavailable right now. Install MetaMask to continue.', true);
}

function closeAuthChooser() {
  document.getElementById('authChooserModal').classList.remove('show');
}

async function chooseMetaMask() {
  closeAuthChooser();
  await connectViaMetaMask(true);
}

async function choosePrivy() {
  closeAuthChooser();
  await connectViaPrivy();
}

async function connectViaMetaMask(interactive) {
  const btn = document.getElementById('connectBtn');
  try {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    const accounts = interactive
      ? await window.ethereum.request({ method: 'eth_requestAccounts' })
      : await window.ethereum.request({ method: 'eth_accounts' });

    if (!accounts || accounts.length === 0) {
      btn.disabled = false;
      btn.textContent = 'Connect Wallet';
      return;
    }

    // Ensure the correct network *before* constructing the ethers provider —
    // ethers.BrowserProvider treats a chain change observed mid-session as a
    // safety error ("network changed"), not something to swallow. Doing the
    // switch first means it only ever sees the already-correct network.
    const onArcNetwork = await ensureArcNetworkRaw(true);

    browserProvider = new ethers.BrowserProvider(window.ethereum);
    signer = await browserProvider.getSigner();
    userAddress = accounts[0];
    activeAuthMethod = 'metamask';
    localStorage.setItem('influence_connected', 'metamask');

    const network = await browserProvider.getNetwork();
    updateNetworkBanner(Number(network.chainId));
    if (onArcNetwork && Number(network.chainId) === CFG.chainId) showToast('🔗', 'Connected to Arc Testnet.');

    updateWalletUI();
    if (document.getElementById('view-deals').style.display !== 'none') loadMyDeals();
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  } finally {
    btn.disabled = false;
    if (!userAddress) btn.textContent = 'Connect Wallet';
  }
}

async function connectViaPrivy() {
  if (!privyAvailable()) {
    showToast('⚠️', 'Social login is unavailable right now.', true);
    return;
  }
  await window.InfluenceAuth.ready;
  window.InfluenceAuth.login();
  // Completion (success or cancel) arrives asynchronously via the onChange
  // listener registered in init() — Privy's own modal handles the
  // Twitter-vs-email choice, there's nothing to await synchronously here.
}

// Fired whenever Privy's auth state changes — a fresh login, a session
// Privy restored automatically on page load, or a logout.
async function onPrivyAuthChange({ authenticated, address }) {
  if (authenticated && address) {
    try {
      const provider = await window.InfluenceAuth.getProvider();
      browserProvider = new ethers.BrowserProvider(provider);
      signer = await browserProvider.getSigner();
      userAddress = address;
      activeAuthMethod = 'privy';
      localStorage.setItem('influence_connected', 'privy');

      const network = await browserProvider.getNetwork();
      updateNetworkBanner(Number(network.chainId));
      updateWalletUI();
      if (document.getElementById('view-deals').style.display !== 'none') loadMyDeals();
    } catch (err) {
      showToast('⚠️', txErrorMessage(err), true);
    }
  } else if (activeAuthMethod === 'privy') {
    userAddress = null;
    signer = null;
    browserProvider = null;
    activeAuthMethod = null;
    localStorage.removeItem('influence_connected');
    updateWalletUI();
  }
}

function updateWalletUI() {
  const connectBtn = document.getElementById('connectBtn');
  const chip = document.getElementById('walletChip');
  const addrEl = document.getElementById('walletAddr');
  const userRow = document.getElementById('sidebarUserRow');
  const userAddrEl = document.getElementById('sidebarUserAddr');
  const userAvatar = document.getElementById('sidebarUserAvatar');

  if (userAddress) {
    connectBtn.style.display = 'none';
    chip.style.display = 'flex';
    addrEl.textContent = shortAddr(userAddress);
    userRow.style.display = 'flex';
    userAddrEl.textContent = shortAddr(userAddress);
    userAvatar.textContent = userAddress.slice(2, 3).toUpperCase();
  } else {
    connectBtn.style.display = 'block';
    connectBtn.textContent = 'Connect Wallet';
    chip.style.display = 'none';
    userRow.style.display = 'none';
  }
}

function openExplorerForAddress() {
  if (userAddress) window.open(`${CFG.explorer}/address/${userAddress}`, '_blank', 'noopener');
}

async function disconnectWallet() {
  if (activeAuthMethod === 'privy' && privyAvailable()) {
    try {
      window.InfluenceAuth.logout();
    } catch (err) {
      // Continue regardless — local state below is what actually matters.
    }
  } else {
    // There's no universal EIP-1193 "disconnect" — MetaMask and a few others
    // support revoking the eth_accounts permission programmatically, so this
    // asks for that where possible, but it's a best-effort bonus, not
    // required: clearing local state below is what actually makes the app
    // forget the connection and stop auto-reconnecting on the next visit.
    try {
      await window.ethereum?.request({
        method: 'wallet_revokePermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch (err) {
      // Wallet doesn't support programmatic revocation — fine, continue below.
    }
  }

  userAddress = null;
  signer = null;
  browserProvider = null;
  activeAuthMethod = null;
  localStorage.removeItem('influence_connected');
  document.getElementById('networkBanner').classList.remove('show');
  updateWalletUI();
  if (document.getElementById('view-deals').style.display !== 'none') loadMyDeals();
  showToast('👋', 'Wallet disconnected.');
}

function updateNetworkBanner(chainId) {
  const banner = document.getElementById('networkBanner');
  if (chainId !== CFG.chainId) banner.classList.add('show');
  else banner.classList.remove('show');
}

/* Talks to window.ethereum only — deliberately never touches browserProvider
   or ethers at all, so it's safe to call before those exist (the connect
   flow) or after (the manual banner button). Returns true once the wallet
   is confirmed on Arc Testnet, false otherwise.

   silent=true is used right after a fresh connect, so the app doesn't nag
   with an error toast if the user simply dismisses the switch/add prompt —
   the persistent "Wrong network" banner (updateNetworkBanner) is the calm
   fallback either way, so declining here never leaves the user stuck with
   no way to fix it. silent=false is the manual "Switch network" banner
   button, where showing what went wrong is the whole point. */
async function ensureArcNetworkRaw(silent = false) {
  try {
    const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (typeof currentChainId === 'string' && currentChainId.toLowerCase() === CFG.chainIdHex.toLowerCase()) return true;
  } catch (err) {
    // Fall through and attempt the switch anyway.
  }

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CFG.chainIdHex }],
    });
    return true;
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CFG.chainIdHex,
            chainName: 'Arc Testnet',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            rpcUrls: [CFG.rpcUrl, CFG.rpcUrlFallback].filter(Boolean),
            blockExplorerUrls: [CFG.explorer],
          }],
        });
        return true;
      } catch (addErr) {
        if (!silent) showToast('⚠️', txErrorMessage(addErr), true);
        return false;
      }
    }
    if (!silent) showToast('⚠️', txErrorMessage(switchErr), true);
    return false;
  }
}

/* Manual "Switch network" banner button — the user is already connected, so
   an existing browserProvider/signer are live and must be rebuilt after a
   successful switch (same "network changed" reasoning as connectViaMetaMask). */
async function switchToArcTestnet() {
  const ok = await ensureArcNetworkRaw(false);
  if (!ok) return;
  browserProvider = new ethers.BrowserProvider(window.ethereum);
  signer = await browserProvider.getSigner();
  const network = await browserProvider.getNetwork();
  updateNetworkBanner(Number(network.chainId));
  if (Number(network.chainId) === CFG.chainId) showToast('🔗', 'Connected to Arc Testnet.');
}

function requireReadyToTransact() {
  if (!signer || !userAddress) {
    showToast('🔌', 'Connect your wallet first.', true);
    return false;
  }
  return true;
}

/* ── Local time badges ── */
function iconForHour(h) {
  if (h >= 5 && h < 7) return '🌅';
  if (h >= 7 && h < 17) return '☀️';
  if (h >= 17 && h < 19) return '🌇';
  return '🌙';
}
function updateLocalTimes() {
  document.querySelectorAll('.local-time-badge').forEach((badge) => {
    const tz = parseFloat(badge.getAttribute('data-tz'));
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const local = new Date(utcMs + tz * 3600000);
    let h = local.getHours();
    const m = local.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = (h % 12) || 12;
    badge.querySelector('.clock-icon').textContent = iconForHour(h);
    badge.querySelector('.clock-time').textContent = `${h12}:${m} ${ampm}`;
  });
}
setInterval(updateLocalTimes, 30000);

/* ── Ticker ── */
function buildTicker() {
  const track = document.getElementById('tickerTrack');
  if (!creatorsList.length) return;
  const items = creatorsList.map((c) => {
    const top = [...c.socials].sort((a, b) => Number(b.followers) - Number(a.followers))[0];
    const handle = top ? '@' + top.url.replace(/\/$/, '').replace(/^.*\//, '').replace(/^@/, '') : c.name;
    const count = top ? formatFollowers(top.followers) : '';
    return { handle, count, niche: c.niche };
  });
  const doubled = [...items, ...items];
  track.innerHTML = doubled
    .map((d) => `<span class="ticker-item"><span class="t-handle">${escapeHtml(d.handle)}</span><span class="t-count">${escapeHtml(d.count)}</span><span class="t-dot"></span><span>${escapeHtml(d.niche)}</span></span>`)
    .join('');
}

/* ── Load creators from CreatorRegistry ── */
async function loadCreators() {
  try {
    const registry = registryRead();
    const count = Number(await withRetry(() => registry.getCreatorCount()));
    const addresses = await mapSerial(
      Array.from({ length: count }, (_, i) => i),
      (i) => registry.creatorAddresses(i)
    );
    const profiles = await mapSerial(addresses, (a) => registry.getCreator(a));

    creatorsList = addresses.map((addr, i) => {
      const [p, socials] = profiles[i];
      return {
        address: addr,
        name: p.name,
        niche: p.niche,
        location: p.location,
        bio: p.bio,
        tz: Number(p.tzOffsetTenths) / 10,
        colorA: p.colorA,
        colorB: p.colorB,
        ratePerPost: p.ratePerPost,
        verified: p.verified,
        socials: socials.map((s) => ({ platform: s.platform, url: s.url, followers: Number(s.followers) })),
      };
    });
    creatorsMap = new Map(creatorsList.map((c) => [c.address.toLowerCase(), c]));

    document.getElementById('statCreatorCount').textContent = creatorsList.length;

    const nicheSelect = document.getElementById('filterNiche');
    const niches = [...new Set(creatorsList.map((c) => c.niche).filter(Boolean))].sort();
    nicheSelect.innerHTML = '<option value="">All niches</option>' + niches.map((n) => `<option>${escapeHtml(n)}</option>`).join('');

    renderMarketplace();
    buildTicker();
    updateLocalTimes();
  } catch (err) {
    document.getElementById('influencerGrid').innerHTML =
      `<div class="deals-empty" style="grid-column:1/-1;"><div class="emoji">⚠️</div>Couldn't load creators from Arc testnet.<br/><span style="font-size:11px;">${escapeHtml(txErrorMessage(err))}</span></div>`;
  }

  computePaidOutStat();
}

async function computePaidOutStat() {
  try {
    const escrow = escrowReadC();
    const events = await withRetry(() => escrow.queryFilter(escrow.filters.DealReleased()));
    let total = 0n;
    for (const ev of events) total += ev.args.creatorAmount + ev.args.feeAmount;
    document.getElementById('statPaidOut').innerHTML = '$' + fmtUSDC(total, 0);
  } catch (err) {
    document.getElementById('statPaidOut').textContent = '—';
  }
}

/* ── Marketplace rendering + filters ── */
let activePill = 'all';
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pillRow').addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    activePill = pill.dataset.pill;
    renderMarketplace();
  });
});

function maxFollowers(c) {
  return c.socials.reduce((m, s) => Math.max(m, Number(s.followers)), 0);
}
/* Ratings live only in the Reviews contract now (no cached aggregate on
   CreatorRegistry), so there's no cheap way to show a rating on every grid
   card without fetching each creator's full review list up front — which
   would multiply RPC calls against an already rate-limited endpoint. Rating
   is instead fetched live, per creator, only when the hire modal opens. */
function avgRatingFromReviews(reviews) {
  if (!reviews.length) return null;
  return reviews.reduce((sum, r) => sum + Number(r.stars), 0) / reviews.length;
}

function renderMarketplace() {
  const grid = document.getElementById('influencerGrid');
  if (!creatorsList.length) {
    grid.innerHTML = `<div class="deals-empty" style="grid-column:1/-1;"><div class="emoji">🌱</div>No creators registered yet — be the first!</div>`;
    return;
  }

  const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  const platform = document.getElementById('filterPlatform').value;
  const niche = document.getElementById('filterNiche').value;
  const budget = document.getElementById('filterBudget').value;

  let list = creatorsList.filter((c) => {
    if (search) {
      const hay = [c.name, c.niche, c.location, ...c.socials.map((s) => s.url)].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (platform && !c.socials.some((s) => s.platform === platform)) return false;
    if (niche && c.niche !== niche) return false;
    if (budget) {
      const [min, max] = budget.split('-').map(Number);
      const rate = parseFloat(ethers.formatEther(c.ratePerPost));
      if (rate < min || rate >= max) return false;
    }
    const mf = maxFollowers(c);
    if (activePill === '1m' && mf < 1000000) return false;
    if (activePill === '100k-1m' && !(mf >= 100000 && mf < 1000000)) return false;
    if (activePill === '10k-100k' && !(mf >= 10000 && mf < 100000)) return false;
    if (activePill === 'micro' && mf >= 10000) return false;
    if (activePill === 'verified' && !c.verified) return false;
    return true;
  });

  list = [...list].sort((a, b) => maxFollowers(b) - maxFollowers(a));

  if (!list.length) {
    grid.innerHTML = `<div class="deals-empty" style="grid-column:1/-1;"><div class="emoji">🔍</div>No creators match those filters.</div>`;
    return;
  }

  grid.innerHTML = list.map(buildCreatorCardHtml).join('');
  updateLocalTimes();
}

function buildCreatorCardHtml(c) {
  const gradient = `linear-gradient(135deg,${c.colorA},${c.colorB})`;
  const socialsHtml = c.socials.slice(0, 3).map(socialBadgeHtml).join('');

  return `
  <div class="inf-card" onclick="openModalForAddress('${c.address}')">
    <div class="inf-card-top">
      <div class="inf-profile">
        <div class="inf-avatar" style="background:${gradient};">${escapeHtml(initialsFor(c.name))}</div>
        <div>
          <div class="inf-name">${escapeHtml(c.name)} ${c.verified ? '<span class="verified">✓ Verified</span>' : ''}</div>
          <div class="inf-location">${escapeHtml(c.niche)} · ${escapeHtml(c.location)} <span class="local-time-badge" data-tz="${c.tz}"><span class="clock-icon">•</span><span class="clock-time">--:--</span></span></div>
        </div>
      </div>
      <div class="niche-tag">${escapeHtml(c.niche)}</div>
      <div class="inf-bio">${escapeHtml(c.bio)}</div>
      <div class="platform-row">${socialsHtml}</div>
    </div>
    <div class="inf-card-bottom">
      <div><div class="inf-rate">${fmtUSDC(c.ratePerPost, 0)} USDC</div><div class="inf-rate-label">per post · 1% platform fee</div></div>
      <button class="hire-btn" onclick="event.stopPropagation();openModalForAddress('${c.address}')">Hire →</button>
    </div>
  </div>`;
}

/* ── Hire modal ── */
function openModalForAddress(addr) {
  const c = creatorsMap.get(addr.toLowerCase());
  if (!c) return;
  selectedHireAddress = c.address;

  const gradient = `linear-gradient(135deg,${c.colorA},${c.colorB})`;
  document.getElementById('modalAvatar').style.background = gradient;
  document.getElementById('modalAvatar').textContent = initialsFor(c.name);
  document.getElementById('modalName').textContent = c.name;
  document.getElementById('modalVerifiedBadge').style.display = c.verified ? 'inline-flex' : 'none';
  document.getElementById('modalSub').textContent = `${c.niche} · ${c.location}`;
  document.getElementById('modalAddr').textContent = shortAddr(c.address);

  const modalSocials = document.getElementById('modalSocials');
  modalSocials.innerHTML = c.socials.length
    ? c.socials.map(socialBadgeHtml).join('')
    : '<span style="font-size:12px;color:var(--muted);">No social links provided.</span>';

  document.getElementById('modalStars').textContent = '';
  document.getElementById('modalRating').textContent = '…';
  document.getElementById('modalDeals').textContent = '';

  const rate = c.ratePerPost;
  const feeWei = (rate * 100n) / 10000n;
  const creatorWei = rate - feeWei;
  document.getElementById('modalTotal').textContent = fmtUSDC(rate) + ' USDC';
  document.getElementById('modalBaseRate').textContent = fmtUSDC(creatorWei) + ' USDC';
  document.getElementById('modalFee').textContent = fmtUSDC(feeWei) + ' USDC';
  document.getElementById('modalEscrow1').textContent = 'You lock ' + fmtUSDC(rate) + ' USDC';
  document.getElementById('modalPayBtn').textContent = `⚡ Lock ${fmtUSDC(rate)} USDC in Escrow →`;
  document.getElementById('modalPayBtn').disabled = false;
  document.getElementById('modalBrief').value = '';

  document.getElementById('modalReviews').innerHTML = '<div style="font-size:12px;color:var(--muted);">Loading reviews…</div>';
  withRetry(() => reviewsReadC().getReviews(c.address)).then((reviews) => {
    const rating = avgRatingFromReviews(reviews);
    document.getElementById('modalStars').textContent = rating !== null ? starsHtml(rating) : '';
    document.getElementById('modalRating').textContent = rating !== null ? rating.toFixed(1) : 'New';
    document.getElementById('modalDeals').textContent = reviews.length ? `· ${reviews.length} review${reviews.length === 1 ? '' : 's'}` : '';

    if (!reviews.length) {
      document.getElementById('modalReviews').innerHTML = '<div style="font-size:12px;color:var(--muted);">No reviews yet — reviews appear here once a brand completes a paid deal with this creator and reviews it.</div>';
      return;
    }
    document.getElementById('modalReviews').innerHTML = [...reviews].reverse().map((r) => {
      const date = new Date(Number(r.timestamp) * 1000);
      return `<div class="review-item">
        <div class="review-top"><div class="reviewer-name">${escapeHtml(shortAddr(r.brand))}</div><div class="review-stars">${starsHtml(Number(r.stars))}</div></div>
        <div class="review-text">${r.text ? escapeHtml(r.text) : '<span style=\'opacity:0.6\'>No written comment.</span>'}</div>
        <div class="review-date">${relativeTime(date)} · deal #${Number(r.dealId)}</div>
      </div>`;
    }).join('');
  }).catch(() => {
    document.getElementById('modalReviews').innerHTML = '<div style="font-size:12px;color:var(--muted);">Couldn\'t load reviews.</div>';
    document.getElementById('modalRating').textContent = '';
  });

  document.getElementById('hireModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  document.getElementById('hireModal').classList.remove('show');
  document.body.style.overflow = '';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modalPayBtn').addEventListener('click', hireSelectedCreator);
});

async function hireSelectedCreator() {
  if (!requireReadyToTransact()) return;
  const c = creatorsMap.get(selectedHireAddress.toLowerCase());
  if (!c) return;
  if (c.address.toLowerCase() === userAddress.toLowerCase()) {
    showToast('⚠️', "You can't hire yourself.", true);
    return;
  }
  const brief = document.getElementById('modalBrief').value.trim();
  if (!brief) {
    showToast('⚠️', 'Please describe the job in the brief first.', true);
    document.getElementById('modalBrief').focus();
    return;
  }

  const btn = document.getElementById('modalPayBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  try {
    const network = await browserProvider.getNetwork();
    if (Number(network.chainId) !== CFG.chainId) {
      showToast('⚠️', 'Switch your wallet to Arc Testnet first.', true);
      return;
    }
    btn.textContent = '⏳ Confirm in wallet…';
    const tx = await escrowWrite().createDeal(c.address, brief, { value: c.ratePerPost });
    btn.textContent = '⏳ Locking funds on Arc…';
    const receipt = await tx.wait();
    showToast('🔒', `${fmtUSDC(c.ratePerPost)} USDC locked in escrow for ${escapeHtml(c.name)}. ${explorerTxLink(receipt.hash)}`);
    const created = findEventArgs(receipt, escrowWrite(), 'DealCreated');
    if (created) triggerNotify('hired', Number(created.dealId), receipt.hash);
    closeModal();
    switchNavById('deals');
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* ── Register creator profile ── */
function updateRatePreview(val) {
  const n = parseFloat(val) || 0;
  document.getElementById('ratePreview').textContent = (n * 0.99).toFixed(2) + ' USDC';
}

async function submitRegisterProfile() {
  if (!requireReadyToTransact()) return;

  const name = document.getElementById('regName').value.trim();
  const location = document.getElementById('regLocation').value.trim();
  const tzInput = document.getElementById('regTz').value.trim();
  const bio = document.getElementById('regBio').value.trim();
  const niche = document.getElementById('regNiche').value;
  const rateStr = document.getElementById('rateInput').value.trim();

  if (!name) { showToast('⚠️', 'Please enter your name.', true); return; }
  const rate = parseFloat(rateStr);
  if (!rate || rate <= 0) { showToast('⚠️', 'Please enter a valid rate in USDC.', true); return; }

  const tz = tzInput === '' ? 0 : Math.round(parseFloat(tzInput) * 10);

  const socialRows = [
    ['Instagram', 'socInstagram', 'socInstagramCount'],
    ['TikTok', 'socTiktok', 'socTiktokCount'],
    ['YouTube', 'socYoutube', 'socYoutubeCount'],
    ['Twitter', 'socTwitter', 'socTwitterCount'],
  ];
  const socials = socialRows
    .map(([platform, handleId, countId]) => ({
      platform,
      url: normalizeSocialUrl(platform, document.getElementById(handleId).value),
      followers: parseInt(document.getElementById(countId).value, 10) || 0,
    }))
    .filter((s) => s.url.length > 0);

  const [colorA, colorB] = colorsFromAddress(userAddress);

  const btn = document.getElementById('registerSubmitBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  try {
    const network = await browserProvider.getNetwork();
    if (Number(network.chainId) !== CFG.chainId) {
      showToast('⚠️', 'Switch your wallet to Arc Testnet first.', true);
      return;
    }
    btn.textContent = '⏳ Confirm in wallet…';
    const tx = await registryWrite().registerCreator(
      name, niche, location, bio, tz, colorA, colorB, ethers.parseEther(String(rate)), socials
    );
    btn.textContent = '⏳ Writing to Arc…';
    const receipt = await tx.wait();
    showToast('✦', `Profile live on Arc testnet! ${explorerTxLink(receipt.hash)}`);
    await loadCreators();
    switchNavById('marketplace');
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Must byte-for-byte match contactMessage() in web/api/contact.js — this is
// the exact string the wallet signs, and the server recovers the signer
// from it. No shared module between browser and serverless function here,
// so keep both in sync by hand.
function buildContactMessage(email, timestamp) {
  return `Set my Influence notification email to: ${email}\n\nTimestamp: ${timestamp}`;
}

async function saveNotificationEmail() {
  if (!requireReadyToTransact()) return;

  const email = document.getElementById('regEmail').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('⚠️', 'Please enter a valid email address.', true);
    return;
  }

  const btn = document.getElementById('regEmailSaveBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = '⏳ Confirm signature in wallet…';
    const timestamp = Date.now();
    const signature = await signer.signMessage(buildContactMessage(email, timestamp));

    btn.textContent = '⏳ Saving…';
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: userAddress, email, signature, timestamp }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `request failed (${res.status})`);
    }
    showToast('✉️', "Saved — we'll email you when you're hired and when funds are released.");
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* ── Deals ── */
function setDealFilter(filter) {
  currentDealFilter = filter;
  document.querySelectorAll('#roleSwitcher .role-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  renderDeals();
}

async function loadMyDeals() {
  const container = document.getElementById('dealsContainer');
  if (!userAddress) {
    container.innerHTML = `<div class="deals-empty"><div class="emoji">🔌</div>Connect your wallet to see your deals.</div>`;
    document.getElementById('dealsNavBadge').style.display = 'none';
    return;
  }
  container.innerHTML = `<div class="deals-empty"><div class="emoji">⏳</div>Loading your deals from Arc testnet…</div>`;

  try {
    const escrow = escrowReadC();
    const brandIds = await withRetry(() => escrow.getBrandDeals(userAddress));
    await sleep(350);
    const creatorIds = await withRetry(() => escrow.getCreatorDeals(userAddress));
    const roleById = new Map();
    brandIds.forEach((id) => roleById.set(Number(id), { ...(roleById.get(Number(id)) || {}), brand: true }));
    creatorIds.forEach((id) => roleById.set(Number(id), { ...(roleById.get(Number(id)) || {}), creator: true }));

    const ids = [...roleById.keys()];
    const rawDeals = await mapSerial(ids, (id) => escrow.deals(id));

    dealsCache = ids.map((id, i) => {
      const d = rawDeals[i];
      return {
        id,
        brand: d.brand,
        creator: d.creator,
        amount: d.amount,
        brief: d.brief,
        proofLink: d.proofLink,
        status: Number(d.status),
        createdAt: Number(d.createdAt),
        proofSubmittedAt: Number(d.proofSubmittedAt),
        completedAt: Number(d.completedAt),
        roles: roleById.get(id),
        reviewed: null, // filled in below for completed deals the viewer brand-owns
      };
    }).sort((a, b) => b.createdAt - a.createdAt);

    const activeCount = dealsCache.filter((d) => d.status === 0 || d.status === 1).length;
    document.getElementById('dealsNavBadge').style.display = activeCount > 0 ? 'inline-block' : 'none';
    document.getElementById('dealsNavBadge').textContent = activeCount;

    renderDeals();

    // Second pass: only for completed deals where this wallet is the brand,
    // check whether a review has already been submitted (needed to decide
    // whether to show the "leave a review" form).
    const reviewsC = reviewsReadC();
    const toCheck = dealsCache.filter((d) => d.status === 2 && d.roles.brand);
    if (toCheck.length) {
      const reviewed = await mapSerial(toCheck, (d) => reviewsC.hasReviewed(d.id));
      toCheck.forEach((d, i) => { d.reviewed = reviewed[i]; });
      renderDeals();
    }
  } catch (err) {
    container.innerHTML = `<div class="deals-empty"><div class="emoji">⚠️</div>Couldn't load deals.<br/><span style="font-size:11px;">${escapeHtml(txErrorMessage(err))}</span></div>`;
  }
}

function renderDeals() {
  const container = document.getElementById('dealsContainer');
  let list = dealsCache;
  if (currentDealFilter === 'brand') list = list.filter((d) => d.roles.brand);
  if (currentDealFilter === 'creator') list = list.filter((d) => d.roles.creator);

  const activeDeals = dealsCache.filter((d) => d.status === 0 || d.status === 1);
  const completedDeals = dealsCache.filter((d) => d.status === 2);
  const lockedTotal = activeDeals.reduce((sum, d) => sum + d.amount, 0n);
  document.getElementById('statActive').textContent = activeDeals.length;
  document.getElementById('statCompleted').textContent = completedDeals.length;
  document.getElementById('statLocked').textContent = fmtUSDC(lockedTotal, 0);

  if (!list.length) {
    container.innerHTML = `<div class="deals-empty"><div class="emoji">📋</div>No deals here yet. Hire a creator from the marketplace to get started.</div>`;
    return;
  }

  container.innerHTML = list.map(buildDealCardHtml).join('');
}

function dealCounterpartyLabel(d, isBrandView) {
  if (isBrandView) {
    const c = creatorsMap.get(d.creator.toLowerCase());
    return c ? escapeHtml(c.name) : shortAddr(d.creator);
  }
  return 'Brand ' + shortAddr(d.brand);
}

function autoReleaseStatus(d) {
  const elapsed = Math.floor(Date.now() / 1000) - d.proofSubmittedAt;
  const remaining = AUTO_RELEASE_SECONDS - elapsed;
  if (remaining <= 0) return { eligible: true, text: 'Auto-release available now' };
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  return { eligible: false, text: `Auto-release in ${h}h ${m}m` };
}

function buildDealCardHtml(d) {
  const isBrand = d.roles.brand;
  const isCreator = d.roles.creator;
  const statusMeta = [
    { cls: 'in-progress', label: '⏳ IN PROGRESS' },
    { cls: 'awaiting-ack', label: '🔵 PROOF SUBMITTED' },
    { cls: 'completed', label: '✅ COMPLETED' },
    { cls: 'cancelled', label: '↩️ CANCELLED' },
  ][d.status];
  const cardCls = ['', 'pending-proof', 'awaiting-brand', 'completed'][d.status] || '';
  const c = creatorsMap.get(d.creator.toLowerCase());
  const gradient = c ? `linear-gradient(135deg,${c.colorA},${c.colorB})` : 'linear-gradient(135deg,#3A2E42,#221A2E)';
  const name = c ? c.name : shortAddr(d.creator);

  let body = '';

  if (d.status === 0) {
    // Active: waiting on creator
    if (isCreator) {
      body = `
        <div class="proof-upload-panel">
          <div class="proof-upload-title">📤 Submit your proof of performance</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Paste a link to the post, or describe the deliverable + metrics. This is stored on-chain.</div>
          <input class="proof-upload-input" type="text" id="proof-input-${d.id}" placeholder="Post link, screenshot description, or metrics..." />
        </div>
        <button class="btn-mark-complete" onclick="submitProofForDeal(${d.id})">✅ Submit Proof</button>
        <div style="font-size:11px;color:var(--muted);text-align:center;margin-top:8px;">This notifies the brand to review your proof and release payment from escrow.</div>`;
    } else if (isBrand) {
      body = `
        <div style="background:var(--navy2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;text-align:center;">
          <div style="font-size:22px;margin-bottom:8px;">⏳</div>
          <div style="font-size:13px;font-weight:600;color:var(--muted);">Waiting for ${escapeHtml(name)} to submit proof</div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px;">You'll be able to review and release once proof is submitted.</div>
        </div>
        <button class="btn-secondary-line" onclick="cancelDealAction(${d.id})">✕ Cancel & reclaim funds</button>`;
    }
  } else if (d.status === 1) {
    // Proof submitted: waiting on brand (or auto-release)
    const ar = autoReleaseStatus(d);
    if (isBrand) {
      body = `
        <div class="proof-submitted-panel">
          <div class="proof-submitted-title">📋 Proof submitted by ${escapeHtml(name)}</div>
          <div class="proof-submitted-item"><strong>Proof:</strong>&nbsp;${safeLinkOrText(d.proofLink)}</div>
        </div>
        <button class="btn-acknowledge" onclick="approveDeal(${d.id})">✅ Acknowledge &amp; Release Funds</button>
        <div style="font-size:11px;color:var(--muted);text-align:center;margin-top:8px;">This releases ${fmtUSDC(d.amount * 99n / 100n)} USDC to ${escapeHtml(name)} and ${fmtUSDC(d.amount - d.amount * 99n / 100n)} USDC to Influence. Irreversible. You can leave a review once funds are released.</div>
        ${ar.eligible ? `<button class="btn-secondary-line auto" onclick="triggerAutoRelease(${d.id})">⏱ ${ar.text} — trigger it</button>` : ''}`;
    } else if (isCreator) {
      body = `
        <div class="completed-panel" style="background:rgba(111,168,220,0.08);border-color:rgba(111,168,220,0.3);">
          <div class="completed-icon">📤</div>
          <div>
            <div style="font-size:13px;font-weight:700;color:var(--blue);">Proof submitted — awaiting brand approval</div>
            <div style="font-size:11px;color:var(--muted);margin-top:3px;">${ar.text}.</div>
          </div>
        </div>
        ${ar.eligible ? `<button class="btn-secondary-line auto" onclick="triggerAutoRelease(${d.id})">⏱ Trigger auto-release now</button>` : ''}`;
    }
  } else if (d.status === 2) {
    const creatorAmt = d.amount * 99n / 100n;
    const feeAmt = d.amount - creatorAmt;
    body = `
      <div class="completed-panel">
        <div class="completed-icon">🎉</div>
        <div>
          <div class="completed-title">Funds released</div>
          <div class="completed-sub">${fmtUSDC(creatorAmt)} USDC → creator · ${fmtUSDC(feeAmt)} USDC → Influence · Total ${fmtUSDC(d.amount)} USDC</div>
        </div>
      </div>`;

    if (isBrand) {
      if (d.reviewed === null) {
        body += `<div style="font-size:11px;color:var(--muted);text-align:center;margin-top:10px;">Checking review status…</div>`;
      } else if (d.reviewed) {
        body += `<div style="font-size:12px;color:var(--mint);text-align:center;margin-top:10px;">✓ You've reviewed this deal.</div>`;
      } else {
        const stars = reviewRatingState[d.id] || 5;
        const starButtons = [1, 2, 3, 4, 5].map((n) =>
          `<button type="button" class="star-btn ${n <= stars ? 'on' : ''}" onclick="setReviewStars(${d.id},${n})">★</button>`
        ).join('');
        body += `
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">
            <label class="form-label">Leave a review for ${escapeHtml(name)}</label>
            <div class="rating-input">${starButtons}</div>
            <input class="proof-upload-input" type="text" id="review-text-${d.id}" placeholder="Optional review comment..." />
            <button class="btn-acknowledge" onclick="submitReviewForDeal(${d.id})">✍️ Submit Review</button>
          </div>`;
      }
    }
  } else {
    body = `
      <div class="completed-panel" style="background:rgba(167,155,176,0.1);border-color:var(--border);">
        <div class="completed-icon">↩️</div>
        <div>
          <div class="completed-title" style="color:var(--muted);">Deal cancelled</div>
          <div class="completed-sub">${fmtUSDC(d.amount)} USDC refunded to the brand.</div>
        </div>
      </div>`;
  }

  const roleTag = isBrand && isCreator ? '🏢🎙️ Brand + Creator' : isBrand ? '🏢 Brand' : '🎙️ Creator';

  return `
  <div class="deal-card ${cardCls}">
    <div class="deal-header">
      <div class="deal-creator-info">
        <div class="inf-avatar" style="width:38px;height:38px;font-size:14px;background:${gradient};flex-shrink:0;">${escapeHtml(initialsFor(name))}</div>
        <div>
          <div style="font-size:14px;font-weight:700;">${escapeHtml(name)}</div>
          <div style="font-size:11px;color:var(--muted);">${roleTag} · Deal #${d.id}</div>
        </div>
      </div>
      <div class="deal-status-badge ${statusMeta.cls}">${statusMeta.label}</div>
    </div>
    <div class="deal-body">
      <div class="deal-brief-label">Job brief</div>
      <div class="deal-brief-text">${escapeHtml(d.brief)}</div>
      ${body}
    </div>
    <div class="deal-footer">
      <div><div class="deal-amount">${fmtUSDC(d.amount)} USDC</div><div class="deal-amount-label">${d.status <= 1 ? 'locked in escrow' : 'total deal value'}</div></div>
      <div class="deal-timer"><div class="dot"></div>Arc Testnet · ${CFG.explorer.replace('https://', '')}</div>
    </div>
  </div>`;
}

function setReviewStars(dealId, n) {
  reviewRatingState[dealId] = n;
  renderDeals();
}

async function submitProofForDeal(dealId) {
  if (!requireReadyToTransact()) return;
  const input = document.getElementById(`proof-input-${dealId}`);
  const link = input ? input.value.trim() : '';
  if (!link) {
    showToast('⚠️', 'Please add a proof link or description first.', true);
    input?.focus();
    return;
  }
  try {
    showToast('⏳', 'Confirm the transaction in your wallet…');
    const tx = await escrowWrite().submitProof(dealId, link);
    const receipt = await tx.wait();
    showToast('📤', `Proof submitted on-chain. ${explorerTxLink(receipt.hash)}`);
    loadMyDeals();
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  }
}

async function approveDeal(dealId) {
  if (!requireReadyToTransact()) return;
  try {
    showToast('⏳', 'Confirm the transaction in your wallet…');
    const tx = await escrowWrite().approveAndRelease(dealId);
    const receipt = await tx.wait();
    showToast('💸', `Funds released on Arc! ${explorerTxLink(receipt.hash)}`);
    triggerNotify('released', dealId, receipt.hash, { auto: false });
    loadMyDeals();
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  }
}

async function submitReviewForDeal(dealId) {
  if (!requireReadyToTransact()) return;
  const stars = reviewRatingState[dealId] || 5;
  const textInput = document.getElementById(`review-text-${dealId}`);
  const text = textInput ? textInput.value.trim() : '';
  try {
    showToast('⏳', 'Confirm the transaction in your wallet…');
    const tx = await reviewsWrite().submitReview(dealId, stars, text);
    const receipt = await tx.wait();
    showToast('✍️', `Review submitted on-chain. ${explorerTxLink(receipt.hash)}`);
    loadMyDeals();
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  }
}

async function triggerAutoRelease(dealId) {
  if (!requireReadyToTransact()) return;
  try {
    showToast('⏳', 'Confirm the transaction in your wallet…');
    const tx = await escrowWrite().autoRelease(dealId);
    const receipt = await tx.wait();
    showToast('💸', `Auto-release complete. ${explorerTxLink(receipt.hash)}`);
    triggerNotify('released', dealId, receipt.hash, { auto: true });
    loadMyDeals();
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  }
}

async function cancelDealAction(dealId) {
  if (!requireReadyToTransact()) return;
  if (!window.confirm('Cancel this deal and reclaim your funds? The creator will no longer be able to deliver against it.')) return;
  try {
    showToast('⏳', 'Confirm the transaction in your wallet…');
    const tx = await escrowWrite().cancelDeal(dealId);
    const receipt = await tx.wait();
    showToast('↩️', `Deal cancelled, funds refunded. ${explorerTxLink(receipt.hash)}`);
    loadMyDeals();
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  }
}

/* ── Support & Complaint Center ──────────────────────────────────
   Entirely client-side by design: X can't be pre-filled with a DM's
   contents via URL (no such public API), and a mailto: link can't carry
   file attachments — there's no backend here that could receive them
   either. So "prepare a complaint" means: build a clean text summary,
   let the user copy it (for X) or open it pre-filled (for email), and be
   upfront that any selected files need to be attached by hand. */
const SUPPORT_X_URL = 'https://x.com/influence_fi';
const SUPPORT_EMAIL = 'influencefi.online@gmail.com';

let selectedComplaintFiles = [];
let lastComplaintText = '';

function switchSupportTab(tab) {
  document.getElementById('supportTabXBtn').classList.toggle('active', tab === 'x');
  document.getElementById('supportTabXBtn').setAttribute('aria-selected', String(tab === 'x'));
  document.getElementById('supportTabEmailBtn').classList.toggle('active', tab === 'email');
  document.getElementById('supportTabEmailBtn').setAttribute('aria-selected', String(tab === 'email'));
  document.getElementById('supportPanelX').classList.toggle('active', tab === 'x');
  document.getElementById('supportPanelEmail').classList.toggle('active', tab === 'email');
}

function openXSupport() {
  window.open(SUPPORT_X_URL, '_blank', 'noopener');
  showToast('𝕏', 'Redirecting to X…');
}

function quickEmailBody() {
  const walletLine = userAddress ? userAddress : '';
  return `Hello Influence Team,\n\nIssue Type: \n\nCampaign: \n\nWallet Address: ${walletLine}\n\nDescription: \n\nThank you.`;
}

function openEmailSupport() {
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Influence Support Request')}&body=${encodeURIComponent(quickEmailBody())}`;
  window.location.href = url;
  showToast('📧', "Opening your email client…");
}

/* ── Prefill (real state only — wallet address / registered creator name
   / your own recent deals for the campaign suggestions, nothing fabricated) ── */
function prefillSupportCenter() {
  const walletEl = document.getElementById('cWallet');
  if (userAddress && !walletEl.value) walletEl.value = userAddress;

  const nameEl = document.getElementById('cName');
  if (userAddress && !nameEl.value) {
    const c = creatorsMap.get(userAddress.toLowerCase());
    if (c) nameEl.value = c.name;
  }

  const list = document.getElementById('cCampaignList');
  if (dealsCache.length) {
    list.innerHTML = dealsCache
      .map((d) => `<option value="Deal #${d.id}">${escapeHtml(d.brief.slice(0, 60))}</option>`)
      .join('');
  }
}

/* ── File picker (display-only — see note at top of this section) ── */
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('cFiles');
  const zone = document.getElementById('fileDropZone');
  if (!input || !zone) return;

  input.addEventListener('change', () => handleFileSelect(input.files));

  ['dragover', 'dragenter'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
    })
  );
  zone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFileSelect(e.dataTransfer.files);
  });
});

function handleFileSelect(fileList) {
  for (const f of fileList) selectedComplaintFiles.push(f);
  renderFileChips();
}

function removeComplaintFile(index) {
  selectedComplaintFiles.splice(index, 1);
  renderFileChips();
}

function renderFileChips() {
  document.getElementById('fileChipRow').innerHTML = selectedComplaintFiles
    .map((f, i) => `<div class="file-chip"><span class="name">📎 ${escapeHtml(f.name)}</span><button type="button" onclick="removeComplaintFile(${i})" aria-label="Remove ${escapeHtml(f.name)}">✕</button></div>`)
    .join('');
}

/* ── Complaint form ── */
function formatComplaintText(c) {
  const lines = [
    'INFLUENCE SUPPORT COMPLAINT',
    '─'.repeat(32),
    `Name: ${c.name}`,
    `Email: ${c.email}`,
    `Category: ${c.category}`,
    `Campaign: ${c.campaign || '—'}`,
    `Wallet Address: ${c.wallet || '—'}`,
    `Subject: ${c.subject}`,
    '',
    'Description:',
    c.description,
  ];
  if (c.fileNames.length) {
    lines.push('', `Attachments (attach manually): ${c.fileNames.join(', ')}`);
  }
  return lines.join('\n');
}

function submitComplaintForm() {
  const name = document.getElementById('cName').value.trim();
  const email = document.getElementById('cEmail').value.trim();
  const campaign = document.getElementById('cCampaign').value.trim();
  const category = document.getElementById('cCategory').value;
  const subject = document.getElementById('cSubject').value.trim();
  const wallet = document.getElementById('cWallet').value.trim();
  const description = document.getElementById('cDescription').value.trim();

  if (!name || !email || !category || !subject || !description) {
    showToast('⚠️', 'Please fill in name, email, category, subject, and description.', true);
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('⚠️', 'Please enter a valid email address.', true);
    return;
  }

  const complaint = { name, email, campaign, category, subject, wallet, description, fileNames: selectedComplaintFiles.map((f) => f.name) };
  lastComplaintText = formatComplaintText(complaint);
  window._lastComplaint = complaint;

  document.getElementById('complaintSummaryBox').textContent = lastComplaintText;
  const panel = document.getElementById('complaintResultPanel');
  panel.classList.add('show');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('✅', 'Your complaint has been prepared successfully.');
}

async function copyComplaintToClipboard() {
  if (!lastComplaintText) return;
  try {
    await navigator.clipboard.writeText(lastComplaintText);
    showToast('📋', 'Complaint copied to clipboard.');
  } catch (err) {
    showToast('⚠️', "Couldn't copy automatically — select the text above and copy it manually.", true);
  }
}

function continueComplaintViaX() {
  window.open(SUPPORT_X_URL, '_blank', 'noopener');
  showToast('𝕏', 'Redirecting to X — paste your copied complaint into the message.');
}

function continueComplaintViaEmail() {
  const c = window._lastComplaint;
  if (!c) return;
  const body = [
    'Hello Influence Team,',
    '',
    `Issue Type: ${c.category}`,
    `Campaign: ${c.campaign || ''}`,
    `Wallet Address: ${c.wallet || ''}`,
    '',
    `Description:`,
    c.description,
    '',
    `Submitted by: ${c.name} (${c.email})`,
    c.fileNames.length ? `Attachments to attach manually: ${c.fileNames.join(', ')}` : '',
    '',
    'Thank you.',
  ].join('\n');
  const subject = `Influence Support Request — ${c.subject}`;
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
  showToast('📧', 'Opening your email client…');
}

/* ── FAQ accordion ── */
function toggleFaq(btn) {
  const item = btn.closest('.faq-item');
  const isOpen = item.classList.toggle('open');
  btn.setAttribute('aria-expanded', String(isOpen));
}

/* ── Wallet event listeners ── */
if (window.ethereum) {
  window.ethereum.on('accountsChanged', (accounts) => {
    if (activeAuthMethod !== 'metamask' && activeAuthMethod !== null) return; // a Privy session owns the current state, ignore stray MetaMask events
    if (!accounts.length) {
      userAddress = null;
      signer = null;
      activeAuthMethod = null;
      localStorage.removeItem('influence_connected');
      updateWalletUI();
      if (document.getElementById('view-deals').style.display !== 'none') loadMyDeals();
    } else {
      connectViaMetaMask(false);
    }
  });
  window.ethereum.on('chainChanged', () => {
    if (activeAuthMethod === 'metamask') window.location.reload();
  });
}

/* ── Init ── */
(async function init() {
  readProvider = buildReadProvider();
  await loadCreators();

  // Lets external links (the landing page's CTAs, the email notification
  // templates) deep-link straight to a specific view — e.g. app.html#deals
  // — rather than always landing on the marketplace regardless of intent.
  // Purely additive: doesn't change what any nav item or button does.
  const validViews = ['marketplace', 'how', 'register', 'deals', 'support'];
  const initialView = (location.hash || '').replace('#', '');
  if (validViews.includes(initialView)) switchNavById(initialView);

  // Privy manages its own session persistence — if a prior social-login
  // session exists, mounting the widget restores it automatically and fires
  // onPrivyAuthChange on its own; nothing to trigger explicitly here beyond
  // registering the listener before that fires.
  if (privyAvailable()) {
    window.InfluenceAuth.onChange(onPrivyAuthChange);
  }

  const lastMethod = localStorage.getItem('influence_connected');
  if (lastMethod === 'metamask' && window.ethereum) {
    await connectViaMetaMask(false);
  }
})();
