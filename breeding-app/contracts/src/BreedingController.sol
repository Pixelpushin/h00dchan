// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {GeneticsLib} from "./GeneticsLib.sol";
import {HoodchanBabies} from "./HoodchanBabies.sol";
import {IBreedable} from "./interfaces/IBreedable.sol";
import {IPerTokenSex} from "./interfaces/IPerTokenSex.sol";

/// @title BreedingController
/// @notice Orchestrates a CryptoKitties-style breeding loop across three
/// symmetric ERC-721 collections (HOODCHAN, HoodchanGirlfriends,
/// HoodchanBabies) - any allowlisted token from any allowlisted collection
/// can be the MATRON or the SIRE in a given `breed()` call, babies included
/// (third-generation-and-beyond breeding is in scope by construction).
/// This is a full rewrite against the v2 design spec
/// (docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md), which
/// SUPERSEDES an earlier two-step escrow-then-later-finalize seed-hiding
/// scheme + dual-currency + TBA-minting attempt in full. Deleted, not
/// reintroduced: that two-step escrow/lock/expiry machinery, the ETH
/// payment path, mint-into-TBA, and numeric-magnitude dominance genetics
/// (see GeneticsLib).
///
/// ============================================================
/// HOODCHAN ADAPTER (the one documented trust point that remains)
/// ============================================================
/// HOODCHAN is a real, already-deployed, already-owned-by-someone-else
/// collection (h00dchan's own lib/chain.ts: CONTRACT =
/// 0x774Db2207D26570F5638028839c816702A40aBC2, verified live on-chain as an
/// EIP-1167 clone answering `ownerOf`/`totalSupply`). This contract does
/// not own it and cannot read its 5-slot genes on-chain - HOODCHAN's
/// tokenURI resolves to an ipfs:// JSON document, not on-chain storage this
/// contract can eth_call into. So HOODCHAN's genes are synced in by an
/// off-chain operator script (`breeding-app/scripts/sync-genes.ts` +
/// `setHoodchanGenes`/`setHoodchanGenesBatch` below) instead of read live -
/// `hoodchanGenes` and `hoodchanGenesSet` are a documented trust point: a
/// stale or malicious sync would let a HOODCHAN parent breed with wrong
/// genes, and there is no on-chain way to catch that. `ownerOf` for
/// HOODCHAN, by contrast, IS read live (plain ERC-721, no adapter needed).
///
/// ============================================================
/// ACCEPTED TRADEOFF: predictable seed, single atomic transaction
/// ============================================================
/// `GeneticsLib.breedingSeed` is a pure function of public inputs only
/// (both parents' collection+id and a per-breed nonce) - a sophisticated
/// caller can simulate the outcome before sending the breed tx and choose
/// whether to send it ("breed-sniping"). This is EXPLICITLY ACCEPTED per
/// the design spec, not mitigated: "you get what you get." Do not
/// reintroduce blockhash anchoring, a two-step escrow-then-later-finalize
/// seed-hiding scheme, or VRF here - the escalating per-token cooldown
/// plus the unconditional birth fee are the spec's chosen mitigation
/// instead (re-rolling costs real CHAN and burns real cooldown time).
contract BreedingController is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    /// @dev Every allowlisted collection's sex is resolved one of three
    /// ways: fixed Male (HOODCHAN), fixed Female (Girlfriends), or
    /// PerToken (Babies - coin-flipped once at mint, read live via
    /// IPerTokenSex.sexOf). Set once per collection at allowlist time by
    /// the owner, not per-token, except for PerToken collections where the
    /// token itself is the source of truth.
    enum CollectionSex {
        Male,
        Female,
        PerToken
    }

    /// @dev A token's escalating-cooldown state, keyed by
    /// (collection, tokenId) - see `breedState` below. `breedCount` is also
    /// the index into the cooldown ladder for that token's NEXT breed.
    struct TokenBreedState {
        uint32 breedCount;
        uint64 cooldownEnd;
    }

    /// @dev Per-(collection,tokenId) siring terms, set/edited/delisted only
    /// by whoever owns that token AT CALL TIME (checked live via
    /// `ownerOf`, never cached). `listed == false` (the default) means the
    /// token cannot be borrowed as a sire by anyone except the token's own
    /// owner/approved operator - "price 0" must never silently mean
    /// "available for free by default", it must be explicitly listed at
    /// price 0.
    ///
    /// `lister` records WHO opted this token in, and `breed()` requires it
    /// to still equal the token's live `ownerOf`. Without that, a listing
    /// SURVIVES a transfer of the sire: the buyer of a token that its
    /// previous owner had listed (e.g. free, at price 0) would find their
    /// brand-new token publicly siring-available on terms they never
    /// agreed to, letting anyone permanently escalate its cooldown ladder
    /// for nothing. The design spec is explicit that a token is not
    /// available by default and that "its owner must explicitly list it" -
    /// a NEW owner has explicitly listed nothing, so the listing must go
    /// stale on transfer. Comparing against live `ownerOf` achieves that
    /// with no transfer hook on collections we do not control (HOODCHAN).
    struct SiringListing {
        uint128 price;
        bool listed;
        address lister;
    }

    // ---------------------------------------------------------------
    // Immutable wiring
    // ---------------------------------------------------------------

    /// @dev The real, live HOODCHAN collection address - the one collection
    /// whose genes are read through the `hoodchanGenes` adapter mapping
    /// instead of a live `genesOf` call (see the contract-level HOODCHAN
    /// ADAPTER note). Its `ownerOf` IS read live like any other allowlisted
    /// collection.
    address public immutable hoodchanAddress;

    HoodchanBabies public immutable babies;
    IERC20 public immutable chanToken;

    // ---------------------------------------------------------------
    // Mutable admin config
    // ---------------------------------------------------------------

    /// @dev Owner-only allowlist - the only mandatory gate on which
    /// collections' tokens can participate in `breed()` at all. A
    /// compromised single key adding a malicious contract here is a real
    /// risk (arbitrary `genesOf` return values feed directly into minted
    /// genomes) - kept behind the same `onlyOwner` pattern as the rest of
    /// this repo's admin actions, per the design spec's Hygiene
    /// requirements.
    mapping(address => bool) public isBreedableCollection;

    /// @dev Fixed per-collection sex tag (Male/Female), or PerToken to defer
    /// to the token itself (see `CollectionSex`). Only meaningful once the
    /// collection is also allowlisted.
    mapping(address => CollectionSex) public collectionSex;

    /// @dev CHAN recipients for the two fee flows. `treasury` receives the
    /// birth fee (funds per-baby art-gen cost); `burnAddress`/`multisig`
    /// split the 8% siring protocol fee 5%/3% (see `_collectSiringFee`).
    address public treasury;
    address public burnAddress;
    address public multisig;

    /// @dev Flat, owner-configurable birth fee charged on EVERY breed
    /// (self-siring included) - see `_collectBirthFee`. Exact amount is a
    /// config value per the design spec, not load-bearing to spec.
    uint256 public birthFee;

    /// @dev Flat multiplier applied to `birthFee` when `matronSex ==
    /// sireSex` ("test tube baby" pricing tier) - e.g. 2 means same-sex
    /// pairings pay 2x the normal birth fee. Owner-configurable, exact
    /// value not load-bearing to spec.
    uint256 public sameSexFeeMultiplier;

    // ---------------------------------------------------------------
    // Mutable breeding state
    // ---------------------------------------------------------------

    /// @dev Global, monotonically incrementing breed counter - the final
    /// input to GeneticsLib.breedingSeed, incremented once per `breed()`
    /// call. Starts at 0, so the first ever breed uses nonce = 0.
    uint256 public breedNonce;

    /// @dev Escalating-cooldown state, keyed by (collection, tokenId) - a
    /// COMPOSITE key, deliberately, so e.g. HOODCHAN #5 and Babies #5 never
    /// share cooldown state just because their tokenIds collide across
    /// different collections.
    mapping(address => mapping(uint256 => TokenBreedState)) public breedState;

    /// @dev Siring listings, same composite (collection, tokenId) keying as
    /// `breedState` and for the same reason.
    mapping(address => mapping(uint256 => SiringListing)) public siringListings;

    /// @dev Off-chain-synced copy of a HOODCHAN token's 5 gene-slot values
    /// (Hat, Face, Body, Background, Accessory). See the contract-level
    /// HOODCHAN ADAPTER note - this is a trust point, not a live read.
    mapping(uint256 => uint8[5]) public hoodchanGenes;
    /// @dev Separate from "all-zero genes" being a legitimate value - a
    /// HOODCHAN parent whose genes were never synced must revert breeding,
    /// not silently breed with all-0s.
    mapping(uint256 => bool) public hoodchanGenesSet;

    /// @dev One or more addresses (in addition to `owner()`) trusted to run
    /// the off-chain HOODCHAN gene-sync script and call `setHoodchanGenes`
    /// / `setHoodchanGenesBatch`. Kept separate from `owner()` so the sync
    /// bot's hot key never needs to be the same key that can retarget
    /// allowlist/fee config or receive ownership transfers.
    mapping(address => bool) public isOperator;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event BreedableCollectionSet(address indexed collection, bool allowed, CollectionSex sex);
    event TreasurySet(address indexed treasury);
    event BurnAddressSet(address indexed burnAddress);
    event MultisigSet(address indexed multisig);
    event BirthFeeSet(uint256 birthFee);
    event SameSexFeeMultiplierSet(uint256 multiplier);
    event OperatorSet(address indexed operator, bool allowed);
    event HoodchanGenesSet(uint256 indexed tokenId, uint8[5] genes);
    event SiringListed(address indexed collection, uint256 indexed tokenId, uint128 price);
    event SiringUnlisted(address indexed collection, uint256 indexed tokenId);
    event Bred(
        uint256 indexed babyTokenId,
        address matronCollection,
        uint256 matronId,
        address sireCollection,
        uint256 sireId,
        uint256 breedNonce_,
        uint256 seed,
        uint8[5] genome,
        bool babyIsMale,
        bool isTestTubeBaby
    );

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error ZeroAddress();
    error NotOperator();
    error CollectionNotAllowlisted();
    error NotTokenOwnerOrApproved();
    error NotTokenOwner();
    error SireNotAvailable();
    error MatronOnCooldown();
    error SireOnCooldown();
    error GenesNotSet();
    error SameToken();
    error SiringFeeTooHigh();
    error InvalidMultiplier();

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    modifier onlyOperator() {
        if (msg.sender != owner() && !isOperator[msg.sender]) revert NotOperator();
        _;
    }

    constructor(
        address initialOwner,
        address hoodchanAddress_,
        address babiesAddress,
        address chanTokenAddress,
        address treasury_,
        address burnAddress_,
        address multisig_,
        uint256 birthFee_,
        uint256 sameSexFeeMultiplier_
    ) Ownable(initialOwner) {
        if (
            hoodchanAddress_ == address(0) || babiesAddress == address(0) || chanTokenAddress == address(0)
                || treasury_ == address(0) || burnAddress_ == address(0) || multisig_ == address(0)
        ) revert ZeroAddress();
        // A multiplier below 1 would make the same-sex tier CHEAPER than
        // the normal tier - and a multiplier of 0 would make same-sex
        // breeding entirely free, contradicting the design spec's "flat
        // birth fee - charged on EVERY breed, no exceptions".
        if (sameSexFeeMultiplier_ < 1) revert InvalidMultiplier();

        hoodchanAddress = hoodchanAddress_;
        babies = HoodchanBabies(babiesAddress);
        chanToken = IERC20(chanTokenAddress);
        treasury = treasury_;
        burnAddress = burnAddress_;
        multisig = multisig_;
        birthFee = birthFee_;
        sameSexFeeMultiplier = sameSexFeeMultiplier_;
    }

    // ---------------------------------------------------------------
    // Admin: allowlist + fee config
    // ---------------------------------------------------------------

    /// @notice Add/remove a collection from the breedable allowlist and set
    /// its fixed sex tag (ignored if `sex == PerToken`, in which case the
    /// collection itself must implement IPerTokenSex - see `_sexOf`).
    function setBreedableCollection(address collection, bool allowed, CollectionSex sex) external onlyOwner {
        if (collection == address(0)) revert ZeroAddress();
        isBreedableCollection[collection] = allowed;
        collectionSex[collection] = sex;
        emit BreedableCollectionSet(collection, allowed, sex);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setBurnAddress(address burnAddress_) external onlyOwner {
        if (burnAddress_ == address(0)) revert ZeroAddress();
        burnAddress = burnAddress_;
        emit BurnAddressSet(burnAddress_);
    }

    function setMultisig(address multisig_) external onlyOwner {
        if (multisig_ == address(0)) revert ZeroAddress();
        multisig = multisig_;
        emit MultisigSet(multisig_);
    }

    function setBirthFee(uint256 birthFee_) external onlyOwner {
        birthFee = birthFee_;
        emit BirthFeeSet(birthFee_);
    }

    /// @dev Same `>= 1` floor as the constructor - see there for why.
    function setSameSexFeeMultiplier(uint256 multiplier) external onlyOwner {
        if (multiplier < 1) revert InvalidMultiplier();
        sameSexFeeMultiplier = multiplier;
        emit SameSexFeeMultiplierSet(multiplier);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    // ---------------------------------------------------------------
    // Operator: HOODCHAN gene-sync trust point
    // ---------------------------------------------------------------

    /// @notice Sync a HOODCHAN token's 5 gene-slot values from its
    /// off-chain metadata. See the contract-level HOODCHAN ADAPTER note -
    /// this IS the trust point, there is no on-chain verification against
    /// HOODCHAN's real metadata.
    function setHoodchanGenes(uint256 tokenId, uint8[5] calldata genes) external onlyOperator {
        hoodchanGenes[tokenId] = genes;
        hoodchanGenesSet[tokenId] = true;
        emit HoodchanGenesSet(tokenId, genes);
    }

    /// @dev Batch form for the off-chain sync script to amortize calldata
    /// across HOODCHAN's ~1200-token supply instead of one tx per token.
    function setHoodchanGenesBatch(uint256[] calldata tokenIds, uint8[5][] calldata genes) external onlyOperator {
        uint256 len = tokenIds.length;
        require(len == genes.length, "length mismatch");
        for (uint256 i = 0; i < len; i++) {
            hoodchanGenes[tokenIds[i]] = genes[i];
            hoodchanGenesSet[tokenIds[i]] = true;
            emit HoodchanGenesSet(tokenIds[i], genes[i]);
        }
    }

    // ---------------------------------------------------------------
    // Siring: generalized list/unlist, any allowlisted collection
    // ---------------------------------------------------------------

    /// @notice List `tokenId` (from any allowlisted `collection`) as
    /// publicly available for siring at `price` CHAN. Gated on the CURRENT
    /// `ownerOf` at call time (not cached) - a token that changes hands
    /// loses its old owner's listing authority automatically. `price == 0`
    /// is a valid, explicit "free but listed" choice, distinct from being
    /// unlisted (the default) - see `SiringListing`.
    function listSiring(address collection, uint256 tokenId, uint128 price) external {
        if (!isBreedableCollection[collection]) revert CollectionNotAllowlisted();
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        siringListings[collection][tokenId] = SiringListing({price: price, listed: true, lister: msg.sender});
        emit SiringListed(collection, tokenId, price);
    }

    /// @notice Remove a token from siring availability entirely - distinct
    /// from a free (`price == 0`) listing, which stays available. Only the
    /// current owner may delist.
    function unlistSiring(address collection, uint256 tokenId) external {
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        delete siringListings[collection][tokenId];
        emit SiringUnlisted(collection, tokenId);
    }

    // ---------------------------------------------------------------
    // Breeding: single atomic transaction
    // ---------------------------------------------------------------

    /// @notice Breed `matronId` (from `matronCollection`) with `sireId`
    /// (from `sireCollection`), minting a new HoodchanBabies token to the
    /// MATRON'S OWNER. No escrow, no pull-payments, no two-step seed-hiding
    /// scheme, no gestation/claim step - genome is computed and finalized
    /// in this same tx (see the contract-level ACCEPTED TRADEOFF note).
    ///
    /// Flow (checks -> effects -> interactions):
    ///   1. CHECKS: both collections allowlisted; caller owns/is approved
    ///      for the matron (the only mandatory ownership check); sire is
    ///      either caller-owned/approved OR explicitly listed; both
    ///      tokens' cooldowns have passed; both parents' genes are
    ///      available.
    ///   2. EFFECTS: write escalating cooldown state for BOTH tokens FIRST,
    ///      before any external call that isn't a pure ownership/existence
    ///      check.
    ///   3. INTERACTIONS: collect the birth fee (always) and siring fee (if
    ///      borrowing), read both parents' live gene values, compute the
    ///      seed/genome/baby-sex, mint the baby, emit `Bred`.
    ///
    /// @param maxSiringFee The most CHAN the caller is willing to pay the
    /// SIRE'S OWNER for this breed (the 8% protocol fee is charged on top
    /// of the accepted price, as always - see `_collectSiringFee`). Pass 0
    /// when self-siring or when only accepting a free listing. This is
    /// SLIPPAGE PROTECTION and it is load-bearing, not ceremony: the sire's
    /// owner is an UNTRUSTED counterparty who can call `listSiring` again
    /// at any moment, including in the block that front-runs this call. A
    /// breeder who reads a 1 CHAN listing off-chain, signs, and has granted
    /// the usual unlimited CHAN allowance would otherwise pay whatever
    /// price the sire's owner re-listed at in the meantime - up to their
    /// entire balance, with 100% of it going to the attacker. Bounding the
    /// accepted price at the caller's own quote is the only thing that
    /// makes a listed price an offer rather than a blank cheque. (The
    /// design spec's `breed(matronCollection, matronId, sireCollection,
    /// sireId)` line describes the mechanic - one atomic call, no
    /// commit/reveal - not a frozen ABI; the spec separately requires that
    /// the fee flows be safe.)
    function breed(
        address matronCollection,
        uint256 matronId,
        address sireCollection,
        uint256 sireId,
        uint256 maxSiringFee
    ) external nonReentrant returns (uint256 babyTokenId) {
        // --- 1. Checks ---
        if (!isBreedableCollection[matronCollection] || !isBreedableCollection[sireCollection]) {
            revert CollectionNotAllowlisted();
        }
        if (matronCollection == sireCollection && matronId == sireId) revert SameToken();

        address matronOwner = IERC721(matronCollection).ownerOf(matronId);
        if (!_isOwnerOrApproved(matronCollection, matronId, matronOwner, msg.sender)) {
            revert NotTokenOwnerOrApproved();
        }

        address sireOwner = IERC721(sireCollection).ownerOf(sireId);
        bool sireCallerOwned = _isOwnerOrApproved(sireCollection, sireId, sireOwner, msg.sender);
        SiringListing memory listing;
        if (!sireCallerOwned) {
            listing = siringListings[sireCollection][sireId];
            // `lister != sireOwner` means the token changed hands since it
            // was listed - the CURRENT owner never opted in, so the stale
            // listing confers nothing (see `SiringListing`).
            if (!listing.listed || listing.lister != sireOwner) revert SireNotAvailable();
            // Slippage bound against a re-listing front-run (see the
            // `maxSiringFee` param docs above).
            if (listing.price > maxSiringFee) revert SiringFeeTooHigh();
        }

        TokenBreedState storage matronState = breedState[matronCollection][matronId];
        TokenBreedState storage sireState = breedState[sireCollection][sireId];
        // >= , not > : Robinhood Chain's block.timestamp is
        // monotonic-NON-decreasing (multiple blocks can share a second-
        // granularity timestamp) - a cooldownEnd exactly equal to the
        // current timestamp has still legitimately elapsed.
        if (block.timestamp < matronState.cooldownEnd) revert MatronOnCooldown();
        if (block.timestamp < sireState.cooldownEnd) revert SireOnCooldown();

        // "Genes available" check - for a HOODCHAN parent this is a cheap
        // storage read (hoodchanGenesSet); for any other allowlisted
        // collection, token existence (and therefore genesOf availability)
        // is already implied by the successful `ownerOf` calls above, so
        // no extra external call is needed here. The actual `genesOf`
        // reads happen below, in Interactions, per the Hygiene
        // requirement to write cooldown state before external calls
        // wherever practical.
        _requireGenesAvailable(matronCollection, matronId);
        _requireGenesAvailable(sireCollection, sireId);

        // --- 2. Effects: escalating cooldown, BOTH tokens, before any
        // external call below ---
        matronState.cooldownEnd = uint64(block.timestamp + _cooldownSeconds(matronState.breedCount));
        matronState.breedCount += 1;
        sireState.cooldownEnd = uint64(block.timestamp + _cooldownSeconds(sireState.breedCount));
        sireState.breedCount += 1;

        // --- 3. Interactions ---
        bool matronIsMale = _sexOf(matronCollection, matronId);
        bool sireIsMale = _sexOf(sireCollection, sireId);
        bool sameSex = matronIsMale == sireIsMale;

        _collectBirthFee(sameSex);
        if (!sireCallerOwned) {
            _collectSiringFee(sireOwner, listing.price);
        }

        uint8[5] memory matronGenes = _genesOf(matronCollection, matronId);
        uint8[5] memory sireGenes = _genesOf(sireCollection, sireId);

        uint256 nonce = breedNonce++;
        uint256 seed = GeneticsLib.breedingSeed(matronCollection, matronId, sireCollection, sireId, nonce);
        uint8[5] memory genome = GeneticsLib.resolveGenome(matronGenes, sireGenes, seed);
        bool babyIsMale = GeneticsLib.resolveBabyIsMale(seed);

        babyTokenId = babies.mint(
            matronOwner, genome, seed, babyIsMale, sameSex, matronCollection, matronId, sireCollection, sireId, nonce
        );

        emit Bred(
            babyTokenId, matronCollection, matronId, sireCollection, sireId, nonce, seed, genome, babyIsMale, sameSex
        );
    }

    // ---------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------

    function _isOwnerOrApproved(address collection, uint256 tokenId, address owner_, address caller)
        internal
        view
        returns (bool)
    {
        return caller == owner_ || IERC721(collection).getApproved(tokenId) == caller
            || IERC721(collection).isApprovedForAll(owner_, caller);
    }

    function _requireGenesAvailable(address collection, uint256 tokenId) internal view {
        if (collection == hoodchanAddress && !hoodchanGenesSet[tokenId]) revert GenesNotSet();
    }

    /// @dev Reads a parent's 5-slot gene array. HOODCHAN is fronted by the
    /// off-chain-synced `hoodchanGenes` adapter mapping (see the
    /// contract-level HOODCHAN ADAPTER note); every other allowlisted
    /// collection is read live via `genesOf` (IBreedable).
    function _genesOf(address collection, uint256 tokenId) internal view returns (uint8[5] memory) {
        if (collection == hoodchanAddress) {
            return hoodchanGenes[tokenId];
        }
        return IBreedable(collection).genesOf(tokenId);
    }

    /// @dev Resolves a token's sex tag per its collection's configured
    /// `CollectionSex`. Male/Female are fixed at allowlist time (no
    /// per-token storage needed for HOODCHAN/Girlfriends); PerToken defers
    /// to the token's own contract (currently only HoodchanBabies).
    function _sexOf(address collection, uint256 tokenId) internal view returns (bool isMale) {
        CollectionSex sex = collectionSex[collection];
        if (sex == CollectionSex.Male) return true;
        if (sex == CollectionSex.Female) return false;
        return IPerTokenSex(collection).sexOf(tokenId);
    }

    /// @dev Escalating cooldown ladder, in SECONDS, indexed by a token's
    /// current `breedCount` (its NEXT cooldown, i.e. called BEFORE
    /// incrementing breedCount). Roughly doubling:
    /// 1min, 2min, 5min, 10min, 30min, 1hr, 2hr, 4hr, 8hr, 16hr, 1day,
    /// 2day, 4day, capped at 7 days forever after. `block.timestamp` in
    /// SECONDS is the only correct unit here - empirically, Robinhood
    /// Chain (id 4663) produces ~10 blocks/sec with second-granularity,
    /// monotonic-non-decreasing timestamps, so `block.number` can never be
    /// used for duration math on this chain (a prior attempt's real bug).
    function _cooldownSeconds(uint256 breedCount) internal pure returns (uint256) {
        uint32[14] memory ladder = [
            uint32(60),
            120,
            300,
            600,
            1800,
            3600,
            7200,
            14400,
            28800,
            57600,
            86400,
            172800,
            345600,
            604800
        ];
        uint256 idx = breedCount >= ladder.length ? ladder.length - 1 : breedCount;
        return ladder[idx];
    }

    /// @dev Flat birth fee, charged on EVERY breed including self-siring,
    /// multiplied for same-sex ("test tube baby") pairings. Never split or
    /// burned - goes entirely to `treasury` (funds the per-baby OpenAI
    /// art-gen cost). Distinct from, and unaffected by, the siring
    /// protocol fee below.
    function _collectBirthFee(bool sameSex) internal {
        uint256 fee = sameSex ? birthFee * sameSexFeeMultiplier : birthFee;
        if (fee > 0) {
            chanToken.safeTransferFrom(msg.sender, treasury, fee);
        }
    }

    /// @dev Only called when borrowing a sire NOT owned/approved by the
    /// caller. The sire's owner receives EXACTLY 100% of the listed
    /// `price` - the 8% protocol fee is ADDED on top (paid by the caller in
    /// addition to `price`, never carved out of it), split 5% burn / 3%
    /// multisig, i.e. the caller's total debit for the siring portion is
    /// `price + price*500/10000 + price*300/10000` = 10800/10000 of
    /// `price` when the two components are computed by independent floor
    /// division (as below) rather than `price * 800/10000` computed once.
    /// ROUNDING DIRECTION: each component floors independently, so the
    /// sum of the two protocol-fee legs can be up to 1 wei short of an
    /// exact 8% in the caller's favor (never the contract's) - e.g.
    /// price=3 gives burn=0, multisig=0 instead of a theoretical 0.24;
    /// this dust is simply never collected, not lost or stuck anywhere.
    /// `price == 0` (an explicit "free but listed" sire) naturally yields
    /// zero protocol fee too - 8% of nothing is nothing.
    function _collectSiringFee(address sireOwner, uint256 price) internal {
        if (price > 0) {
            chanToken.safeTransferFrom(msg.sender, sireOwner, price);
        }
        uint256 burnAmount = (price * 500) / 10000; // 5%
        uint256 multisigAmount = (price * 300) / 10000; // 3%
        if (burnAmount > 0) {
            chanToken.safeTransferFrom(msg.sender, burnAddress, burnAmount);
        }
        if (multisigAmount > 0) {
            chanToken.safeTransferFrom(msg.sender, multisig, multisigAmount);
        }
    }
}
