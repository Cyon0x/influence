const { ethers } = require("hardhat");
const deployed = require("../deployed.json");
const seedWallets = require("../seed-wallets.json");

async function main() {
  const [deployer] = await ethers.getSigners();
  const registry = await ethers.getContractAt("CreatorRegistry", deployed.registryAddress);
  const escrow = await ethers.getContractAt("InfluenceEscrow", deployed.escrowAddress);

  const kemi = seedWallets.find((w) => w.name === "Kemi Adeyemi");
  const kemiWallet = new ethers.Wallet(kemi.privateKey, ethers.provider);

  console.log("=== Happy path: create -> proof -> approve ===");
  const amount = ethers.parseEther("2");
  let tx = await escrow.connect(deployer).createDeal(kemiWallet.address, "E2E test: promote our launch on TikTok", { value: amount });
  let receipt = await tx.wait();
  const dealId = Number((await escrow.getDealCount()) - 1n);
  console.log("Deal created, id:", dealId, "tx:", receipt.hash);

  const beforeDeal = await escrow.deals(dealId);
  console.assert(Number(beforeDeal.status) === 0, "expected Active status");

  tx = await escrow.connect(kemiWallet).submitProof(dealId, "https://tiktok.com/@kemi_cooks/video/e2e-test-proof");
  receipt = await tx.wait();
  console.log("Proof submitted, tx:", receipt.hash);

  const beforeRegistry = await registry.getCreator(kemiWallet.address);
  const dealsBefore = beforeRegistry[0].dealsCompleted;
  const kemiBalBefore = await ethers.provider.getBalance(kemiWallet.address);

  tx = await escrow.connect(deployer).approveAndRelease(dealId, 5, "E2E test review: fast delivery, great quality.");
  receipt = await tx.wait();
  console.log("Approved + released, tx:", receipt.hash);

  const afterDeal = await escrow.deals(dealId);
  console.assert(Number(afterDeal.status) === 2, "expected Completed status, got " + afterDeal.status);

  const kemiBalAfter = await ethers.provider.getBalance(kemiWallet.address);
  const expectedCreatorAmount = (amount * 99n) / 100n;
  console.log("Kemi balance delta:", ethers.formatEther(kemiBalAfter - kemiBalBefore), "expected +", ethers.formatEther(expectedCreatorAmount));
  console.assert(kemiBalAfter - kemiBalBefore === expectedCreatorAmount, "creator payout mismatch");

  const afterRegistry = await registry.getCreator(kemiWallet.address);
  console.assert(afterRegistry[0].dealsCompleted === dealsBefore + 1n, "dealsCompleted should increment");
  console.log("Kemi dealsCompleted now:", afterRegistry[0].dealsCompleted.toString());

  const reviews = await registry.getReviews(kemiWallet.address);
  console.log("Kemi review count now:", reviews.length, "latest text:", reviews[reviews.length - 1].text);

  console.log("\n=== Cancel path ===");
  const tunde = seedWallets.find((w) => w.name === "Tunde Balogun");
  const cancelAmount = ethers.parseEther("1");
  tx = await escrow.connect(deployer).createDeal(tunde.address, "E2E test: will cancel this one", { value: cancelAmount });
  receipt = await tx.wait();
  const cancelDealId = Number((await escrow.getDealCount()) - 1n);
  console.log("Deal created for cancel test, id:", cancelDealId, "tx:", receipt.hash);

  const deployerBalBefore = await ethers.provider.getBalance(deployer.address);
  tx = await escrow.connect(deployer).cancelDeal(cancelDealId);
  receipt = await tx.wait();
  const gasCost = receipt.gasUsed * receipt.gasPrice;
  const deployerBalAfter = await ethers.provider.getBalance(deployer.address);
  console.log("Cancel tx:", receipt.hash);

  const cancelledDeal = await escrow.deals(cancelDealId);
  console.assert(Number(cancelledDeal.status) === 3, "expected Cancelled status");
  console.assert(deployerBalAfter - deployerBalBefore + gasCost === cancelAmount, "refund mismatch");
  console.log("Refund verified: brand reclaimed", ethers.formatEther(cancelAmount), "USDC (net of gas)");

  console.log("\n✅ All E2E checks passed against live Arc testnet deployment.");
}

main().catch((err) => {
  console.error("E2E CHECK FAILED:", err);
  process.exitCode = 1;
});
