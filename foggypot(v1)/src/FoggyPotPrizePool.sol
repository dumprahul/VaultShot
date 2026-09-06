// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FoggyPotBalanceLedger} from "./FoggyPotBalanceLedger.sol";
import {FoggyPotReserve} from "./FoggyPotReserve.sol";
import {FoggyPotVault} from "./FoggyPotVault.sol";

/// @title FoggyPotPrizePool
/// @notice Owns the draw lifecycle for one pool. runDraw() generates FHE.randEuint64(), runs a
/// per-tier running-sum + FHE.lt selection loop over all depositors, and distributes each tier's
/// prize as a genuine confidential transfer — an `FHE.sub` debit from Reserve's own encrypted
/// balance (see FoggyPotReserve) paired with an `FHE.select`-gated credit to whichever
/// participant the random draw lands on — entirely on-chain, entirely oblivious to who won
/// except the winner themselves.
///
/// Tiers are PUBLIC, PLAINTEXT config (sizes, winner counts) — only the balance comparisons that
/// decide who wins are encrypted. Grand tier picks 1 winner (70% of the draw's prize budget);
/// Minor tier picks 3 winners (remaining 30%, split evenly), excluding already-picked winners
/// within that same tier by zeroing their selection weight for subsequent passes.
///
/// Why no encrypted division: fhEVM only supports division/modulus by a PLAINTEXT divisor, never
/// an encrypted one. totalDeposits is intentionally tracked in plaintext (see FoggyPotVault), so
/// bounding the draw to [0, totalDeposits) is exactly `FHE.rem(FHE.randEuint64(), totalDeposits)`
/// — modulus by a plaintext divisor, not an "encrypted division". The Grand tier's single pass is
/// then guaranteed to find a winner (the bound exactly equals total weight in play). A Minor
/// tier's 2nd/3rd pass reuses that same bound rather than a shrunk one — computing the reduced
/// sum would require knowing which participant was already excluded, which is exactly the secret
/// being protected — so if the random draw lands within that pass's already-excluded winner's
/// zeroed slice, no one's running sum reaches it and that pass simply finds no winner. Because
/// each draw's full prize budget is pulled from Reserve into the Vault up front (see runDraw),
/// a missed pass's fixed share isn't lost — it sits as uncredited surplus backing the Vault's
/// real token balance rather than being attributed to any user's encrypted balance. This is a
/// deliberate, documented simplification, not a bug, and only affects later Minor-tier passes
/// (the Grand tier's single pass is mathematically guaranteed to find a winner).
contract FoggyPotPrizePool is ZamaEthereumConfig, Ownable {
    uint256 public constant GRAND_BPS = 7_000;
    uint256 public constant MINOR_BPS = 3_000;
    uint256 public constant MINOR_WINNER_COUNT = 3;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    FoggyPotBalanceLedger public immutable ledger;
    FoggyPotReserve public immutable reserve;
    FoggyPotVault public immutable vault;

    uint256 public immutable drawPeriod;
    uint64 public immutable totalPrizePerDraw;
    uint64 public immutable grandPrizeAmount;
    uint64 public immutable minorPrizeAmount;

    uint256 public nextDrawTime;
    uint256 public drawCount;
    address public keeper;

    event KeeperSet(address indexed keeper);
    event DrawSkipped(uint256 indexed drawId, string reason);
    event DrawCompleted(uint256 indexed drawId, uint256 timestamp, uint256 participantCount);

    modifier onlyAdminOrKeeper() {
        require(msg.sender == owner() || msg.sender == keeper, "PrizePool: not admin or keeper");
        _;
    }

    constructor(
        address admin,
        FoggyPotBalanceLedger ledger_,
        FoggyPotReserve reserve_,
        FoggyPotVault vault_,
        uint256 drawPeriod_,
        uint64 totalPrizePerDraw_
    ) Ownable(admin) {
        ledger = ledger_;
        reserve = reserve_;
        vault = vault_;
        drawPeriod = drawPeriod_;
        totalPrizePerDraw = totalPrizePerDraw_;

        grandPrizeAmount = uint64((uint256(totalPrizePerDraw_) * GRAND_BPS) / BPS_DENOMINATOR);
        uint64 minorTotal = uint64((uint256(totalPrizePerDraw_) * MINOR_BPS) / BPS_DENOMINATOR);
        minorPrizeAmount = minorTotal / uint64(MINOR_WINNER_COUNT);

        nextDrawTime = block.timestamp + drawPeriod_;
    }

    /// @notice One-time wiring of the DrawKeeper allowed to trigger draws. Admin-only.
    function setKeeper(address keeper_) external onlyOwner {
        require(keeper == address(0), "PrizePool: keeper already set");
        require(keeper_ != address(0), "PrizePool: zero address");
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function isDrawDue() external view returns (bool) {
        return block.timestamp >= nextDrawTime;
    }

    /// @notice Runs one draw: 1 Grand-tier pass + MINOR_WINNER_COUNT Minor-tier passes. Callable
    /// by the admin or the registered DrawKeeper once the draw window has elapsed.
    function runDraw() external onlyAdminOrKeeper {
        require(block.timestamp >= nextDrawTime, "PrizePool: too early");

        uint256 drawId = drawCount++;
        while (nextDrawTime <= block.timestamp) {
            nextDrawTime += drawPeriod;
        }

        address[] memory participants = ledger.allDepositors();
        uint64 totalDeposits = vault.totalDeposits();

        if (participants.length == 0 || totalDeposits == 0) {
            emit DrawSkipped(drawId, "no depositors");
            return;
        }

        uint256 totalPrizeBudget = uint256(grandPrizeAmount) + uint256(minorPrizeAmount) * MINOR_WINNER_COUNT;
        if (reserve.balance() < totalPrizeBudget) {
            emit DrawSkipped(drawId, "reserve underfunded");
            return;
        }
        reserve.releaseTo(address(vault), totalPrizeBudget);
        vault.creditPrizeBudget(uint64(totalPrizeBudget));

        // Grand and Minor tiers each get their own snapshot of balances-at-draw-time: exclusion
        // (zeroing a pass's winner's weight) is scoped to *within* a tier, per Section 6 of the
        // spec — a Grand-tier winner remains fully eligible for Minor-tier prizes in the same draw.
        euint64[] memory grandBalances = _snapshotBalances(participants);
        _runSelectionPass(participants, grandBalances, totalDeposits, grandPrizeAmount);

        // Minor tier — MINOR_WINNER_COUNT passes, excluding each pass's winner from later passes
        // within this same tier by zeroing their effective weight.
        euint64[] memory minorBalances = _snapshotBalances(participants);
        for (uint256 pass = 0; pass < MINOR_WINNER_COUNT; pass++) {
            _runSelectionPass(participants, minorBalances, totalDeposits, minorPrizeAmount);
        }

        emit DrawCompleted(drawId, block.timestamp, participants.length);
    }

    function _snapshotBalances(address[] memory participants) private view returns (euint64[] memory balances) {
        balances = new euint64[](participants.length);
        for (uint256 i = 0; i < participants.length; i++) {
            balances[i] = ledger.confidentialBalanceOf(participants[i]);
        }
    }

    /// @dev One weighted-random selection pass over `participants`, using `effectiveBalances` as
    /// each participant's current weight (mutated in place: the pass's winner's weight is zeroed
    /// so they're excluded from any subsequent pass sharing this same array). Distributes
    /// `prizeAmount` as a genuine confidential transfer: an unconditional `FHE.sub` debit from
    /// Reserve's encrypted balance, paired with an oblivious `FHE.select`-gated credit to
    /// whichever single participant's cumulative weight first exceeds the pass's random draw.
    function _runSelectionPass(
        address[] memory participants,
        euint64[] memory effectiveBalances,
        uint64 weightBound,
        uint64 prizeAmount
    ) private {
        reserve.debitConfidential(prizeAmount);

        euint64 zero = FHE.asEuint64(0);
        euint64 prize = FHE.asEuint64(prizeAmount);
        euint64 rand = FHE.rem(FHE.randEuint64(), weightBound);
        euint64 runningSum = zero;
        ebool alreadyWon = FHE.asEbool(false);

        for (uint256 i = 0; i < participants.length; i++) {
            runningSum = FHE.add(runningSum, effectiveBalances[i]);
            ebool crossed = FHE.lt(rand, runningSum);
            ebool isThisWinner = FHE.and(crossed, FHE.not(alreadyWon));
            alreadyWon = FHE.or(alreadyWon, isThisWinner);

            euint64 creditAmount = FHE.select(isThisWinner, prize, zero);
            FHE.allowTransient(creditAmount, address(ledger));
            ledger.credit(participants[i], creditAmount);

            effectiveBalances[i] = FHE.select(isThisWinner, zero, effectiveBalances[i]);
        }
    }
}
