// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from
    "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/// @title VaultShotToken (cUSD)
/// @notice Confidential wrapper around a plain ERC-20 (MockUSDC), built entirely on OpenZeppelin's
/// audited ERC7984ERC20Wrapper — this is the "wrap" boundary from the architecture discussion: a
/// generic, shared, non-VaultShot-specific contract. Anyone can wrap/unwrap through it for any
/// reason, which is exactly what decorrelates "wrapped X" from "deposited X into VaultShot" (see
/// the root README's confidentiality discussion).
///
/// wrap(to, amount): plaintext amount, real ERC20 in, confidential cUSD out.
/// unwrap(from, to, amount): confidential cUSD in, a public-decryption round trip, then real
/// ERC20 out via finalizeUnwrap — the exit-side plaintext moment, same shape as the entry side.
contract VaultShotToken is ZamaEthereumConfig, ERC7984ERC20Wrapper {
    constructor(IERC20 underlying_)
        ERC7984("VaultShot Confidential USD", "cUSD", "https://vaultshot.example/token")
        ERC7984ERC20Wrapper(underlying_)
    {}
}
