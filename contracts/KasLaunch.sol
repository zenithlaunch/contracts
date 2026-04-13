// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
//  KasLaunch — Bonding Curve Launchpad for Igra Network (Kaspa L2)

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniswapV2Factory {
    function createPair(address tokenA, address tokenB)
        external
        returns (address pair);
    function getPair(address tokenA, address tokenB)
        external
        view
        returns (address pair);
}

interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

contract KasLaunch is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    uint256 public constant TOKEN_TOTAL_SUPPLY             = 1_000_000_000 * 1e18;
    uint256 public constant INITIAL_VIRTUAL_TOKEN_RESERVES = 800_000_000 * 1e18;
    uint256 public constant INITIAL_VIRTUAL_KAS_RESERVES   = 105_000 * 1e18;
    uint256 public constant LP_RESERVE_SUPPLY              = 200_000_000 * 1e18;
    uint256 public constant RESCUE_TIMELOCK                = 7 days;
    uint256 public constant ROUTER_TIMELOCK                = 2 days;
    uint256 public constant LP_SLIPPAGE_BPS                = 300;  // 3% max slippage on graduation LP
    uint256 public graduationKasThreshold = 300_000 * 1e18;
    uint256 public createFee              = 150 * 1e18;
    uint256 public feeBasisPoints    = 100;   // 1%
    uint256 public graduationFeeBps  = 200;   // 2%

    address public feeRecipient;
    address public factory;
    IUniswapV2Router02 public dexRouter;

    // Timelock for router changes
    address public pendingDexRouter;
    uint256 public pendingRouterValidAt;
    struct TokenCurve {
        address tokenMint;
        uint256 virtualTokenReserves;
        uint256 virtualKasReserves;
        uint256 realTokenReserves;
        uint256 realKasReserves;
        uint256 lpReservedTokens;
        uint256 tokenTotalSupply;
        bool    complete;
        address creator;
        string  metadataUri;
        uint256 graduatedAt; // timestamp when curve completed (for rescue timelock)
    }

    mapping(address => TokenCurve) public bondingCurve;
    address[] public allTokens;
    event TokenCreated(
        address indexed token,
        address indexed creator,
        string  name,
        string  symbol,
        string  metadataUri,
        uint256 timestamp
    );
    event Trade(
        address indexed token,
        uint256 kasAmount,
        uint256 tokenAmount,
        bool    isBuy,
        address indexed trader,
        uint256 timestamp,
        uint256 virtualKasReserves,
        uint256 virtualTokenReserves,
        uint256 price
    );
    event Graduated(
        address indexed token,
        address indexed dexPair,
        uint256 kasLiquidity,
        uint256 tokenLiquidity,
        uint256 timestamp
    );
    event DexRouterProposed(address indexed router, uint256 validAt);
    event DexRouterAccepted(address indexed router);
    event FactorySet(address indexed factory);

    modifier onlyFactory() {
        require(msg.sender == factory, "KasLaunch: caller is not factory");
        _;
    }

    constructor(address feeRecipient_, address dexRouter_) Ownable(msg.sender) {
        require(feeRecipient_ != address(0), "KasLaunch: zero fee recipient");
        feeRecipient = feeRecipient_;
        dexRouter    = IUniswapV2Router02(dexRouter_);
    }

    receive() external payable {}

    function setFactory(address factory_) external onlyOwner {
        require(factory_ != address(0), "KasLaunch: zero factory");
        require(factory == address(0),  "KasLaunch: factory already set");
        factory = factory_;
        emit FactorySet(factory_);
    }

    function createPool(
        address token,
        uint256 amount,
        address creator,
        string calldata metadataUri
    ) external payable nonReentrant onlyFactory {
        require(amount > 0,                                    "KasLaunch: amount zero");
        require(feeRecipient != address(0),                    "KasLaunch: fee recipient not set");
        require(msg.value >= createFee,                        "KasLaunch: insufficient create fee");
        require(bondingCurve[token].tokenMint == address(0),   "KasLaunch: pool exists");

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        _sendKas(feeRecipient, createFee);

        uint256 excess = msg.value - createFee;
        if (excess > 0) _sendKas(msg.sender, excess);

        require(amount >= LP_RESERVE_SUPPLY, "KasLaunch: amount below LP reserve");

        bondingCurve[token] = TokenCurve({
            tokenMint:             token,
            virtualTokenReserves:  INITIAL_VIRTUAL_TOKEN_RESERVES,
            virtualKasReserves:    INITIAL_VIRTUAL_KAS_RESERVES,
            realTokenReserves:     amount - LP_RESERVE_SUPPLY,
            realKasReserves:       0,
            lpReservedTokens:      LP_RESERVE_SUPPLY,
            tokenTotalSupply:      TOKEN_TOTAL_SUPPLY,
            complete:              false,
            creator:               creator,
            metadataUri:           metadataUri,
            graduatedAt:           0
        });

        allTokens.push(token);
    }

    function buy(
        address token,
        uint256 tokenAmount,
        uint256 maxKasCost
    ) external payable nonReentrant {
        TokenCurve storage curve = bondingCurve[token];
        require(tokenAmount > 0,      "KasLaunch: amount zero");
        require(!curve.complete,      "KasLaunch: curve complete");

        require(tokenAmount < curve.realTokenReserves, "KasLaunch: insufficient reserves");

        uint256 kasCost = calculateBuyCost(curve, tokenAmount);
        require(kasCost <= maxKasCost,    "KasLaunch: slippage exceeded");
        require(msg.value >= kasCost,     "KasLaunch: insufficient iKAS");

        uint256 fee        = (kasCost * feeBasisPoints) / 10_000;
        uint256 kasNetCost = kasCost - fee;

        _sendKas(feeRecipient, fee);
        IERC20(token).safeTransfer(msg.sender, tokenAmount);

        curve.realTokenReserves    -= tokenAmount;
        curve.virtualTokenReserves -= tokenAmount;
        curve.virtualKasReserves   += kasNetCost;
        curve.realKasReserves      += kasNetCost;

        if (msg.value > kasCost) _sendKas(msg.sender, msg.value - kasCost);

        uint256 price = _currentPrice(curve);
        emit Trade(token, kasCost, tokenAmount, true, msg.sender, block.timestamp,
            curve.virtualKasReserves, curve.virtualTokenReserves, price);

        if (curve.realKasReserves >= graduationKasThreshold) {
            _graduate(token, curve);
        }
    }

    function sell(
        address token,
        uint256 tokenAmount,
        uint256 minKasOut
    ) external nonReentrant {
        TokenCurve storage curve = bondingCurve[token];
        require(!curve.complete,  "KasLaunch: curve complete");
        require(tokenAmount > 0,  "KasLaunch: amount zero");

        // sell: tokens enter pool → token reserves increase
        uint256 kasOut = calculateSellReturn(curve, tokenAmount);
        if (kasOut > curve.realKasReserves) kasOut = curve.realKasReserves;

        require(kasOut >= minKasOut, "KasLaunch: slippage exceeded");

        uint256 fee    = (kasOut * feeBasisPoints) / 10_000;
        uint256 netKas = kasOut - fee;

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        _sendKas(feeRecipient, fee);
        _sendKas(msg.sender, netKas);

        curve.realTokenReserves    += tokenAmount;
        curve.virtualTokenReserves += tokenAmount;
        curve.virtualKasReserves   -= kasOut;
        curve.realKasReserves      -= kasOut;

        uint256 price = _currentPrice(curve);
        emit Trade(token, kasOut, tokenAmount, false, msg.sender, block.timestamp,
            curve.virtualKasReserves, curve.virtualTokenReserves, price);
    }

    function _graduate(address token, TokenCurve storage curve) internal {
        // If no DEX configured yet, skip — curve stays open until DEX is set
        if (address(dexRouter) == address(0)) return;

        curve.complete    = true;
        curve.graduatedAt = block.timestamp;

        uint256 totalKas             = curve.realKasReserves;
        uint256 tokensForLp          = curve.lpReservedTokens;
        uint256 remainingCurveTokens = curve.realTokenReserves;

        uint256 graduationFee = (totalKas * graduationFeeBps) / 10_000;
        uint256 kasForLp      = totalKas - graduationFee;

        // Zero reserves before external calls (CEI pattern)
        curve.realKasReserves   = 0;
        curve.realTokenReserves = 0;
        curve.lpReservedTokens  = 0;

        IERC20(token).approve(address(dexRouter), tokensForLp);

        uint256 tokenMin = tokensForLp * (10_000 - LP_SLIPPAGE_BPS) / 10_000;
        uint256 kasMin   = kasForLp    * (10_000 - LP_SLIPPAGE_BPS) / 10_000;

        address pair;
        try dexRouter.addLiquidityETH{value: kasForLp}(
            token,
            tokensForLp,
            tokenMin,
            kasMin,
            address(0xdead), // LP permanently burned — no rug possible
            block.timestamp + 300
        ) {
            pair = IUniswapV2Factory(dexRouter.factory()).getPair(
                token, dexRouter.WETH()
            );
            // Burn unsold curve tokens — they never enter LP
            IERC20(token).safeTransfer(address(0xdead), remainingCurveTokens);
        } catch {
            // DEX migration failed — restore full state (fee not sent yet)
            IERC20(token).approve(address(dexRouter), 0);
            curve.realKasReserves   = totalKas;
            curve.realTokenReserves = remainingCurveTokens;
            curve.lpReservedTokens  = tokensForLp;
            curve.complete          = false;
            curve.graduatedAt       = 0;
            return;
        }

        // Fee sent only after successful LP creation
        _sendKas(feeRecipient, graduationFee);

        emit Graduated(token, pair, kasForLp, tokensForLp, block.timestamp);
    }

    // KAS cost for buying `tokenAmount` tokens (tokens leave pool).
    function calculateBuyCost(TokenCurve memory curve, uint256 tokenAmount)
        public
        pure
        returns (uint256)
    {
        require(tokenAmount < curve.virtualTokenReserves, "KasLaunch: insufficient liquidity");
        uint256 k               = curve.virtualKasReserves * curve.virtualTokenReserves;
        uint256 newTokenReserves = curve.virtualTokenReserves - tokenAmount;
        uint256 newKasReserves   = k / newTokenReserves;
        return newKasReserves - curve.virtualKasReserves;
    }

    // KAS returned for selling `tokenAmount` tokens (tokens enter pool).
    function calculateSellReturn(TokenCurve memory curve, uint256 tokenAmount)
        public
        pure
        returns (uint256)
    {
        uint256 k                = curve.virtualKasReserves * curve.virtualTokenReserves;
        uint256 newTokenReserves = curve.virtualTokenReserves + tokenAmount;
        uint256 newKasReserves   = k / newTokenReserves;
        if (newKasReserves >= curve.virtualKasReserves) return 0;
        return curve.virtualKasReserves - newKasReserves;
    }
    function calculateKasCost(TokenCurve memory curve, uint256 tokenAmount)
        public
        pure
        returns (uint256)
    {
        return calculateBuyCost(curve, tokenAmount);
    }

    function _currentPrice(TokenCurve memory curve) internal pure returns (uint256) {
        return (curve.virtualKasReserves * 1e18) / curve.virtualTokenReserves;
    }

    function _marketCap(TokenCurve memory curve) internal pure returns (uint256) {
        if (curve.realTokenReserves == 0) return type(uint256).max;
        return (curve.virtualKasReserves * curve.tokenTotalSupply) / curve.realTokenReserves;
    }

    /**
     * @notice Emergency rescue for a graduated token if DEX migration left funds.
     *         Only callable 7 days after graduation to give users time to react.
     */
    function rescueGraduatedFunds(address token) external onlyOwner {
        TokenCurve storage curve = bondingCurve[token];
        require(curve.complete,                                        "KasLaunch: not complete");
        require(curve.graduatedAt > 0,                                 "KasLaunch: no graduation timestamp");
        require(block.timestamp >= curve.graduatedAt + RESCUE_TIMELOCK, "KasLaunch: timelock active");

        uint256 kas    = curve.realKasReserves;
        uint256 tokens = curve.realTokenReserves;
        curve.realKasReserves   = 0;
        curve.realTokenReserves = 0;
        if (kas > 0)    _sendKas(owner(), kas);
        if (tokens > 0) IERC20(token).safeTransfer(owner(), tokens);
    }

    function setFeeRecipient(address addr) external onlyOwner {
        require(addr != address(0), "KasLaunch: zero address");
        feeRecipient = addr;
    }

    // Propose a new DEX router. Takes effect only after ROUTER_TIMELOCK (2 days).
    function proposeDexRouter(address addr) external onlyOwner {
        require(addr != address(0), "KasLaunch: zero address");
        pendingDexRouter    = addr;
        pendingRouterValidAt = block.timestamp + ROUTER_TIMELOCK;
        emit DexRouterProposed(addr, pendingRouterValidAt);
    }

    function acceptDexRouter() external onlyOwner {
        require(pendingDexRouter != address(0),             "KasLaunch: no pending router");
        require(block.timestamp >= pendingRouterValidAt,    "KasLaunch: timelock active");
        dexRouter        = IUniswapV2Router02(pendingDexRouter);
        emit DexRouterAccepted(pendingDexRouter);
        pendingDexRouter    = address(0);
        pendingRouterValidAt = 0;
    }

    function setGraduationKasThreshold(uint256 threshold) external onlyOwner {
        require(threshold >= 1_000 * 1e18, "KasLaunch: threshold too low"); // min 1k KAS
        graduationKasThreshold = threshold;
    }

    function setCreateFee(uint256 fee) external onlyOwner {
        require(fee <= 500 * 1e18, "KasLaunch: fee too high"); // max 500 KAS
        createFee = fee;
    }

    function setFeeBasisPoints(uint256 bps) external onlyOwner {
        require(bps <= 500, "KasLaunch: fee too high"); // max 5%
        feeBasisPoints = bps;
    }

    function setGraduationFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 1000, "KasLaunch: graduation fee too high"); // max 10%
        graduationFeeBps = bps;
    }

    function getBondingCurve(address token) external view returns (TokenCurve memory) {
        return bondingCurve[token];
    }

    function getCreateFee() external view returns (uint256) {
        return createFee;
    }

    function getTokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function getTokens(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory)
    {
        uint256 total = allTokens.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = allTokens[i];
        }
        return result;
    }

    function getPrice(address token) external view returns (uint256) {
        return _currentPrice(bondingCurve[token]);
    }

    function getMarketCap(address token) external view returns (uint256) {
        return _marketCap(bondingCurve[token]);
    }

    function _sendKas(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "KasLaunch: iKAS transfer failed");
    }
}
