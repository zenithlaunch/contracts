// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
//  KasTokenFactory — One-click token + bonding curve deployment

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./KasToken.sol";

interface IKasLaunch {
    function createPool(
        address token,
        uint256 amount,
        address creator,
        string calldata metadataUri
    ) external payable;

    function getCreateFee() external view returns (uint256);
}

contract KasTokenFactory is Ownable, ReentrancyGuard {
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 * 1e18; // 1 billion

    address public kasLaunchAddress;

    struct TokenRecord {
        address tokenAddress;
        address creator;
        string  name;
        string  symbol;
        string  metadataUri;
        uint256 createdAt;
    }

    TokenRecord[] public deployedTokens;
    mapping(address => address[]) public creatorTokens; // creator → [tokenAddresses]

    event TokenDeployed(
        address indexed token,
        address indexed creator,
        string  name,
        string  symbol,
        string  metadataUri,
        uint256 timestamp
    );

    constructor(address kasLaunch_) Ownable(msg.sender) {
        kasLaunchAddress = kasLaunch_;
    }

    
    function deployToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataUri
    ) external payable nonReentrant returns (address tokenAddress) {
        uint256 createFee = IKasLaunch(kasLaunchAddress).getCreateFee();
        require(msg.value >= createFee, "KasTokenFactory: insufficient fee");

        // Deploy new ERC20 — full supply minted to this factory
        KasToken token = new KasToken(name, symbol, INITIAL_SUPPLY);
        tokenAddress = address(token);

        // Approve KasLaunch to pull the tokens
        token.approve(kasLaunchAddress, INITIAL_SUPPLY);

        // Register on bonding curve; forward createFee
        IKasLaunch(kasLaunchAddress).createPool{value: createFee}(
            tokenAddress,
            INITIAL_SUPPLY,
            msg.sender,
            metadataUri
        );

        // Refund excess
        uint256 excess = msg.value - createFee;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            require(ok, "KasTokenFactory: refund failed");
        }

        // Store record
        deployedTokens.push(TokenRecord({
            tokenAddress: tokenAddress,
            creator:      msg.sender,
            name:         name,
            symbol:       symbol,
            metadataUri:  metadataUri,
            createdAt:    block.timestamp
        }));
        creatorTokens[msg.sender].push(tokenAddress);

        emit TokenDeployed(tokenAddress, msg.sender, name, symbol, metadataUri, block.timestamp);
    }

    function setKasLaunchAddress(address addr) external onlyOwner {
        require(addr != address(0), "zero address");
        kasLaunchAddress = addr;
    }

    function getDeployedCount() external view returns (uint256) {
        return deployedTokens.length;
    }

    function getCreateFee() external view returns (uint256) {
        return IKasLaunch(kasLaunchAddress).getCreateFee();
    }

    function getCreatorTokens(address creator) external view returns (address[] memory) {
        return creatorTokens[creator];
    }
}
