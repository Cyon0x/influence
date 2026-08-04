# Influence — Escrow Influencer Marketplace (Arc Testnet)

A real, working dApp: brands lock native USDC in an on-chain escrow contract to hire
creators; funds release when the brand approves (or automatically after 48h).
Creator profiles, deals, and reviews all live on-chain on
[Arc Testnet](https://docs.arc.io), Circle's stablecoin-native L1 — no seeded/demo
data of any kind, the marketplace shows only creators who have genuinely registered
themselves, and reviews only exist for deals that were genuinely paid out.

There is now a small off-chain layer too (see "Backend" below), added specifically
for two things a public blockchain shouldn't hold directly: email notifications and
social login. Everything else — escrow, profiles, reviews, payments — is still 100%
on-chain, unchanged from before.

**Live app**: https://influence-orpin.vercel.app — auto-deployed from `main` via the
`web/` directory (Vercel project root is set to `web`).

## Live deployment

| | |
|---|---|
| Network | Arc Testnet, chain ID `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com (20 USDC / 2h per address) |
| CreatorRegistry / InfluenceEscrow / Reviews | see `contracts/deployed.json` |

USDC is Arc's **native gas token** (18 decimals) — brands don't `approve()` an
ERC-20, they just send value with the transaction, same as sending ETH.

## Project layout

```
contracts/                 Hardhat project
  contracts/
    CreatorRegistry.sol     pure on-chain profile directory (name/bio/niche/socials/rate)
    InfluenceEscrow.sol     deal lifecycle: create / proof / approve / auto-release / cancel
    Reviews.sol              standalone review ledger, reads deal outcomes from InfluenceEscrow
  test/                     15 passing unit tests across all three contracts
  scripts/deploy.js         deploys all three contracts fresh, wires Reviews to Escrow.
                            Writes NO seed/demo data — registry and escrow start empty.
  deployed.json             addresses + network info (safe to share, no secrets)
  .env                      DEPLOYER_PRIVATE_KEY, RPC URL, fee recipient — gitignored

web/                        Static frontend + a small Vercel serverless API layer
  index.html                 same visual design as the original prototype
  app.js                     wallet connect (MetaMask + Privy) + all contract reads/writes
  config.js                  generated: contract addresses + ABIs for the frontend
  vendor/ethers.umd.min.js   vendored so the site has no CDN runtime dependency
  logo.png                   rasterized from the sidebar SVG mark, for email templates
                              (HTML email clients render inline SVG poorly/inconsistently)

  auth-widget/                separate Vite+React project — the ONLY React code in
                              this repo. Builds to ../auth-widget.js, a self-contained
                              script the static page loads with a plain <script> tag.
    src/main.jsx               wraps Privy's React SDK, exposes a plain imperative
                                window.InfluenceAuth API (login/logout/getProvider/
                                onChange) so vanilla-JS app.js never needs to be
                                React-aware. See "Social login" below.

  api/                        Vercel serverless functions (plain Node, no framework)
    contact.js                 POST: save/update a creator's notification email,
                                signature-verified — proves wallet ownership without
                                a password/session system
    notify/hired.js             POST: fired by the client right after createDeal()
    notify/released.js          confirms — re-verifies against real chain state
                                before sending, never trusts the client's claim
    cron/notify-backstop.js    GET, Vercel Cron (daily): catches anything the
                                instant client-triggered calls above missed

  lib/                        shared server-side code
    prisma.js                  cached Prisma client (serverless-safe singleton)
    chain.js, chain-config.json, escrowAbi.json   server-side chain access —
                                separate from web/config.js because Vercel functions
                                can't read outside the project's root directory
    notify.js                   tryNotify(dealId, kind) — the single choke point
                                both notify/*.js and the cron backstop call through
    emailTemplates.js           the actual email HTML/text, Influence-branded
    rateLimit.js                in-memory per-instance limiter (same tradeoff as
                                the sibling FinFlow project, see its README)

  prisma/schema.prisma        3 tiny tables — see "Backend" below
```

## Contract design notes

- **`SocialLink.url` stores a real, full `https://` URL per platform**, not a bare
  handle or follower-count-only entry — `struct SocialLink { string platform;
  string url; uint256 followers; }`. Only platforms the creator actually filled
  in get an entry (empty ones are filtered out before the transaction, both
  client-side and by the contract, which never stores anything with an empty
  name/rate to begin with). Normalization (turning `@handle` or
  `instagram.com/handle` into `https://instagram.com/handle`) happens in
  `app.js`'s `normalizeSocialUrl()` before submission, not in Solidity — string
  manipulation on-chain (prefix checks, concatenation) costs meaningfully more
  gas than doing it in JS first, and there's no security reason to enforce it
  on-chain the way review authenticity needed to be: a malformed link only
  breaks that one creator's own badge, it can't defraud anyone else. The
  frontend still only ever renders a stored value as a clickable `<a>` if it
  passes an `^https?://` check first, so even a value written by a direct
  contract call that skipped normalization can't become a `javascript:`-scheme
  or otherwise unsafe link — it just falls back to plain, non-clickable text.
- **Three separate contracts, not two.** `CreatorRegistry` is a pure profile
  directory now — it used to also cache `ratingSum`/`ratingCount`/`dealsCompleted`
  and had owner-only `seedStats`/`seedReview` functions that existed solely to
  inject demo data. Those were removed entirely (not just left unused) once
  reviews moved to their own contract.
- **`Reviews.sol` is standalone by design**, not bolted onto `CreatorRegistry` or
  `InfluenceEscrow`. It takes `InfluenceEscrow`'s address in its constructor and
  reads deal outcomes directly from Escrow's public `deals(dealId)` getter — it
  doesn't touch `CreatorRegistry` at all (a review is valid regardless of whether
  the creator ever registered a profile). This means neither `CreatorRegistry`
  nor `InfluenceEscrow` needs to be redeployed if the review system changes again.
- **On-chain enforcement, not frontend trust**: `Reviews.submitReview(dealId, stars,
  text)` reverts unless (a) the referenced deal's status is genuinely `Completed`
  and (b) `msg.sender` is exactly that deal's `brand` address. One review per
  `dealId` (`dealReviewed[dealId]`), not per brand-creator pair, so the same brand
  can review multiple separate deals with the same creator. None of this can be
  bypassed by calling the contract directly — there's no separate/softer check in
  the frontend.
- **`InfluenceEscrow.approveAndRelease(dealId)` takes no rating params anymore.**
  It used to accept `(dealId, stars, reviewText)` and write straight into
  `CreatorRegistry`, coupling fund release to review submission. That's gone —
  approving a deal only releases funds; leaving a review is a separate, optional
  transaction against `Reviews.sol` afterward.
- **Escrow math**: brand locks exactly the creator's listed rate. On release, the
  creator receives 99% and the platform (`feeRecipient`) receives 1%
  (`FEE_BPS = 100`).
- **Auto-release**: 48h after `submitProof`, *anyone* can call `autoRelease` to pay
  the creator if the brand never responds.
- **Cancel**: a brand can reclaim funds via `cancelDeal` any time before the
  creator submits proof.
- **No backend**: Avatars are algorithmically colored circles (2-color gradient
  derived from the wallet address) with initials — there's no image upload/storage.
- **No aggregate rating cached anywhere on-chain.** Since ratings live only in
  `Reviews.sol` and there's no cheap way to read "this creator's average rating"
  without fetching their full review list, the frontend only fetches reviews (and
  computes an average client-side) when you open a specific creator's hire modal —
  not for every card in the marketplace grid. That's a deliberate tradeoff against
  Arc testnet's rate-limited public RPC (see below): a "★ rating" badge on every
  grid card would mean fetching every creator's reviews just to render the list.

## Backend

Added for exactly two things that don't belong on a public, permanent, unencrypted
ledger: **email addresses** and **email sending**. Nothing about escrow, profiles,
deals, or reviews moved off-chain — `app.js` still talks to the three contracts
directly for all of that, same as before.

**Why this needed a backend at all**: an email notification requires (a) something
that finds out a deal was created/released — can't be trusted to the client alone,
since a closed browser tab would just silently skip the email — and (b) an
email-provider API key, which can never live in client-side JS. Both need a server.

**Data stored, off-chain, in Postgres** (`prisma/schema.prisma`):
- `CreatorContact` — wallet address → notification email. Opt-in, settable/updatable
  any time from "Join as Creator" regardless of on-chain registration status, proven
  via a signed message (`buildContactMessage()` in `app.js`, verified with
  `ethers.verifyMessage` in `api/contact.js`) — no password, no session cookie.
- `NotificationLog` — one row per `(dealId, kind)`, unique constraint. This is the
  actual dedupe mechanism: both the instant client-triggered call and the once-daily
  cron backstop go through the same `tryNotify()`, and whichever gets there first
  wins via this constraint — not an in-memory flag, so it's race-safe across
  concurrent serverless invocations.
- `SyncCursor` — one row, tracks how far the cron backstop has scanned.

**Delivery has two paths, same as FinFlow's reconciliation pattern**: the instant
path fires right after `tx.wait()` succeeds in `app.js` (near-real-time, the common
case) and independently *re-derives* everything from `InfluenceEscrow.deals(dealId)`
server-side rather than trusting the client's POST body — a malicious client can at
worst trigger an early send of an email that would have gone out anyway, never a
fabricated one. The cron backstop (`vercel.json`, once/day on the Hobby plan) scans
`DealCreated`/`DealReleased` events from the last cursor position and catches
anything that happened outside the app's own UI, or where the instant call failed
for any reason.

## Social login

Twitter and email login, via [Privy](https://privy.io) — click "Connect Wallet" and
choose "Continue with Twitter or Email" instead of MetaMask. Privy creates and
manages a real embedded wallet behind that login; once authenticated, `app.js`
wraps it in a standard `ethers.BrowserProvider` exactly like it wraps
`window.ethereum` for MetaMask, so every downstream contract call is identical
regardless of which path got you there — `activeAuthMethod` just tracks which one
is live, for disconnect and for gating the MetaMask-only `accountsChanged`/
`chainChanged` listeners.

This lives in its own tiny Vite+React project (`auth-widget/`) that builds to a
single self-contained `auth-widget.js`, because Privy's best-supported integration
path is React and the rest of this site deliberately isn't. `src/main.jsx` is a
thin, non-React-aware bridge: it exposes `window.InfluenceAuth` (`login`, `logout`,
`getProvider`, `onChange`) so `app.js` never needs a JSX build step of its own.
`window.InfluenceAuth` is always defined (even with `PRIVY_APP_ID` unset — see
below) so `app.js` can safely probe it without knowing whether social login is
configured.

**Known tradeoff**: Privy's SDK is heavy — the built `auth-widget.js` is currently
~4.2MB unminified / ~1.3MB gzipped, because it bundles WalletConnect and every
connector type it supports, not just the embedded-wallet path this app actually
uses. That's inherent to this whole category of provider (Dynamic and Web3Auth are
comparably sized), not a bug — flagging it as a real page-weight cost, not hiding it.

To change the Privy app ID: edit `auth-widget/.env` (`VITE_PRIVY_APP_ID=...`), then
`cd auth-widget && npm run build` — this regenerates `../auth-widget.js`, which is
committed (consumers of the static site don't run a build step, same reasoning as
vendoring `ethers.umd.min.js`).

## Support Center

Sidebar → Support Center. Entirely client-side, no backend involved — two real
platform constraints shaped how it works, worth knowing before changing it:

- **X can't be pre-filled with a DM's contents via URL** — there's no public API for
  that, only web intents for composing a public tweet. So "Message Us on X" just
  opens the profile; for the complaint form, the flow is copy the prepared summary
  (`copyComplaintToClipboard()`), then paste it into a DM after redirecting.
- **A `mailto:` link can't carry file attachments**, and there's nothing here that
  could receive an upload anyway. The file picker (`handleFileSelect()`) is
  genuinely just a picker — it lists selected filenames in the generated message so
  you remember to attach them yourself, it never uploads or stores them anywhere.
  Said explicitly in the UI (`.file-note`), not left implicit.

`SUPPORT_EMAIL`/`SUPPORT_X_URL` are constants at the top of the Support Center
section in `app.js`.

## Running locally

**Frontend only**, no backend/API routes (fastest, matches how this project ran
before the backend existed):
```bash
cd web
python3 -m http.server 8899
```

**Full stack**, including `/api/*` routes (needed to test email capture, the notify
triggers, or the cron backstop):
```bash
cd web
npm install                      # installs Prisma/ethers/resend for the API layer
vercel dev --listen 8899
```
`vercel dev` reads the same env vars as the live Vercel project (`DATABASE_URL`,
`RESEND_API_KEY`, etc. — pull them with `vercel env pull` once they're set, or
create a local `.env` from `.env.example`). Without a real `DATABASE_URL`, the
static site and wallet flows work exactly as before; only `/api/contact` and
`/api/notify/*` will fail (cleanly, with a JSON 500) at the database step.

Either way: connect a MetaMask (or any EIP-1193 wallet) funded with testnet USDC
from the faucet, or use "Continue with Twitter or Email"; the app will prompt you
to add/switch to Arc Testnet if needed.

## Testing the full loop (including a real review)

The registry starts genuinely empty — there is no seed data to hire against. To
exercise the whole flow you need two wallets:

1. Register a creator profile from **wallet B** via "Join as Creator".
2. From **wallet A**, hire that profile from the marketplace — this locks USDC in
   `InfluenceEscrow`.
3. Switch to **wallet B**, go to My Deals, submit proof for that deal.
4. Switch back to **wallet A**, go to My Deals, click "Acknowledge & Release
   Funds" — this pays wallet B (99%) and the platform fee recipient (1%).
5. Still as **wallet A**, on that same now-completed deal, use the "Leave a
   review" form that appears — this calls `Reviews.submitReview`. Confirm it shows
   up on wallet B's profile in the marketplace (open their hire modal).
6. Try reviewing the same deal again, or reviewing as wallet B, or reviewing
   before step 4 — all three should be rejected by the contract (not just the UI).

## Redeploying

```bash
cd contracts
npx hardhat compile
npx hardhat test                              # 15 tests, no network needed
npx hardhat run scripts/deploy.js --network arcTestnet
# then regenerate web/config.js from contracts/deployed.json + the 3 ABIs
# (ask your assistant, or see git history for the exact node -e snippet)
```

`.env` needs:
```
DEPLOYER_PRIVATE_KEY=0x...   # testnet-only burner, becomes owner + feeRecipient
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
FEE_RECIPIENT=0x...          # defaults to the deployer address
```

Redeploying `CreatorRegistry` or `InfluenceEscrow` abandons whatever was
registered/in-flight on the old addresses (blockchains don't support deleting a
contract's data — the old contract just sits there, unused, forever). `Reviews.sol`
is pinned to one `InfluenceEscrow` address at construction time, so redeploying
Escrow means redeploying Reviews too.

## Known limitation: public RPC rate limits

The public Arc testnet RPC (`rpc.testnet.arc.network`) rate-limits aggressively
(`-32011 request limit reached`). `app.js` handles this with a retry/backoff
wrapper (`withRetry`) and serializes reads (`mapSerial`) instead of firing them
all in parallel — you may see 429s in the browser console during heavy use, but
the app retries transparently. If this becomes a problem in practice, point
`config.js`'s `rpcUrl` at one of Arc's other testnet endpoints (Blockdaemon,
dRPC, QuickNode — see Arc docs) or a paid RPC provider.
