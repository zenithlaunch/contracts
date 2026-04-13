// SPDX-License-Identifier: MIT
import { expect }           from "chai";
import { ethers }           from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  KasLaunch,
  KasTokenFactory,
  KasToken,
} from "../typechain-types";

const INITIAL_SUPPLY = ethers.parseEther("1000000000"); // 1B tokens
const CREATE_FEE     = ethers.parseEther("150");

async function deployStack(owner: SignerWithAddress, feeRecipient: SignerWithAddress) {
  const KasLaunchCF = await ethers.getContractFactory("KasLaunch");
  const kasLaunch   = (await KasLaunchCF.deploy(
    feeRecipient.address,
    ethers.ZeroAddress // DEX disabled — not needed for these tests
  )) as KasLaunch;

  const FactoryCF = await ethers.getContractFactory("KasTokenFactory");
  const factory   = (await FactoryCF.deploy(
    await kasLaunch.getAddress()
  )) as KasTokenFactory;

  await kasLaunch.setFactory(await factory.getAddress());
  return { kasLaunch, factory };
}

async function deployTokenViaFactory(
  factory: KasTokenFactory,
  caller:  SignerWithAddress
): Promise<string> {
  const tx      = await factory.connect(caller).deployToken("Test", "TST", "ipfs://test", { value: CREATE_FEE });
  const receipt = await tx.wait();
  const iface   = factory.interface;
  const log     = receipt!.logs
    .map(l => { try { return iface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === "TokenDeployed");
  return log!.args[0] as string;
}

describe("KasLaunch", () => {
  let owner:        SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let alice:        SignerWithAddress;
  let bob:          SignerWithAddress;

  let kasLaunch: KasLaunch;
  let factory:   KasTokenFactory;

  beforeEach(async () => {
    [owner, feeRecipient, alice, bob] = await ethers.getSigners();
    ({ kasLaunch, factory } = await deployStack(owner, feeRecipient));
  });

  // ── Test 1: only the registered factory may call createPool ───────────────
  describe("createPool access control", () => {
    it("reverts when called directly (not via factory)", async () => {
      const KasTokenCF = await ethers.getContractFactory("KasToken");
      const token      = (await KasTokenCF.deploy("Rogue", "RGE", INITIAL_SUPPLY)) as KasToken;
      await token.approve(await kasLaunch.getAddress(), INITIAL_SUPPLY);

      await expect(
        kasLaunch.connect(alice).createPool(
          await token.getAddress(),
          INITIAL_SUPPLY,
          alice.address,
          "ipfs://rogue",
          { value: CREATE_FEE }
        )
      ).to.be.revertedWith("KasLaunch: caller is not factory");
    });

    it("succeeds when called through the registered factory", async () => {
      const tokenAddr = await deployTokenViaFactory(factory, alice);
      const curve     = await kasLaunch.getBondingCurve(tokenAddr);
      expect(curve.tokenMint.toLowerCase()).to.equal(tokenAddr.toLowerCase());
      expect(curve.creator.toLowerCase()).to.equal(alice.address.toLowerCase());
    });
  });

  // ── Test 2: ERC-20 transfer failures revert cleanly (SafeERC20) ───────────
  describe("SafeERC20 — failed token transfer reverts cleanly", () => {
    it("reverts on buy when requesting more tokens than real reserves", async () => {
      const tokenAddr = await deployTokenViaFactory(factory, alice);
      const curve     = await kasLaunch.getBondingCurve(tokenAddr);

      // Ask for more than realTokenReserves — reverts before any transfer or ETH deduction
      const tooMany = curve.realTokenReserves + 1n;
      await expect(
        kasLaunch.connect(bob).buy(tokenAddr, tooMany, ethers.parseEther("1000"), {
          value: ethers.parseEther("1000"),
        })
      ).to.be.revertedWith("KasLaunch: insufficient reserves");
    });

    it("reverts on sell when caller has no token allowance (SafeERC20 safeTransferFrom)", async () => {
      const tokenAddr = await deployTokenViaFactory(factory, alice);
      // bob has no tokens and has granted no allowance → safeTransferFrom must revert
      await expect(
        kasLaunch.connect(bob).sell(tokenAddr, ethers.parseEther("1"), 0n)
      ).to.be.reverted;
    });
  });
});
