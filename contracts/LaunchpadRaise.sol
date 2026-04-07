// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
//  LaunchpadRaise — Classic Launchpad for Serious Projects
//  Flow:
//   1. LaunchpadFactory deploys this contract for approved projects
//   2. Project receives a deploy with pre-set hardcap/softcap/price/window
//   3. Users invest KAS during the raise window
//   4. If softcap met: anyone calls finalize() — tokens distributed, KAS sent
//   5. If softcap NOT met: users call refund() after endTime
//
//  Features:
//   • Optional Merkle-tree whitelist
//   • Linear vesting with configurable TGE % + cliff + duration
//   • 2% platform fee on finalization
//
//  Security fixes (v2):
//   • tokenSupply must cover full hardcap at given tokenPrice (on-chain check)
//   • cancel() restricted to before endTime — after that anyone can finalize
//   • cancel() checks !canceled to prevent double-cancel
//   • investorCount only increments on first investment (was already correct)

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./KasToken.sol";

contract LaunchpadRaise is ReentrancyGuard, Ownable {
    address public projectWallet;
    string  public tokenName;
    string  public tokenSymbol;
    uint256 public tokenSupply;
    uint256 public hardcap;
    uint256 public softcap;
    uint256 public tokenPrice;       // KAS per token (in wei)
    uint256 public startTime;
    uint256 public endTime;
    string  public metadataUri;
    bool    public whitelistEnabled;
    bytes32 public merkleRoot;
    uint256 public tgePercent;
    uint256 public cliffDuration;
    uint256 public vestingDuration;
    uint256 public constant PLATFORM_FEE_BPS  = 200;   // 2%
    uint256 public constant TOKEN_RESCUE_DELAY = 180 days;

    KasToken public token;
    uint256  public totalRaised;
    uint256  public investorCount;
    bool     public finalized;
    bool     public canceled;
    uint256  public finalizedAt;
    uint256  public maxInvestment; // 0 = no limit per wallet

    mapping(address => uint256) public investments;
    mapping(address => uint256) public tokensClaimed;
    mapping(address => bool)    public refundClaimed;
    event RaiseCreated(
        address indexed raiseContract,
        address indexed projectWallet,
        string  tokenName,
        string  tokenSymbol,
        uint256 hardcap,
        uint256 softcap,
        uint256 startTime,
        uint256 endTime
    );
    event Invested(
        address indexed investor,
        uint256 kasAmount,
        uint256 tokenAmount,
        uint256 totalRaised
    );
    event Finalized(
        address indexed projectWallet,
        uint256 kasToProject,
        uint256 platformFee,
        address tokenAddress,
        uint256 timestamp
    );
    event Refunded(address indexed investor, uint256 kasAmount);
    event TokensClaimed(address indexed investor, uint256 amount, uint256 timestamp);
    event Canceled(uint256 timestamp);
    event UnclaimedTokensRescued(address indexed to, uint256 amount, uint256 timestamp);
    constructor(
        address  projectWallet_,
        string   memory tokenName_,
        string   memory tokenSymbol_,
        uint256  tokenSupply_,
        uint256  hardcap_,
        uint256  softcap_,
        uint256  tokenPrice_,
        uint256  startTime_,
        uint256  endTime_,
        bool     whitelistEnabled_,
        bytes32  merkleRoot_,
        uint256  tgePercent_,
        uint256  cliffDuration_,
        uint256  vestingDuration_,
        string   memory metadataUri_,
        address  factoryOwner_,
        uint256  maxInvestment_   // 0 = no per-wallet cap
    ) Ownable(factoryOwner_) {
        require(projectWallet_  != address(0),   "LaunchpadRaise: zero project wallet");
        require(hardcap_        >= softcap_,      "LaunchpadRaise: hardcap < softcap");
        require(softcap_        > 0,              "LaunchpadRaise: zero softcap");
        require(tokenPrice_     > 0,              "LaunchpadRaise: zero token price");
        require(startTime_      < endTime_,       "LaunchpadRaise: invalid time window");
        require(startTime_      > block.timestamp,"LaunchpadRaise: start in past");
        require(tgePercent_     <= 100,           "LaunchpadRaise: tge > 100");
        require(tokenSupply_    > 0,              "LaunchpadRaise: zero supply");

        // tokenSupply must cover all investors at hardcap: tokenSupply >= hardcap * 1e18 / tokenPrice
        require(
            tokenSupply_ * tokenPrice_ >= hardcap_ * 1e18,
            "LaunchpadRaise: tokenSupply too low for hardcap"
        );

        projectWallet    = projectWallet_;
        tokenName        = tokenName_;
        tokenSymbol      = tokenSymbol_;
        tokenSupply      = tokenSupply_;
        hardcap          = hardcap_;
        softcap          = softcap_;
        tokenPrice       = tokenPrice_;
        startTime        = startTime_;
        endTime          = endTime_;
        whitelistEnabled = whitelistEnabled_;
        merkleRoot       = merkleRoot_;
        tgePercent       = tgePercent_;
        cliffDuration    = cliffDuration_;
        vestingDuration  = vestingDuration_;
        metadataUri      = metadataUri_;
        maxInvestment    = maxInvestment_;

        emit RaiseCreated(
            address(this),
            projectWallet_,
            tokenName_,
            tokenSymbol_,
            hardcap_,
            softcap_,
            startTime_,
            endTime_
        );
    }

    modifier raiseOpen() {
        require(block.timestamp >= startTime, "LaunchpadRaise: not started");
        require(block.timestamp <= endTime,   "LaunchpadRaise: ended");
        require(!finalized && !canceled,      "LaunchpadRaise: closed");
        _;
    }

    modifier raiseEnded() {
        require(block.timestamp > endTime || finalized || canceled, "LaunchpadRaise: still open");
        _;
    }

    function invest(bytes32[] calldata merkleProof)
        external
        payable
        nonReentrant
        raiseOpen
    {
        require(msg.value > 0,                                 "LaunchpadRaise: zero investment");
        require(totalRaised + msg.value <= hardcap,            "LaunchpadRaise: hardcap exceeded");
        if (maxInvestment > 0) {
            require(
                investments[msg.sender] + msg.value <= maxInvestment,
                "LaunchpadRaise: exceeds max investment per wallet"
            );
        }

        if (whitelistEnabled) {
            require(
                MerkleProof.verify(
                    merkleProof,
                    merkleRoot,
                    keccak256(abi.encodePacked(msg.sender))
                ),
                "LaunchpadRaise: not whitelisted"
            );
        }

        if (investments[msg.sender] == 0) investorCount++;
        investments[msg.sender] += msg.value;
        totalRaised              += msg.value;

        uint256 tokensForAmount = (msg.value * 1e18) / tokenPrice;
        emit Invested(msg.sender, msg.value, tokensForAmount, totalRaised);

        // Auto-finalize on hardcap
        if (totalRaised == hardcap) {
            _finalize();
        }
    }

    // Finalize the raise after endTime if softcap was met.
    function finalize() external nonReentrant {
        require(!finalized && !canceled,                              "LaunchpadRaise: already closed");
        require(
            block.timestamp > endTime || totalRaised >= hardcap,
            "LaunchpadRaise: raise still open"
        );
        require(totalRaised >= softcap,                               "LaunchpadRaise: softcap not reached");
        _finalize();
    }

    function _finalize() internal {
        finalized   = true;
        finalizedAt = block.timestamp;

        token = new KasToken(tokenName, tokenSymbol, tokenSupply);

        uint256 platformFee  = (totalRaised * PLATFORM_FEE_BPS) / 10_000;
        uint256 kasToProject = totalRaised - platformFee;

        _sendKas(projectWallet, kasToProject);
        _sendKas(owner(), platformFee);

        emit Finalized(projectWallet, kasToProject, platformFee, address(token), block.timestamp);
    }

    function refund() external nonReentrant raiseEnded {
        require(
            canceled || (!finalized && totalRaised < softcap),
            "LaunchpadRaise: raise succeeded, use claim"
        );
        require(!refundClaimed[msg.sender], "LaunchpadRaise: already refunded");
        require(investments[msg.sender] > 0, "LaunchpadRaise: nothing to refund");

        refundClaimed[msg.sender] = true;
        uint256 amount = investments[msg.sender];
        investments[msg.sender] = 0;

        _sendKas(msg.sender, amount);
        emit Refunded(msg.sender, amount);
    }

    function claimTokens() external nonReentrant {
        require(finalized,                   "LaunchpadRaise: not finalized");
        require(investments[msg.sender] > 0, "LaunchpadRaise: no investment");

        uint256 totalEntitlement = (investments[msg.sender] * 1e18) / tokenPrice;
        uint256 claimable        = _vestedAmount(msg.sender, totalEntitlement);
        uint256 unclaimed        = claimable - tokensClaimed[msg.sender];

        require(unclaimed > 0, "LaunchpadRaise: nothing to claim");

        tokensClaimed[msg.sender] += unclaimed;
        require(
            token.transfer(msg.sender, unclaimed),
            "LaunchpadRaise: token transfer failed"
        );

        emit TokensClaimed(msg.sender, unclaimed, block.timestamp);
    }

    function _vestedAmount(address, uint256 total)
        internal
        view
        returns (uint256)
    {
        if (!finalized) return 0;

        uint256 tgeAmount = (total * tgePercent) / 100;

        if (vestingDuration == 0) return total;

        uint256 cliffEnd   = finalizedAt + cliffDuration;
        uint256 vestingEnd = cliffEnd + vestingDuration;

        if (block.timestamp < cliffEnd && tgePercent == 0) return 0;
        if (block.timestamp < cliffEnd) return tgeAmount;

        uint256 elapsed       = block.timestamp - cliffEnd;
        uint256 vestingAmount = total - tgeAmount;
        uint256 vestedPortion = block.timestamp >= vestingEnd
            ? vestingAmount
            : (vestingAmount * elapsed) / vestingDuration;

        return tgeAmount + vestedPortion;
    }

    function claimableTokens(address investor) external view returns (uint256) {
        if (!finalized || investments[investor] == 0) return 0;
        uint256 total  = (investments[investor] * 1e18) / tokenPrice;
        uint256 vested = _vestedAmount(investor, total);
        return vested - tokensClaimed[investor];
    }

    function tokenEntitlement(address investor) external view returns (uint256) {
        return (investments[investor] * 1e18) / tokenPrice;
    }

    /**
     * @notice Cancel the raise (emergency).
     *         FIX: only callable before endTime — after endTime investors
     *         can finalize themselves, so cancel is no longer needed and
     *         prevents the team from canceling a successful raise post-deadline.
     */
    function cancel() external onlyOwner {
        require(!finalized,                  "LaunchpadRaise: already finalized");
        require(!canceled,                   "LaunchpadRaise: already canceled");
        require(block.timestamp < endTime,   "LaunchpadRaise: raise ended, use finalize");
        canceled = true;
        emit Canceled(block.timestamp);
    }

    // Update the whitelist Merkle root.
    function updateMerkleRoot(bytes32 root) external onlyOwner {
        require(block.timestamp < startTime, "LaunchpadRaise: raise already started");
        merkleRoot = root;
    }

    // Rescue unclaimed tokens 180 days after finalization.
    function rescueUnclaimedTokens() external onlyOwner {
        require(finalized,                                              "LaunchpadRaise: not finalized");
        require(block.timestamp >= finalizedAt + TOKEN_RESCUE_DELAY,   "LaunchpadRaise: rescue delay active");

        uint256 remaining = token.balanceOf(address(this));
        require(remaining > 0, "LaunchpadRaise: nothing to rescue");

        require(token.transfer(projectWallet, remaining), "LaunchpadRaise: transfer failed");
        emit UnclaimedTokensRescued(projectWallet, remaining, block.timestamp);
    }

    function getProgress() external view returns (uint256 raised, uint256 cap, uint256 pct) {
        raised = totalRaised;
        cap    = hardcap;
        pct    = hardcap > 0 ? (totalRaised * 100) / hardcap : 0;
    }

    function isActive() external view returns (bool) {
        return !finalized &&
               !canceled &&
               block.timestamp >= startTime &&
               block.timestamp <= endTime;
    }

    function softcapReached() external view returns (bool) {
        return totalRaised >= softcap;
    }

    function _sendKas(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "LaunchpadRaise: KAS transfer failed");
    }
}
