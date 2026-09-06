// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VaultShotToken} from "./VaultShotToken.sol";

/// @title VaultShotReserve
/// @notice Holds this pool's admin-funded mock yield, entirely in confidential cUSD. Unlike
/// FoggyPot's Reserve (which needed a separate encrypted mirror alongside a real plaintext ERC-20
/// balance), there's only one balance here — the token itself is already confidential, so
/// `token.confidentialBalanceOf(address(this))` IS the real holding, no mirror needed.
///
/// availableBudget is a PLAINTEXT admin-maintained counter, deliberately — not a leak of user
/// data, since only the admin's own funding/payout amounts feed it, and admin already knows those
/// (they funded it themselves, from their own wrapped cUSD). It exists because runDraw() needs to
/// make a plaintext branch decision ("do we have enough to pay this draw's budget or not"), and
/// Solidity can't branch on an encrypted condition without revealing it. This keeps that decision
/// on data that was never secret to begin with, without needing to decrypt Reserve's actual cUSD
/// balance every draw.
contract VaultShotReserve is ZamaEthereumConfig, Ownable {
    VaultShotToken public immutable token;
    address public prizePool;

    uint64 public availableBudget;

    event Funded(address indexed from, uint64 amount);
    event Released(address indexed to, uint64 amount);
    event PrizePoolSet(address indexed prizePool);

    modifier onlyPrizePool() {
        require(msg.sender == prizePool, "Reserve: not prize pool");
        _;
    }

    constructor(address admin, VaultShotToken token_) Ownable(admin) {
        token = token_;
    }

    /// @notice One-time wiring of the PrizePool allowed to release funds. Admin-only.
    function setPrizePool(address prizePool_) external onlyOwner {
        require(prizePool == address(0), "Reserve: already set");
        require(prizePool_ != address(0), "Reserve: zero address");
        prizePool = prizePool_;
        emit PrizePoolSet(prizePool_);
    }

    /// @notice Admin funds this pool's mock yield reserve with confidential cUSD. The admin must
    /// have approved this Reserve as an operator on the token first. `plaintextAmount` must match
    /// `encryptedAmount` — trusted because this is an owner-only call funding the admin's own
    /// accounting counter, not a user-facing function; a mismatch only shorts the admin's own
    /// bookkeeping, never anyone else's funds.
    function fund(externalEuint64 encryptedAmount, bytes calldata inputProof, uint64 plaintextAmount)
        external
        onlyOwner
    {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        FHE.allowTransient(amount, address(this));
        // The token's own _update performs FHE arithmetic on `amount` in its own execution
        // context, so the token contract itself needs ACL access to it too — not just Reserve.
        FHE.allowTransient(amount, address(token));
        token.confidentialTransferFrom(msg.sender, address(this), amount);

        availableBudget += plaintextAmount;
        emit Funded(msg.sender, plaintextAmount);
    }

    /// @notice Called by the PrizePool during runDraw() to move confidential cUSD into the Vault,
    /// backing that draw's prize budget. `amount` is plaintext because prize tier sizes are
    /// public config (only who wins is secret) — Reserve mints the matching ciphertext itself
    /// from that known plaintext figure and sends it as a genuine confidential transfer.
    function releaseTo(address to, uint64 amount) external onlyPrizePool returns (euint64 released) {
        require(availableBudget >= amount, "Reserve: underfunded");
        availableBudget -= amount;

        released = FHE.asEuint64(amount);
        FHE.allowTransient(released, address(this));
        // Same reasoning as fund(): the token needs its own ACL access to `released` for the FHE
        // arithmetic inside its _update.
        FHE.allowTransient(released, address(token));
        token.confidentialTransfer(to, released);
        FHE.allowTransient(released, msg.sender);

        emit Released(to, amount);
    }

    /// @notice Convenience passthrough to the token's own confidential balance for this Reserve —
    /// there's no separate mirror to maintain in this architecture, so this just forwards.
    function getEncryptedBalance() external view returns (euint64) {
        return token.confidentialBalanceOf(address(this));
    }
}
