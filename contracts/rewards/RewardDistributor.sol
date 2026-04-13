// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RewardDistributor
 * @notice Distributes the 100k KAS testnet reward pool via Merkle proof claims.
 *
 * Flow:
 *   1. Owner deploys and funds the contract (sends KAS via receive()).
 *   2. Owner calls setMerkleRoot() once — starts the 180-day claim window.
 *   3. Eligible wallets call claim() with their amount and Merkle proof.
 *   4. After claimDeadline, owner calls rescueUnclaimed() to recover dust.
 */
contract RewardDistributor is ReentrancyGuard {

    address public immutable owner;
    bytes32 public merkleRoot;
    bool    public rootSet;
    uint256 public claimDeadline;

    mapping(address => bool) public claimed;

    event MerkleRootSet(bytes32 indexed root, uint256 claimDeadline);
    event Claimed(address indexed wallet, uint256 amount);
    event UnclaimedRescued(address indexed to, uint256 amount);
    event FundsReceived(address indexed sender, uint256 amount);

    error NotOwner();
    error RootAlreadySet();
    error RootNotSet();
    error ClaimExpired();
    error AlreadyClaimed();
    error InvalidProof();
    error TransferFailed();
    error DeadlineNotReached();
    error NothingToRescue();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {
        emit FundsReceived(msg.sender, msg.value);
    }

    /**
     * @notice Sets the Merkle root and opens the claim window. Can only be called once.
     * @param root  Merkle root computed from snapshot.json.
     */
    function setMerkleRoot(bytes32 root) external onlyOwner {
        if (rootSet) revert RootAlreadySet();
        merkleRoot    = root;
        rootSet       = true;
        claimDeadline = block.timestamp + 180 days;
        emit MerkleRootSet(root, claimDeadline);
    }

    /**
     * @notice Claims KAS for the caller.
     * @param amount  KAS amount in wei (must match snapshot leaf).
     * @param proof   Merkle proof from snapshot_v1/{wallet}.proof in Firebase.
     */
    function claim(uint256 amount, bytes32[] calldata proof) external nonReentrant {
        if (!rootSet)                        revert RootNotSet();
        if (block.timestamp > claimDeadline) revert ClaimExpired();
        if (claimed[msg.sender])             revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();

        claimed[msg.sender] = true;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Claimed(msg.sender, amount);
    }

    /**
     * @notice Recovers unclaimed KAS to treasury after the claim window closes.
     * @param to  Recipient address (Treasury).
     */
    function rescueUnclaimed(address to) external onlyOwner nonReentrant {
        if (block.timestamp <= claimDeadline) revert DeadlineNotReached();
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToRescue();

        (bool ok,) = to.call{value: bal}("");
        if (!ok) revert TransferFailed();

        emit UnclaimedRescued(to, bal);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
