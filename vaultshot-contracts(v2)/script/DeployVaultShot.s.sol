// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {VaultShotToken} from "../src/VaultShotToken.sol";
import {VaultShotBalanceLedger} from "../src/VaultShotBalanceLedger.sol";
import {VaultShotVault} from "../src/VaultShotVault.sol";
import {VaultShotReserve} from "../src/VaultShotReserve.sol";
import {VaultShotPrizePool} from "../src/VaultShotPrizePool.sol";
import {VaultShotDrawKeeper} from "../src/VaultShotDrawKeeper.sol";

/// @notice Deploys MockUSDC, the shared VaultShotToken (cUSD) wrapper, one demo pool (5 minute
/// draw period), and its DrawKeeper. Also mints the admin some MockUSDC and wraps it into cUSD so
/// the admin has confidential balance ready to fund the Reserve with — but the actual
/// `reserve.fund()` call is NOT made here, since it needs a real encrypted input (externalEuint64
/// + proof) that only the Zama relayer SDK can produce off-chain. That step, and all
/// deposit/draw/withdraw testing, happens in client/src/vaultshot.ts against these addresses.
///
/// Run with:
///   forge script script/DeployVaultShot.s.sol --rpc-url <RPC> --account rahul --broadcast
contract DeployVaultShot is Script {
    uint256 constant DRAW_PERIOD = 5 minutes;
    uint64 constant TOTAL_PRIZE_PER_DRAW = 100 * 10 ** 6; // 100 cUSD per draw
    uint256 constant ADMIN_WRAP_AMOUNT = 5_000 * 10 ** 6; // plaintext USDC minted + wrapped for admin

    function run() external {
        vm.startBroadcast();

        MockUSDC token = new MockUSDC();
        console.log("MockUSDC:", address(token));

        // NOTE: reading msg.sender directly in run()'s own call frame would return Foundry's
        // internal script-harness address, not the broadcasting wallet — vm.startBroadcast() only
        // rewrites the sender seen by *nested* calls/creations from this point on, not a plain
        // variable read in the frame that's already executing. MockUSDC's constructor reads
        // msg.sender from inside its own (nested, broadcasted) CREATE, so its resolved owner is
        // the real deployer — reuse that instead of re-deriving admin independently.
        address admin = token.owner();

        VaultShotToken cusd = new VaultShotToken(token);
        console.log("VaultShotToken (cUSD):", address(cusd));

        VaultShotBalanceLedger ledger = new VaultShotBalanceLedger(admin);
        VaultShotVault vault = new VaultShotVault(admin, cusd, ledger);
        VaultShotReserve reserve = new VaultShotReserve(admin, cusd);
        VaultShotPrizePool prizePool =
            new VaultShotPrizePool(admin, ledger, reserve, vault, DRAW_PERIOD, TOTAL_PRIZE_PER_DRAW);

        ledger.setAuthorizedContracts(address(vault), address(prizePool));
        reserve.setPrizePool(address(prizePool));
        vault.setPrizePool(address(prizePool));

        VaultShotDrawKeeper keeper = new VaultShotDrawKeeper(admin);
        VaultShotPrizePool[] memory pools = new VaultShotPrizePool[](1);
        pools[0] = prizePool;
        keeper.setPools(pools);
        prizePool.setKeeper(address(keeper));

        console.log("--- Demo Pool (5 min) ---");
        console.log("  Ledger:   ", address(ledger));
        console.log("  Vault:    ", address(vault));
        console.log("  Reserve:  ", address(reserve));
        console.log("  PrizePool:", address(prizePool));
        console.log("DrawKeeper:", address(keeper));

        // Mint the admin plaintext USDC and wrap it into confidential cUSD, ready for the TS
        // script to call reserve.fund() with a real encrypted input.
        token.adminMint(admin, ADMIN_WRAP_AMOUNT);
        token.approve(address(cusd), ADMIN_WRAP_AMOUNT);
        cusd.wrap(admin, ADMIN_WRAP_AMOUNT);
        console.log("Admin wrapped into cUSD:", ADMIN_WRAP_AMOUNT);

        vm.stopBroadcast();
    }
}
