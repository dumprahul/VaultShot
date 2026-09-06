// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {euint64} from "encrypted-types/EncryptedTypes.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FoggyPotBalanceLedger} from "../src/FoggyPotBalanceLedger.sol";
import {FoggyPotVault} from "../src/FoggyPotVault.sol";
import {FoggyPotReserve} from "../src/FoggyPotReserve.sol";
import {FoggyPotPrizePool} from "../src/FoggyPotPrizePool.sol";
import {FoggyPotDrawKeeper} from "../src/FoggyPotDrawKeeper.sol";

contract FoggyPotTest is FhevmTest {
    uint256 constant DRAW_PERIOD = 5 minutes;
    uint64 constant TOTAL_PRIZE_PER_DRAW = 100 * 10 ** 6;
    uint64 constant RESERVE_FUNDING = 1_000 * 10 ** 6;

    MockUSDC token;
    FoggyPotBalanceLedger ledger;
    FoggyPotVault vault;
    FoggyPotReserve reserve;
    FoggyPotPrizePool prizePool;
    FoggyPotDrawKeeper keeper;

    Account admin;
    Account alice;
    Account bob;
    Account carol;

    function setUp() public override {
        super.setUp();

        admin = makeAccount("admin");
        alice = makeAccount("alice");
        bob = makeAccount("bob");
        carol = makeAccount("carol");

        vm.startPrank(admin.addr);
        token = new MockUSDC();
        ledger = new FoggyPotBalanceLedger(admin.addr);
        vault = new FoggyPotVault(admin.addr, token, ledger);
        reserve = new FoggyPotReserve(admin.addr, token);
        prizePool =
            new FoggyPotPrizePool(admin.addr, ledger, reserve, vault, DRAW_PERIOD, TOTAL_PRIZE_PER_DRAW);

        ledger.setAuthorizedContracts(address(vault), address(prizePool));
        reserve.setPrizePool(address(prizePool));
        vault.setPrizePool(address(prizePool));

        keeper = new FoggyPotDrawKeeper(admin.addr);
        FoggyPotPrizePool[] memory pools = new FoggyPotPrizePool[](1);
        pools[0] = prizePool;
        keeper.setPools(pools);
        prizePool.setKeeper(address(keeper));

        token.adminMint(admin.addr, RESERVE_FUNDING);
        token.approve(address(reserve), RESERVE_FUNDING);
        reserve.fund(RESERVE_FUNDING);
        vm.stopPrank();

        _fundAndApprove(alice.addr, 1_000 * 10 ** 6);
        _fundAndApprove(bob.addr, 1_000 * 10 ** 6);
        _fundAndApprove(carol.addr, 1_000 * 10 ** 6);
    }

    function _fundAndApprove(address user, uint256 amount) internal {
        vm.prank(admin.addr);
        token.adminMint(user, amount);
        vm.prank(user);
        token.approve(address(vault), type(uint256).max);
    }

    function _decryptBalance(Account memory user) internal returns (uint256) {
        bytes32 handle = euint64.unwrap(ledger.confidentialBalanceOf(user.addr));
        if (handle == bytes32(0)) return 0;
        bytes memory sig = signUserDecrypt(user.key, address(ledger));
        return userDecrypt(handle, user.addr, address(ledger), sig);
    }

    /// @dev userDecrypt() is internal (inherited from FhevmTest), so calling it directly creates
    /// no external call frame for vm.expectRevert to intercept. This wrapper forces one.
    function _userDecryptExternal(bytes32 handle, address userAddress, address contractAddress, bytes memory sig)
        external
        returns (uint256)
    {
        return userDecrypt(handle, userAddress, contractAddress, sig);
    }

    /// @dev Reserve grants decrypt permission on its confidential balance to its owner (admin).
    function _decryptReserveBalance() internal returns (uint256) {
        bytes32 handle = euint64.unwrap(reserve.confidentialBalance());
        if (handle == bytes32(0)) return 0;
        bytes memory sig = signUserDecrypt(admin.key, address(reserve));
        return userDecrypt(handle, admin.addr, address(reserve), sig);
    }

    // ---------------------------------------------------------------------
    // Deposit
    // ---------------------------------------------------------------------

    function test_depositCreditsEncryptedBalance() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);

        assertEq(_decryptBalance(alice), 100 * 10 ** 6);
        assertEq(vault.totalDeposits(), 100 * 10 ** 6);
        assertEq(token.balanceOf(address(vault)), 100 * 10 ** 6);
        assertEq(ledger.depositorsCount(), 1);
    }

    /// @dev seeConfidentialBalance is an alias for confidentialBalanceOf — same handle, same ACL
    /// grants, decryptable the same way.
    function test_seeConfidentialBalanceMatchesConfidentialBalanceOf() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);

        bytes32 viaOriginal = euint64.unwrap(ledger.confidentialBalanceOf(alice.addr));
        bytes32 viaAlias = euint64.unwrap(ledger.seeConfidentialBalance(alice.addr));
        assertEq(viaOriginal, viaAlias);

        bytes memory sig = signUserDecrypt(alice.key, address(ledger));
        assertEq(userDecrypt(viaAlias, alice.addr, address(ledger), sig), 100 * 10 ** 6);
    }

    function test_multipleDepositsAccumulate() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);
        vm.prank(alice.addr);
        vault.deposit(50 * 10 ** 6);

        assertEq(_decryptBalance(alice), 150 * 10 ** 6);
        assertEq(ledger.depositorsCount(), 1); // still a single depositor
    }

    function test_depositRevertsWithoutApproval() public {
        address dave = makeAddr("dave");
        vm.prank(admin.addr);
        token.adminMint(dave, 100 * 10 ** 6);
        // dave never approved the vault.

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 100 * 10 ** 6)
        );
        vm.prank(dave);
        vault.deposit(100 * 10 ** 6);
    }

    function test_depositRevertsWithInsufficientBalance() public {
        address dave = makeAddr("dave");
        vm.prank(dave);
        token.approve(address(vault), type(uint256).max);
        // dave approved but was never minted any tokens.

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, dave, 0, 100 * 10 ** 6)
        );
        vm.prank(dave);
        vault.deposit(100 * 10 ** 6);
    }

    function test_depositRevertsOnZeroAmount() public {
        vm.expectRevert(bytes("Vault: zero amount"));
        vm.prank(alice.addr);
        vault.deposit(0);
    }

    // ---------------------------------------------------------------------
    // Draw
    // ---------------------------------------------------------------------

    function test_runDrawRevertsBeforeWindowElapses() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);

        vm.prank(admin.addr);
        vm.expectRevert(bytes("PrizePool: too early"));
        prizePool.runDraw();
    }

    function test_runDrawSkipsWithNoDepositors() public {
        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        prizePool.runDraw();

        assertEq(prizePool.drawCount(), 1);
        assertEq(prizePool.nextDrawTime(), block.timestamp + DRAW_PERIOD);
    }

    function test_runDrawDistributesPrizesAndConservesTokenBacking() public {
        vm.prank(alice.addr);
        vault.deposit(300 * 10 ** 6);
        vm.prank(bob.addr);
        vault.deposit(200 * 10 ** 6);
        vm.prank(carol.addr);
        vault.deposit(100 * 10 ** 6);

        uint256 reserveBefore = reserve.balance();

        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        prizePool.runDraw();

        uint256 reserveAfter = reserve.balance();
        assertEq(reserveBefore - reserveAfter, TOTAL_PRIZE_PER_DRAW);

        uint256 aliceBal = _decryptBalance(alice);
        uint256 bobBal = _decryptBalance(bob);
        uint256 carolBal = _decryptBalance(carol);
        uint256 totalCredited = aliceBal + bobBal + carolBal;

        // The vault must always hold at least as much real backing as all credited encrypted
        // balances sum to (full collateralization). It can hold MORE: a Minor-tier pass that
        // finds no winner (see FoggyPotPrizePool's NatSpec) still had its fixed budget pulled
        // from Reserve up front, so that slice sits as uncredited surplus in the Vault rather
        // than being lost or left under-collateralized.
        assertGe(token.balanceOf(address(vault)), totalCredited);
        assertEq(token.balanceOf(address(vault)), 600 * 10 ** 6 + TOTAL_PRIZE_PER_DRAW);

        // Grand tier is mathematically guaranteed to find a winner (see NatSpec), so at least
        // grandPrizeAmount is always distributed; at most the full per-draw budget is.
        uint256 totalWon = totalCredited - 600 * 10 ** 6;
        assertGe(totalWon, prizePool.grandPrizeAmount());
        assertLe(totalWon, TOTAL_PRIZE_PER_DRAW);
    }

    function test_fundSyncsRealAndEncryptedReserveBalance() public {
        // setUp() already funded the reserve once; confirm the encrypted mirror matches.
        assertEq(_decryptReserveBalance(), reserve.balance());
        assertEq(_decryptReserveBalance(), RESERVE_FUNDING);
    }

    /// @dev The core "confidential transfer" property: Reserve's ENCRYPTED balance (not just its
    /// real ERC-20 balance) decreases by exactly the per-draw budget, proving prize distribution
    /// is a genuine encrypted-to-encrypted transfer (FHE.sub from Reserve, FHE.select-gated
    /// FHE.add to a winner) rather than a credit conjured with no corresponding debit anywhere.
    function test_runDrawDebitsReserveConfidentialBalance() public {
        vm.prank(alice.addr);
        vault.deposit(300 * 10 ** 6);
        vm.prank(bob.addr);
        vault.deposit(200 * 10 ** 6);
        vm.prank(carol.addr);
        vault.deposit(100 * 10 ** 6);

        uint256 encryptedReserveBefore = _decryptReserveBalance();
        assertEq(encryptedReserveBefore, RESERVE_FUNDING);

        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        prizePool.runDraw();

        uint256 encryptedReserveAfter = _decryptReserveBalance();

        // Debited by exactly the full per-draw budget: one unconditional FHE.sub per pass (Grand
        // + 3x Minor), same total regardless of which passes actually found a winner.
        assertEq(encryptedReserveBefore - encryptedReserveAfter, TOTAL_PRIZE_PER_DRAW);
        // The encrypted mirror and the real ERC-20 balance move in lockstep.
        assertEq(encryptedReserveAfter, reserve.balance());
    }

    function test_runDrawAdvancesNextDrawTimePastMissedWindows() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);

        vm.warp(block.timestamp + DRAW_PERIOD * 3 + 1);
        vm.prank(admin.addr);
        prizePool.runDraw();

        assertGt(prizePool.nextDrawTime(), block.timestamp);
        assertEq(prizePool.drawCount(), 1);
    }

    // ---------------------------------------------------------------------
    // Withdraw
    // ---------------------------------------------------------------------

    function test_withdrawFullRoundTrip() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);

        uint256 balanceBeforeWithdraw = token.balanceOf(alice.addr);

        vm.prank(alice.addr);
        vault.requestWithdraw();

        bytes32 handle = vault.pendingWithdrawHandle(alice.addr);
        assertTrue(handle != bytes32(0));

        // The real KMS ABI-encodes one `uint256` per handle as a flat tuple (not a dynamic
        // `uint256[]`) — for one handle that's `abi.encode(uint256)`. buildDecryptionProof lets us
        // construct a proof matching that exact production encoding, rather than the higher-level
        // publicDecrypt() mock helper, which (unlike the real relayer) always array-wraps.
        bytes memory abiEncodedCleartext = abi.encode(uint256(100 * 10 ** 6));
        bytes memory proof = buildDecryptionProof(handle, abiEncodedCleartext);

        vm.prank(alice.addr);
        vault.finalizeWithdraw(abiEncodedCleartext, proof);

        assertEq(token.balanceOf(alice.addr), balanceBeforeWithdraw + 100 * 10 ** 6);
        assertEq(_decryptBalance(alice), 0);
        assertEq(vault.pendingWithdrawHandle(alice.addr), bytes32(0));
    }

    /// @dev Regression test: a solo depositor's balance grows via BOTH the Grand tier (always
    /// guaranteed to find its one winner) and the Minor tier's first pass (guaranteed too, since
    /// it gets its own fresh, unzeroed snapshot — see runDraw's NatSpec on per-tier snapshots).
    /// Withdrawing that combined deposit+prize balance must not underflow totalDeposits, which
    /// only ever tracked raw deposits until PrizePool started also crediting the prize budget.
    function test_soloDepositorCanWithdrawDepositPlusPrizes() public {
        vm.prank(alice.addr);
        vault.deposit(300 * 10 ** 6);

        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        prizePool.runDraw();

        uint256 expectedBalance = 300 * 10 ** 6 + prizePool.grandPrizeAmount() + prizePool.minorPrizeAmount();
        assertEq(_decryptBalance(alice), expectedBalance);

        vm.prank(alice.addr);
        vault.requestWithdraw();

        bytes32 handle = vault.pendingWithdrawHandle(alice.addr);
        bytes memory abiEncodedCleartext = abi.encode(expectedBalance);
        bytes memory proof = buildDecryptionProof(handle, abiEncodedCleartext);

        uint256 balanceBefore = token.balanceOf(alice.addr);
        vm.prank(alice.addr);
        vault.finalizeWithdraw(abiEncodedCleartext, proof);

        assertEq(token.balanceOf(alice.addr), balanceBefore + expectedBalance);
    }

    /// @dev Winner-only decryption, enforced: Bob has no ACL grant on Alice's balance handle, so
    /// even a validly-signed decrypt request from Bob for Alice's handle must revert. Decryption
    /// is per-account, not "anyone who knows the handle."
    function test_onlyAccountOwnerCanDecryptTheirBalance() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);

        bytes32 aliceHandle = euint64.unwrap(ledger.confidentialBalanceOf(alice.addr));
        bytes memory bobSignature = signUserDecrypt(bob.key, address(ledger));

        vm.expectRevert(
            abi.encodeWithSignature("UserNotAuthorizedForDecrypt(bytes32,address)", aliceHandle, bob.addr)
        );
        this._userDecryptExternal(aliceHandle, bob.addr, address(ledger), bobSignature);
    }

    function test_cannotRequestWithdrawTwiceConcurrently() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);

        vm.prank(alice.addr);
        vault.requestWithdraw();

        vm.prank(alice.addr);
        vm.expectRevert(bytes("Vault: withdraw already pending"));
        vault.requestWithdraw();
    }

    // ---------------------------------------------------------------------
    // Chainlink Automation keeper
    // ---------------------------------------------------------------------

    function test_keeperCheckAndPerformUpkeep() public {
        vm.prank(alice.addr);
        vault.deposit(100 * 10 ** 6);

        (bool needed,) = keeper.checkUpkeep("");
        assertFalse(needed);

        vm.warp(block.timestamp + DRAW_PERIOD);

        (bool neededNow, bytes memory performData) = keeper.checkUpkeep("");
        assertTrue(neededNow);

        keeper.performUpkeep(performData);
        assertEq(prizePool.drawCount(), 1);
    }

    function test_onlyAdminOrKeeperCanRunDraw() public {
        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(alice.addr);
        vm.expectRevert(bytes("PrizePool: not admin or keeper"));
        prizePool.runDraw();
    }
}
