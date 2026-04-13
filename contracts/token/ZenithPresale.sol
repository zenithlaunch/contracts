// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// FCFS presale for ZTH at a fixed price of 0.005 iKAS per ZTH (200 ZTH per iKAS).
contract ZenithPresale is Ownable, ReentrancyGuard {

    IERC20  public immutable zth;
    address public immutable treasury;
    uint256 public constant HARD_CAP       = 150_000_000 * 1e18; // 150M ZTH
    uint256 public constant MAX_PER_WALLET =      50_000 * 1e18; // 50k  ZTH
    uint256 public constant ZTH_PER_KAS   = 200;                  // 0.005 iKAS / ZTH
    bool    public presaleOpen;
    uint256 public totalSold;
    mapping(address => uint256) public bought; // ZTH purchased per wallet
    event PresaleOpened();
    event PresaleClosed();
    event Bought(address indexed buyer, uint256 kasAmount, uint256 zthAmount);

    constructor(address _zth, address _treasury) Ownable(msg.sender) {
        require(_zth      != address(0), "ZenithPresale: zero ZTH");
        require(_treasury != address(0), "ZenithPresale: zero treasury");
        zth      = IERC20(_zth);
        treasury = _treasury;
    }

    function openPresale() external onlyOwner {
        require(!presaleOpen, "ZenithPresale: already open");
        require(
            zth.balanceOf(address(this)) >= HARD_CAP,
            "ZenithPresale: fund contract with 150M ZTH first"
        );
        presaleOpen = true;
        emit PresaleOpened();
    }

    function closePresale() external onlyOwner {
        presaleOpen = false;
        emit PresaleClosed();
    }
    function withdrawUnsoldZth() external onlyOwner {
        require(!presaleOpen, "ZenithPresale: close presale first");
        uint256 remaining = zth.balanceOf(address(this));
        require(remaining > 0, "ZenithPresale: nothing to withdraw");
        zth.transfer(treasury, remaining);
    }

    // Buy ZTH with iKAS. Sends ZTH immediately to caller.
    function buy() external payable nonReentrant {
        require(presaleOpen,       "ZenithPresale: presale not open");
        require(msg.value > 0,     "ZenithPresale: send iKAS to buy");

        uint256 zthAmount = msg.value * ZTH_PER_KAS;

        require(
            totalSold + zthAmount <= HARD_CAP,
            "ZenithPresale: exceeds hard cap"
        );
        require(
            bought[msg.sender] + zthAmount <= MAX_PER_WALLET,
            "ZenithPresale: wallet limit reached"
        );

        totalSold              += zthAmount;
        bought[msg.sender]     += zthAmount;

        // Auto-close when hard cap is exactly reached
        if (totalSold >= HARD_CAP) {
            presaleOpen = false;
            emit PresaleClosed();
        }

        // Forward iKAS to treasury immediately (no custody risk)
        (bool sent,) = treasury.call{value: msg.value}("");
        require(sent, "ZenithPresale: iKAS transfer failed");

        zth.transfer(msg.sender, zthAmount);
        emit Bought(msg.sender, msg.value, zthAmount);
    }

    function remaining() external view returns (uint256) {
        return HARD_CAP - totalSold;
    }

    function walletRemaining(address user) external view returns (uint256) {
        uint256 used = bought[user];
        if (used >= MAX_PER_WALLET) return 0;
        return MAX_PER_WALLET - used;
    }

    function progressBps() external view returns (uint256) {
        return (totalSold * 10_000) / HARD_CAP;
    }
}
