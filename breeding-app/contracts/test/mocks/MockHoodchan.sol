// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Stand-in for the real, already-deployed HOODCHAN collection
/// (0x774Db2207D26570F5638028839c816702A40aBC2 on Robinhood Chain, per
/// lib/chain.ts) - tests only. The real HOODCHAN is never redeployed or
/// modified; BreedingController only ever needs plain IERC721.ownerOf from
/// it (see the contract-level DISCOVERY-DRIVEN DESIGN note on why it can't
/// read traits directly).
contract MockHoodchan is ERC721 {
    uint256 public nextTokenId = 1;

    constructor() ERC721("Mock HOODCHAN", "mHC") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
    }
}
