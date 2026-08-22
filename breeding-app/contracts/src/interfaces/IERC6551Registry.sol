// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface for the canonical ERC-6551 registry - the same
/// contract the tba-kit package's (github:Pixelpushin/tba-kit) `computeTbaAddress()` calls (selector
/// `246a0021`, confirmed against tba-kit's dist/index.js: `SELECTOR_ACCOUNT
/// = "246a0021"`). Only the read-only `account()` view is needed here;
/// BreedingController never calls `createAccount()` - it mints directly
/// into a token's TBA address regardless of whether that TBA has been
/// activated yet (see tba-kit's own header comment: "a counterfactual
/// address ... can still receive assets").
interface IERC6551Registry {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address);
}
