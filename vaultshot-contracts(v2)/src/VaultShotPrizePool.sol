// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VaultShotBalanceLedger} from "./VaultShotBalanceLedger.sol";
import {VaultShotReserve} from "./VaultShotReserve.sol";
import {VaultShotVault} from "./VaultShotVault.sol";

/// @title VaultShotPrizePool
/// @notice Owns the draw lifecycle. Unlike FoggyPot's single-transaction runDraw(), a draw here
/// is TWO phases, because Vault.totalDeposits is now encrypted (see VaultShotVault's NatSpec) and
/// has to be revealed — in aggregate only, never any individual balance — before it can bound
/// FHE.randEuint64 via FHE.rem.
///
///   1. requestDraw()  — flags the encrypted total decryptable, advances the schedule.
///   2. (off-chain)    — instance.publicDecrypt([handle]) gets the plaintext total + KMS proof.
///   3. finalizeDraw() — verifies the proof, then runs the exact same weighted running-sum
///                       selection loop FoggyPot used, bounded by the freshly-revealed total.
///
/// The selection loop itself, the tier structure, and the "why no encrypted division" reasoning
/// are identical to FoggyPot — only how the plaintext bound is obtained has changed.
contract VaultShotPrizePool is ZamaEthereumConfig, Ownable {
    uint256 public constant GRAND_BPS = 7_000;
    uint256 public constant MINOR_BPS = 3_000;
    uint256 public constant MINOR_WINNER_COUNT = 3;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    enum DrawStage {
        Idle,
        TotalRequested
    }

    VaultShotBalanceLedger public immutable ledger;
    VaultShotReserve public immutable reserve;
    VaultShotVault public immutable vault;

    uint256 public immutable drawPeriod;
    uint64 public immutable totalPrizePerDraw;
    uint64 public immutable grandPrizeAmount;
    uint64 public immutable minorPrizeAmount;

    uint256 public nextDrawTime;
    uint256 public drawCount;
    address public keeper;

    DrawStage public stage;
    uint256 public pendingDrawId;

    event KeeperSet(address indexed keeper);
    event DrawRequested(uint256 indexed drawId, bytes32 totalHandle);
    event DrawSkipped(uint256 indexed drawId, string reason);
    event DrawCompleted(uint256 indexed drawId, uint256 timestamp, uint256 participantCount, uint64 totalDeposits);

    modifier onlyAdminOrKeeper() {
        require(msg.sender == owner() || msg.sender == keeper, "PrizePool: not admin or keeper");
        _;
    }

    constructor(
        address admin,
        VaultShotBalanceLedger ledger_,
        VaultShotReserve reserve_,
        VaultShotVault vault_,
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
        return stage == DrawStage.Idle && block.timestamp >= nextDrawTime;
    }

    /// @notice Phase 1: flags the encrypted total decryptable and advances the schedule. Callable
    /// by the admin or the registered keeper once the draw window has elapsed.
    function requestDraw() external onlyAdminOrKeeper returns (bytes32 totalHandle) {
        require(stage == DrawStage.Idle, "PrizePool: draw already in progress");
        require(block.timestamp >= nextDrawTime, "PrizePool: too early");

        while (nextDrawTime <= block.timestamp) {
            nextDrawTime += drawPeriod;
        }

        pendingDrawId = drawCount++;
        stage = DrawStage.TotalRequested;
        totalHandle = vault.markTotalForDraw();

        emit DrawRequested(pendingDrawId, totalHandle);
    }

    /// @notice Phase 2: verifies the KMS's decryption proof for the total, then runs the draw.
    /// Callable by the admin or the registered keeper — same as phase 1.
    function finalizeDraw(bytes calldata abiEncodedTotal, bytes calldata decryptionProof) external onlyAdminOrKeeper {
        require(stage == DrawStage.TotalRequested, "PrizePool: no draw pending");

        bytes32 handle = vault.pendingTotalHandle();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        FHE.checkSignatures(handles, abiEncodedTotal, decryptionProof);

        uint64 totalDeposits = uint64(abi.decode(abiEncodedTotal, (uint256)));
        uint256 drawId = pendingDrawId;
        stage = DrawStage.Idle;

        address[] memory participants = ledger.allDepositors();
        if (participants.length == 0 || totalDeposits == 0) {
            emit DrawSkipped(drawId, "no depositors");
            return;
        }

        uint256 totalPrizeBudget = uint256(grandPrizeAmount) + uint256(minorPrizeAmount) * MINOR_WINNER_COUNT;
        if (reserve.availableBudget() < totalPrizeBudget) {
            emit DrawSkipped(drawId, "reserve underfunded");
            return;
        }

        euint64 released = reserve.releaseTo(address(vault), uint64(totalPrizeBudget));
        FHE.allowTransient(released, address(vault));
        vault.creditPrizeBudgetToTotal(released);

        // Grand and Minor tiers each get their own snapshot of balances-at-draw-time — exclusion
        // is scoped to *within* a tier, same as FoggyPot.
        euint64[] memory grandBalances = _snapshotBalances(participants);
        _runSelectionPass(participants, grandBalances, totalDeposits, grandPrizeAmount);

        euint64[] memory minorBalances = _snapshotBalances(participants);
        for (uint256 pass = 0; pass < MINOR_WINNER_COUNT; pass++) {
            _runSelectionPass(participants, minorBalances, totalDeposits, minorPrizeAmount);
        }

        emit DrawCompleted(drawId, block.timestamp, participants.length, totalDeposits);
    }

    function _snapshotBalances(address[] memory participants) private view returns (euint64[] memory balances) {
        balances = new euint64[](participants.length);
        for (uint256 i = 0; i < participants.length; i++) {
            balances[i] = ledger.confidentialBalanceOf(participants[i]);
        }
    }

    /// @dev Identical mechanism to FoggyPot's selection pass: a running-sum comparison against
    /// one random draw, bounded by the plaintext total, crediting whichever participant's
    /// cumulative weight crosses it — oblivious to everyone but that participant.
    function _runSelectionPass(
        address[] memory participants,
        euint64[] memory effectiveBalances,
        uint64 weightBound,
        uint64 prizeAmount
    ) private {
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
