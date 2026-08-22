// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {GeneticsLib} from "./GeneticsLib.sol";
import {IERC6551Registry} from "./interfaces/IERC6551Registry.sol";
import {HoodchanBabies} from "./HoodchanBabies.sol";

/// @title BreedingController
/// @notice Orchestrates HOODCHAN (father) x HoodchanGirlfriends (mother)
/// breeding into HoodchanBabies, minted directly into the mother's
/// ERC-6551 token-bound account.
///
/// DISCOVERY-DRIVEN DESIGN: HOODCHAN is a real, already-deployed,
/// already-owned-by-someone-else collection (h00dchan's own lib/chain.ts:
/// CONTRACT = 0x774Db2...). This contract does not own it, cannot upgrade
/// it, and - critically - CANNOT READ ITS TRAITS: HOODCHAN's tokenURI
/// resolves to an ipfs:// JSON document (name/image/attributes), not
/// on-chain storage this contract can eth_call into. So HOODCHAN's 5-slot
/// genes and its "STATUS: Upgraded" flag (confirmed live via OpenSea on
/// tokens #531/#777/#1067, per the design spec - no code anywhere reads it
/// on-chain today) both have to be synced in by an off-chain script
/// instead of read live. `hoodchanGenes` and `upgradedAllowlist` below are
/// BOTH metadata-sync trust points: this contract trusts whatever the
/// operator wrote there was actually read off HOODCHAN's real metadata at
/// some point, not derived on-chain. A stale or malicious sync would let a
/// father breed with wrong genes, or let a non-Upgraded father accept ETH
/// - there is no on-chain way to catch either case in v1.
///
/// ============================================================
/// SEED-FAIRNESS MITIGATION (commit/reveal + blockhash entropy)
/// ============================================================
/// The original single-tx `breed()` design computed
/// `keccak256(fatherTokenId, motherTokenId, breedNonce)` entirely from
/// values readable BEFORE the breeding tx landed (token IDs are public,
/// `breedNonce` is a public, sequential counter) - the whole genome,
/// including whether a legendary mutation hits, was fully computable in
/// advance and a caller could choose to send (or withhold) their tx based
/// on that preview ("breed-sniping"). This has been replaced with a
/// two-step commit/reveal flow:
///
///   1. `commitBreed` - verifies ownership/genes/cap, escrows payment at
///      the CURRENT listed price (never a caller-supplied max), locks
///      both parent tokens against concurrent commits, and snapshots
///      `commitBlock = block.number` plus a fresh `breedNonce`.
///   2. `revealBreed` - callable by ANYONE once `block.number >
///      commitBlock`, derives the seed from
///      `keccak256(fatherTokenId, motherTokenId, nonce,
///      blockhash(commitBlock))`. `blockhash(commitBlock)` is NOT known
///      at commit time (it doesn't exist yet - it's the hash of a future
///      block), so the genome is no longer predictable before the commit
///      tx is even mined, closing the pre-computation window.
///
/// `blockhash()` was chosen over `block.prevrandao` deliberately:
/// Robinhood Chain (the deploy target, chain id 4663) is a Nitro-based
/// Arbitrum Orbit chain. On Orbit/Arbitrum chains, `block.prevrandao` is
/// NOT derived from L1 randomness the way it is on Ethereum L1 post-Merge
/// - it's attacker-influenceable/known ahead of time on these chains, so
/// using it here would silently reintroduce the exact bug this mitigation
/// exists to close. `blockhash(n)` for a PAST block, by contrast, behaves
/// normally on Nitro-based Orbit chains for the most recent 256 L2 blocks
/// (the same 256-block window as Ethereum L1) and is genuinely unknown
/// until block `n` is actually produced.
///
/// Known residual limitations, both accepted for v1:
///   - A miner/sequencer with block-production control over `commitBlock`
///     could in principle choose whether to include a given block (a much
///     narrower grinding window than full seed pre-computation, and one
///     shared by essentially every blockhash-based commit/reveal scheme).
///     No oracle (e.g. Pyth VRF, as AquaPrime's own genetics system uses)
///     is introduced here - the design spec explicitly prioritizes
///     shipping the P2P economy without an oracle dependency for v1.
///   - If `revealBreed` isn't called within 256 blocks of `commitBlock`,
///     `blockhash(commitBlock)` returns `bytes32(0)` and the reveal can no
///     longer be fairly computed. `revealBreed` reverts with
///     `CommitExpired` in that case; `cancelExpiredCommit` refunds the
///     escrowed payment and unlocks both parent tokens instead. A
///     re-anchor-to-`blockhash(block.number - 1)` fallback (with a
///     correspondingly smaller grinding window) was considered but
///     deliberately NOT implemented - expire-and-refund is simpler and
///     strictly safer, at the cost of the committer needing to retry.
contract BreedingController is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------
    // Immutable wiring
    // ---------------------------------------------------------------

    /// @dev HOODCHAN itself - untouched, external, father role. Plain
    /// IERC721 (only ownerOf is needed) rather than a HOODCHAN-specific
    /// type, since this contract never reads anything else off it.
    IERC721 public immutable hoodchan;

    /// @dev HoodchanGirlfriends - mother role. Typed as IERC721 for
    /// ownerOf and cast to the concrete type only where genesOf() is
    /// needed, so a future real Girlfriends collection swap (per the
    /// design spec: "the contract address is a config value, not
    /// hardcoded") only has to satisfy IERC721 + a genesOf(uint256)
    /// getter, not this exact dummy implementation.
    IHoodchanGirlfriendsGenes public immutable girlfriends;
    address public immutable girlfriendsAddress;

    HoodchanBabies public immutable babies;
    IERC20 public immutable chanToken;

    /// @dev Same ERC-6551 registry + implementation the tba-kit package
    /// (github:Pixelpushin/tba-kit) uses (constants confirmed against
    /// node_modules' tba-kit dist/index.js:
    /// REGISTRY_ADDRESS = 0x000000006551c19487814612e58FE06813775758,
    /// IMPLEMENTATION_ADDRESS = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC).
    /// Taken as constructor args rather than hardcoded here so this
    /// contract never silently drifts from whatever tba-kit ships if
    /// those values are ever redeployed/updated - see script/Deploy.s.sol
    /// for the concrete values passed at deploy time.
    IERC6551Registry public immutable tbaRegistry;
    address public immutable tbaImplementation;

    /// @dev Standard ERC-6551 default salt (bytes32(0)) - matches
    /// tba-kit's ZERO_SALT and every TBA address this app has already
    /// computed for HOODCHAN itself (lib/tba.ts). Must stay bytes32(0):
    /// any other salt would compute a DIFFERENT TBA address than the rest
    /// of this ecosystem already uses for the same token.
    bytes32 internal constant TBA_SALT = bytes32(0);

    /// @dev Soft cap on babies nested inside one mother's TBA "at once" -
    /// deliberately the SAME number as lib/leveling.ts's
    /// NESTED_HOLDING_MAX_TOKENS (5), which already caps the nested-holding
    /// XP bonus for the exact same TBA-nesting mechanic breeding reuses
    /// (see the design spec: "matching the existing nested-holding XP
    /// cap - not a new rule"). Checked live via balanceOf(motherTba) on
    /// HoodchanBabies, not a lifetime mint counter - a mother who nests out
    /// a baby (transfers it elsewhere) frees up a slot, matching the "at
    /// once" wording.
    uint256 public constant NESTED_CAP = 5;

    /// @dev EVM blockhash is only available for the most recent 256
    /// blocks (see the contract-level SEED-FAIRNESS MITIGATION note).
    /// Past that, `revealBreed` can no longer fairly derive a seed and
    /// the commit must be cancelled/refunded instead.
    uint256 internal constant REVEAL_WINDOW_BLOCKS = 256;

    // ---------------------------------------------------------------
    // Mutable state
    // ---------------------------------------------------------------

    /// @dev Global, monotonically incrementing breed counter - the third
    /// input to GeneticsLib.breedingSeed, snapshotted into a Commit at
    /// `commitBreed` time. Starts at 0, so the first ever breed uses
    /// nonce = 0.
    uint256 public breedNonce;

    /// @dev Off-chain-synced copy of a HOODCHAN token's 5 gene-slot values
    /// (Hat, Face, Body, Background, Accessory). See the contract-level
    /// "DISCOVERY-DRIVEN DESIGN" note - this is a trust point, not a live
    /// read.
    mapping(uint256 => uint8[5]) public hoodchanGenes;
    /// @dev Separate from "all-zero genes" being a legitimate value - an
    /// unset father must revert breeding, not silently breed with all-0s.
    mapping(uint256 => bool) public hoodchanGenesSet;

    /// @dev Off-chain-synced copy of whether a HOODCHAN token's metadata
    /// carries `trait_type: "STATUS", value: "Upgraded"`. See the
    /// contract-level "DISCOVERY-DRIVEN DESIGN" note - also a trust point.
    mapping(uint256 => bool) public upgradedAllowlist;

    /// @dev One or more addresses (in addition to `owner()`) trusted to
    /// run the off-chain metadata-sync script and call `setHoodchanGenes`
    /// / `setHoodchanGenesBatch` / `setUpgradedAllowlist(Batch)`. Kept
    /// separate from `owner()` so the sync bot's hot key never needs to be
    /// the same key that can retarget `babies.setBreedingController` or
    /// receive ownership transfers. NOTE: setHoodchanGenes/
    /// setHoodchanGenesBatch and the upgraded-allowlist setters are
    /// unchanged from the original design - their off-chain sync
    /// correctness (keeping these mappings honest against HOODCHAN's real
    /// metadata) is a separate, already-tracked follow-up owned elsewhere,
    /// not part of this fix.
    mapping(address => bool) public isOperator;

    struct SiringListing {
        uint128 chanPrice;
        uint128 ethPrice;
        bool listed;
    }

    /// @dev Per-father siring terms, set/edited/delisted only by whoever
    /// owns that HOODCHAN token AT CALL TIME (checked live via
    /// hoodchan.ownerOf, never cached) - see onlyHoodchanOwner. A father
    /// with `listed == false` (the default for every token until its
    /// owner explicitly lists it) cannot be bred with by anyone except an
    /// address that already owns both the father and the mother (the
    /// same-owner free path bypasses the listing requirement entirely,
    /// same as it bypasses payment - you don't need your own permission to
    /// breed your own stud).
    mapping(uint256 => SiringListing) public siringListings;

    enum PayMethod {
        CHAN,
        ETH
    }

    /// @dev A single in-flight (or resolved) breed attempt. `nonce` and
    /// `commitBlock` are snapshotted once, at commit time, and never
    /// change - `revealBreed` derives the seed from exactly these values
    /// plus `blockhash(commitBlock)` (see the SEED-FAIRNESS MITIGATION
    /// note). `amountEscrowed` is the price actually charged (the CURRENT
    /// listed price at commit time, always <= the caller's supplied max),
    /// held by this contract until reveal (paid to `fatherOwnerAtCommit`)
    /// or cancellation (refunded to `committer`).
    struct Commit {
        uint256 fatherTokenId;
        uint256 motherTokenId;
        address committer;
        address fatherOwnerAtCommit;
        uint64 commitBlock;
        uint256 nonce;
        uint128 amountEscrowed;
        PayMethod method;
        bool sameOwner;
        bool resolved;
    }

    mapping(uint256 => Commit) public commits;
    uint256 public nextCommitId = 1;

    /// @dev One active (unresolved) commit at a time per token, on EITHER
    /// side of the breed - prevents a father or mother from being
    /// double-committed while a reveal is pending (see commitBreed).
    mapping(uint256 => bool) public fatherLocked;
    mapping(uint256 => bool) public motherLocked;

    /// @dev Pull-payment balances. ETH payouts are ALWAYS pull-based (see
    /// the contract-level SEED-FAIRNESS / BUG 6 note on why: the outcome
    /// - mint - must never be gated behind a push-payment call that a
    /// hostile recipient could revert). CHAN payouts are attempted as a
    /// direct push first (a plain ERC-20 transfer has no recipient
    /// callback hook to exploit) but fall back to pull if that push fails
    /// for any reason (blacklist, paused token, etc.) - so a broken or
    /// hostile CHAN deployment can never block a reveal either.
    mapping(address => uint256) public pendingEthWithdrawals;
    mapping(address => uint256) public pendingChanWithdrawals;

    enum CommitCancelReason {
        Expired,
        NestedCapExceeded
    }

    event SiringListed(uint256 indexed fatherTokenId, uint128 chanPrice, uint128 ethPrice);
    event SiringDelisted(uint256 indexed fatherTokenId);
    event HoodchanGenesSet(uint256 indexed tokenId, uint8[5] genes);
    event UpgradedAllowlistSet(uint256 indexed tokenId, bool allowed);
    event OperatorSet(address indexed operator, bool allowed);
    event CommitCreated(
        uint256 indexed commitId,
        uint256 indexed fatherTokenId,
        uint256 indexed motherTokenId,
        address committer,
        address fatherOwnerAtCommit,
        uint256 commitBlock,
        uint256 nonce,
        PayMethod method,
        uint256 amountEscrowed
    );
    event CommitCancelled(uint256 indexed commitId, CommitCancelReason reason);
    event Bred(
        uint256 indexed babyTokenId,
        uint256 indexed fatherTokenId,
        uint256 indexed motherTokenId,
        uint256 breedNonce_,
        uint256 seed,
        uint8[5] genome,
        address motherTba,
        PayMethod paymentMethod,
        uint256 amountPaid,
        uint256 commitId
    );
    event EthClaimed(address indexed to, uint256 amount);
    event ChanClaimed(address indexed to, uint256 amount);

    error NotOperator();
    error NotHoodchanOwner();
    error NotGirlfriendOwner();
    error GenesNotSet();
    error SiringNotListed();
    error WrongPaymentAmount();
    error PriceExceedsMax();
    error NotUpgradedForEth();
    error EthNotAccepted();
    error StrayEthValue();
    error NestedCapExceeded();
    error EthTransferFailed();
    error ZeroAddress();
    error FatherLocked();
    error MotherLocked();
    error CommitNotFound();
    error CommitAlreadyResolved();
    error RevealTooEarly();
    error CommitExpired();
    error CommitNotExpired();
    error NothingToClaim();

    modifier onlyOperator() {
        if (msg.sender != owner() && !isOperator[msg.sender]) revert NotOperator();
        _;
    }

    modifier onlyHoodchanOwner(uint256 tokenId) {
        if (hoodchan.ownerOf(tokenId) != msg.sender) revert NotHoodchanOwner();
        _;
    }

    constructor(
        address initialOwner,
        address hoodchanAddress,
        address girlfriendsAddress_,
        address babiesAddress,
        address chanTokenAddress,
        address tbaRegistryAddress,
        address tbaImplementationAddress
    ) Ownable(initialOwner) {
        if (
            hoodchanAddress == address(0) || girlfriendsAddress_ == address(0) || babiesAddress == address(0)
                || chanTokenAddress == address(0) || tbaRegistryAddress == address(0)
                || tbaImplementationAddress == address(0)
        ) revert ZeroAddress();

        hoodchan = IERC721(hoodchanAddress);
        girlfriends = IHoodchanGirlfriendsGenes(girlfriendsAddress_);
        girlfriendsAddress = girlfriendsAddress_;
        babies = HoodchanBabies(babiesAddress);
        chanToken = IERC20(chanTokenAddress);
        tbaRegistry = IERC6551Registry(tbaRegistryAddress);
        tbaImplementation = tbaImplementationAddress;
    }

    // ---------------------------------------------------------------
    // Operator: metadata-sync trust points (unchanged - see BUG 7,
    // owned elsewhere, out of scope for this fix)
    // ---------------------------------------------------------------

    function setOperator(address operator, bool allowed) external onlyOwner {
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /// @notice Sync a HOODCHAN token's 5 gene-slot values from its
    /// off-chain metadata. See the contract-level DISCOVERY-DRIVEN DESIGN
    /// note - this IS the trust point, there is no on-chain verification
    /// against HOODCHAN's real metadata.
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

    /// @notice Sync whether a HOODCHAN token's metadata carries
    /// `STATUS: "Upgraded"`. Same trust-point caveat as setHoodchanGenes.
    function setUpgradedAllowlist(uint256 tokenId, bool allowed) external onlyOperator {
        upgradedAllowlist[tokenId] = allowed;
        emit UpgradedAllowlistSet(tokenId, allowed);
    }

    function setUpgradedAllowlistBatch(uint256[] calldata tokenIds, bool allowed) external onlyOperator {
        uint256 len = tokenIds.length;
        for (uint256 i = 0; i < len; i++) {
            upgradedAllowlist[tokenIds[i]] = allowed;
            emit UpgradedAllowlistSet(tokenIds[i], allowed);
        }
    }

    // ---------------------------------------------------------------
    // Siring: HOODCHAN owner-controlled pricing
    // ---------------------------------------------------------------

    /// @notice Set or edit a father's siring terms. Only the CURRENT
    /// HOODCHAN owner (checked live, not cached) may call this - a token
    /// that changes hands automatically loses its old owner's listing
    /// authority, no separate revoke step needed. `ethPrice` is only ever
    /// usable by a breeder if `upgradedAllowlist[fatherTokenId]` is also
    /// true at commit time (see commitBreed) - setting it here for a
    /// non-allowlisted token is harmless (unusable) rather than reverting,
    /// since allowlist status can change independently and later.
    function setSiringPrice(uint256 fatherTokenId, uint128 chanPrice, uint128 ethPrice)
        external
        onlyHoodchanOwner(fatherTokenId)
    {
        siringListings[fatherTokenId] = SiringListing({chanPrice: chanPrice, ethPrice: ethPrice, listed: true});
        emit SiringListed(fatherTokenId, chanPrice, ethPrice);
    }

    /// @notice Remove a father from siring availability entirely -
    /// distinct from a free (chanPrice == 0) listing, which stays
    /// available. Only the current HOODCHAN owner may delist. Does not
    /// affect any commit already in flight (that commit already escrowed
    /// its price and locked the father; it resolves independently via
    /// revealBreed / cancelExpiredCommit).
    function delistSiring(uint256 fatherTokenId) external onlyHoodchanOwner(fatherTokenId) {
        delete siringListings[fatherTokenId];
        emit SiringDelisted(fatherTokenId);
    }

    // ---------------------------------------------------------------
    // Breeding: commit
    // ---------------------------------------------------------------

    /// @notice Step 1 of 2. Commits `fatherTokenId` (HOODCHAN) x
    /// `motherTokenId` (HoodchanGirlfriends) to breed. Caller must own the
    /// mother. Verifies eligibility, escrows payment at the CURRENT
    /// listed price (bounded by `maxChanPrice`/`maxEthPrice` - see the
    /// contract-level SEED-FAIRNESS note and BUG 2's slippage-guard fix:
    /// this is what stops a father owner from front-running with
    /// `setSiringPrice` after the caller has already decided what they're
    /// willing to pay), and locks both parent tokens against any other
    /// concurrent commit. Call `revealBreed` with the returned `commitId`
    /// once at least one block has passed.
    function commitBreed(
        uint256 fatherTokenId,
        uint256 motherTokenId,
        uint128 maxChanPrice,
        uint128 maxEthPrice,
        PayMethod method
    ) external payable nonReentrant returns (uint256 commitId) {
        if (girlfriends.ownerOf(motherTokenId) != msg.sender) revert NotGirlfriendOwner();
        if (!hoodchanGenesSet[fatherTokenId]) revert GenesNotSet();
        if (fatherLocked[fatherTokenId]) revert FatherLocked();
        if (motherLocked[motherTokenId]) revert MotherLocked();

        address motherTba =
            tbaRegistry.account(tbaImplementation, TBA_SALT, block.chainid, girlfriendsAddress, motherTokenId);
        if (babies.balanceOf(motherTba) >= NESTED_CAP) revert NestedCapExceeded();

        address fatherOwner = hoodchan.ownerOf(fatherTokenId);
        bool sameOwner = fatherOwner == msg.sender;

        uint128 amountEscrowed = 0;
        if (!sameOwner) {
            amountEscrowed = _escrowPayment(fatherTokenId, method, maxChanPrice, maxEthPrice);
        } else if (msg.value != 0) {
            // Same-owner breeds are always free - refuse stray ETH rather
            // than silently swallowing it into the contract.
            revert StrayEthValue();
        }

        fatherLocked[fatherTokenId] = true;
        motherLocked[motherTokenId] = true;

        uint256 nonce = breedNonce++;
        commitId = nextCommitId++;
        commits[commitId] = Commit({
            fatherTokenId: fatherTokenId,
            motherTokenId: motherTokenId,
            committer: msg.sender,
            fatherOwnerAtCommit: fatherOwner,
            commitBlock: uint64(block.number),
            nonce: nonce,
            amountEscrowed: amountEscrowed,
            method: method,
            sameOwner: sameOwner,
            resolved: false
        });

        emit CommitCreated(
            commitId, fatherTokenId, motherTokenId, msg.sender, fatherOwner, block.number, nonce, method, amountEscrowed
        );
    }

    /// @dev Isolated for readability/testing - handles both the CHAN and
    /// ETH escrow branches for a non-same-owner commit. Escrows the
    /// CURRENT listing price (never the caller's max) into this contract;
    /// reverts BEFORE any transfer if that price exceeds the caller's
    /// supplied bound (BUG 2 fix - was previously unbounded and read live
    /// with zero slippage protection).
    function _escrowPayment(uint256 fatherTokenId, PayMethod method, uint128 maxChanPrice, uint128 maxEthPrice)
        private
        returns (uint128 amountEscrowed)
    {
        SiringListing memory listing = siringListings[fatherTokenId];
        if (!listing.listed) revert SiringNotListed();

        if (method == PayMethod.ETH) {
            // ETH is ONLY accepted for allowlisted-Upgraded fathers - see
            // the contract-level DISCOVERY-DRIVEN DESIGN note: this flag
            // is itself an off-chain-synced trust point, not something
            // this contract can verify against HOODCHAN's real metadata.
            if (!upgradedAllowlist[fatherTokenId]) revert NotUpgradedForEth();
            uint128 currentPrice = listing.ethPrice;
            if (currentPrice > maxEthPrice) revert PriceExceedsMax();
            if (msg.value != currentPrice) revert WrongPaymentAmount();
            amountEscrowed = currentPrice;
            // Held natively as address(this).balance until reveal/cancel
            // - no external call here, so there is nothing for a hostile
            // father owner to intercept at commit time either.
        } else {
            if (msg.value != 0) revert StrayEthValue();
            uint128 currentPrice = listing.chanPrice;
            if (currentPrice > maxChanPrice) revert PriceExceedsMax();
            amountEscrowed = currentPrice;
            if (amountEscrowed != 0) {
                // Buyer -> CONTRACT (escrow), not buyer -> father owner.
                // Forwarding to the father owner is deferred to
                // revealBreed, strictly AFTER the genome/mint is locked
                // in (BUG 6 fix).
                chanToken.safeTransferFrom(msg.sender, address(this), amountEscrowed);
            }
        }
    }

    // ---------------------------------------------------------------
    // Breeding: reveal
    // ---------------------------------------------------------------

    /// @notice Step 2 of 2. Callable by ANYONE once `block.number >
    /// commitBlock` (no restriction to the original committer - the
    /// outcome is already fully determined by the commit, so there's no
    /// benefit to gatekeeping who triggers it, and letting anyone reveal
    /// means a committer can't grief their own breed by simply not
    /// showing up). Derives the seed from
    /// `blockhash(commitBlock)` (unknown at commit time - see the
    /// contract-level SEED-FAIRNESS note), mints the baby into the
    /// mother's TBA FIRST, and only THEN pays out the escrowed amount
    /// (BUG 6 fix - the genome can never be re-rolled by a payout
    /// reverting, because payout happens strictly after mint and never
    /// gates it).
    function revealBreed(uint256 commitId) external nonReentrant returns (uint256 babyTokenId) {
        Commit storage c = commits[commitId];
        if (c.commitBlock == 0) revert CommitNotFound();
        if (c.resolved) revert CommitAlreadyResolved();
        if (block.number <= c.commitBlock) revert RevealTooEarly();

        bytes32 anchor = blockhash(c.commitBlock);
        if (anchor == bytes32(0)) revert CommitExpired();

        address motherTba =
            tbaRegistry.account(tbaImplementation, TBA_SALT, block.chainid, girlfriendsAddress, c.motherTokenId);

        // Re-checked against the live balance (not just at commit time) -
        // a direct external transfer of an existing baby into the mother's
        // TBA between commit and reveal could otherwise push it over
        // NESTED_CAP. Refund-and-unlock rather than revert, so an escrowed
        // payment is never permanently stuck.
        if (babies.balanceOf(motherTba) >= NESTED_CAP) {
            _refundAndUnlock(commitId, c);
            emit CommitCancelled(commitId, CommitCancelReason.NestedCapExceeded);
            return 0;
        }

        uint256 seed = GeneticsLib.breedingSeed(c.fatherTokenId, c.motherTokenId, c.nonce, anchor);
        uint8[5] memory genome =
            GeneticsLib.resolveGenome(hoodchanGenes[c.fatherTokenId], girlfriends.genesOf(c.motherTokenId), seed);

        // Effects BEFORE the mint's external call, and the mint itself
        // happens BEFORE any payout - the genome above is now fully
        // determined and committed to storage via the mint below prior to
        // any code path that could revert on a hostile recipient.
        c.resolved = true;
        fatherLocked[c.fatherTokenId] = false;
        motherLocked[c.motherTokenId] = false;

        babyTokenId = babies.mint(motherTba, genome, seed, c.fatherTokenId, c.motherTokenId, c.nonce);

        if (!c.sameOwner && c.amountEscrowed > 0) {
            _payout(c.fatherOwnerAtCommit, c.amountEscrowed, c.method);
        }

        emit Bred(
            babyTokenId,
            c.fatherTokenId,
            c.motherTokenId,
            c.nonce,
            seed,
            genome,
            motherTba,
            c.method,
            c.amountEscrowed,
            commitId
        );
    }

    /// @notice Refund + unlock path for a commit whose reveal window has
    /// closed (`block.number - commitBlock > 256`, i.e.
    /// `blockhash(commitBlock)` now returns 0 and can no longer fairly
    /// derive a seed - see the contract-level SEED-FAIRNESS note).
    /// Callable by anyone, same rationale as revealBreed - the refund
    /// destination is fixed (the original committer), so there is nothing
    /// to gain by gatekeeping who triggers it.
    function cancelExpiredCommit(uint256 commitId) external nonReentrant {
        Commit storage c = commits[commitId];
        if (c.commitBlock == 0) revert CommitNotFound();
        if (c.resolved) revert CommitAlreadyResolved();
        if (block.number - uint256(c.commitBlock) <= REVEAL_WINDOW_BLOCKS) revert CommitNotExpired();

        _refundAndUnlock(commitId, c);
        emit CommitCancelled(commitId, CommitCancelReason.Expired);
    }

    function _refundAndUnlock(uint256 commitId, Commit storage c) private {
        c.resolved = true;
        fatherLocked[c.fatherTokenId] = false;
        motherLocked[c.motherTokenId] = false;
        if (!c.sameOwner && c.amountEscrowed > 0) {
            _payout(c.committer, c.amountEscrowed, c.method);
        }
    }

    /// @dev Always pull-based for ETH (credits `pendingEthWithdrawals`,
    /// claimed via `claimEth`) - never a push `.call` here, so a hostile
    /// recipient's `receive()` can never run during (and therefore can
    /// never revert / re-enter / affect the outcome of) `revealBreed` or
    /// `cancelExpiredCommit`. CHAN is attempted as a direct push first
    /// (plain ERC-20 transfers have no recipient callback to exploit) and
    /// falls back to `pendingChanWithdrawals` (claimed via `claimChan`) if
    /// that push fails for any reason, so a broken/blacklisting CHAN
    /// deployment can't block resolution either.
    function _payout(address to, uint256 amount, PayMethod method) private {
        if (amount == 0) return;
        if (method == PayMethod.ETH) {
            pendingEthWithdrawals[to] += amount;
        } else {
            (bool ok, bytes memory data) =
                address(chanToken).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
            bool success = ok && (data.length == 0 || abi.decode(data, (bool)));
            if (!success) {
                pendingChanWithdrawals[to] += amount;
            }
        }
    }

    /// @notice Claim any ETH owed from resolved commits (payouts or
    /// refunds). Pull-based by design - see `_payout`.
    function claimEth() external nonReentrant {
        uint256 amount = pendingEthWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingEthWithdrawals[msg.sender] = 0;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert EthTransferFailed();
        emit EthClaimed(msg.sender, amount);
    }

    /// @notice Claim any CHAN owed from resolved commits whose direct
    /// push payout failed - see `_payout`.
    function claimChan() external nonReentrant {
        uint256 amount = pendingChanWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingChanWithdrawals[msg.sender] = 0;
        chanToken.safeTransfer(msg.sender, amount);
        emit ChanClaimed(msg.sender, amount);
    }

    // Accept ETH only via commitBreed's explicit ETH path - no bare
    // receive()/fallback(), since this contract only ever holds ETH as
    // escrow for a specific commit (tracked in that commit's
    // amountEscrowed) or as claimable pull-payment balances (tracked in
    // pendingEthWithdrawals), never as an untracked stray balance. A
    // direct ETH send with no calldata simply reverts.
}

/// @dev Minimal interface HoodchanGirlfriends (and any future real
/// Girlfriends collection swapped in for it, per the design spec) must
/// satisfy for BreedingController to read the mother's on-chain genome -
/// standard ERC-721 ownerOf plus one extra getter, deliberately not a
/// dependency on HoodchanGirlfriends' concrete type.
interface IHoodchanGirlfriendsGenes {
    function ownerOf(uint256 tokenId) external view returns (address);
    function genesOf(uint256 tokenId) external view returns (uint8[5] memory);
}
