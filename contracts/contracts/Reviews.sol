// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IInfluenceEscrow {
    function deals(uint256 dealId)
        external
        view
        returns (
            address brand,
            address creator,
            uint256 amount,
            string memory brief,
            string memory proofLink,
            uint8 status,
            uint256 createdAt,
            uint256 proofSubmittedAt,
            uint256 completedAt
        );
}

/// @title Reviews
/// @notice Standalone review ledger for Influence. Deliberately separate from
///         CreatorRegistry and InfluenceEscrow (rather than bolted onto either) so
///         neither needs to be redeployed if review logic changes again. Reads deal
///         outcomes directly from the immutable InfluenceEscrow it's constructed
///         with — a review can only be submitted by the exact brand address on a
///         deal that is genuinely Completed, one review per dealId, enforced here
///         on-chain rather than trusted to the frontend.
contract Reviews {
    uint8 private constant STATUS_COMPLETED = 2;

    struct Review {
        address brand;
        address creator;
        uint256 dealId;
        uint8 stars;
        string text;
        uint256 timestamp;
    }

    IInfluenceEscrow public immutable escrow;

    mapping(uint256 => bool) public dealReviewed;
    mapping(address => Review[]) private creatorReviews;

    event ReviewSubmitted(uint256 indexed dealId, address indexed creator, address indexed brand, uint8 stars);

    constructor(address _escrow) {
        escrow = IInfluenceEscrow(_escrow);
    }

    function submitReview(uint256 dealId, uint8 stars, string calldata text) external {
        require(stars >= 1 && stars <= 5, "stars 1-5");
        require(!dealReviewed[dealId], "deal already reviewed");

        (address brand, address creator, , , , uint8 status, , , ) = escrow.deals(dealId);
        require(status == STATUS_COMPLETED, "deal not released");
        require(msg.sender == brand, "not this deal's brand");

        dealReviewed[dealId] = true;
        creatorReviews[creator].push(Review(brand, creator, dealId, stars, text, block.timestamp));

        emit ReviewSubmitted(dealId, creator, brand, stars);
    }

    function getReviews(address creator) external view returns (Review[] memory) {
        return creatorReviews[creator];
    }

    function hasReviewed(uint256 dealId) external view returns (bool) {
        return dealReviewed[dealId];
    }
}
