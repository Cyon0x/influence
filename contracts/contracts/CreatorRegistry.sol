// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CreatorRegistry
/// @notice On-chain profile + reputation store for Influence creators.
///         Deal completion stats are written by the paired InfluenceEscrow contract only.
contract CreatorRegistry {
    struct SocialLink {
        string platform; // e.g. "Instagram", "TikTok", "YouTube", "Twitter"
        string handle;
        uint256 followers;
    }

    struct Creator {
        address wallet;
        string name;
        string niche;
        string location;
        string bio;
        int16 tzOffsetTenths; // UTC offset * 10, e.g. Lagos +1:00 = 10, Manila +8:00 = 80
        string colorA;        // avatar gradient start, e.g. "#E91E8C"
        string colorB;        // avatar gradient end
        uint256 ratePerPost;  // native USDC, 18 decimals
        bool verified;
        bool registered;
        uint256 dealsCompleted;
        uint256 ratingSum;    // sum of star ratings (1-5 each)
        uint256 ratingCount;
    }

    struct Review {
        address brand;
        string reviewerName; // display fallback if brand has no brand-side profile
        uint8 stars;
        string text;
        uint256 timestamp;
        uint256 dealId; // 0 for admin-seeded reviews
    }

    address public owner;
    address public escrowContract;

    mapping(address => Creator) private creators;
    mapping(address => SocialLink[]) private creatorSocials;
    mapping(address => Review[]) private creatorReviews;
    address[] public creatorAddresses;

    event CreatorRegistered(address indexed creator, string name);
    event CreatorVerified(address indexed creator, bool verified);
    event ReviewAdded(address indexed creator, address indexed brand, uint8 stars, uint256 dealId);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyEscrow() {
        require(msg.sender == escrowContract, "not escrow");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setEscrowContract(address _escrow) external onlyOwner {
        escrowContract = _escrow;
    }

    function registerCreator(
        string calldata name,
        string calldata niche,
        string calldata location,
        string calldata bio,
        int16 tzOffsetTenths,
        string calldata colorA,
        string calldata colorB,
        uint256 ratePerPost,
        SocialLink[] calldata socials
    ) external {
        require(bytes(name).length > 0, "name required");
        require(ratePerPost > 0, "rate required");

        Creator storage c = creators[msg.sender];
        if (!c.registered) {
            creatorAddresses.push(msg.sender);
            c.registered = true;
            c.wallet = msg.sender;
        }
        c.name = name;
        c.niche = niche;
        c.location = location;
        c.bio = bio;
        c.tzOffsetTenths = tzOffsetTenths;
        c.colorA = colorA;
        c.colorB = colorB;
        c.ratePerPost = ratePerPost;

        delete creatorSocials[msg.sender];
        for (uint256 i = 0; i < socials.length; i++) {
            creatorSocials[msg.sender].push(socials[i]);
        }

        emit CreatorRegistered(msg.sender, name);
    }

    function setVerified(address creator, bool v) external onlyOwner {
        require(creators[creator].registered, "not registered");
        creators[creator].verified = v;
        emit CreatorVerified(creator, v);
    }

    /// @notice Called by InfluenceEscrow when a deal is released, to update stats/reviews.
    function recordCompletedDeal(
        address creator,
        address brand,
        uint256 dealId,
        uint8 stars,
        string calldata reviewText
    ) external onlyEscrow {
        Creator storage c = creators[creator];
        c.dealsCompleted += 1;
        if (stars > 0) {
            c.ratingSum += stars;
            c.ratingCount += 1;
            creatorReviews[creator].push(Review(brand, "", stars, reviewText, block.timestamp, dealId));
            emit ReviewAdded(creator, brand, stars, dealId);
        }
    }

    /// @notice Owner-only cosmetic seeding for demo/testnet purposes (initial baseline stats).
    function seedStats(address creator, uint256 dealsCompleted, uint256 ratingSum, uint256 ratingCount) external onlyOwner {
        require(creators[creator].registered, "not registered");
        Creator storage c = creators[creator];
        c.dealsCompleted = dealsCompleted;
        c.ratingSum = ratingSum;
        c.ratingCount = ratingCount;
    }

    /// @notice Owner-only cosmetic seeding of a review with no real wallet behind it (demo/testnet only).
    function seedReview(
        address creator,
        string calldata reviewerName,
        uint8 stars,
        string calldata text,
        uint256 daysAgo
    ) external onlyOwner {
        require(creators[creator].registered, "not registered");
        creatorReviews[creator].push(Review(owner, reviewerName, stars, text, block.timestamp - daysAgo * 1 days, 0));
    }

    function getCreatorCount() external view returns (uint256) {
        return creatorAddresses.length;
    }

    function getCreator(address creator) external view returns (Creator memory, SocialLink[] memory) {
        return (creators[creator], creatorSocials[creator]);
    }

    function getReviews(address creator) external view returns (Review[] memory) {
        return creatorReviews[creator];
    }

    function isRegistered(address creator) external view returns (bool) {
        return creators[creator].registered;
    }
}
