// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC6551Registry} from "../../src/interfaces/IERC6551Registry.sol";

/// @dev Test-only stand-in for the real, already-deployed ERC-6551
/// registry (0x000000006551c19487814612e58FE06813775758, canonical on
/// every EVM chain per the tba-kit package). Doesn't replicate the real
/// registry's CREATE2 proxy-bytecode-hash formula - BreedingController
/// treats `account()` as an opaque deterministic-address oracle, so a
/// simpler deterministic mapping (hash of the same 5 inputs) is enough to
/// exercise BreedingController's own logic (mint destination, per-mother
/// nested cap) without needing to match mainnet bytecode exactly.
contract MockERC6551Registry is IERC6551Registry {
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        pure
        override
        returns (address)
    {
        return address(
            uint160(uint256(keccak256(abi.encode(implementation, salt, chainId, tokenContract, tokenId))))
        );
    }
}
