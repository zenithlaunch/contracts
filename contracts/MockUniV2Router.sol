// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * MockUniV2Router — Minimal Uniswap V2 router mock for testnet graduation validation.
 *
 * Implements exactly the surface area KasLaunch._graduate() calls:
 *   - factory()          → returns address(this) (self acts as factory too)
 *   - WETH()             → returns a deterministic mock address
 *   - addLiquidityETH()  → accepts ETH + tokens, emits event, returns non-zero values
 *   - getPair()          → returns address(this) as the mock pair
 *
 * Tokens and ETH sent to addLiquidityETH are kept here (simulating LP).
 * Useful only for testing — never use in production.
 */
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockUniV2Router {
    // Fixed mock WETH address — just needs to be consistent
    address public constant MOCK_WETH = address(0x000000000000000000000000000000000000dEaD);

    event LiquidityAdded(
        address indexed token,
        uint256 tokenAmount,
        uint256 kasAmount,
        address to
    );

    // ── IUniswapV2Router02 surface ──────────────────────────

    function factory() external view returns (address) {
        return address(this); // self-referential: this contract also acts as the factory
    }

    function WETH() external pure returns (address) {
        return MOCK_WETH;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 /*amountTokenMin*/,
        uint256 /*amountETHMin*/,
        address to,
        uint256 /*deadline*/
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        // Pull tokens from caller
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        // KAS (ETH on EVM) arrives via msg.value — kept here to simulate LP

        emit LiquidityAdded(token, amountTokenDesired, msg.value, to);

        // Return non-zero values so callers don't think it failed
        return (amountTokenDesired, msg.value, 1e18);
    }

    // ── IUniswapV2Factory surface ───────────────────────────

    function getPair(address /*tokenA*/, address /*tokenB*/) external view returns (address) {
        // Return self as the "pair" — non-zero address so frontend can detect graduation
        return address(this);
    }

    // Allow receiving ETH
    receive() external payable {}
}
