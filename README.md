<div align="center">
  <h1>Zenith Contracts</h1>
  <p><strong>Fair-launch bonding curve launchpad on Kaspa L2 (Igra Network)</strong></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)
  [![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636?style=flat-square&logo=solidity)](https://docs.soliditylang.org/)
  [![Network](https://img.shields.io/badge/Network-Igra%20L2-49eacb?style=flat-square)](https://igralabs.com)
  [![Hardhat](https://img.shields.io/badge/Built%20with-Hardhat-f7c948?style=flat-square)](https://hardhat.org)
  [![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-5.x-4e5ee4?style=flat-square)](https://openzeppelin.com)
</div>

---

> **This repository contains the smart contracts only.** The frontend application is maintained separately. These contracts are currently deployed on Igra Galleon Testnet (see addresses below). Mainnet deployment is pending audit completion.

---

## Overview

Zenith is a pump.fun-style token launchpad built on [Igra Network](https://igralabs.com), the Kaspa EVM Layer 2. Anyone can launch a token in seconds — no presales, no creator allocation. Protocol fees are adjustable by the owner within fixed limits (trading fee capped at 5%, graduation fee capped at 10%). All bonding curve mechanics are implemented in immutable contract logic. Tokens graduate to ZealousSwap DEX automatically when they hit the configured market cap threshold.

- **xy=k bonding curve** — transparent, manipulation-resistant pricing
- **No presales or creator allocations** — every token starts at the same price for everyone
- **Automatic DEX graduation** — liquidity is seeded and LP tokens are sent to `0x000...dEaD` on-chain
- **Protocol fees** — 1% trading fee (both sides), 2% graduation fee; both adjustable by owner within hard caps

---

## Architecture

```
User
 │
 ▼
KasLaunch.sol ── createToken() ──▶ KasTokenFactory.sol ──▶ KasToken.sol (ERC20)
 │
 ├── buy()  ──▶ xy=k curve ──▶ transfer tokens to buyer
 ├── sell() ──▶ xy=k curve ──▶ return iKAS to seller
 │
 └── _graduate() ──▶ ZealousSwap Router (Uni V2)
                      ├── addLiquidityETH()
                      └── LP tokens → 0x000...dEaD
```

### Bonding Curve

Starting virtual reserves: **3,000 iKAS / 1,000,000,000 tokens**

| | Formula |
|---|---|
| Buy cost | `kasIn = (k / (tokenReserves - tokenOut)) - kasReserves` |
| Sell return | `kasOut = kasReserves - (k / (tokenReserves + tokenIn))` |
| Price | `price = kasReserves / tokenReserves` |
| Market cap | `price × totalSupply` |

Max buy per tx: **80% of remaining token reserves** (20% reserved as graduation liquidity buffer).

---

## Contracts

### Testnet — Igra Galleon (Chain ID `38836`)

| Contract | Address |
|---|---|
| `KasLaunch` | [`0x7c4A6Eb9a3FA49d334657cC33801eF3F3058FDF4`](https://explorer.galleon-testnet.igralabs.com/address/0x7c4A6Eb9a3FA49d334657cC33801eF3F3058FDF4) |
| `KasTokenFactory` | [`0x48b9CE95257349b849af8b5f40874Ead8F4CAA69`](https://explorer.galleon-testnet.igralabs.com/address/0x48b9CE95257349b849af8b5f40874Ead8F4CAA69) |
| `LaunchpadFactory` | [`0xDc8D25ce89733b8166949C01C571D07EeB17882e`](https://explorer.galleon-testnet.igralabs.com/address/0xDc8D25ce89733b8166949C01C571D07EeB17882e) |

> Deployed April 2026. No mainnet deployment yet — pending third-party security audit.

### Mainnet — Igra Network (Chain ID `38833`)

*Not yet deployed.*

---

## Parameters (Testnet)

| Parameter | Current Value | Setter | Cap |
|---|---|---|---|
| Creation fee | 150 iKAS | `setCreateFee()` | None |
| Trading fee | 1% (both sides) | `setFeeBasisPoints()` | 5% max |
| Graduation fee | 2% of LP | `setGraduationFeeBps()` | 10% max |
| Graduation market cap | 200,000 iKAS | `setMcapLimit()` | None |

All setter functions are `onlyOwner`.

---

## Events

```solidity
event TokenCreated(
    address indexed token,
    address indexed creator,
    string name,
    string symbol,
    string metadataUri,
    uint256 timestamp
);

event Trade(
    address indexed token,
    uint256 kasAmount,
    uint256 tokenAmount,
    bool isBuy,
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
```

---

## Security

- **Reentrancy guard** on all state-changing functions (`ReentrancyGuard` from OpenZeppelin)
- **Ownable** — standard single-step ownership transfer; `Ownable2Step` planned for mainnet
- **DEX Router Timelock** — router address changes require a 48-hour delay (`proposeDexRouter` → `acceptDexRouter`), preventing silent redirection of graduation liquidity
- **LP tokens burned** — sent to `0x000000000000000000000000000000000000dEaD` on graduation; liquidity is permanent
- **Graduation state rollback** — if the DEX call fails, all state changes are reverted via try/catch (CEI pattern); no funds can be lost in a failed graduation
- **Emergency rescue** — `rescueGraduatedFunds()` callable by owner only **after** a 7-day timelock post-graduation, giving users time to react before any owner access to residual funds

> This contract has not yet undergone a third-party security audit. A mainnet audit is planned before production deployment.

---

## Development

```bash
# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Deploy to testnet
npx hardhat run scripts/deployTestnet.ts --network igra_galleon
```

### Environment Variables

Create a `.env` file (never commit this):

```
DEPLOYER_PRIVATE_KEY=0x...
IGRA_GALLEON_RPC_URL=https://galleon-testnet.igralabs.com:8545
```

---

## Stack

- Solidity `^0.8.24` + Hardhat + OpenZeppelin 5.x
- TypeChain for typed contract bindings
- Igra Network (Kaspa L2, EVM-compatible)
- ZealousSwap (Uniswap V2-compatible) for graduation liquidity

---

<div align="center">
  <a href="https://zenithlaunch.xyz">zenithlaunch.xyz</a> &nbsp;·&nbsp;
  <a href="https://twitter.com/zenith_launch">Twitter</a> &nbsp;·&nbsp;
  <a href="https://t.me/zenithlaunch">Telegram</a>
</div>
