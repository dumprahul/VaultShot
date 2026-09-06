// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VaultShotToken} from "./VaultShotToken.sol";
import {VaultShotBalanceLedger} from "./VaultShotBalanceLedger.sol";

/// @title VaultShotVault
/// @notice Deposit/withdraw entry point for one VaultShot pool — the confidential-native
/// successor to FoggyPot's Vault. The underlying asset here is already confidential (cUSD, an
/// ERC7984 token), so both deposit AND withdrawal are genuine confidential transfers: no
/// plaintext amount ever passes through this contract's own functions (contrast with FoggyPot,
/// where deposit/withdraw amounts were plaintext at the boundary).
///
/// totalDeposits is now ENCRYPTED (euint64), not plaintext like FoggyPot's — individual deposits
/// no longer leak a plaintext amount to piggyback a running total on. Bounding the draw's random
/// number still needs a *plaintext* divisor (fhEVM has no encrypted-divisor modulus), so the
/// total is revealed once per draw, in aggregate only, via markTotalForDraw() + a public-decrypt
/// round trip — see VaultShotPrizePool. Never any individual balance, only the sum.
contract VaultShotVault is ZamaEthereumConfig, Ownable {
    VaultShotToken public immutable token;
    VaultShotBalanceLedger public immutable ledger;

    euint64 private _totalDeposits;
    bytes32 public pendingTotalHandle;

    address public prizePool;

    event Deposited(address indexed user);
    event Withdrawn(address indexed user);
    event PrizePoolSet(address indexed prizePool);
    event TotalMarkedForDraw(bytes32 handle);

    modifier onlyPrizePool() {
        require(msg.sender == prizePool, "Vault: not prize pool");
        _;
    }

    constructor(address admin, VaultShotToken token_, VaultShotBalanceLedger ledger_) Ownable(admin) {
        token = token_;
        ledger = ledger_;
    }

    /// @notice One-time wiring of the PrizePool allowed to credit the prize budget and request
    /// the encrypted total for a draw. Admin-only.
    function setPrizePool(address prizePool_) external onlyOwner {
        require(prizePool == address(0), "Vault: already set");
        require(prizePool_ != address(0), "Vault: zero address");
        prizePool = prizePool_;
        emit PrizePoolSet(prizePool_);
    }

    /// @notice Encrypted running total across all depositors — see NatSpec above for why this
    /// exists and how it's used. Anyone can read the handle; nobody but the parties granted
    /// access via markTotalForDraw()'s public-decryptability can turn it into a plaintext number.
    function totalDeposits() external view returns (euint64) {
        return _totalDeposits;
    }

    /// @notice Deposits `amount` of confidential cUSD. The depositor must have approved this
    /// Vault as an operator on the token first (`token.setOperator(vault, until)`), same role as
    /// an ERC-20 `approve` but time-bound rather than amount-bound.
    function deposit(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        FHE.allowTransient(amount, address(this));
        // The token's own _update performs FHE arithmetic on `amount` in its own execution
        // context, so the token contract itself needs ACL access to it too — not just the caller.
        FHE.allowTransient(amount, address(token));

        // Pull the confidential tokens in — a genuine confidentialTransferFrom, no plaintext
        // amount anywhere in this call.
        token.confidentialTransferFrom(msg.sender, address(this), amount);

        FHE.allowTransient(amount, address(ledger));
        ledger.credit(msg.sender, amount);

        euint64 newTotal = FHE.add(_totalDeposits, amount);
        FHE.allowThis(newTotal);
        FHE.allow(newTotal, prizePool);
        _totalDeposits = newTotal;

        emit Deposited(msg.sender);
    }

    /// @notice Withdraws the caller's full balance (principal plus any winnings), at any time, no
    /// restrictions. Unlike FoggyPot this is a single transaction: the Vault already holds a
    /// persistent ACL grant on the balance handle (from Ledger's own credit/debitAll grants), so
    /// no public-decryption round trip is needed to send it back — it's a confidential transfer
    /// the whole way, principal included.
    function withdraw() external {
        euint64 amount = ledger.debitAll(msg.sender);

        euint64 newTotal = FHE.sub(_totalDeposits, amount);
        FHE.allowThis(newTotal);
        FHE.allow(newTotal, prizePool);
        _totalDeposits = newTotal;

        // Same reasoning as deposit(): the token needs its own ACL access to `amount` for the FHE
        // arithmetic inside its _update, in addition to whatever Ledger's _grant already gave us.
        FHE.allowTransient(amount, address(token));
        token.confidentialTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender);
    }

    /// @notice Called by PrizePool at the start of a draw: flags the current encrypted total as
    /// publicly decryptable and returns its handle. Never touches any individual balance.
    function markTotalForDraw() external onlyPrizePool returns (bytes32 handle) {
        FHE.makePubliclyDecryptable(_totalDeposits);
        handle = euint64.unwrap(_totalDeposits);
        pendingTotalHandle = handle;
        emit TotalMarkedForDraw(handle);
    }

    /// @notice Called by PrizePool during runDraw() to credit the prize budget cUSD it just
    /// pulled from Reserve into this Vault's own confidential balance bookkeeping side (the
    /// Ledger, not the token balance — the token balance already reflects the transfer itself).
    function creditPrizeBudgetToTotal(euint64 amount) external onlyPrizePool {
        euint64 newTotal = FHE.add(_totalDeposits, amount);
        FHE.allowThis(newTotal);
        FHE.allow(newTotal, prizePool);
        _totalDeposits = newTotal;
    }
}
