// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice Interface every allowlisted breeding-participant collection
/// (other than HOODCHAN itself, fronted by BreedingController's synced
/// `hoodchanGenes` adapter mapping - see BreedingController's header
/// comment) must satisfy: standard ERC-721 ownership plus one extra getter
/// for the 5-slot gene array. HoodchanGirlfriends and HoodchanBabies (whose
/// old single-word getter name was renamed to `genesOf` for interface
/// parity) both already satisfy this with no special-casing, which is
/// exactly the point - a Baby must be usable as a matron OR sire from day
/// one, not just be born, so it has to speak the same shape as every other
/// allowlisted collection.
interface IBreedable is IERC721 {
    function genesOf(uint256 tokenId) external view returns (uint8[5] memory);
}
