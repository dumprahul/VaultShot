// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {VaultShotPrizePool} from "./VaultShotPrizePool.sol";

/// @notice Matches Chainlink's AutomationCompatibleInterface exactly (declared locally, same as
/// FoggyPot's keeper, to avoid pulling in the full chainlink-contracts dependency).
interface AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata checkData) external returns (bool upkeepNeeded, bytes memory performData);
    function performUpkeep(bytes calldata performData) external;
}

/// @title VaultShotDrawKeeper
/// @notice Chainlink Automation entry point shared across all VaultShot pools. checkUpkeep()
/// finds whichever pool's draw window has elapsed; performUpkeep() calls that pool's
/// requestDraw() — phase 1 only.
///
/// Honest limitation: checkUpkeep/performUpkeep is a single-shot "is something due, then do it"
/// model. It doesn't fit phase 2 (finalizeDraw), which needs an off-chain publicDecrypt() round
/// trip in between requesting and finalizing — there's no way for this contract to "detect" that
/// the off-chain decryption has completed, only an external agent driving both steps can do that.
/// So this contract (and Chainlink Automation, when/if it's actually servicing testnets again)
/// only ever triggers phase 1. client/src/keeper-bot.ts drives the full request -> decrypt ->
/// finalize sequence directly against PrizePool, and is what actually keeps draws completing.
contract VaultShotDrawKeeper is AutomationCompatibleInterface, Ownable {
    VaultShotPrizePool[] public pools;

    event PoolsSet(uint256 count);
    event UpkeepPerformed(uint256 indexed poolIndex, address indexed pool);

    constructor(address admin) Ownable(admin) {}

    /// @notice One-time wiring of the pools this keeper watches. Admin-only.
    function setPools(VaultShotPrizePool[] calldata pools_) external onlyOwner {
        require(pools.length == 0, "DrawKeeper: pools already set");
        require(pools_.length > 0, "DrawKeeper: empty pools");
        for (uint256 i = 0; i < pools_.length; i++) {
            pools.push(pools_[i]);
        }
        emit PoolsSet(pools_.length);
    }

    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory performData) {
        for (uint256 i = 0; i < pools.length; i++) {
            if (pools[i].isDrawDue()) {
                return (true, abi.encode(i));
            }
        }
        return (false, bytes(""));
    }

    /// @notice Triggers phase 1 (requestDraw) only — see NatSpec above for why phase 2 can't live
    /// in this interface.
    function performUpkeep(bytes calldata performData) external override {
        uint256 poolIndex = abi.decode(performData, (uint256));
        require(poolIndex < pools.length, "DrawKeeper: bad index");

        VaultShotPrizePool pool = pools[poolIndex];
        require(pool.isDrawDue(), "DrawKeeper: draw not due");

        pool.requestDraw();
        emit UpkeepPerformed(poolIndex, address(pool));
    }

    function poolsCount() external view returns (uint256) {
        return pools.length;
    }
}
