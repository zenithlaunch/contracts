// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IZealousRouter {
    // ZealousSwap uses addLiquidityKAS (not addLiquidityETH — same params, renamed)
    function addLiquidityKAS(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountKASMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountKAS, uint256 liquidity);
}

/**
 * ZealousSwapAdapter — bridges KasLaunch's IUniswapV2Router02 expectations
 * to ZealousSwap's actual interface on Igra Mainnet.
 *
 * ZealousSwap exposes WKAS() instead of WETH(). KasLaunch calls WETH() during
 * graduation. This adapter satisfies that call and forwards addLiquidityETH
 * to the real router unchanged.
 *
 * Immutable — no owner, no upgradability.
 * Constructor args keep environment-specific addresses out of source code.
 */
contract ZealousSwapAdapter {
    using SafeERC20 for IERC20;
    address public immutable zealousRouter;
    address public immutable zealousFactory;
    address public immutable wkas;

    constructor(address zealousRouter_, address zealousFactory_, address wkas_) {
        require(zealousRouter_  != address(0), "adapter: zero router");
        require(zealousFactory_ != address(0), "adapter: zero factory");
        require(wkas_           != address(0), "adapter: zero wkas");
        zealousRouter  = zealousRouter_;
        zealousFactory = zealousFactory_;
        wkas           = wkas_;
    }

    // IUniswapV2Router02 surface used by KasLaunch._graduate()

    function WETH() external view returns (address) {
        return wkas;
    }

    function factory() external view returns (address) {
        return zealousFactory;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountTokenDesired);
        IERC20(token).forceApprove(zealousRouter, amountTokenDesired);
        (amountToken, amountETH, liquidity) = IZealousRouter(zealousRouter).addLiquidityKAS{value: msg.value}(
            token,
            amountTokenDesired,
            amountTokenMin,
            amountETHMin,
            to,
            deadline
        );

        // Return any ETH the router did not consume
        uint256 ethDust = address(this).balance;
        if (ethDust > 0) {
            (bool ok,) = msg.sender.call{value: ethDust}("");
            require(ok, "adapter: eth refund failed");
        }

        // Return any tokens the router did not consume and reset approval
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) IERC20(token).safeTransfer(msg.sender, tokenDust);
        IERC20(token).forceApprove(zealousRouter, 0);
    }

    receive() external payable {}
}
