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
  const map = { marketplace: 0, how: 1, register: 2, deals: 3 };
  if (items[map[viewId]]) items[map[viewId]].classList.add('active');
  activateView(viewId);
}
function activateView(viewId) {
  ['marketplace', 'how', 'register', 'deals'].forEach((id) => {
    const v = document.getElementById('view-' + id);
    if (v) v.style.display = id === viewId ? 'block' : 'none';
  });
  closeSidebar();
  window.scrollTo(0, 0);
  if (viewId === 'deals') loadMyDeals();
}

/* ── Wallet connection ── */
async function onConnectClick() {
  if (!window.ethereum) {
    showToast('⚠️', 'No wallet extension found. Install MetaMask (or another EVM wallet) to continue.', true);
    return;
  }
  await connectWallet(true);
}

async function connectWallet(interactive) {
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

    browserProvider = new ethers.BrowserProvider(window.ethereum);
    signer = await browserProvider.getSigner();
    userAddress = accounts[0];
    localStorage.setItem('influence_connected', '1');

    const network = await browserProvider.getNetwork();
    updateNetworkBanner(Number(network.chainId));

    updateWalletUI();
    if (document.getElementById('view-deals').style.display !== 'none') loadMyDeals();
  } catch (err) {
    showToast('⚠️', txErrorMessage(err), true);
  } finally {
    btn.disabled = false;
    if (!userAddress) btn.textContent = 'Connect Wallet';
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

function updateNetworkBanner(chainId) {
  const banner = document.getElementById('networkBanner');
  if (chainId !== CFG.chainId) banner.classList.add('show');
  else banner.classList.remove('show');
}

async function switchToArcTestnet() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CFG.chainIdHex }],
    });
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CFG.chainIdHex,
            chainName: 'Arc Testnet',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
            rpcUrls: [CFG.rpcUrl],
            blockExplorerUrls: [CFG.explorer],
          }],
        });
      } catch (addErr) {
        showToast('⚠️', txErrorMessage(addErr), true);
        return;
      }
    } else {
      showToast('⚠️', txErrorMessage(switchErr), true);
      return;
    }
  }
  const network = await browserProvider.getNetwork();
  updateNetworkBanner(Number(network.chainId));
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
    const handle = top ? '@' + top.handle.replace(/^.*\//, '').replace(/^@/, '') : c.name;
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
        socials: socials.map((s) => ({ platform: s.platform, handle: s.handle, followers: Number(s.followers) })),
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
      const hay = [c.name, c.niche, c.location, ...c.socials.map((s) => s.handle)].join(' ').toLowerCase();
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
  const socialsHtml = c.socials
    .slice(0, 3)
    .map((s) => `<span class="platform-badge">${PLATFORM_ICON[s.platform] || '🔗'} ${escapeHtml(s.platform)} <span class="count">${formatFollowers(s.followers)}</span></span>`)
    .join('');

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
  document.getElementById('modalSub').textContent = `${c.niche} · ${c.location} · ${c.socials.map((s) => formatFollowers(s.followers) + ' ' + s.platform).join(' · ')}`;
  document.getElementById('modalAddr').textContent = shortAddr(c.address);

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
  if (!requireReadyToTransact()) {
    await connectWallet(true);
    if (!signer) return;
  }

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
      handle: document.getElementById(handleId).value.trim(),
      followers: parseInt(document.getElementById(countId).value, 10) || 0,
    }))
    .filter((s) => s.handle.length > 0);

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

/* ── Wallet event listeners ── */
if (window.ethereum) {
  window.ethereum.on('accountsChanged', (accounts) => {
    if (!accounts.length) {
      userAddress = null;
      signer = null;
      localStorage.removeItem('influence_connected');
      updateWalletUI();
      if (document.getElementById('view-deals').style.display !== 'none') loadMyDeals();
    } else {
      connectWallet(false);
    }
  });
  window.ethereum.on('chainChanged', () => window.location.reload());
}

/* ── Init ── */
(async function init() {
  readProvider = new ethers.JsonRpcProvider(CFG.rpcUrl, { chainId: CFG.chainId, name: 'arc-testnet' }, { staticNetwork: true });
  await loadCreators();

  if (window.ethereum && localStorage.getItem('influence_connected') === '1') {
    await connectWallet(false);
  }
})();
