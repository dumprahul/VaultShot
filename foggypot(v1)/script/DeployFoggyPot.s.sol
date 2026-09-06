// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FoggyPotBalanceLedger} from "../src/FoggyPotBalanceLedger.sol";
import {FoggyPotVault} from "../src/FoggyPotVault.sol";
import {FoggyPotReserve} from "../src/FoggyPotReserve.sol";
import {FoggyPotPrizePool} from "../src/FoggyPotPrizePool.sol";
import {FoggyPotDrawKeeper} from "../src/FoggyPotDrawKeeper.sol";

/// @notice Deploys one MockUSDC, three identical FoggyPot pool stacks (5 min / 24 hr / 30 day
/// draw periods), and one shared DrawKeeper wired to all three. Run with:
///   forge script script/DeployFoggyPot.s.sol --rpc-url <RPC> --account rahul --broadcast
contract DeployFoggyPot is Script {
    uint64 constant TOTAL_PRIZE_PER_DRAW = 100 * 10 ** 6; // 100 mUSDC per draw, all pools
    uint64 constant RESERVE_SEED_FUNDING = 1_000 * 10 ** 6; // 1,000 mUSDC seeded into each Reserve

    struct PoolAddrs {
        FoggyPotBalanceLedger ledger;
        FoggyPotVault vault;
        FoggyPotReserve reserve;
        FoggyPotPrizePool prizePool;
    }

    function run() external {
        vm.startBroadcast();
        address admin = msg.sender;

        MockUSDC token = new MockUSDC();
        console.log("MockUSDC:", address(token));

        PoolAddrs memory demoPool = _deployPool(admin, token, 5 minutes, "Demo (5 min)");
        PoolAddrs memory standardPool = _deployPool(admin, token, 24 hours, "Standard (24 hr)");
        PoolAddrs memory longPool = _deployPool(admin, token, 30 days, "Long-horizon (30 day)");

        FoggyPotDrawKeeper keeper = new FoggyPotDrawKeeper(admin);
        FoggyPotPrizePool[] memory pools = new FoggyPotPrizePool[](3);
        pools[0] = demoPool.prizePool;
        pools[1] = standardPool.prizePool;
        pools[2] = longPool.prizePool;
        keeper.setPools(pools);

        demoPool.prizePool.setKeeper(address(keeper));
        standardPool.prizePool.setKeeper(address(keeper));
        longPool.prizePool.setKeeper(address(keeper));

        console.log("DrawKeeper:", address(keeper));

        // Mint the admin some tokens and seed each pool's reserve so draws have a prize to pay.
        token.adminMint(admin, RESERVE_SEED_FUNDING * 3);
        _seedReserve(token, demoPool.reserve);
        _seedReserve(token, standardPool.reserve);
        _seedReserve(token, longPool.reserve);

        vm.stopBroadcast();
    }

    function _deployPool(address admin, MockUSDC token, uint256 drawPeriod, string memory label)
        internal
        returns (PoolAddrs memory p)
    {
        p.ledger = new FoggyPotBalanceLedger(admin);
        p.vault = new FoggyPotVault(admin, token, p.ledger);
        p.reserve = new FoggyPotReserve(admin, token);
        p.prizePool = new FoggyPotPrizePool(admin, p.ledger, p.reserve, p.vault, drawPeriod, TOTAL_PRIZE_PER_DRAW);

        p.ledger.setAuthorizedContracts(address(p.vault), address(p.prizePool));
        p.reserve.setPrizePool(address(p.prizePool));
        p.vault.setPrizePool(address(p.prizePool));

        console.log(string.concat("--- ", label, " ---"));
        console.log("  Ledger:   ", address(p.ledger));
        console.log("  Vault:    ", address(p.vault));
        console.log("  Reserve:  ", address(p.reserve));
        console.log("  PrizePool:", address(p.prizePool));
    }

    function _seedReserve(MockUSDC token, FoggyPotReserve reserve) internal {
        token.approve(address(reserve), RESERVE_SEED_FUNDING);
        reserve.fund(RESERVE_SEED_FUNDING);
    }
}
