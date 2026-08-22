// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HoodchanGirlfriends
/// @notice Dummy placeholder "mother" collection for the breeding system
/// (design spec: "~12 placeholder tokens ... clearly throwaway - swapped
/// for the real contract address once the official team deploys"). Every
/// consumer (BreedingController) takes this contract's address as a
/// constructor arg, never a hardcoded literal, specifically so that swap
/// is a config change, not a redeploy of the whole system.
///
/// Unlike HOODCHAN itself (an already-deployed, unowned-by-us collection
/// whose traits BreedingController can only learn about via off-chain
/// metadata sync - see BreedingController's `hoodchanGenes` mapping), we
/// control this collection outright, so its 5-slot gene array is stored
/// on-chain from the moment of mint. No metadata-sync trust point needed
/// for the mother's side of a breed.
contract HoodchanGirlfriends is ERC721, Ownable {
    uint256 public nextTokenId = 1;
    string private _baseTokenURI;

    /// @dev slotIndex order matches GeneticsLib/BreedingController's gene
    /// slot table: [Hat, Face, Body, Background, Accessory].
    mapping(uint256 => uint8[5]) private _genes;

    event Minted(uint256 indexed tokenId, address indexed to, uint8[5] genes);
    event BaseURIUpdated(string baseURI);

    constructor(address initialOwner) ERC721("Hoodchan Girlfriends", "HCGF") Ownable(initialOwner) {}

    /// @notice Owner-only mint with an explicit 5-slot genome supplied at
    /// mint time (per spec: "owner-mintable with a 5-slot genome supplied
    /// at mint"). No public mint - this is a fixed, curated placeholder
    /// set of ~12 tokens, not an open collection.
    function mint(address to, uint8[5] calldata geneValues) external onlyOwner returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _genes[tokenId] = geneValues;
        _safeMint(to, tokenId);
        emit Minted(tokenId, to, geneValues);
    }

    function genesOf(uint256 tokenId) external view returns (uint8[5] memory) {
        _requireOwned(tokenId);
        return _genes[tokenId];
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
        emit BaseURIUpdated(baseURI_);
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
