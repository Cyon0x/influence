const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("InfluenceEscrow + CreatorRegistry", function () {
  async function deployFixture() {
    const [owner, brand, creator, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("CreatorRegistry");
    const registry = await Registry.deploy();

    const Escrow = await ethers.getContractFactory("InfluenceEscrow");
    const escrow = await Escrow.deploy(await registry.getAddress(), owner.address);

    await registry.setEscrowContract(await escrow.getAddress());

    await registry.connect(creator).registerCreator(
      "Test Creator",
      "Tech",
      "Lagos",
      "bio",
      10,
      "#111111",
      "#222222",
      ethers.parseEther("100"),
      []
    );

    return { owner, brand, creator, other, registry, escrow };
  }

  it("locks funds on createDeal", async function () {
    const { brand, creator, escrow } = await deployFixture();
    const amount = ethers.parseEther("100");

    await expect(escrow.connect(brand).createDeal(creator.address, "do a post", { value: amount }))
      .to.emit(escrow, "DealCreated")
      .withArgs(0, brand.address, creator.address, amount, "do a post");

    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(amount);
  });

  it("rejects zero-value or self-hire deals", async function () {
    const { brand, escrow } = await deployFixture();
    await expect(escrow.connect(brand).createDeal(brand.address, "x", { value: 0 })).to.be.reverted;
  });

  it("full happy path: create -> proof -> approve -> release with 99/1 split + review", async function () {
    const { owner, brand, creator, escrow, registry } = await deployFixture();
    const amount = ethers.parseEther("100");

    await escrow.connect(brand).createDeal(creator.address, "brief", { value: amount });
    await escrow.connect(creator).submitProof(0, "https://proof.link");

    const creatorBalBefore = await ethers.provider.getBalance(creator.address);
    const ownerBalBefore = await ethers.provider.getBalance(owner.address);

    await expect(escrow.connect(brand).approveAndRelease(0, 5, "Great work!"))
      .to.emit(escrow, "DealReleased")
      .withArgs(0, ethers.parseEther("99"), ethers.parseEther("1"), false);

    const creatorBalAfter = await ethers.provider.getBalance(creator.address);
    const ownerBalAfter = await ethers.provider.getBalance(owner.address);

    expect(creatorBalAfter - creatorBalBefore).to.equal(ethers.parseEther("99"));
    expect(ownerBalAfter - ownerBalBefore).to.equal(ethers.parseEther("1"));

    const [profile] = await registry.getCreator(creator.address);
    expect(profile.dealsCompleted).to.equal(1);
    expect(profile.ratingSum).to.equal(5);
    expect(profile.ratingCount).to.equal(1);

    const reviews = await registry.getReviews(creator.address);
    expect(reviews.length).to.equal(1);
    expect(reviews[0].text).to.equal("Great work!");
  });

  it("prevents approval before proof is submitted", async function () {
    const { brand, creator, escrow } = await deployFixture();
    await escrow.connect(brand).createDeal(creator.address, "brief", { value: ethers.parseEther("10") });
    await expect(escrow.connect(brand).approveAndRelease(0, 5, "nice")).to.be.revertedWith("wrong status");
  });

  it("prevents non-brand from approving and non-creator from submitting proof", async function () {
    const { brand, creator, other, escrow } = await deployFixture();
    await escrow.connect(brand).createDeal(creator.address, "brief", { value: ethers.parseEther("10") });
    await expect(escrow.connect(other).submitProof(0, "link")).to.be.revertedWith("not the creator");

    await escrow.connect(creator).submitProof(0, "link");
    await expect(escrow.connect(other).approveAndRelease(0, 5, "x")).to.be.revertedWith("not the brand");
  });

  it("blocks auto-release before 48h and allows it after, paid by anyone", async function () {
    const { brand, creator, other, escrow } = await deployFixture();
    await escrow.connect(brand).createDeal(creator.address, "brief", { value: ethers.parseEther("50") });
    await escrow.connect(creator).submitProof(0, "link");

    await expect(escrow.connect(other).autoRelease(0)).to.be.revertedWith("too early");

    await time.increase(48 * 3600 + 1);

    const creatorBalBefore = await ethers.provider.getBalance(creator.address);
    await expect(escrow.connect(other).autoRelease(0))
      .to.emit(escrow, "DealReleased")
      .withArgs(0, ethers.parseEther("49.5"), ethers.parseEther("0.5"), true);
    const creatorBalAfter = await ethers.provider.getBalance(creator.address);
    expect(creatorBalAfter - creatorBalBefore).to.equal(ethers.parseEther("49.5"));
  });

  it("lets brand cancel and reclaim funds while still Active", async function () {
    const { brand, creator, escrow } = await deployFixture();
    const amount = ethers.parseEther("20");
    await escrow.connect(brand).createDeal(creator.address, "brief", { value: amount });

    const brandBalBefore = await ethers.provider.getBalance(brand.address);
    const tx = await escrow.connect(brand).cancelDeal(0);
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const brandBalAfter = await ethers.provider.getBalance(brand.address);

    expect(brandBalAfter - brandBalBefore + gasCost).to.equal(amount);
  });

  it("blocks cancel once proof has been submitted", async function () {
    const { brand, creator, escrow } = await deployFixture();
    await escrow.connect(brand).createDeal(creator.address, "brief", { value: ethers.parseEther("5") });
    await escrow.connect(creator).submitProof(0, "link");
    await expect(escrow.connect(brand).cancelDeal(0)).to.be.revertedWith("wrong status");
  });

  it("only escrow contract can record completed deals on the registry", async function () {
    const { other, creator, registry } = await deployFixture();
    await expect(
      registry.connect(other).recordCompletedDeal(creator.address, other.address, 0, 5, "hi")
    ).to.be.revertedWith("not escrow");
  });
});
