const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Reviews", function () {
  async function deployFixture() {
    const [owner, brand, creator, otherBrand] = await ethers.getSigners();

    const Escrow = await ethers.getContractFactory("InfluenceEscrow");
    const escrow = await Escrow.deploy(owner.address);

    const Reviews = await ethers.getContractFactory("Reviews");
    const reviews = await Reviews.deploy(await escrow.getAddress());

    return { owner, brand, creator, otherBrand, escrow, reviews };
  }

  async function createAndComplete(escrow, brand, creator, amount = ethers.parseEther("10")) {
    await escrow.connect(brand).createDeal(creator.address, "brief", { value: amount });
    const dealId = Number((await escrow.getDealCount()) - 1n);
    await escrow.connect(creator).submitProof(dealId, "https://proof.link");
    await escrow.connect(brand).approveAndRelease(dealId);
    return dealId;
  }

  it("rejects reviewing a deal that isn't released yet", async function () {
    const { brand, creator, escrow, reviews } = await deployFixture();
    await escrow.connect(brand).createDeal(creator.address, "brief", { value: ethers.parseEther("10") });
    // still Active — no proof, no approval
    await expect(reviews.connect(brand).submitReview(0, 5, "great!")).to.be.revertedWith("deal not released");

    await escrow.connect(creator).submitProof(0, "link");
    // now ProofSubmitted, still not Completed
    await expect(reviews.connect(brand).submitReview(0, 5, "great!")).to.be.revertedWith("deal not released");
  });

  it("rejects reviewing as someone who isn't the deal's brand", async function () {
    const { brand, creator, otherBrand, escrow, reviews } = await deployFixture();
    const dealId = await createAndComplete(escrow, brand, creator);

    await expect(reviews.connect(otherBrand).submitReview(dealId, 5, "not my deal")).to.be.revertedWith(
      "not this deal's brand"
    );
    // the creator themselves shouldn't be able to review their own deal either
    await expect(reviews.connect(creator).submitReview(dealId, 5, "self review")).to.be.revertedWith(
      "not this deal's brand"
    );
  });

  it("rejects double-reviewing the same deal", async function () {
    const { brand, creator, escrow, reviews } = await deployFixture();
    const dealId = await createAndComplete(escrow, brand, creator);

    await reviews.connect(brand).submitReview(dealId, 4, "good work");
    await expect(reviews.connect(brand).submitReview(dealId, 5, "trying again")).to.be.revertedWith(
      "deal already reviewed"
    );
  });

  it("happy path: brand reviews a genuinely completed deal", async function () {
    const { brand, creator, escrow, reviews } = await deployFixture();
    const dealId = await createAndComplete(escrow, brand, creator);

    await expect(reviews.connect(brand).submitReview(dealId, 5, "Delivered exactly as briefed."))
      .to.emit(reviews, "ReviewSubmitted")
      .withArgs(dealId, creator.address, brand.address, 5);

    expect(await reviews.hasReviewed(dealId)).to.equal(true);

    const creatorReviews = await reviews.getReviews(creator.address);
    expect(creatorReviews.length).to.equal(1);
    expect(creatorReviews[0].brand).to.equal(brand.address);
    expect(creatorReviews[0].dealId).to.equal(dealId);
    expect(creatorReviews[0].stars).to.equal(5);
    expect(creatorReviews[0].text).to.equal("Delivered exactly as briefed.");
  });

  it("rejects out-of-range star ratings", async function () {
    const { brand, creator, escrow, reviews } = await deployFixture();
    const dealId = await createAndComplete(escrow, brand, creator);
    await expect(reviews.connect(brand).submitReview(dealId, 0, "x")).to.be.revertedWith("stars 1-5");
    await expect(reviews.connect(brand).submitReview(dealId, 6, "x")).to.be.revertedWith("stars 1-5");
  });

  it("allows the same brand to review two separate completed deals with the same creator", async function () {
    const { brand, creator, escrow, reviews } = await deployFixture();
    const dealId1 = await createAndComplete(escrow, brand, creator);
    const dealId2 = await createAndComplete(escrow, brand, creator);

    await reviews.connect(brand).submitReview(dealId1, 3, "first deal, okay");
    await reviews.connect(brand).submitReview(dealId2, 5, "second deal, great");

    const creatorReviews = await reviews.getReviews(creator.address);
    expect(creatorReviews.length).to.equal(2);
  });

  it("reverts on an out-of-range dealId instead of silently succeeding", async function () {
    const { brand, reviews } = await deployFixture();
    await expect(reviews.connect(brand).submitReview(999, 5, "x")).to.be.reverted;
  });
});
