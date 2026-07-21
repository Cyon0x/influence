# Influence — Escrow Influencer Marketplace (Arc Testnet)

A real, working dApp: brands lock native USDC in an on-chain escrow contract to hire
creators; funds release when the brand approves (or automatically after 48h). No
backend, no database, no seeded/demo data of any kind — creator profiles, deals,
and reviews all live on-chain on [Arc Testnet](https://docs.arc.io), Circle's
stablecoin-native L1. The marketplace shows only creators who have genuinely
registered themselves; reviews only exist for deals that were genuinely paid out.

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

web/                        Static frontend, no build step
  index.html                 same visual design as the original prototype
  app.js                     wallet connect + all contract reads/writes (ethers.js)
  config.js                  generated: addresses + ABIs for the frontend
  vendor/ethers.umd.min.js   vendored so the site has no CDN runtime dependency
```

## Contract design notes

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

## Running locally

```bash
cd web
python3 -m http.server 8899
# open http://localhost:8899
```

That's it — it's a static site. Connect a MetaMask (or any EIP-1193 wallet)
funded with testnet USDC from the faucet; the app will prompt you to add/switch
to Arc Testnet if needed.

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
