// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Read a token's sex tag when its collection is configured as
/// `BreedingController.CollectionSex.PerToken` (currently only
/// HoodchanBabies - a baby's sex is coin-flipped once at mint time
/// (`GeneticsLib.resolveBabyIsMale`) and stored alongside its genome so it
/// carries forward into any later breed where that baby participates as a
/// parent). HOODCHAN and Girlfriends don't implement this - their sex is
/// fixed per-collection (Male / Female respectively) at allowlist time, no
/// per-token storage needed.
interface IPerTokenSex {
    function sexOf(uint256 tokenId) external view returns (bool isMale);
}
