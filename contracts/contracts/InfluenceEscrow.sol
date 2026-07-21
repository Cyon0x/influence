// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title InfluenceEscrow
/// @notice Locks native USDC (Arc's gas token) for a brand->creator deal, released either by
///         brand approval or automatically 48h after proof is submitted. Rating/reviews are
///         handled entirely by the separate Reviews contract, which reads deal outcomes from
///         this contract's public `deals` getter — this contract has no knowledge of reviews.
contract InfluenceEscrow {
    enum Status {
        Active,         // funded, waiting on creator
        ProofSubmitted, // creator delivered, waiting on brand (or auto-release timer)
        Completed,
        Cancelled
    }

    struct Deal {
        address brand;
        address creator;
        uint256 amount; // native USDC locked, 18 decimals
        string brief;
        string proofLink;
        Status status;
        uint256 createdAt;
        uint256 proofSubmittedAt;
        uint256 completedAt;
    }

    uint256 public constant FEE_BPS = 100; // 1%
    uint256 public constant AUTO_RELEASE_DELAY = 48 hours;

    address public owner;
    address public feeRecipient;

    Deal[] public deals;
    mapping(address => uint256[]) private brandDeals;
    mapping(address => uint256[]) private creatorDeals;

    event DealCreated(uint256 indexed dealId, address indexed brand, address indexed creator, uint256 amount, string brief);
    event ProofSubmitted(uint256 indexed dealId, string proofLink);
    event DealReleased(uint256 indexed dealId, uint256 creatorAmount, uint256 feeAmount, bool autoReleased);
    event DealCancelled(uint256 indexed dealId);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _feeRecipient) {
        owner = msg.sender;
        feeRecipient = _feeRecipient;
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        feeRecipient = _feeRecipient;
    }

    /// @notice Brand locks native USDC for a creator. msg.value is held in escrow in full.
    function createDeal(address creator, string calldata brief) external payable returns (uint256 dealId) {
        require(msg.value > 0, "no funds sent");
        require(creator != msg.sender, "cannot hire yourself");
        require(bytes(brief).length > 0, "brief required");

        dealId = deals.length;
        deals.push(
            Deal({
                brand: msg.sender,
                creator: creator,
                amount: msg.value,
                brief: brief,
                proofLink: "",
                status: Status.Active,
                createdAt: block.timestamp,
                proofSubmittedAt: 0,
                completedAt: 0
            })
        );
        brandDeals[msg.sender].push(dealId);
        creatorDeals[creator].push(dealId);

        emit DealCreated(dealId, msg.sender, creator, msg.value, brief);
    }

    /// @notice Brand can reclaim funds if the creator hasn't submitted proof yet.
    function cancelDeal(uint256 dealId) external {
        Deal storage d = deals[dealId];
        require(msg.sender == d.brand, "not the brand");
        require(d.status == Status.Active, "wrong status");

        d.status = Status.Cancelled;
        (bool sent, ) = payable(d.brand).call{value: d.amount}("");
        require(sent, "refund failed");

        emit DealCancelled(dealId);
    }

    function submitProof(uint256 dealId, string calldata proofLink) external {
        Deal storage d = deals[dealId];
        require(msg.sender == d.creator, "not the creator");
        require(d.status == Status.Active, "wrong status");
        require(bytes(proofLink).length > 0, "proof required");

        d.proofLink = proofLink;
        d.status = Status.ProofSubmitted;
        d.proofSubmittedAt = block.timestamp;

        emit ProofSubmitted(dealId, proofLink);
    }

    /// @notice Brand approves delivered work and releases funds.
    function approveAndRelease(uint256 dealId) external {
        Deal storage d = deals[dealId];
        require(msg.sender == d.brand, "not the brand");
        require(d.status == Status.ProofSubmitted, "wrong status");

        _release(dealId, false);
    }

    /// @notice Anyone can trigger release once 48h have passed since proof submission.
    function autoRelease(uint256 dealId) external {
        Deal storage d = deals[dealId];
        require(d.status == Status.ProofSubmitted, "wrong status");
        require(block.timestamp >= d.proofSubmittedAt + AUTO_RELEASE_DELAY, "too early");

        _release(dealId, true);
    }

    function _release(uint256 dealId, bool autoReleased) internal {
        Deal storage d = deals[dealId];
        d.status = Status.Completed;
        d.completedAt = block.timestamp;

        uint256 fee = (d.amount * FEE_BPS) / 10000;
        uint256 creatorAmount = d.amount - fee;

        (bool sentCreator, ) = payable(d.creator).call{value: creatorAmount}("");
        require(sentCreator, "creator transfer failed");
        (bool sentFee, ) = payable(feeRecipient).call{value: fee}("");
        require(sentFee, "fee transfer failed");

        emit DealReleased(dealId, creatorAmount, fee, autoReleased);
    }

    function getDealCount() external view returns (uint256) {
        return deals.length;
    }

    function getBrandDeals(address brand) external view returns (uint256[] memory) {
        return brandDeals[brand];
    }

    function getCreatorDeals(address creator) external view returns (uint256[] memory) {
        return creatorDeals[creator];
    }
}
