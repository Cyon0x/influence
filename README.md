# Influence — Escrow Influencer Marketplace (Arc Testnet)

A real, working dApp: brands lock native USDC in an on-chain escrow contract to hire
creators; funds release when the brand approves (or automatically after 48h). No
backend, no database — creator profiles, deals, and reviews all live on-chain on
[Arc Testnet](https://docs.arc.io), Circle's stablecoin-native L1.

## Live deployment

| | |
|---|---|
| Network | Arc Testnet, chain ID `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com (20 USDC / 2h per address) |
| CreatorRegistry | see `contracts/deployed.json` |
| InfluenceEscrow | see `contracts/deployed.json` |

USDC is Arc's **native gas token** (18 decimals) — brands don't `approve()` an
ERC-20, they just send value with the transaction, same as sending ETH.

## Project layout

```
contracts/                 Hardhat project
  contracts/
    CreatorRegistry.sol     on-chain creator profiles, ratings, reviews
    InfluenceEscrow.sol     deal lifecycle: create / proof / approve / auto-release / cancel
  test/                     9 passing unit tests (full lifecycle, access control, timing)
  scripts/
    deploy.js                deploys both contracts, links them, seeds 7 demo creators
    e2e-check.js              live integration test against the deployed testnet contracts
  deployed.json             addresses + network info (safe to share, no secrets)
  seed-wallets.json         demo creators' private keys — LOCAL ONLY, gitignored
  .env                      DEPLOYER_PRIVATE_KEY, RPC URL, fee recipient — gitignored

web/                        Static frontend, no build step
  index.html                 same visual design as the original prototype
  app.js                     wallet connect + all contract reads/writes (ethers.js)
  config.js                  generated: addresses + ABIs for the frontend
  vendor/ethers.umd.min.js   vendored so the site has no CDN runtime dependency
```

## Contract design notes

- **Escrow math**: brand locks exactly the creator's listed rate. On release, the
  creator receives 99% and the platform (`feeRecipient`) receives 1%
  (`FEE_BPS = 100`). This is deliberately different from the original prototype,
  which used two conflicting fee formulas in different screens — this version
  picks one and is consistent everywhere.
- **Auto-release**: 48h after `submitProof`, *anyone* can call `autoRelease` to pay
  the creator if the brand never responds — this protects creators from brands
  who ghost.
- **Cancel**: a brand can reclaim funds via `cancelDeal` any time before the
  creator submits proof — without this, a creator who never delivers and never
  submits proof would lock the brand's funds forever with no exit.
- **No backend**: `CreatorRegistry` holds name/bio/niche/socials/rate/reviews.
  Avatars are algorithmically colored circles (2-color gradient derived from the
  wallet address) with initials — there's no image upload/storage.

## Running locally

```bash
cd web
python3 -m http.server 8899
# open http://localhost:8899
```

That's it — it's a static site. Connect a MetaMask (or any EIP-1193 wallet)
funded with testnet USDC from the faucet; the app will prompt you to add/switch
to Arc Testnet if needed.

## Testing both sides of a deal

To see the full brand ↔ creator loop, you need two wallets:

1. Your own wallet acts as the **brand** — hire any of the 7 seeded demo creators
   from the marketplace.
2. To act as that creator (submit proof, get paid), import their private key from
   `contracts/seed-wallets.json` into a second MetaMask account. Each demo wallet
   was funded with 1 USDC for gas.
3. Or register your own creator profile from a second wallet via "Join as
   Creator", and hire *that* profile from your main wallet.

## Redeploying

```bash
cd contracts
npx hardhat compile
npx hardhat test                              # 9 tests, no network needed
npx hardhat run scripts/deploy.js --network arcTestnet
node -e "... regenerate web/config.js ..."    # see git history / ask your assistant
```

`.env` needs:
```
DEPLOYER_PRIVATE_KEY=0x...   # testnet-only burner, becomes owner + feeRecipient
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
FEE_RECIPIENT=0x...          # defaults to the deployer address
```

## Known limitation: public RPC rate limits

The public Arc testnet RPC (`rpc.testnet.arc.network`) rate-limits aggressively
(`-32011 request limit reached`). `app.js` handles this with a retry/backoff
wrapper (`withRetry`) and serializes reads (`mapSerial`) instead of firing them
all in parallel — you may see 429s in the browser console during heavy use, but
the app retries transparently. If this becomes a problem in practice, point
`config.js`'s `rpcUrl` at one of Arc's other testnet endpoints (Blockdaemon,
dRPC, QuickNode — see Arc docs) or a paid RPC provider.
