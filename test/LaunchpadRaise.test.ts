// SPDX-License-Identifier: MIT
import { expect }           from "chai";
import { ethers, network }  from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { LaunchpadRaise }   from "../typechain-types";

async function currentBlockTime(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return block!.timestamp;
}

async function increaseTimeTo(target: number) {
  await network.provider.send("evm_setNextBlockTimestamp", [target]);
  await network.provider.send("evm_mine");
}

// KasToken has no receive() or fallback() — any native transfer to it reverts.
// We use it as a stand-in for a non-payable "projectWallet" or "owner".
async function deployNonPayable(): Promise<string> {
  const CF  = await ethers.getContractFactory("KasToken");
  const tok = await CF.deploy("NP", "NP", 1n);
  return await tok.getAddress();
}

// ─── factory helper ──────────────────────────────────────────────────────────

async function deployRaise(
  factoryOwner:  string,
  projectWallet: string,
  overrides: Partial<{
    hardcap:     bigint;
    softcap:     bigint;
    tokenPrice:  bigint;
    tokenSupply: bigint;
  }> = {}
): Promise<LaunchpadRaise> {
  const now       = await currentBlockTime();
  const startTime = now + 30;
  const endTime   = now + 3600;

  const hardcap     = overrides.hardcap    ?? ethers.parseEther("1000");
  const softcap     = overrides.softcap    ?? ethers.parseEther("100");
  const tokenPrice  = overrides.tokenPrice ?? ethers.parseEther("0.001");
  const tokenSupply = overrides.tokenSupply
    ?? (hardcap * ethers.parseEther("1")) / tokenPrice;

  const CF = await ethers.getContractFactory("LaunchpadRaise");
  return (await CF.deploy(
    projectWallet,
    "TestToken", "TST",
    tokenSupply,
    hardcap,
    softcap,
    tokenPrice,
    startTime,
    endTime,
    false,
    ethers.ZeroHash,
    100,  // 100% TGE — no vesting
    0,
    0,
    "ipfs://test",
    factoryOwner,
    0     // no per-wallet cap
  )) as LaunchpadRaise;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("LaunchpadRaise", () => {
  let owner:  SignerWithAddress;
  let alice:  SignerWithAddress;
  let bob:    SignerWithAddress;
  let rescue: SignerWithAddress;

  beforeEach(async () => {
    [owner, alice, bob, rescue] = await ethers.getSigners();
  });

  // ── Test 3: finalize() must never freeze investor funds ───────────────────
  describe("finalize() — pending fallback when direct KAS send fails", () => {
    it("does not revert when projectWallet cannot receive KAS; credits pendingWithdrawals", async () => {
      const badWallet = await deployNonPayable();
      const raise     = await deployRaise(owner.address, badWallet);

      const startTime = Number(await raise.startTime());
      await increaseTimeTo(startTime + 1);

      const softcap = await raise.softcap();
      await raise.connect(alice).invest([], { value: softcap });

      const endTime = Number(await raise.endTime());
      await increaseTimeTo(endTime + 1);

      // Must NOT revert despite projectWallet being non-payable
      await expect(raise.connect(bob).finalize()).to.not.be.reverted;

      const platformFeeBps = await raise.PLATFORM_FEE_BPS();
      const platformFee    = (softcap * platformFeeBps) / 10_000n;
      const kasToProject   = softcap - platformFee;

      expect(await raise.pendingWithdrawals(badWallet)).to.equal(kasToProject);
    });

    it("credits owner in pendingWithdrawals when owner address cannot receive KAS", async () => {
      const badOwner = await deployNonPayable();
      const raise    = await deployRaise(badOwner, alice.address);

      const startTime = Number(await raise.startTime());
      await increaseTimeTo(startTime + 1);

      const softcap = await raise.softcap();
      await raise.connect(bob).invest([], { value: softcap });

      const endTime = Number(await raise.endTime());
      await increaseTimeTo(endTime + 1);

      await expect(raise.connect(bob).finalize()).to.not.be.reverted;

      const platformFeeBps = await raise.PLATFORM_FEE_BPS();
      const platformFee    = (softcap * platformFeeBps) / 10_000n;
      expect(await raise.pendingWithdrawals(badOwner)).to.equal(platformFee);
    });
  });

  // ── Test 4: withdrawPending / redirectPending ──────────────────────────────
  describe("withdrawPending() and redirectPending()", () => {
    it("redirectPending() lets owner route stranded funds to any rescue address", async () => {
      const badWallet = await deployNonPayable();
      const raise     = await deployRaise(owner.address, badWallet);

      const startTime = Number(await raise.startTime());
      await increaseTimeTo(startTime + 1);

      const softcap = await raise.softcap();
      await raise.connect(alice).invest([], { value: softcap });

      const endTime = Number(await raise.endTime());
      await increaseTimeTo(endTime + 1);
      await raise.connect(bob).finalize();

      const pending = await raise.pendingWithdrawals(badWallet);
      expect(pending).to.be.gt(0n);

      // badWallet cannot originate calls — owner uses redirectPending()
      const rescueBefore = await ethers.provider.getBalance(rescue.address);
      await raise.connect(owner).redirectPending(badWallet, rescue.address);
      const rescueAfter  = await ethers.provider.getBalance(rescue.address);

      expect(rescueAfter - rescueBefore).to.equal(pending);
      expect(await raise.pendingWithdrawals(badWallet)).to.equal(0n);
    });

    it("withdrawPending(to) lets a callable credit-holder direct funds to any address", async () => {
      const badWallet = await deployNonPayable();
      const raise     = await deployRaise(owner.address, badWallet);

      const startTime = Number(await raise.startTime());
      await increaseTimeTo(startTime + 1);

      const softcap = await raise.softcap();
      await raise.connect(alice).invest([], { value: softcap });

      const endTime = Number(await raise.endTime());
      await increaseTimeTo(endTime + 1);
      await raise.connect(bob).finalize();

      const pending = await raise.pendingWithdrawals(badWallet);
      expect(pending).to.be.gt(0n);

      // Impersonate badWallet (funded for gas) to simulate an upgradeable proxy
      // that can make calls but cannot receive ETH natively
      await network.provider.send("hardhat_setBalance", [badWallet, "0x56BC75E2D63100000"]);
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [badWallet] });
      const signer = await ethers.getSigner(badWallet);

      const rescueBefore = await ethers.provider.getBalance(rescue.address);
      await raise.connect(signer).withdrawPending(rescue.address);
      const rescueAfter  = await ethers.provider.getBalance(rescue.address);

      await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [badWallet] });

      expect(rescueAfter - rescueBefore).to.equal(pending);
      expect(await raise.pendingWithdrawals(badWallet)).to.equal(0n);
    });

    it("redirectPending() is only callable by owner", async () => {
      const raise = await deployRaise(owner.address, alice.address);
      await expect(
        raise.connect(alice).redirectPending(alice.address, bob.address)
      ).to.be.revertedWithCustomError(raise, "OwnableUnauthorizedAccount");
    });

    it("reverts when there is nothing pending to withdraw", async () => {
      const raise = await deployRaise(owner.address, alice.address);
      await expect(
        raise.connect(alice).withdrawPending(rescue.address)
      ).to.be.revertedWith("LaunchpadRaise: nothing to withdraw");
    });
  });
});
