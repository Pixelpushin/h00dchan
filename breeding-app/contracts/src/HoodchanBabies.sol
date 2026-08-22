// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HoodchanBabies
/// @notice Mint-on-breed-only offspring collection. "HoodchanBabies" (this
/// contract name) and its "HCBABY" symbol are the one allowed exception to
/// the no-child-coded-wording rule per the design spec - every other
/// on-chain string (metadata, events) must stay in the "freshly spawned
/// young" / breeding-age-at-mint register instead. Babies are immediately
/// breedable themselves (matron OR sire, day one) - see `genesOf` below,
/// which is what makes that possible with no special-casing in
/// BreedingController.
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
    /// (matronCollection, matronId, sireCollection, sireId, breedNonce) via
    /// GeneticsLib.breedingSeed, but stored directly so on-chain/off-chain
    /// genome verification never has to trust an event log staying
    /// available.
    mapping(uint256 => uint256) public breedingSeedOf;

    /// @dev Sex tag, coin-flipped once at mint (GeneticsLib.resolveBabyIsMale)
    /// and fixed forever after - read live by BreedingController via
    /// `sexOf` (IPerTokenSex) whenever this baby later participates as a
    /// parent in its own right. true = Male, false = Female.
    mapping(uint256 => bool) private _isMale;

    /// @dev Cosmetic flex trait only - `matronSex == sireSex` at THIS
    /// baby's own mint time, i.e. whether it was produced from a same-sex
    /// ("test tube baby") pairing. Does not affect this baby's own
    /// coin-flip inheritance odds when it later breeds; purely a UI badge.
    mapping(uint256 => bool) public isTestTubeBaby;

    event Minted(
        uint256 indexed tokenId,
        address indexed to,
        uint8[5] genome,
        uint256 seed,
        bool isMale,
        bool isTestTubeBaby,
        address matronCollection,
        uint256 matronId,
        address sireCollection,
        uint256 sireId,
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
    /// passes the MATRON'S OWNER wallet here - a normal wallet, possibly a
    /// contract wallet, never a TBA - see BreedingController.breed()).
    /// Callable only by the wired-up BreedingController; there is no public
    /// mint path.
    /// @dev Uses `_safeMint`, not `_mint` - explicit decision (design spec's
    /// Hygiene section demands one, not an assumption). `to` is now an
    /// arbitrary caller-side wallet that could be a contract (e.g. a Safe),
    /// unlike the prior TBA-only design where `to` was always a
    /// known-codeless counterfactual address and `_mint` was chosen
    /// specifically to skip that check. That justification is void now:
    /// using `_mint` here would silently break every real contract-wallet
    /// holder that correctly implements `onERC721Received` (the mint would
    /// still succeed, but wallets/marketplaces that assume ERC-721
    /// safe-transfer semantics were followed could mishandle the token).
    /// `_safeMint`'s reentrancy surface is bounded by BreedingController's
    /// `nonReentrant` guard on `breed()`, which is already held for the
    /// entire call that reaches this mint - a reentrant call back into
    /// `breed()` (or any other `nonReentrant` controller function) from a
    /// hostile `onERC721Received` reverts immediately on the guard, and
    /// nothing in `breed()` runs AFTER this mint except emitting the `Bred`
    /// event, so there is no post-mint state for a reentrant call to
    /// corrupt even if it reached some non-guarded path.
    function mint(
        address to,
        uint8[5] calldata genome,
        uint256 seed,
        bool isMale_,
        bool isTestTubeBaby_,
        address matronCollection,
        uint256 matronId,
        address sireCollection,
        uint256 sireId,
        uint256 breedNonce
    ) external onlyBreedingController returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _packedGenome[tokenId] = _pack(genome);
        breedingSeedOf[tokenId] = seed;
        _isMale[tokenId] = isMale_;
        isTestTubeBaby[tokenId] = isTestTubeBaby_;
        _safeMint(to, tokenId);
        emit Minted(
            tokenId, to, genome, seed, isMale_, isTestTubeBaby_, matronCollection, matronId, sireCollection, sireId, breedNonce
        );
    }

    /// @notice Renamed from this contract's old single-word getter name -
    /// `genesOf` is the shared interface name every allowlisted collection
    /// speaks (see IBreedable), so a Baby needs zero special-casing to be
    /// used as a matron or sire in a later breed.
    function genesOf(uint256 tokenId) external view returns (uint8[5] memory) {
        _requireOwned(tokenId);
        return _unpack(_packedGenome[tokenId]);
    }

    /// @notice IPerTokenSex - BreedingController reads this live whenever a
    /// Baby participates as a parent, since (unlike HOODCHAN/Girlfriends)
    /// a Baby's sex isn't fixed per-collection.
    function sexOf(uint256 tokenId) external view returns (bool isMale) {
        _requireOwned(tokenId);
        return _isMale[tokenId];
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
