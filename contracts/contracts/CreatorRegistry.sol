// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CreatorRegistry
/// @notice On-chain profile directory for Influence creators. Ratings and reviews
///         live in the separate Reviews contract, which reads deal outcomes
///         directly from InfluenceEscrow — this contract only stores what a
///         creator submits about themselves.
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
    }

    address public owner;

    mapping(address => Creator) private creators;
    mapping(address => SocialLink[]) private creatorSocials;
    address[] public creatorAddresses;

    event CreatorRegistered(address indexed creator, string name);
    event CreatorVerified(address indexed creator, bool verified);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
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

    function getCreatorCount() external view returns (uint256) {
        return creatorAddresses.length;
    }

    function getCreator(address creator) external view returns (Creator memory, SocialLink[] memory) {
        return (creators[creator], creatorSocials[creator]);
    }

    function isRegistered(address creator) external view returns (bool) {
        return creators[creator].registered;
    }
}
