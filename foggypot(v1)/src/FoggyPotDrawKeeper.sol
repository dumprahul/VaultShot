// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FoggyPotPrizePool} from "./FoggyPotPrizePool.sol";

/// @notice Matches Chainlink's AutomationCompatibleInterface exactly (declared locally to avoid
/// pulling in the full chainlink-contracts dependency for one interface).
interface AutomationCompatibleInterface {
    function checkUpkeep(bytes calldata checkData) external returns (bool upkeepNeeded, bytes memory performData);
    function performUpkeep(bytes calldata performData) external;
}

/// @title FoggyPotDrawKeeper
/// @notice Chainlink Automation entry point shared across all FoggyPot pools. checkUpkeep()
/// loops the registered pool addresses and returns the first one whose draw window has elapsed;
/// performUpkeep() calls runDraw() on it. Registered as this contract's address at
/// automation.chain.link, funded with testnet LINK.
contract FoggyPotDrawKeeper is AutomationCompatibleInterface, Ownable {
    FoggyPotPrizePool[] public pools;

    event PoolsSet(uint256 count);
    event UpkeepPerformed(uint256 indexed poolIndex, address indexed pool);

    constructor(address admin) Ownable(admin) {}

    /// @notice One-time wiring of the pools this keeper watches. Admin-only.
    function setPools(FoggyPotPrizePool[] calldata pools_) external onlyOwner {
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

    function performUpkeep(bytes calldata performData) external override {
        uint256 poolIndex = abi.decode(performData, (uint256));
        require(poolIndex < pools.length, "DrawKeeper: bad index");

        FoggyPotPrizePool pool = pools[poolIndex];
        require(pool.isDrawDue(), "DrawKeeper: draw not due");

        pool.runDraw();
        emit UpkeepPerformed(poolIndex, address(pool));
    }

    function poolsCount() external view returns (uint256) {
        return pools.length;
    }
}
