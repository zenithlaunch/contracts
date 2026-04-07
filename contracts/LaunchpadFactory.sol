// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
//  LaunchpadFactory — Application gate + deploy factory
//  for the Classic Launchpad (serious projects).
//  Flow:
//   1. Project calls applyForRaise(ipfsHash) — stores application on-chain
//   2. Owner reviews off-chain, calls approveRaise() with full params
//   3. Factory deploys a LaunchpadRaise contract
//   4. Frontend reads events to display all raises

import "@openzeppelin/contracts/access/Ownable.sol";
import "./LaunchpadRaise.sol";

contract LaunchpadFactory is Ownable {
    enum ApplicationStatus { Pending, Approved, Rejected }

    struct Application {
        address applicant;
        string  ipfsHash;       // IPFS hash of the application JSON
        ApplicationStatus status;
        uint256 submittedAt;
        address raiseContract;  // set after approval
    }

    uint256 public applicationCount;
    mapping(uint256 => Application) public applications;
    mapping(address => uint256[]) public applicantApplications;
    address[] public allRaises;
    mapping(address => bool) public isValidRaise;
    event ApplicationSubmitted(
        uint256 indexed applicationId,
        address indexed applicant,
        string  ipfsHash,
        uint256 timestamp
    );
    event ApplicationApproved(
        uint256 indexed applicationId,
        address indexed raiseContract
    );
    event ApplicationRejected(uint256 indexed applicationId, string reason);
    event RaiseDeployed(
        address indexed raiseContract,
        address indexed projectWallet,
        string  tokenName,
        string  tokenSymbol,
        uint256 hardcap,
        uint256 softcap,
        uint256 startTime,
        uint256 endTime
    );

    constructor() Ownable(msg.sender) {}

    // Submit a raise application. Store the IPFS hash on-chain.
    function applyForRaise(string calldata ipfsHash) external returns (uint256 applicationId) {
        require(bytes(ipfsHash).length > 0, "LaunchpadFactory: empty ipfs hash");

        applicationId = applicationCount++;
        applications[applicationId] = Application({
            applicant:     msg.sender,
            ipfsHash:      ipfsHash,
            status:        ApplicationStatus.Pending,
            submittedAt:   block.timestamp,
            raiseContract: address(0)
        });
        applicantApplications[msg.sender].push(applicationId);

        emit ApplicationSubmitted(applicationId, msg.sender, ipfsHash, block.timestamp);
    }

    // Approve an application and deploy the LaunchpadRaise contract.
    function approveAndDeployRaise(
        uint256 applicationId,
        // Token params
        string  calldata tokenName,
        string  calldata tokenSymbol,
        uint256 tokenSupply,
        // Raise params
        uint256 hardcap_,
        uint256 softcap_,
        uint256 tokenPrice_,
        uint256 startTime_,
        uint256 endTime_,
        // Whitelist
        bool    whitelistEnabled_,
        bytes32 merkleRoot_,
        // Vesting
        uint256 tgePercent_,
        uint256 cliffDuration_,
        uint256 vestingDuration_,
        // Metadata
        string  calldata metadataUri_,
        // Optional cap per wallet (0 = no limit)
        uint256 maxInvestment_
    ) external onlyOwner returns (address raiseContract) {
        Application storage app = applications[applicationId];
        require(app.applicant != address(0),             "LaunchpadFactory: invalid app id");
        require(app.status == ApplicationStatus.Pending, "LaunchpadFactory: app not pending");

        app.status = ApplicationStatus.Approved;

        LaunchpadRaise raise = new LaunchpadRaise(
            app.applicant,    // projectWallet = applicant
            tokenName,
            tokenSymbol,
            tokenSupply,
            hardcap_,
            softcap_,
            tokenPrice_,
            startTime_,
            endTime_,
            whitelistEnabled_,
            merkleRoot_,
            tgePercent_,
            cliffDuration_,
            vestingDuration_,
            metadataUri_,
            owner(),          // factoryOwner = this contract's owner
            maxInvestment_
        );

        raiseContract = address(raise);
        app.raiseContract = raiseContract;

        allRaises.push(raiseContract);
        isValidRaise[raiseContract] = true;

        emit ApplicationApproved(applicationId, raiseContract);
        emit RaiseDeployed(
            raiseContract,
            app.applicant,
            tokenName,
            tokenSymbol,
            hardcap_,
            softcap_,
            startTime_,
            endTime_
        );
    }

    // Reject an application with a reason (stored off-chain via event).
    function rejectApplication(uint256 applicationId, string calldata reason)
        external
        onlyOwner
    {
        Application storage app = applications[applicationId];
        require(app.applicant != address(0),             "LaunchpadFactory: invalid app id");
        require(app.status == ApplicationStatus.Pending, "LaunchpadFactory: app not pending");

        app.status = ApplicationStatus.Rejected;
        emit ApplicationRejected(applicationId, reason);
    }

    function getRaiseCount() external view returns (uint256) {
        return allRaises.length;
    }

    function getRaises(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory)
    {
        uint256 total = allRaises.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = allRaises[i];
        }
        return result;
    }

    function getApplicantApplications(address applicant)
        external
        view
        returns (uint256[] memory)
    {
        return applicantApplications[applicant];
    }
}
