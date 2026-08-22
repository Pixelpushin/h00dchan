// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IBreedLike {
    function breed(
        address matronCollection,
        uint256 matronId,
        address sireCollection,
        uint256 sireId,
        uint256 maxSiringFee
    ) external returns (uint256);
}

/// @dev Test-only hostile contract exercising BreedingController's
/// reentrancy surface per the design spec's Hygiene section ("nonReentrant
/// on breed() generally; write cooldown state before any external call
/// wherever practical"). Two distinct roles, both configurable on the same
/// contract instance so a single mock covers the full surface named in the
/// task brief:
///
///   1. As an ALLOWLISTED COLLECTION (`ownerOf`/`getApproved`/
///      `isApprovedForAll`/`genesOf`) - BreedingController calls these
///      through the `view`-declared IERC721/IBreedable interfaces, so
///      Solidity emits a STATICCALL at every one of those call sites
///      regardless of what this contract actually does. A nested call back
///      into `breed()` (a state-changing function) therefore reverts at the
///      EVM level from the STATICCALL's own restriction, independent of
///      (and in addition to) BreedingController's own `nonReentrant` guard
///      - either mechanism is sufficient, this mock exercises both call
///      sites named in the task brief (`ownerOf`, `genesOf`).
///   2. As an ERC721 RECEIVER (`onERC721Received`) - `_safeMint`'s receiver
///      callback in HoodchanBabies.mint is a real CALL (not a STATICCALL),
///      reached while BreedingController's `nonReentrant` guard is still
///      held for the entire outer `breed()` call. This is the vector the
///      design spec calls out explicitly ("or onERC721Received if
///      _safeMint was chosen") - the malicious hook's nested `breed()` call
///      must revert with ReentrancyGuardReentrantCall, and that revert must
///      propagate all the way up through _safeMint -> mint() -> breed(),
///      failing the ENTIRE outer breed(), not just the reentrant attempt.
///
/// Deliberately NOT wrapped in try/catch on any hook: an unguarded direct
/// call means a successful reentrancy attempt would let the outer call
/// silently continue (masking the bug), whereas letting the nested revert
/// propagate is what actually proves the outer `breed()` call fails end to
/// end.
contract MaliciousReentrant is IERC721Receiver {
    address public controller;

    bool public reenterOnOwnerOf;
    bool public reenterOnGenesOf;
    bool public reenterOnReceive;

    address public reMatronCollection;
    uint256 public reMatronId;
    address public reSireCollection;
    uint256 public reSireId;

    mapping(uint256 => address) private _owners;
    mapping(uint256 => uint8[5]) private _genes;

    function setController(address controller_) external {
        controller = controller_;
    }

    function setReentryArgs(address matronCollection, uint256 matronId, address sireCollection, uint256 sireId)
        external
    {
        reMatronCollection = matronCollection;
        reMatronId = matronId;
        reSireCollection = sireCollection;
        reSireId = sireId;
    }

    function setReenterOnOwnerOf(bool v) external {
        reenterOnOwnerOf = v;
    }

    function setReenterOnGenesOf(bool v) external {
        reenterOnGenesOf = v;
    }

    function setReenterOnReceive(bool v) external {
        reenterOnReceive = v;
    }

    /// @dev Registers a fake token this mock "owns" so it can stand in as a
    /// matron/sire collection token (allowlisted separately by the test).
    function mintTo(address to, uint256 tokenId, uint8[5] calldata genes_) external {
        _owners[tokenId] = to;
        _genes[tokenId] = genes_;
    }

    // ---------------------------------------------------------------
    // IERC721-shaped surface (ownerOf/getApproved/isApprovedForAll) +
    // IBreedable's genesOf - matches what BreedingController actually calls
    // on an allowlisted collection.
    // ---------------------------------------------------------------

    /// @dev Deliberately NOT declared `view` (unlike IERC721.ownerOf) even
    /// though its own body never writes storage - it needs to be able to
    /// call `breed()` (state-changing) without a compile-time mutability
    /// error. This has zero effect on the actual protection being tested:
    /// BreedingController's call site is `IERC721(collection).ownerOf(...)`,
    /// and IERC721.ownerOf IS declared `view` there, so Solidity emits a
    /// STATICCALL at THAT call site regardless of this contract's own
    /// declared mutability - the STATICCALL's read-only restriction
    /// propagates to every nested call in this frame (including the nested
    /// `breed()` attempt below), which is the actual thing under test.
    function ownerOf(uint256 tokenId) external returns (address) {
        if (reenterOnOwnerOf) {
            IBreedLike(controller).breed(reMatronCollection, reMatronId, reSireCollection, reSireId, type(uint256).max);
        }
        return _owners[tokenId];
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    /// @dev Same non-`view` rationale as `ownerOf` above - BreedingController
    /// calls this through IBreedable.genesOf, which IS declared `view`
    /// there, so that call site still emits a STATICCALL regardless.
    function genesOf(uint256 tokenId) external returns (uint8[5] memory) {
        if (reenterOnGenesOf) {
            IBreedLike(controller).breed(reMatronCollection, reMatronId, reSireCollection, reSireId, type(uint256).max);
        }
        return _genes[tokenId];
    }

    // ---------------------------------------------------------------
    // IERC721Receiver - reached via HoodchanBabies._safeMint(matronOwner,
    // ...) when this contract IS the matron's owner. A real CALL, not a
    // STATICCALL - the vector the design spec calls out by name.
    // ---------------------------------------------------------------

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (reenterOnReceive) {
            IBreedLike(controller).breed(reMatronCollection, reMatronId, reSireCollection, reSireId, type(uint256).max);
        }
        return this.onERC721Received.selector;
    }
}
