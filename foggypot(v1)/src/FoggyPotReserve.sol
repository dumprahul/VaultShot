// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title FoggyPotReserve
/// @notice Holds this pool's admin-funded mock yield, in the same token the pool accepts. No
/// conversion, no cross-pool sharing. Yield is entirely simulated: the admin transfers real
/// tokens in via fund(), which credits BOTH the real ERC-20 balance and a mirrored encrypted
/// balance (`confidentialBalance`) tracking the same figure.
///
/// That encrypted mirror is what makes prize distribution a genuine confidential transfer: each
/// draw pass calls debitConfidential() here (an `FHE.sub` on this contract's own encrypted
/// balance) paired with an oblivious `FHE.select`-gated credit to whichever participant's weight
/// the random draw lands on (see FoggyPotPrizePool._runSelectionPass). A known amount leaves an
/// encrypted balance, an encrypted amount (0 or that same amount) arrives at exactly one
/// participant's — a transfer between two euint64 balances, not a credit conjured from nowhere.
///
/// The real ERC-20 movement (releaseTo, unchanged) still separately backs actual withdrawals;
/// the encrypted mirror is bookkeeping for the confidentiality property, not a second source of
/// truth for solvency — the real balance remains authoritative (see runDraw's underfunded check).
contract FoggyPotReserve is ZamaEthereumConfig, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public prizePool;

    euint64 private _confidentialBalance;

    event Funded(address indexed from, uint256 amount);
    event Released(address indexed to, uint256 amount);
    event PrizePoolSet(address indexed prizePool);

    modifier onlyPrizePool() {
        require(msg.sender == prizePool, "Reserve: not prize pool");
        _;
    }

    constructor(address admin, IERC20 token_) Ownable(admin) {
        token = token_;
    }

    /// @notice One-time wiring of the PrizePool allowed to pull funds. Admin-only.
    function setPrizePool(address prizePool_) external onlyOwner {
        require(prizePool == address(0), "Reserve: already set");
        require(prizePool_ != address(0), "Reserve: zero address");
        prizePool = prizePool_;
        emit PrizePoolSet(prizePool_);
    }

    /// @notice Admin funds this pool's mock yield reserve. Requires prior ERC20 approval. Credits
    /// the real ERC-20 balance and the encrypted mirror by the same (already-public, since this
    /// is a plaintext ERC20 transfer) amount.
    function fund(uint256 amount) external onlyOwner {
        token.safeTransferFrom(msg.sender, address(this), amount);

        euint64 newBalance = FHE.add(_confidentialBalance, FHE.asEuint64(uint64(amount)));
        _grant(newBalance);
        _confidentialBalance = newBalance;

        emit Funded(msg.sender, amount);
    }

    /// @notice Called by the PrizePool during runDraw() to move real prize tokens into the Vault.
    function releaseTo(address to, uint256 amount) external onlyPrizePool {
        token.safeTransfer(to, amount);
        emit Released(to, amount);
    }

    /// @notice Called by the PrizePool once per selection pass: debits `amount` from the
    /// encrypted mirror. `amount` is plaintext because tier prize sizes are public config (only
    /// who wins is secret) — see FoggyPotPrizePool's NatSpec. Unconditional, not FHE.select-gated:
    /// the fixed per-pass budget already always leaves Reserve's real balance too (via releaseTo,
    /// called once per draw for the whole budget), regardless of whether that particular pass
    /// finds a winner.
    function debitConfidential(uint64 amount) external onlyPrizePool returns (euint64 newBalance) {
        newBalance = FHE.sub(_confidentialBalance, FHE.asEuint64(amount));
        _grant(newBalance);
        _confidentialBalance = newBalance;
    }

    function confidentialBalance() external view returns (euint64) {
        return _confidentialBalance;
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function _grant(euint64 value) private {
        FHE.allowThis(value);
        FHE.allow(value, owner());
    }
}
