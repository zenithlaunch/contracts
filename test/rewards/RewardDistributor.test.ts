import { expect }              from "chai";
import { ethers, network }      from "hardhat";
import { StandardMerkleTree }   from "@openzeppelin/merkle-tree";
import { SignerWithAddress }     from "@nomicfoundation/hardhat-ethers/signers";
import { RewardDistributor }     from "../../typechain-types";

const DAYS_180 = 180 * 24 * 60 * 60;

async function increaseTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("RewardDistributor", () => {
  let contract: RewardDistributor;
  let owner:    SignerWithAddress;
  let alice:    SignerWithAddress;
  let bob:      SignerWithAddress;
  let treasury: SignerWithAddress;

  let tree:        StandardMerkleTree<[string, bigint]>;
  let aliceProof:  string[];
  let bobProof:    string[];
  let aliceAmount: bigint;
  let bobAmount:   bigint;

  beforeEach(async () => {
    [owner, alice, bob, treasury] = await ethers.getSigners();

    aliceAmount = ethers.parseEther("60");
    bobAmount   = ethers.parseEther("40");

    tree = StandardMerkleTree.of(
      [
        [alice.address, aliceAmount],
        [bob.address,   bobAmount],
      ],
      ["address", "uint256"],
    );

    aliceProof = tree.getProof([alice.address, aliceAmount]);
    bobProof   = tree.getProof([bob.address,   bobAmount]);

    const Factory = await ethers.getContractFactory("RewardDistributor");
    contract      = (await Factory.connect(owner).deploy()) as RewardDistributor;
    await contract.waitForDeployment();
  });

  // ── setMerkleRoot ──────────────────────────────────────────

  it("owner can set merkle root", async () => {
    await expect(contract.connect(owner).setMerkleRoot(tree.root))
      .to.emit(contract, "MerkleRootSet");

    expect(await contract.rootSet()).to.be.true;
    expect(await contract.merkleRoot()).to.equal(tree.root);
  });

  it("non-owner cannot set merkle root", async () => {
    await expect(contract.connect(alice).setMerkleRoot(tree.root))
      .to.be.revertedWithCustomError(contract, "NotOwner");
  });

  it("root can only be set once", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await expect(contract.connect(owner).setMerkleRoot(tree.root))
      .to.be.revertedWithCustomError(contract, "RootAlreadySet");
  });

  // ── claim ──────────────────────────────────────────────────

  it("valid claim transfers KAS", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") });

    const before = await ethers.provider.getBalance(alice.address);

    const tx      = await contract.connect(alice).claim(aliceAmount, aliceProof);
    const receipt = await tx.wait();
    const gas     = receipt!.gasUsed * receipt!.gasPrice;

    const after = await ethers.provider.getBalance(alice.address);
    expect(after).to.equal(before + aliceAmount - gas);
    expect(await contract.claimed(alice.address)).to.be.true;
  });

  it("cannot claim twice", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") });

    await contract.connect(alice).claim(aliceAmount, aliceProof);
    await expect(contract.connect(alice).claim(aliceAmount, aliceProof))
      .to.be.revertedWithCustomError(contract, "AlreadyClaimed");
  });

  it("invalid proof is rejected", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") });

    await expect(contract.connect(alice).claim(aliceAmount, bobProof))
      .to.be.revertedWithCustomError(contract, "InvalidProof");
  });

  it("wrong amount is rejected", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") });

    await expect(contract.connect(alice).claim(aliceAmount + 1n, aliceProof))
      .to.be.revertedWithCustomError(contract, "InvalidProof");
  });

  it("cannot claim before root is set", async () => {
    await owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") });
    await expect(contract.connect(alice).claim(aliceAmount, aliceProof))
      .to.be.revertedWithCustomError(contract, "RootNotSet");
  });

  // ── rescueUnclaimed ────────────────────────────────────────

  it("rescue reverts before deadline", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await expect(contract.connect(owner).rescueUnclaimed(treasury.address))
      .to.be.revertedWithCustomError(contract, "DeadlineNotReached");
  });

  it("rescue works after deadline", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") });

    // alice claims her share, bob does not
    await contract.connect(alice).claim(aliceAmount, aliceProof);

    await increaseTime(DAYS_180 + 1);

    const before = await ethers.provider.getBalance(treasury.address);
    const tx      = await contract.connect(owner).rescueUnclaimed(treasury.address);
    const receipt = await tx.wait();

    const after    = await ethers.provider.getBalance(treasury.address);
    const rescued  = after - before;

    // only bob's unclaimed share remains
    expect(rescued).to.equal(bobAmount);
    await expect(tx).to.emit(contract, "UnclaimedRescued").withArgs(treasury.address, bobAmount);
  });

  it("cannot claim after deadline", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") });

    await increaseTime(DAYS_180 + 1);

    await expect(contract.connect(alice).claim(aliceAmount, aliceProof))
      .to.be.revertedWithCustomError(contract, "ClaimExpired");
  });

  it("rescue reverts when balance is zero", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") });

    await contract.connect(alice).claim(aliceAmount, aliceProof);
    await contract.connect(bob).claim(bobAmount, bobProof);

    await increaseTime(DAYS_180 + 1);

    await expect(contract.connect(owner).rescueUnclaimed(treasury.address))
      .to.be.revertedWithCustomError(contract, "NothingToRescue");
  });

  it("non-owner cannot rescue", async () => {
    await contract.connect(owner).setMerkleRoot(tree.root);
    await expect(contract.connect(alice).rescueUnclaimed(treasury.address))
      .to.be.revertedWithCustomError(contract, "NotOwner");
  });

  // ── funding ────────────────────────────────────────────────

  it("contract accepts KAS deposits", async () => {
    await expect(owner.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("100") }))
      .to.emit(contract, "FundsReceived");

    expect(await contract.balance()).to.equal(ethers.parseEther("100"));
  });
});
