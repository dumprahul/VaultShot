// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FoggyPotBalanceLedger} from "../src/FoggyPotBalanceLedger.sol";
import {FoggyPotVault} from "../src/FoggyPotVault.sol";
import {FoggyPotReserve} from "../src/FoggyPotReserve.sol";
import {FoggyPotPrizePool} from "../src/FoggyPotPrizePool.sol";

/// @notice Minimal single-pool deploy for quickly testing a single contract change (e.g.
/// seeConfidentialBalance) without the gas cost of the full 3-pool + DrawKeeper deploy. Reuses
/// the already-deployed MockUSDC via EXISTING_TOKEN env var instead of deploying a new one.
///   EXISTING_TOKEN=0x... forge script script/DeployTestPool.s.sol --rpc-url <RPC> --account rahul --broadcast
contract DeployTestPool is Script {
    uint64 constant TOTAL_PRIZE_PER_DRAW = 100 * 10 ** 6;
    uint64 constant RESERVE_SEED_FUNDING = 100 * 10 ** 6;

    function run() external {
        MockUSDC token = MockUSDC(vm.envAddress("EXISTING_TOKEN"));

        vm.startBroadcast();
        address admin = msg.sender;

        FoggyPotBalanceLedger ledger = new FoggyPotBalanceLedger(admin);
        FoggyPotVault vault = new FoggyPotVault(admin, token, ledger);
        FoggyPotReserve reserve = new FoggyPotReserve(admin, token);
        FoggyPotPrizePool prizePool =
            new FoggyPotPrizePool(admin, ledger, reserve, vault, 5 minutes, TOTAL_PRIZE_PER_DRAW);

        ledger.setAuthorizedContracts(address(vault), address(prizePool));
        reserve.setPrizePool(address(prizePool));
        vault.setPrizePool(address(prizePool));

        token.adminMint(admin, RESERVE_SEED_FUNDING);
        token.approve(address(reserve), RESERVE_SEED_FUNDING);
        reserve.fund(RESERVE_SEED_FUNDING);

        console.log("Ledger:   ", address(ledger));
        console.log("Vault:    ", address(vault));
        console.log("Reserve:  ", address(reserve));
        console.log("PrizePool:", address(prizePool));

        vm.stopBroadcast();
    }
}
