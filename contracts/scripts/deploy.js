const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Demo creators mirroring the original prototype's marketplace cards.
// Each gets its own freshly generated wallet so the full brand<->creator
// escrow loop can be tested with two real, independent accounts.
const DEMO_CREATORS = [
  {
    name: "Adaeze Okafor",
    niche: "Fashion",
    location: "Lagos",
    bio: "Nigerian fashion creator helping women dress confidently on any budget. Strong engagement with working-class women aged 25–40.",
    tz: 10, // UTC+1.0
    colorA: "#E91E8C",
    colorB: "#FF6B35",
    rate: "105",
    verified: true,
    dealsCompleted: 47,
    ratingSum: 49,
    ratingCount: 10,
    socials: [
      { platform: "Instagram", handle: "instagram.com/adaeze_fashion", followers: 42000 },
      { platform: "TikTok", handle: "tiktok.com/@adaeze_fashion", followers: 18000 },
    ],
    reviews: [
      { reviewerName: "TechLauncher NG", stars: 5, text: "Delivered on time, great engagement. Post got 3x our usual reach. Would hire again without hesitation.", daysAgo: 14 },
      { reviewerName: "Naija Startup Co.", stars: 5, text: "Professional, responsive, and the content was exactly what we briefed. Proof submitted within 24hrs.", daysAgo: 30 },
      { reviewerName: "AfroWear Brand", stars: 4, text: "Good work overall. Slight delay on delivery but communicated proactively. Quality content.", daysAgo: 60 },
    ],
  },
  {
    name: "Kemi Adeyemi",
    niche: "Food",
    location: "Abuja",
    bio: "Nigerian food content creator specializing in authentic recipes. My audience is Nigerians in diaspora who want to cook African food at home.",
    tz: 10,
    colorA: "#010101",
    colorB: "#333333",
    rate: "210",
    verified: false,
    dealsCompleted: 31,
    ratingSum: 47,
    ratingCount: 10,
    socials: [
      { platform: "TikTok", handle: "tiktok.com/@kemi_cooks", followers: 87000 },
      { platform: "YouTube", handle: "youtube.com/@kemi_cooks", followers: 22000 },
    ],
    reviews: [],
  },
  {
    name: "Tunde Balogun",
    niche: "Tech & Web3",
    location: "Lagos",
    bio: "Tech reviewer and personal finance educator for Nigerian Gen Z. Known for honest product reviews and practical money advice that actually works in Nigeria.",
    tz: 10,
    colorA: "#3ECF8E",
    colorB: "#0EA5E9",
    rate: "315",
    verified: true,
    dealsCompleted: 22,
    ratingSum: 48,
    ratingCount: 10,
    socials: [
      { platform: "Twitter", handle: "x.com/tundetech", followers: 31000 },
      { platform: "LinkedIn", handle: "linkedin.com/in/tundetech", followers: 8000 },
      { platform: "YouTube", handle: "youtube.com/@tundetech", followers: 14000 },
    ],
    reviews: [],
  },
  {
    name: "Chioma Eze",
    niche: "Beauty",
    location: "Port Harcourt",
    bio: "Natural skincare advocate promoting African ingredients. My audience trusts my honest reviews — I only promote products I personally use and believe in.",
    tz: 10,
    colorA: "#8B5CF6",
    colorB: "#EC4899",
    rate: "63",
    verified: false,
    dealsCompleted: 14,
    ratingSum: 46,
    ratingCount: 10,
    socials: [
      { platform: "Instagram", handle: "instagram.com/chiomask", followers: 15000 },
      { platform: "TikTok", handle: "tiktok.com/@chiomask", followers: 9000 },
    ],
    reviews: [],
  },
  {
    name: "Emeka Obi",
    niche: "Comedy",
    location: "Lagos",
    bio: "Lagos comedy skit creator. Office life, Lagos traffic, Nigerian parents — my content consistently hits 200K+ views and drives massive engagement.",
    tz: 10,
    colorA: "#F59E0B",
    colorB: "#FF5C5C",
    rate: "525",
    verified: true,
    dealsCompleted: 58,
    ratingSum: 49,
    ratingCount: 10,
    socials: [
      { platform: "TikTok", handle: "tiktok.com/@emekafunny", followers: 45000 },
      { platform: "Instagram", handle: "instagram.com/emekafunny", followers: 28000 },
    ],
    reviews: [],
  },
  {
    name: "Fatima Aliyu",
    niche: "Fitness",
    location: "Kano",
    bio: "Fitness coach for Muslim women in Northern Nigeria. Home workouts, halal nutrition, and modest activewear reviews. Deeply trusted community.",
    tz: 10,
    colorA: "#0EA5E9",
    colorB: "#FFB86B",
    rate: "84",
    verified: true,
    dealsCompleted: 9,
    ratingSum: 45,
    ratingCount: 10,
    socials: [
      { platform: "Instagram", handle: "instagram.com/fatimafits", followers: 12000 },
      { platform: "Facebook", handle: "facebook.com/fatimafits", followers: 6000 },
    ],
    reviews: [],
  },
  {
    name: "Isabela Cruz",
    niche: "Beauty",
    location: "Manila",
    bio: "Manila-based beauty creator specializing in K-beauty dupes and budget skincare routines for the Filipino market. Deep trust with young professionals.",
    tz: 80, // UTC+8.0
    colorA: "#FF6B9D",
    colorB: "#FFB86B",
    rate: "140",
    verified: true,
    dealsCompleted: 26,
    ratingSum: 48,
    ratingCount: 10,
    socials: [
      { platform: "TikTok", handle: "tiktok.com/@fashionph", followers: 63000 },
      { platform: "Instagram", handle: "instagram.com/fashionph", followers: 19000 },
    ],
    reviews: [],
  },
];

