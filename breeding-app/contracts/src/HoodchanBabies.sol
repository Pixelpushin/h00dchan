// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HoodchanBabies
/// @notice Mint-on-breed-only offspring collection. "HoodchanBabies" (this
/// contract name) and its "HCBABY" symbol are the one allowed exception to
/// the no-child-coded-wording rule per the design spec - every other
/// on-chain string (metadata, events) must stay in the "freshly spawned
/// young" / breeding-age-at-mint register instead.
contract HoodchanBabies is ERC721, Ownable {
    uint256 public nextTokenId = 1;

    /// @dev The only address ever allowed to call `mint()`. Set once by
    /// the owner post-deploy (BreedingController needs this contract's
    /// address in ITS OWN constructor first - see script/Deploy.s.sol's
    /// deploy order - so the controller can't be wired in at construction
    /// time here without a chicken-and-egg dependency).
    address public breedingController;

    string private _baseTokenURI;
    mapping(uint256 => string) private _tokenURIOverride;

    /// @dev The 5 gene-slot values (Hat, Face, Body, Background,
    /// Accessory - GeneticsLib.GENE_SLOTS order) packed into a single
    /// uint40 (5 * uint8) rather than stored as 5 separate storage slots
    /// or as strings. Two reasons, not one:
    ///   1. Gas - one SSTORE per baby instead of five.
    ///   2. The slot-value -> human-readable-trait-name mapping is an
    ///      off-chain registry layer BY DESIGN (see BreedingController's
    ///      header comment on why HOODCHAN's own traits are off-chain) -
    ///      storing strings on-chain here would duplicate data this
    ///      contract has no way to keep in sync with that registry, for
    ///      zero benefit over storing the raw values and letting the
    ///      off-chain layer render them.
    mapping(uint256 => uint40) private _packedGenome;

    /// @dev The exact breeding seed used for this baby - re-derivable from
    /// (fatherTokenId, motherTokenId, breedNonce) via
    /// GeneticsLib.breedingSeed, but stored directly so on-chain/off-chain
    /// genome verification never has to trust an event log staying
    /// available.
    mapping(uint256 => uint256) public breedingSeedOf;

    event Minted(
        uint256 indexed tokenId,
        address indexed to,
        uint8[5] genome,
        uint256 seed,
        uint256 fatherTokenId,
        uint256 motherTokenId,
        uint256 breedNonce
    );
    event BreedingControllerUpdated(address indexed controller);
    event BaseURIUpdated(string baseURI);
    event TokenURIOverridden(uint256 indexed tokenId, string uri);

    error NotBreedingController();

    constructor(address initialOwner) ERC721("HoodchanBabies", "HCBABY") Ownable(initialOwner) {}

    modifier onlyBreedingController() {
        if (msg.sender != breedingController) revert NotBreedingController();
        _;
    }

    function setBreedingController(address controller) external onlyOwner {
        breedingController = controller;
        emit BreedingControllerUpdated(controller);
    }

    /// @notice Mint a new baby directly to `to` (BreedingController always
    /// passes the mother's computed TBA address here, never an EOA - see
    /// BreedingController.breed()). Callable only by the wired-up
    /// BreedingController; there is no public mint path.
    /// @dev Uses `_mint`, not `_safeMint`, deliberately (BreedingController's
    /// BUG 6 fix). `to` is always the mother's computed ERC-6551 TBA
    /// address, which has NO CODE until the tba-kit implementation
    /// (0x41C8f39463A868d3A88af00cd0fe7102F30E44eC) is actually deployed
    /// on Robinhood Chain - not yet true as of this writing (see
    /// BreedingController's constructor doc / script/Deploy.s.sol).
    /// `_safeMint` would behave identically to `_mint` today (its
    /// `onERC721Received` check is skipped for codeless recipients), but
    /// switching to `_mint` removes that behavior's dependency on the TBA
    /// implementation staying free of a hostile/reentrant `onERC721Received`
    /// forever - once that implementation IS deployed, `_safeMint` would
    /// start invoking it mid-mint, handing control away during
    /// BreedingController.revealBreed at exactly the moment its genome is
    /// being finalized. `_mint` never does this, closing that window
    /// permanently regardless of what the TBA implementation ends up doing.
    function mint(
        address to,
        uint8[5] calldata genome,
        uint256 seed,
        uint256 fatherTokenId,
        uint256 motherTokenId,
        uint256 breedNonce
    ) external onlyBreedingController returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _packedGenome[tokenId] = _pack(genome);
        breedingSeedOf[tokenId] = seed;
        _mint(to, tokenId);
        emit Minted(tokenId, to, genome, seed, fatherTokenId, motherTokenId, breedNonce);
    }

    function genomeOf(uint256 tokenId) external view returns (uint8[5] memory) {
        _requireOwned(tokenId);
        return _unpack(_packedGenome[tokenId]);
    }

    function _pack(uint8[5] calldata g) private pure returns (uint40 packed) {
        for (uint256 i = 0; i < 5; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            // i is bounded to [0,5) by the loop, so 8*i is always <= 32 -
            // well within uint40's range, never truncates.
            packed |= uint40(g[i]) << uint40(8 * i);
        }
    }

    function _unpack(uint40 packed) private pure returns (uint8[5] memory g) {
        for (uint256 i = 0; i < 5; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            // Same bound as _pack above; packed >> (8*i) with i in [0,5)
            // always leaves a value that fits in uint8 (the top byte of
            // the uint40).
            g[i] = uint8(packed >> uint40(8 * i));
        }
    }

    /// @notice Per-token tokenURI override, for pointing an individual
    /// baby at its generated-art JSON (lib/breedingImage.ts, per the
    /// design spec, uploads asynchronously after the mint tx - the URI
    /// isn't known at mint time) without needing every token to follow a
    /// single baseURI + tokenId naming convention.
    function setTokenURI(uint256 tokenId, string calldata uri) external onlyOwner {
        _requireOwned(tokenId);
        _tokenURIOverride[tokenId] = uri;
        emit TokenURIOverridden(tokenId, uri);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
        emit BaseURIUpdated(baseURI_);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory overrideURI = _tokenURIOverride[tokenId];
        if (bytes(overrideURI).length > 0) {
            return overrideURI;
        }
        return super.tokenURI(tokenId);
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
