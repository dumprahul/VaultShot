// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FoggyPotBalanceLedger} from "./FoggyPotBalanceLedger.sol";

/// @title FoggyPotVault
/// @notice ERC-7984-style deposit/withdraw entry point. Pulls in the plaintext test ERC-20,
/// encrypts the amount, credits the depositor's encrypted balance via the Ledger. Also owns the
/// two-step withdraw flow: request (marks the caller's balance publicly decryptable, zeroes it)
/// then finalize (verifies the KMS decryption proof, sends real tokens back).
///
/// totalDeposits is tracked in PLAINTEXT deliberately: the deposited/withdrawn amount is already
/// momentarily public in the ERC20.transferFrom/transfer at each entry/exit boundary (see
/// README "Confidentiality & Leakage"), so an aggregate running total leaks nothing beyond what
/// each transaction already reveals about itself. Only *individual* balances stay encrypted.
/// PrizePool uses totalDeposits to bound FHE.rem(FHE.randEuint64(), totalDeposits).
///
/// Each draw's PrizePool.runDraw() also calls creditPrizeBudget() with that draw's *full* prize
/// budget — not just whatever was actually, obliviously distributed — because how much of it any
/// one pass actually credited is exactly the secret being protected (see FoggyPotPrizePool's
/// NatSpec). Always crediting the full budget keeps totalDeposits an upper bound on the ledger's
/// true aggregate rather than an exact match: it can never fall short of what a legitimate
/// withdrawal later subtracts (which underflowed before this was added), at the cost of a
/// negligible fairness bias in later draws when a Minor-tier pass misses.
contract FoggyPotVault is ZamaEthereumConfig, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    FoggyPotBalanceLedger public immutable ledger;

    uint64 public totalDeposits;
    address public prizePool;

    /// @dev Snapshot of a user's full encrypted balance, taken at requestWithdraw() and consumed
    /// by finalizeWithdraw(). Locks the balance at 0 in the ledger for the duration.
    mapping(address => bytes32) public pendingWithdrawHandle;

    event Deposited(address indexed user, uint64 amount);
    event WithdrawRequested(address indexed user, bytes32 handle);
    event Withdrawn(address indexed user, uint64 amount);
    event PrizePoolSet(address indexed prizePool);

    modifier onlyPrizePool() {
        require(msg.sender == prizePool, "Vault: not prize pool");
        _;
    }

    constructor(address admin, IERC20 token_, FoggyPotBalanceLedger ledger_) Ownable(admin) {
        token = token_;
        ledger = ledger_;
    }

    /// @notice One-time wiring of the PrizePool allowed to credit the prize budget. Admin-only.
    function setPrizePool(address prizePool_) external onlyOwner {
        require(prizePool == address(0), "Vault: already set");
        require(prizePool_ != address(0), "Vault: zero address");
        prizePool = prizePool_;
        emit PrizePoolSet(prizePool_);
    }

    /// @notice Called by PrizePool once per draw with that draw's full prize budget (see NatSpec).
    function creditPrizeBudget(uint64 amount) external onlyPrizePool {
        totalDeposits += amount;
    }

    /// @notice Deposits `amount` of the plaintext test token. The amount is visible on-chain in
    /// this call's calldata and in the transferFrom event, by necessity (see README).
    function deposit(uint64 amount) external {
        require(amount > 0, "Vault: zero amount");
        token.safeTransferFrom(msg.sender, address(this), amount);

        euint64 encryptedAmount = FHE.asEuint64(amount);
        FHE.allowTransient(encryptedAmount, address(ledger));
        ledger.credit(msg.sender, encryptedAmount);

        totalDeposits += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Step 1 of withdrawal: snapshots and locks the caller's full encrypted balance,
    /// marking it publicly decryptable so the relayer/KMS can produce a decryption proof for it.
    function requestWithdraw() external {
        require(pendingWithdrawHandle[msg.sender] == bytes32(0), "Vault: withdraw already pending");

        euint64 balance = ledger.debitAll(msg.sender);
        FHE.makePubliclyDecryptable(balance);

        bytes32 handle = euint64.unwrap(balance);
        pendingWithdrawHandle[msg.sender] = handle;
        emit WithdrawRequested(msg.sender, handle);
    }

    /// @notice Step 2 of withdrawal: verifies the KMS's decryption proof for the pending handle,
    /// then transfers the real, now-plaintext amount back to the caller.
    /// @param abiEncodedCleartexts The exact bytes the relayer SDK's publicDecrypt() returned
    /// alongside the proof (its `abiEncodedClearValues` field) — passed through verbatim, never
    /// reconstructed here, since checkSignatures verifies these bytes were the ones actually
    /// signed by the KMS. The KMS ABI-encodes one `uint256` per handle as a flat tuple (NOT a
    /// dynamic `uint256[]`); for our single-handle request that's exactly `abi.encode(uint256)`.
    function finalizeWithdraw(bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external {
        bytes32 handle = pendingWithdrawHandle[msg.sender];
        require(handle != bytes32(0), "Vault: no pending withdraw");

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);

        uint64 cleartextAmount = uint64(abi.decode(abiEncodedCleartexts, (uint256)));

        delete pendingWithdrawHandle[msg.sender];
        totalDeposits -= cleartextAmount;

        if (cleartextAmount > 0) {
            token.safeTransfer(msg.sender, cleartextAmount);
        }
        emit Withdrawn(msg.sender, cleartextAmount);
    }
}
