// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// Fixed supply ERC-20 token for the Zenith launchpad platform.
contract ZenithToken is ERC20, Ownable {

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10 ** 18;
    uint256 public constant TEAM_PCT       = 20;
    uint256 public constant TREASURY_PCT   = 25;
    uint256 public constant LIQUIDITY_PCT  = 20;
    uint256 public constant PRESALE_PCT    = 15;
    uint256 public constant ECOSYSTEM_PCT  = 10;
    uint256 public constant COMMUNITY_PCT  = 10;
    address public immutable teamWallet;
    address public immutable treasuryWallet;

    uint256 public immutable vestingStart;
    uint256 public constant  VESTING_CLIFF    = 180 days; // 6 months
    uint256 public constant  VESTING_DURATION = 730 days; // 24 months

    uint256 public immutable teamTotal;    // total tokens for team
    uint256 public           teamClaimed;  // how much team has claimed so far
    event TeamClaimed(uint256 amount, uint256 totalClaimed);
    constructor(
        address _teamWallet,
        address _treasuryWallet
    ) ERC20("Zenith", "ZTH") Ownable(_teamWallet) {
        require(_teamWallet     != address(0), "ZTH: zero team");
        require(_treasuryWallet != address(0), "ZTH: zero treasury");

        teamWallet     = _teamWallet;
        treasuryWallet = _treasuryWallet;
        vestingStart   = block.timestamp;

        // Team allocation — locked in this contract, released via claimTeam()
        teamTotal = (TOTAL_SUPPLY * TEAM_PCT) / 100;

        // Everything else → treasury wallet (liquidity, presale, ecosystem, community, treasury)
        uint256 toTreasury = TOTAL_SUPPLY - teamTotal;

        _mint(address(this), teamTotal);   // locked team tokens
        _mint(_treasuryWallet, toTreasury); // all other allocations
    }

    
    function teamVested() public view returns (uint256) {
        uint256 elapsed = block.timestamp - vestingStart;
        if (elapsed < VESTING_CLIFF) return 0;
        if (elapsed >= VESTING_DURATION) return teamTotal;
        return (teamTotal * elapsed) / VESTING_DURATION;
    }

    
    function teamClaimable() public view returns (uint256) {
        uint256 vested = teamVested();
        if (vested <= teamClaimed) return 0;
        return vested - teamClaimed;
    }

    // Claim unlocked team tokens. Only callable by teamWallet.
    function claimTeam() external {
        require(msg.sender == teamWallet, "ZTH: not team");
        uint256 claimable = teamClaimable();
        require(claimable > 0, "ZTH: nothing to claim");
        teamClaimed += claimable;
        _transfer(address(this), teamWallet, claimable);
        emit TeamClaimed(claimable, teamClaimed);
    }

    // Human-readable vesting status for the team wallet.
    function vestingStatus() external view returns (
        uint256 total,
        uint256 claimed,
        uint256 claimable,
        uint256 locked,
        uint256 cliffEndsAt,
        uint256 fullyVestedAt
    ) {
        total        = teamTotal;
        claimed      = teamClaimed;
        claimable    = teamClaimable();
        locked       = teamTotal - teamClaimed - claimable;
        cliffEndsAt  = vestingStart + VESTING_CLIFF;
        fullyVestedAt= vestingStart + VESTING_DURATION;
    }
}
