// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {euint64, externalEuint64} from "encrypted-types/EncryptedTypes.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {VaultShotToken} from "../src/VaultShotToken.sol";
import {VaultShotBalanceLedger} from "../src/VaultShotBalanceLedger.sol";
import {VaultShotVault} from "../src/VaultShotVault.sol";
import {VaultShotReserve} from "../src/VaultShotReserve.sol";
import {VaultShotPrizePool} from "../src/VaultShotPrizePool.sol";
import {VaultShotDrawKeeper} from "../src/VaultShotDrawKeeper.sol";

contract VaultShotTest is FhevmTest {
    uint256 constant DRAW_PERIOD = 5 minutes;
    uint64 constant TOTAL_PRIZE_PER_DRAW = 100 * 10 ** 6;
    uint64 constant RESERVE_FUNDING = 1_000 * 10 ** 6;
    uint48 constant OPERATOR_UNTIL = type(uint48).max;

    MockUSDC usdc;
    VaultShotToken cusd;
    VaultShotBalanceLedger ledger;
    VaultShotVault vault;
    VaultShotReserve reserve;
    VaultShotPrizePool prizePool;
    VaultShotDrawKeeper keeper;

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
        usdc = new MockUSDC();
        cusd = new VaultShotToken(usdc);
        ledger = new VaultShotBalanceLedger(admin.addr);
        vault = new VaultShotVault(admin.addr, cusd, ledger);
        reserve = new VaultShotReserve(admin.addr, cusd);
        prizePool = new VaultShotPrizePool(admin.addr, ledger, reserve, vault, DRAW_PERIOD, TOTAL_PRIZE_PER_DRAW);

        ledger.setAuthorizedContracts(address(vault), address(prizePool));
        reserve.setPrizePool(address(prizePool));
        vault.setPrizePool(address(prizePool));

        keeper = new VaultShotDrawKeeper(admin.addr);
        VaultShotPrizePool[] memory pools = new VaultShotPrizePool[](1);
        pools[0] = prizePool;
        keeper.setPools(pools);
        prizePool.setKeeper(address(keeper));

        // Fund and wrap the reserve's mock yield.
        usdc.adminMint(admin.addr, RESERVE_FUNDING);
        usdc.approve(address(cusd), RESERVE_FUNDING);
        cusd.wrap(admin.addr, RESERVE_FUNDING);
        cusd.setOperator(address(reserve), OPERATOR_UNTIL);
        (externalEuint64 fundHandle, bytes memory fundProof) = encryptUint64(RESERVE_FUNDING, admin.addr, address(reserve));
        reserve.fund(fundHandle, fundProof, RESERVE_FUNDING);
        vm.stopPrank();

        _fundWrapAndApprove(alice.addr, 1_000 * 10 ** 6);
        _fundWrapAndApprove(bob.addr, 1_000 * 10 ** 6);
        _fundWrapAndApprove(carol.addr, 1_000 * 10 ** 6);
    }

    function _fundWrapAndApprove(address user, uint256 amount) internal {
        vm.prank(admin.addr);
        usdc.adminMint(user, amount);

        vm.startPrank(user);
        usdc.approve(address(cusd), amount);
        cusd.wrap(user, amount);
        cusd.setOperator(address(vault), OPERATOR_UNTIL);
        vm.stopPrank();
    }

    function _deposit(Account memory user, uint64 amount) internal {
        (externalEuint64 handle, bytes memory proof) = encryptUint64(amount, user.addr, address(vault));
        vm.prank(user.addr);
        vault.deposit(handle, proof);
    }

    function _decryptLedgerBalance(Account memory user) internal returns (uint256) {
        bytes32 handle = euint64.unwrap(ledger.confidentialBalanceOf(user.addr));
        if (handle == bytes32(0)) return 0;
        bytes memory sig = signUserDecrypt(user.key, address(ledger));
        return userDecrypt(handle, user.addr, address(ledger), sig);
    }

    function _decryptTokenBalance(Account memory user) internal returns (uint256) {
        bytes32 handle = euint64.unwrap(cusd.confidentialBalanceOf(user.addr));
        if (handle == bytes32(0)) return 0;
        bytes memory sig = signUserDecrypt(user.key, address(cusd));
        return userDecrypt(handle, user.addr, address(cusd), sig);
    }

    /// @dev userDecrypt() is internal (inherited from FhevmTest), so calling it directly creates
    /// no external call frame for vm.expectRevert to intercept. This wrapper forces one.
    function _userDecryptExternal(bytes32 handle, address userAddress, address contractAddress, bytes memory sig)
        external
        returns (uint256)
    {
        return userDecrypt(handle, userAddress, contractAddress, sig);
    }

    // ---------------------------------------------------------------------
    // Wrap
    // ---------------------------------------------------------------------

    function test_wrapMintsConfidentialBalance() public {
        Account memory dave = makeAccount("dave");
        vm.prank(admin.addr);
        usdc.adminMint(dave.addr, 200 * 10 ** 6);

        vm.startPrank(dave.addr);
        usdc.approve(address(cusd), 200 * 10 ** 6);
        cusd.wrap(dave.addr, 200 * 10 ** 6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(cusd)), 200 * 10 ** 6 + RESERVE_FUNDING + 3_000 * 10 ** 6);

        bytes32 handle = euint64.unwrap(cusd.confidentialBalanceOf(dave.addr));
        bytes memory sig = signUserDecrypt(dave.key, address(cusd));
        assertEq(userDecrypt(handle, dave.addr, address(cusd), sig), 200 * 10 ** 6);
    }

    // ---------------------------------------------------------------------
    // Deposit
    // ---------------------------------------------------------------------

    function test_depositCreditsEncryptedBalance() public {
        _deposit(alice, 100 * 10 ** 6);

        assertEq(_decryptLedgerBalance(alice), 100 * 10 ** 6);
        assertEq(ledger.depositorsCount(), 1);
        assertEq(_decryptTokenBalance(alice), 900 * 10 ** 6);
    }

    /// @dev All four Ledger balance aliases must return the exact same handle.
    function test_allBalanceAliasesReturnSameHandle() public {
        _deposit(alice, 100 * 10 ** 6);

        bytes32 h1 = euint64.unwrap(ledger.confidentialBalanceOf(alice.addr));
        bytes32 h2 = euint64.unwrap(ledger.seeConfidentialBalance(alice.addr));
        bytes32 h3 = euint64.unwrap(ledger.getEncryptedBalance(alice.addr));
        bytes32 h4 = euint64.unwrap(ledger.balanceOfEncrypted(alice.addr));
        assertEq(h1, h2);
        assertEq(h1, h3);
        assertEq(h1, h4);

        bytes memory sig = signUserDecrypt(alice.key, address(ledger));
        assertEq(userDecrypt(h4, alice.addr, address(ledger), sig), 100 * 10 ** 6);
    }

    function test_batchEncryptedBalancesReader() public {
        _deposit(alice, 100 * 10 ** 6);
        _deposit(bob, 50 * 10 ** 6);

        address[] memory accounts = new address[](2);
        accounts[0] = alice.addr;
        accounts[1] = bob.addr;
        euint64[] memory balances = ledger.getEncryptedBalances(accounts);

        bytes memory aliceSig = signUserDecrypt(alice.key, address(ledger));
        bytes memory bobSig = signUserDecrypt(bob.key, address(ledger));
        assertEq(userDecrypt(euint64.unwrap(balances[0]), alice.addr, address(ledger), aliceSig), 100 * 10 ** 6);
        assertEq(userDecrypt(euint64.unwrap(balances[1]), bob.addr, address(ledger), bobSig), 50 * 10 ** 6);
    }

    function test_multipleDepositsAccumulate() public {
        _deposit(alice, 100 * 10 ** 6);
        _deposit(alice, 50 * 10 ** 6);

        assertEq(_decryptLedgerBalance(alice), 150 * 10 ** 6);
        assertEq(ledger.depositorsCount(), 1);
    }

    function test_depositRevertsWithoutOperatorApproval() public {
        address dave = makeAddr("dave");
        vm.prank(admin.addr);
        usdc.adminMint(dave, 100 * 10 ** 6);
        vm.startPrank(dave);
        usdc.approve(address(cusd), 100 * 10 ** 6);
        cusd.wrap(dave, 100 * 10 ** 6);
        vm.stopPrank();
        // dave never set the vault as an operator.

        (externalEuint64 handle, bytes memory proof) = encryptUint64(100 * 10 ** 6, dave, address(vault));
        vm.expectRevert(
            abi.encodeWithSignature("ERC7984UnauthorizedSpender(address,address)", dave, address(vault))
        );
        vm.prank(dave);
        vault.deposit(handle, proof);
    }

    // ---------------------------------------------------------------------
    // Withdraw (single transaction, at any time)
    // ---------------------------------------------------------------------

    function test_withdrawReturnsFullBalanceInOneTransaction() public {
        _deposit(alice, 100 * 10 ** 6);

        uint256 tokenBalanceBefore = _decryptTokenBalance(alice);

        vm.prank(alice.addr);
        vault.withdraw();

        assertEq(_decryptLedgerBalance(alice), 0);
        assertEq(_decryptTokenBalance(alice), tokenBalanceBefore + 100 * 10 ** 6);
    }

    function test_withdrawBeforeDrawReturnsExactPrincipal() public {
        _deposit(alice, 300 * 10 ** 6);
        // No draw has run — withdrawing now must return exactly principal, no more, no less.

        vm.prank(alice.addr);
        vault.withdraw();

        assertEq(_decryptTokenBalance(alice), 1_000 * 10 ** 6);
    }

    /// @dev A user who never deposited has an uninitialized (never-computed) FHE handle for their
    /// balance — there's no meaningful "zero ciphertext" to transfer, so this reverts rather than
    /// silently no-op'ing. Degenerate case, not a normal user path.
    function test_withdrawWithZeroBalanceReverts() public {
        vm.prank(alice.addr);
        vm.expectRevert();
        vault.withdraw();
    }

    // ---------------------------------------------------------------------
    // Draw (two-phase: requestDraw -> off-chain publicDecrypt -> finalizeDraw)
    // ---------------------------------------------------------------------

    function test_requestDrawRevertsBeforeWindowElapses() public {
        _deposit(alice, 100 * 10 ** 6);
        vm.prank(admin.addr);
        vm.expectRevert(bytes("PrizePool: too early"));
        prizePool.requestDraw();
    }

    function test_finalizeDrawRevertsWithoutPendingRequest() public {
        vm.prank(admin.addr);
        vm.expectRevert(bytes("PrizePool: no draw pending"));
        prizePool.finalizeDraw(abi.encode(uint256(0)), bytes(""));
    }

    function test_fullDrawSkipsWithNoDepositors() public {
        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        bytes32 handle = prizePool.requestDraw();

        bytes memory abiEncodedTotal = abi.encode(uint256(0));
        bytes memory proof = buildDecryptionProof(handle, abiEncodedTotal);

        vm.prank(admin.addr);
        prizePool.finalizeDraw(abiEncodedTotal, proof);

        assertEq(prizePool.drawCount(), 1);
        assertEq(uint256(prizePool.stage()), 0); // back to Idle
    }

    function test_fullDrawDistributesPrizesConfidentially() public {
        _deposit(alice, 300 * 10 ** 6);
        _deposit(bob, 200 * 10 ** 6);
        _deposit(carol, 100 * 10 ** 6);

        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        bytes32 handle = prizePool.requestDraw();
        assertEq(uint256(prizePool.stage()), 1); // TotalRequested

        uint256 expectedTotal = 600 * 10 ** 6;
        bytes memory abiEncodedTotal = abi.encode(expectedTotal);
        bytes memory proof = buildDecryptionProof(handle, abiEncodedTotal);

        vm.prank(admin.addr);
        prizePool.finalizeDraw(abiEncodedTotal, proof);

        assertEq(uint256(prizePool.stage()), 0);
        assertEq(prizePool.drawCount(), 1);

        uint256 aliceBal = _decryptLedgerBalance(alice);
        uint256 bobBal = _decryptLedgerBalance(bob);
        uint256 carolBal = _decryptLedgerBalance(carol);
        uint256 totalCredited = aliceBal + bobBal + carolBal;
        uint256 totalWon = totalCredited - expectedTotal;

        assertGe(totalWon, prizePool.grandPrizeAmount());
        assertLe(totalWon, TOTAL_PRIZE_PER_DRAW);

        // Reserve's plaintext accounting budget must have decreased by the exact prize total.
        uint256 prizeBudget =
            uint256(prizePool.grandPrizeAmount()) + uint256(prizePool.minorPrizeAmount()) * 3;
        assertEq(reserve.availableBudget(), RESERVE_FUNDING - prizeBudget);
    }

    function test_cannotRequestDrawWhileOneIsPending() public {
        _deposit(alice, 100 * 10 ** 6);
        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        prizePool.requestDraw();

        vm.prank(admin.addr);
        vm.expectRevert(bytes("PrizePool: draw already in progress"));
        prizePool.requestDraw();
    }

    function test_soloDepositorCanWithdrawDepositPlusPrizesAfterDraw() public {
        _deposit(alice, 300 * 10 ** 6);

        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        bytes32 handle = prizePool.requestDraw();

        bytes memory abiEncodedTotal = abi.encode(uint256(300 * 10 ** 6));
        bytes memory proof = buildDecryptionProof(handle, abiEncodedTotal);
        vm.prank(admin.addr);
        prizePool.finalizeDraw(abiEncodedTotal, proof);

        uint256 expectedBalance = 300 * 10 ** 6 + prizePool.grandPrizeAmount() + prizePool.minorPrizeAmount();
        assertEq(_decryptLedgerBalance(alice), expectedBalance);

        uint256 tokenBalanceBefore = _decryptTokenBalance(alice);
        vm.prank(alice.addr);
        vault.withdraw();

        assertEq(_decryptTokenBalance(alice), tokenBalanceBefore + expectedBalance);
    }

    function test_reserveUnderfundedSkipsDraw() public {
        // Drain the reserve's plaintext budget accounting via repeated draws until it can't cover
        // one more, forcing the underfunded branch. Simpler: deploy a fresh, unfunded pool.
        vm.startPrank(admin.addr);
        VaultShotReserve poorReserve = new VaultShotReserve(admin.addr, cusd);
        VaultShotBalanceLedger poorLedger = new VaultShotBalanceLedger(admin.addr);
        VaultShotVault poorVault = new VaultShotVault(admin.addr, cusd, poorLedger);
        VaultShotPrizePool poorPool =
            new VaultShotPrizePool(admin.addr, poorLedger, poorReserve, poorVault, DRAW_PERIOD, TOTAL_PRIZE_PER_DRAW);
        poorLedger.setAuthorizedContracts(address(poorVault), address(poorPool));
        poorReserve.setPrizePool(address(poorPool));
        poorVault.setPrizePool(address(poorPool));
        vm.stopPrank();

        vm.prank(alice.addr);
        cusd.setOperator(address(poorVault), OPERATOR_UNTIL);
        (externalEuint64 handle, bytes memory proof) = encryptUint64(100 * 10 ** 6, alice.addr, address(poorVault));
        vm.prank(alice.addr);
        poorVault.deposit(handle, proof);

        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(admin.addr);
        bytes32 totalHandle = poorPool.requestDraw();

        bytes memory abiEncodedTotal = abi.encode(uint256(100 * 10 ** 6));
        bytes memory decProof = buildDecryptionProof(totalHandle, abiEncodedTotal);
        vm.prank(admin.addr);
        poorPool.finalizeDraw(abiEncodedTotal, decProof);

        assertEq(poorPool.drawCount(), 1);
        // Reserve was never funded, so the draw must skip without crediting any prize.
        bytes32 balanceHandle = euint64.unwrap(poorLedger.confidentialBalanceOf(alice.addr));
        bytes memory balanceSig = signUserDecrypt(alice.key, address(poorLedger));
        assertEq(userDecrypt(balanceHandle, alice.addr, address(poorLedger), balanceSig), 100 * 10 ** 6);
        assertEq(poorReserve.availableBudget(), 0);
    }

    // ---------------------------------------------------------------------
    // Reserve
    // ---------------------------------------------------------------------

    /// @dev getEncryptedBalance() is a pure passthrough — same handle as the token's own view,
    /// with no separate mirror to drift out of sync (contrast FoggyPot's real+mirror duality).
    function test_reserveGetEncryptedBalanceMatchesTokenBalance() public {
        bytes32 viaReserve = euint64.unwrap(reserve.getEncryptedBalance());
        bytes32 viaToken = euint64.unwrap(cusd.confidentialBalanceOf(address(reserve)));
        assertEq(viaReserve, viaToken);
    }

    function test_onlyPrizePoolCanReleaseFromReserve() public {
        vm.prank(alice.addr);
        vm.expectRevert(bytes("Reserve: not prize pool"));
        reserve.releaseTo(alice.addr, 10 * 10 ** 6);
    }

    // ---------------------------------------------------------------------
    // Access control
    // ---------------------------------------------------------------------

    function test_onlyAdminOrKeeperCanRequestDraw() public {
        vm.warp(block.timestamp + DRAW_PERIOD);
        vm.prank(alice.addr);
        vm.expectRevert(bytes("PrizePool: not admin or keeper"));
        prizePool.requestDraw();
    }

    function test_onlyPrizePoolCanMarkTotalForDraw() public {
        vm.prank(alice.addr);
        vm.expectRevert(bytes("Vault: not prize pool"));
        vault.markTotalForDraw();
    }

    function test_onlyAccountOwnerCanDecryptTheirBalance() public {
        _deposit(alice, 100 * 10 ** 6);

        bytes32 aliceHandle = euint64.unwrap(ledger.confidentialBalanceOf(alice.addr));
        bytes memory bobSignature = signUserDecrypt(bob.key, address(ledger));

        vm.expectRevert(
            abi.encodeWithSignature("UserNotAuthorizedForDecrypt(bytes32,address)", aliceHandle, bob.addr)
        );
        this._userDecryptExternal(aliceHandle, bob.addr, address(ledger), bobSignature);
    }

    // ---------------------------------------------------------------------
    // Chainlink Automation keeper (phase 1 only)
    // ---------------------------------------------------------------------

    function test_keeperCheckAndPerformUpkeepTriggersRequestDrawOnly() public {
        _deposit(alice, 100 * 10 ** 6);

        (bool needed,) = keeper.checkUpkeep("");
        assertFalse(needed);

        vm.warp(block.timestamp + DRAW_PERIOD);
        (bool neededNow, bytes memory performData) = keeper.checkUpkeep("");
        assertTrue(neededNow);

        keeper.performUpkeep(performData);
        assertEq(uint256(prizePool.stage()), 1); // TotalRequested — phase 2 is not the keeper's job
    }
}
