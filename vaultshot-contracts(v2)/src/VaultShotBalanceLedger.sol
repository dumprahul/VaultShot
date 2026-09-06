// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VaultShotBalanceLedger
/// @notice Encrypted per-user pool share for one VaultShot pool. Same role as FoggyPot's Ledger —
/// tracks each depositor's share of the pool as a euint64, separate from the Vault's own cUSD
/// custody balance. Only the pool's Vault and PrizePool may mutate balances.
contract VaultShotBalanceLedger is ZamaEthereumConfig, Ownable {
    mapping(address => euint64) private _balances;
    mapping(address => bool) public isDepositor;
    address[] public depositors;

    address public vault;
    address public prizePool;

    event AuthorizedContractsSet(address indexed vault, address indexed prizePool);

    modifier onlyAuthorized() {
        require(msg.sender == vault || msg.sender == prizePool, "Ledger: not authorized");
        _;
    }

    constructor(address admin) Ownable(admin) {}

    /// @notice One-time wiring of the Vault and PrizePool allowed to mutate balances. Admin-only.
    function setAuthorizedContracts(address vault_, address prizePool_) external onlyOwner {
        require(vault == address(0) && prizePool == address(0), "Ledger: already set");
        require(vault_ != address(0) && prizePool_ != address(0), "Ledger: zero address");
        vault = vault_;
        prizePool = prizePool_;
        emit AuthorizedContractsSet(vault_, prizePool_);
    }

    // -----------------------------------------------------------------
    // Balance readers — deliberately several named ways to fetch the same encrypted handle, all
    // decryptable off-chain via the same EIP-712 userDecrypt flow (see client/src/vaultshot.ts).
    // -----------------------------------------------------------------

    function confidentialBalanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    /// @notice Alias of confidentialBalanceOf: pass a wallet address, get back the encrypted
    /// handle. Decrypt it off-chain with the SDK to see the plaintext value.
    function seeConfidentialBalance(address account) external view returns (euint64) {
        return _balances[account];
    }

    /// @notice Second alias, same handle.
    function getEncryptedBalance(address account) external view returns (euint64) {
        return _balances[account];
    }

    /// @notice Third alias, same handle.
    function balanceOfEncrypted(address account) external view returns (euint64) {
        return _balances[account];
    }

    /// @notice Batch reader — fetch several accounts' encrypted balances in one call.
    function getEncryptedBalances(address[] calldata accounts) external view returns (euint64[] memory balances) {
        balances = new euint64[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            balances[i] = _balances[accounts[i]];
        }
    }

    function depositorsCount() external view returns (uint256) {
        return depositors.length;
    }

    function allDepositors() external view returns (address[] memory) {
        return depositors;
    }

    // -----------------------------------------------------------------
    // Mutations — restricted to the pool's own Vault/PrizePool.
    // -----------------------------------------------------------------

    /// @notice Adds `amount` to `account`'s encrypted balance, registering them as a depositor
    /// on first credit. Grants decrypt permission on the new handle to the account and both
    /// authorized contracts.
    function credit(address account, euint64 amount) external onlyAuthorized {
        if (!isDepositor[account]) {
            isDepositor[account] = true;
            depositors.push(account);
        }
        euint64 newBalance = FHE.add(_balances[account], amount);
        _grant(account, newBalance);
        _balances[account] = newBalance;
    }

    /// @notice Zeroes `account`'s encrypted balance and returns the previous value. Used by
    /// Vault.withdraw() to pull the full balance out in one shot.
    function debitAll(address account) external onlyAuthorized returns (euint64 previousBalance) {
        previousBalance = _balances[account];
        euint64 zero = FHE.asEuint64(0);
        _grant(account, zero);
        _balances[account] = zero;
    }

    function _grant(address account, euint64 value) private {
        FHE.allowThis(value);
        FHE.allow(value, account);
        FHE.allow(value, vault);
        FHE.allow(value, prizePool);
    }
}
