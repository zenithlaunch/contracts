<div align="center">
  <h1>Zenith</h1>
  <p><strong>Fair-launch bonding curve launchpad on Kaspa L2 (Igra Network)</strong></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)
  [![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636?style=flat-square&logo=solidity)](https://docs.soliditylang.org/)
  [![Network](https://img.shields.io/badge/Network-Igra%20L2-49eacb?style=flat-square)](https://igralabs.com)
  [![Hardhat](https://img.shields.io/badge/Built%20with-Hardhat-f7c948?style=flat-square)](https://hardhat.org)
  [![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-5.x-4e5ee4?style=flat-square)](https://openzeppelin.com)
</div>

---

> **Zenith is a pump.fun-style token launchpad** on [Igra Network](https://igralabs.com) (Kaspa L2). Anyone can launch a token in seconds — no presales, no creator allocation, no admin keys. Tokens trade on an xy=k bonding curve and graduate to [ZealousSwap](https://zealousswap.com) DEX automatically.

---

## Architecture

```
User
 │
 ▼
KasTokenFactory.sol ──▶ KasToken.sol (ERC20) + registers in KasLaunch
 │
 ▼
KasLaunch.sol
 ├── buy()  ──▶ xy=k bonding curve ──▶ tokens to buyer
 ├── sell() ──▶ xy=k bonding curve ──▶ iKAS to seller
 │
 └── _graduate() ──▶ ZealousSwapAdapter ──▶ ZealousSwap Router
                      ├── addLiquidityKAS()
                      └── LP tokens → 0x000...dEaD (burned)
```

### Contracts

| Contract | Purpose |
|---|---|
| **KasLaunch** | Bonding curve engine — holds all token reserves and iKAS |
| **KasTokenFactory** | One-click token + curve deployment (registered in KasLaunch via one-shot `setFactory`) |
| **KasToken** | Standard ERC20, minted by factory, 1B supply |
| **ZealousSwapAdapter** | Bridges `WETH()`/`addLiquidityETH()` to ZealousSwap's `WKAS()`/`addLiquidityKAS()` |
| **LaunchpadFactory** | Classic raise application gate (separate from bonding curve) |

---

## Bonding Curve

Constant product AMM: `k = virtualKasReserves × virtualTokenReserves`

| Parameter | Value |
|---|---|
| Total supply | 1,000,000,000 tokens |
| Virtual KAS reserves | 105,000 iKAS |
| Virtual token reserves | 800,000,000 tokens |
| LP reserve (held back) | 200,000,000 tokens (20%) |
| Graduation threshold | 300,000 iKAS real reserves |
| Start price | ~0.000131 iKAS/token |
| Start market cap | ~131,250 iKAS |
| Graduation market cap | ~1,924,000 iKAS |
| Curve multiplier | ~14.7x (pump.fun equivalent) |

**Formulas:**

| | Formula |
|---|---|
| Buy cost | `kasIn = (k / (tokenReserves - tokenOut)) - kasReserves` |
| Sell return | `kasOut = kasReserves - (k / (tokenReserves + tokenIn))` |
| Spot price | `kasReserves / tokenReserves` |

At graduation, remaining curve tokens are burned to `0xdead` and LP is permanently locked.

---

## Deployed Contracts

### Mainnet — Igra Network (Chain ID `38833`)

| Contract | Address |
|---|---|
| KasLaunch | [`0xd0b4ABE4Eaa07A7Dd776A821639c43B97493f981`](https://explorer.igralabs.com/address/0xd0b4ABE4Eaa07A7Dd776A821639c43B97493f981) |
| KasTokenFactory | [`0x53FEaD89F09F1bB83636fc3CaAE6446AA56E8058`](https://explorer.igralabs.com/address/0x53FEaD89F09F1bB83636fc3CaAE6446AA56E8058) |
| LaunchpadFactory | [`0xd4165DA84DbedaC1957313f939EfE31cD916dE53`](https://explorer.igralabs.com/address/0xd4165DA84DbedaC1957313f939EfE31cD916dE53) |
| ZealousSwapAdapter | [`0x60c26e5f542cdD55D44Fe233e9003B59E89C4Cd6`](https://explorer.igralabs.com/address/0x60c26e5f542cdD55D44Fe233e9003B59E89C4Cd6) |

### Testnet — Igra Galleon (Chain ID `38836`)

| Contract | Address |
|---|---|
| KasLaunch | [`0x97391448551Bf91223337bAe08c8d6Dd1AeF738b`](https://explorer.galleon-testnet.igralabs.com/address/0x97391448551Bf91223337bAe08c8d6Dd1AeF738b) |
| KasTokenFactory | [`0xeAd1Af018a49ee2857c9db2A448260f9a49d3508`](https://explorer.galleon-testnet.igralabs.com/address/0xeAd1Af018a49ee2857c9db2A448260f9a49d3508) |
| LaunchpadFactory | [`0x55aCd5672Dca15E7C74810701F37B9c8Cf5a1546`](https://explorer.galleon-testnet.igralabs.com/address/0x55aCd5672Dca15E7C74810701F37B9c8Cf5a1546) |

---

## Parameters

| Parameter | Value | Setter | Hard Cap |
|---|---|---|---|
| Creation fee | 150 iKAS | `setCreateFee()` | — |
| Trading fee | 1% (both sides) | `setFeeBasisPoints()` | 5% max |
| Graduation fee | 2% of LP value | `setGraduationFeeBps()` | 10% max |
| Graduation threshold | 300,000 iKAS | Immutable | — |
| LP slippage tolerance | 3% | Immutable | — |

All setter functions are `onlyOwner`.

---

## Security

- **Reentrancy guard** on all state-changing functions (OpenZeppelin `ReentrancyGuard`)
- **SafeERC20** for all token transfers (OpenZeppelin `SafeERC20`)
- **DEX Router timelock** — router changes require 48-hour delay (`proposeDexRouter` → `acceptDexRouter`)
- **Emergency rescue timelock** — `rescueGraduatedFunds()` only after 7-day delay post-graduation
- **LP permanently burned** — sent to `0x000...dEaD` on graduation, liquidity is irrevocable
- **Graduation rollback** — if DEX call fails, all state changes revert (CEI pattern)
- **No admin keys on curve** — bonding curve constants are immutable, owner cannot manipulate price
- **Fee caps** — trading fee hard-capped at 5%, graduation fee at 10% in contract code

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart Contracts | Solidity ^0.8.24, Hardhat, OpenZeppelin 5.x |
| Frontend | React + Vite + TypeScript, Tailwind CSS |
| Web3 | wagmi v2, ethers v6 |
| Metadata | Pinata (IPFS) |
| Database | Firebase Firestore |
| Hosting | Vercel |
| DEX | ZealousSwap (Uniswap V2-compatible) |
| Network | Igra Network (Kaspa L2, EVM-compatible) |

---

## Development

```bash
npm install
npx hardhat compile
npx hardhat test

# Deploy to testnet
npx hardhat run scripts/testnet/deploy.ts --network igra_galleon

# Deploy to mainnet
npx hardhat run scripts/mainnet/redeployV2.ts --network igra_mainnet

# Pre-deploy check
node scripts/predeploy-check.mjs frontend/.env.vercel.mainnet
```

Create a `.env` file (never commit):

```
DEPLOYER_PRIVATE_KEY=0x...
```

---

## Events

```solidity
event TokenCreated(
    address indexed token, address indexed creator,
    string name, string symbol, string metadataUri, uint256 timestamp
);

event Trade(
    address indexed token, uint256 kasAmount, uint256 tokenAmount,
    bool isBuy, address indexed trader, uint256 timestamp,
    uint256 virtualKasReserves, uint256 virtualTokenReserves, uint256 price
);

event Graduated(
    address indexed token, address indexed dexPair,
    uint256 kasLiquidity, uint256 tokenLiquidity, uint256 timestamp
);
```

---

<div align="center">
  <a href="https://zenithlaunch.xyz">zenithlaunch.xyz</a> &nbsp;·&nbsp;
  <a href="https://twitter.com/zenith_launch">Twitter</a> &nbsp;·&nbsp;
  <a href="https://t.me/zenithlaunch">Telegram</a>
</div>
