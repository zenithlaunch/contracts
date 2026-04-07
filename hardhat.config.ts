import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "0".repeat(64);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },

  networks: {
    // ── Igra Galleon Testnet (Primary testnet) ─────────────
    igra_galleon: {
      url: process.env.IGRA_GALLEON_RPC_URL || "https://galleon-testnet.igralabs.com:8545",
      chainId: 38836,
      accounts: [DEPLOYER_PRIVATE_KEY],
      gasPrice: 2000000000000, // 2000 gwei minimum required by Igra Galleon
    },

    // ── Kasplex zkEVM Testnet (Backup) ─────────────────────
    kasplex_testnet: {
      url: process.env.KASPLEX_RPC_URL || "https://rpc.kasplextest.xyz",
      chainId: 167012,
      accounts: [DEPLOYER_PRIVATE_KEY],
      gasPrice: "auto",
    },

    // ── Igra Network Mainnet ──────────────────────────────
    igra_mainnet: {
      url: process.env.IGRA_RPC_URL || "https://rpc.igralabs.com:8545",
      chainId: Number(process.env.IGRA_CHAIN_ID || "38833"),
      accounts: [DEPLOYER_PRIVATE_KEY],
      gasPrice: 2000000000000, // 2000 gwei minimum required by Igra Mainnet
    },

    // ── Local hardhat node ────────────────────────────────
    hardhat: {
      chainId: 31337,
    },
  },

  etherscan: {
    // Kasplex explorer verification (if supported)
    apiKey: {
      kasplex_testnet: process.env.KASPLEX_EXPLORER_API_KEY || "no-key",
      igra_mainnet:    process.env.IGRA_EXPLORER_API_KEY    || "no-key",
    },
    customChains: [
      {
        network: "kasplex_testnet",
        chainId: 167012,
        urls: {
          apiURL:      "https://explorer.testnet.kasplextest.xyz/api",
          browserURL:  "https://explorer.testnet.kasplextest.xyz",
        },
      },
      {
        network: "igra_mainnet",
        chainId: 38833,
        urls: {
          apiURL:     "https://explorer.igralabs.com/api",
          browserURL: "https://explorer.igralabs.com",
        },
      },
    ],
  },

  paths: {
    sources:   "./contracts",
    tests:     "./test",
    cache:     "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
