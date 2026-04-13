// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Stake ZTH, earn iKAS (fee-sharing) + ZTH (emission).
contract ZenithStaking is Ownable, ReentrancyGuard {

    IERC20 public immutable zth;

    uint256 public constant REWARDS_DURATION = 7 days;
    uint256 public totalStaked;
    mapping(address => uint256) public staked;
    uint256 public kasRewardRate;          // wei per second
    uint256 public kasPeriodFinish;
    uint256 public kasLastUpdateTime;
    uint256 public kasRewardPerTokenStored;
    mapping(address => uint256) public kasUserRewardPerTokenPaid;
    mapping(address => uint256) public kasRewards;
    uint256 public zthRewardRate;          // ZTH units per second
    uint256 public zthPeriodFinish;
    uint256 public zthLastUpdateTime;
    uint256 public zthRewardPerTokenStored;
    mapping(address => uint256) public zthUserRewardPerTokenPaid;
    mapping(address => uint256) public zthRewards;
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 kasAmount, uint256 zthAmount);
    event KasRewardNotified(uint256 amount, uint256 rate);
    event ZthRewardNotified(uint256 amount, uint256 rate);

    constructor(address _zth) Ownable(msg.sender) {
        require(_zth != address(0), "ZenithStaking: zero ZTH");
        zth = IERC20(_zth);
    }

    modifier updateReward(address account) {
        uint256 kasRPT = kasRewardPerToken();
        uint256 zthRPT = zthRewardPerToken();

        kasRewardPerTokenStored = kasRPT;
        zthRewardPerTokenStored = zthRPT;
        kasLastUpdateTime       = _kasLastApplicable();
        zthLastUpdateTime       = _zthLastApplicable();

        if (account != address(0)) {
            kasRewards[account] = kasEarned(account);
            zthRewards[account] = zthEarned(account);
            kasUserRewardPerTokenPaid[account] = kasRPT;
            zthUserRewardPerTokenPaid[account] = zthRPT;
        }
        _;
    }

    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "ZenithStaking: cannot stake 0");
        totalStaked        += amount;
        staked[msg.sender] += amount;
        zth.transferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0,                      "ZenithStaking: cannot unstake 0");
        require(staked[msg.sender] >= amount,    "ZenithStaking: insufficient stake");
        totalStaked        -= amount;
        staked[msg.sender] -= amount;
        zth.transfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claimRewards() external nonReentrant updateReward(msg.sender) {
        uint256 kasAmt = kasRewards[msg.sender];
        uint256 zthAmt = zthRewards[msg.sender];

        if (kasAmt == 0 && zthAmt == 0) return;

        kasRewards[msg.sender] = 0;
        zthRewards[msg.sender] = 0;

        if (kasAmt > 0) {
            (bool sent,) = msg.sender.call{value: kasAmt}("");
            require(sent, "ZenithStaking: iKAS transfer failed");
        }
        if (zthAmt > 0) {
            zth.transfer(msg.sender, zthAmt);
        }

        emit RewardsClaimed(msg.sender, kasAmt, zthAmt);
    }

    // Deposit iKAS to distribute as fee-sharing rewards over 7 days.
    function notifyKasReward() external payable onlyOwner updateReward(address(0)) {
        require(msg.value > 0, "ZenithStaking: send iKAS");

        if (block.timestamp >= kasPeriodFinish) {
            kasRewardRate = msg.value / REWARDS_DURATION;
        } else {
            uint256 remaining = kasPeriodFinish - block.timestamp;
            uint256 leftover  = remaining * kasRewardRate;
            kasRewardRate     = (msg.value + leftover) / REWARDS_DURATION;
        }

        require(kasRewardRate > 0, "ZenithStaking: reward rate too low");

        kasLastUpdateTime = block.timestamp;
        kasPeriodFinish   = block.timestamp + REWARDS_DURATION;

        emit KasRewardNotified(msg.value, kasRewardRate);
    }

    // Deposit ZTH to distribute as emission rewards over 7 days.
    function notifyZthReward(uint256 amount) external onlyOwner updateReward(address(0)) {
        require(amount > 0, "ZenithStaking: amount is 0");

        zth.transferFrom(msg.sender, address(this), amount);

        if (block.timestamp >= zthPeriodFinish) {
            zthRewardRate = amount / REWARDS_DURATION;
        } else {
            uint256 remaining = zthPeriodFinish - block.timestamp;
            uint256 leftover  = remaining * zthRewardRate;
            zthRewardRate     = (amount + leftover) / REWARDS_DURATION;
        }

        require(zthRewardRate > 0, "ZenithStaking: reward rate too low");

        zthLastUpdateTime = block.timestamp;
        zthPeriodFinish   = block.timestamp + REWARDS_DURATION;

        emit ZthRewardNotified(amount, zthRewardRate);
    }

    function _kasLastApplicable() internal view returns (uint256) {
        return block.timestamp < kasPeriodFinish ? block.timestamp : kasPeriodFinish;
    }

    function _zthLastApplicable() internal view returns (uint256) {
        return block.timestamp < zthPeriodFinish ? block.timestamp : zthPeriodFinish;
    }

    function kasRewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return kasRewardPerTokenStored;
        return kasRewardPerTokenStored +
            ((_kasLastApplicable() - kasLastUpdateTime) * kasRewardRate * 1e18) / totalStaked;
    }

    function zthRewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return zthRewardPerTokenStored;
        return zthRewardPerTokenStored +
            ((_zthLastApplicable() - zthLastUpdateTime) * zthRewardRate * 1e18) / totalStaked;
    }

    function kasEarned(address account) public view returns (uint256) {
        return (staked[account] * (kasRewardPerToken() - kasUserRewardPerTokenPaid[account])) /
            1e18 + kasRewards[account];
    }

    function zthEarned(address account) public view returns (uint256) {
        return (staked[account] * (zthRewardPerToken() - zthUserRewardPerTokenPaid[account])) /
            1e18 + zthRewards[account];
    }
    ///         kasPrice is the iKAS price in USD cents (e.g. 3 = $0.03).
    ///         zthPrice is the ZTH price in USD cents.
    ///         Returns 0 if TVL is 0.
    function estimateApyBps(uint256 kasUsdCents, uint256 zthUsdCents)
        external view returns (uint256)
    {
        if (totalStaked == 0) return 0;

        uint256 annualKasUsd = kasRewardRate * 365 days * kasUsdCents / 1e18;
        uint256 annualZthUsd = zthRewardRate * 365 days * zthUsdCents / 1e18;
        uint256 tvlUsd       = totalStaked   * zthUsdCents / 1e18;

        if (tvlUsd == 0) return 0;
        return (annualKasUsd + annualZthUsd) * 10_000 / tvlUsd;
    }

    receive() external payable {}
}
