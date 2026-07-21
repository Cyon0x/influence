const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Deploys a genuinely empty stack: CreatorRegistry with zero creators, a fresh
// InfluenceEscrow, and Reviews wired to that Escrow. No demo/seed data of any
// kind is written — the marketplace starts empty until real users register.
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "USDC");

  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address;

  const Registry = await ethers.getContractFactory("CreatorRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  console.log("CreatorRegistry deployed:", await registry.getAddress());

  const Escrow = await ethers.getContractFactory("InfluenceEscrow");
  const escrow = await Escrow.deploy(feeRecipient);
  await escrow.waitForDeployment();
  console.log("InfluenceEscrow deployed:", await escrow.getAddress());

  const Reviews = await ethers.getContractFactory("Reviews");
  const reviews = await Reviews.deploy(await escrow.getAddress());
  await reviews.waitForDeployment();
  console.log("Reviews deployed:", await reviews.getAddress());

  const outDir = path.join(__dirname, "..");
  const deployed = {
    chainId: 5042002,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network",
    explorer: "https://testnet.arcscan.app",
    registryAddress: await registry.getAddress(),
    escrowAddress: await escrow.getAddress(),
    reviewsAddress: await reviews.getAddress(),
    feeRecipient,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "deployed.json"), JSON.stringify(deployed, null, 2));
  console.log("Saved deployment info -> contracts/deployed.json");
  console.log("\nRegistry creator count (should be 0):", (await registry.getCreatorCount()).toString());
  console.log("Escrow deal count (should be 0):", (await escrow.getDealCount()).toString());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
