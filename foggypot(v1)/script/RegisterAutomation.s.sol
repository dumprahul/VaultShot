// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";

interface LinkTokenInterface {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface AutomationRegistrarInterface {
    struct RegistrationParams {
        string name;
        bytes encryptedEmail;
        address upkeepContract;
        uint32 gasLimit;
        address adminAddress;
        uint8 triggerType;
        bytes checkData;
        bytes triggerConfig;
        bytes offchainConfig;
        uint96 amount;
    }

    function registerUpkeep(RegistrationParams calldata requestParams) external returns (uint256);
}

/// @notice Registers FoggyPotDrawKeeper as a Chainlink Automation "custom logic" upkeep on
/// Sepolia, funded with LINK. Run with:
///   forge script script/RegisterAutomation.s.sol --rpc-url <RPC> --account rahul --broadcast
/// Set DRAWKEEPER_ADDRESS and (optionally) LINK_FUNDING_AMOUNT via env vars first.
contract RegisterAutomation is Script {
    address constant LINK_SEPOLIA = 0x779877A7B0D9E8603169DdbD7836e478b4624789;
    address constant REGISTRAR_SEPOLIA = 0xb0E49c5D0d05cbc241d68c05BC5BA1d1B7B72976;

    function run() external {
        address drawKeeper = vm.envAddress("DRAWKEEPER_ADDRESS");
        uint96 amount = uint96(vm.envOr("LINK_FUNDING_AMOUNT", uint256(5e18))); // default 5 LINK

        vm.startBroadcast();
        address admin = msg.sender;

        LinkTokenInterface link = LinkTokenInterface(LINK_SEPOLIA);
        AutomationRegistrarInterface registrar = AutomationRegistrarInterface(REGISTRAR_SEPOLIA);

        console.log("LINK balance:", link.balanceOf(admin));
        link.approve(REGISTRAR_SEPOLIA, amount);

        AutomationRegistrarInterface.RegistrationParams memory params = AutomationRegistrarInterface
            .RegistrationParams({
            name: "FoggyPot DrawKeeper",
            encryptedEmail: "",
            upkeepContract: drawKeeper,
            gasLimit: 5_000_000,
            adminAddress: admin,
            triggerType: 0, // custom logic (checkUpkeep/performUpkeep)
            checkData: "",
            triggerConfig: "",
            offchainConfig: "",
            amount: amount
        });

        uint256 upkeepId = registrar.registerUpkeep(params);

        if (upkeepId != 0) {
            console.log("Upkeep registered! ID:", upkeepId);
        } else {
            console.log("Registration submitted but auto-approve is off (ID=0).");
            console.log("Finish approving it manually at https://automation.chain.link");
        }

        vm.stopBroadcast();
    }
}