const GAS_FUNDING_PER_CREATOR = ethers.parseEther("1"); // native USDC for their own future gas costs

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
  const escrow = await Escrow.deploy(await registry.getAddress(), feeRecipient);
  await escrow.waitForDeployment();
  console.log("InfluenceEscrow deployed:", await escrow.getAddress());

  let tx = await registry.setEscrowContract(await escrow.getAddress());
  await tx.wait();
  console.log("Registry linked to escrow contract");

  const seedWallets = [];

  for (const c of DEMO_CREATORS) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    seedWallets.push({ name: c.name, address: wallet.address, privateKey: wallet.privateKey });

    tx = await deployer.sendTransaction({ to: wallet.address, value: GAS_FUNDING_PER_CREATOR });
    await tx.wait();

    const socials = c.socials.map((s) => ({ platform: s.platform, handle: s.handle, followers: s.followers }));
    tx = await registry
      .connect(wallet)
      .registerCreator(c.name, c.niche, c.location, c.bio, c.tz, c.colorA, c.colorB, ethers.parseEther(c.rate), socials);
    await tx.wait();
    console.log(`Registered ${c.name} -> ${wallet.address}`);

    if (c.verified) {
      tx = await registry.setVerified(wallet.address, true);
      await tx.wait();
    }

    tx = await registry.seedStats(wallet.address, c.dealsCompleted, c.ratingSum, c.ratingCount);
    await tx.wait();

    for (const r of c.reviews) {
      tx = await registry.seedReview(wallet.address, r.reviewerName, r.stars, r.text, r.daysAgo);
      await tx.wait();
    }
  }

  const outDir = path.join(__dirname, "..");
  fs.writeFileSync(path.join(outDir, "seed-wallets.json"), JSON.stringify(seedWallets, null, 2));
  console.log("Saved demo creator wallets -> contracts/seed-wallets.json (gitignored, keep private)");

  const deployed = {
    chainId: 5042002,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network",
    explorer: "https://testnet.arcscan.app",
    registryAddress: await registry.getAddress(),
    escrowAddress: await escrow.getAddress(),
    feeRecipient,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "deployed.json"), JSON.stringify(deployed, null, 2));
  console.log("Saved deployment info -> contracts/deployed.json");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
