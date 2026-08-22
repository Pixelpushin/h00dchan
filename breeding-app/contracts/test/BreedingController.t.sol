// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BreedingController} from "../src/BreedingController.sol";
import {HoodchanBabies} from "../src/HoodchanBabies.sol";
import {HoodchanGirlfriends} from "../src/HoodchanGirlfriends.sol";
import {GeneticsLib} from "../src/GeneticsLib.sol";
import {IBreedable} from "../src/interfaces/IBreedable.sol";

import {MockHoodchan} from "./mocks/MockHoodchan.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MaliciousReentrant} from "./mocks/MaliciousReentrant.sol";

/// @notice v2 rewrite of BreedingController's test suite against the design
/// spec (docs/superpowers/specs/2026-08-21-hoodchan-breeding-design.md).
/// The old suite (test-legacy/BreedingController.t.sol, 783 lines) asserted
/// commit/reveal, dual-currency ETH, mint-into-TBA, and NESTED_CAP behavior
/// - all deleted along with the mechanics themselves, not patched. This is
/// a full rewrite for the single-tx `breed()`, three-symmetric-collection,
/// CHAN-only-fee, escalating-per-token-cooldown design.
contract BreedingControllerTest is Test {
    BreedingController internal controller;
    HoodchanBabies internal babies;
    HoodchanGirlfriends internal girlfriends;
    MockHoodchan internal hoodchan;
    MockERC20 internal chan;

    address internal owner = address(this);
    address internal treasury = address(0x7EA5);
    address internal burnAddr = address(0xB0122);
    address internal multisig = address(0x115);

    address internal matronOwner = address(0xA110CE);
    address internal sireOwner = address(0x51E0);
    address internal stranger = address(0x57A6E5);

    uint256 internal constant BIRTH_FEE = 100 ether;
    uint256 internal constant SAME_SEX_MULTIPLIER = 2;
    uint256 internal constant FUND_AMOUNT = 1_000_000 ether;

    uint8[5] internal gfGenesA = [uint8(10), 20, 30, 40, 50];
    uint8[5] internal gfGenesB = [uint8(200), 190, 180, 170, 160];
    uint8[5] internal hcGenesA = [uint8(5), 15, 25, 35, 45];
    uint8[5] internal hcGenesB = [uint8(210), 220, 230, 240, 245];

    function setUp() public {
        hoodchan = new MockHoodchan();
        girlfriends = new HoodchanGirlfriends(owner);
        babies = new HoodchanBabies(owner);
        chan = new MockERC20();

        controller = new BreedingController(
            owner, address(hoodchan), address(babies), address(chan), treasury, burnAddr, multisig, BIRTH_FEE, SAME_SEX_MULTIPLIER
        );
        babies.setBreedingController(address(controller));

        controller.setBreedableCollection(address(hoodchan), true, BreedingController.CollectionSex.Male);
        controller.setBreedableCollection(address(girlfriends), true, BreedingController.CollectionSex.Female);
        controller.setBreedableCollection(address(babies), true, BreedingController.CollectionSex.PerToken);

        // Roll off block/timestamp 0 so cooldownEnd==0 is unambiguously
        // "never bred" and not confusable with a real elapsed timestamp.
        vm.warp(1_000_000);

        _fund(matronOwner);
        _fund(sireOwner);
        _fund(stranger);
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    function _fund(address who) internal {
        chan.mint(who, FUND_AMOUNT);
        vm.prank(who);
        chan.approve(address(controller), type(uint256).max);
    }

    function _mintGirlfriend(address to, uint8[5] memory genes) internal returns (uint256 tokenId) {
        tokenId = girlfriends.mint(to, genes);
    }

    function _mintHoodchan(address to, uint8[5] memory genes) internal returns (uint256 tokenId) {
        tokenId = hoodchan.mint(to);
        controller.setHoodchanGenes(tokenId, genes);
    }

    function _breed(address caller, address matronC, uint256 matronId, address sireC, uint256 sireId)
        internal
        returns (uint256 babyId)
    {
        vm.prank(caller);
        babyId = controller.breed(matronC, matronId, sireC, sireId, type(uint256).max, type(uint256).max);
    }

    // ---------------------------------------------------------------
    // Admin gating
    // ---------------------------------------------------------------

    function test_SetBreedableCollection_OwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        controller.setBreedableCollection(address(0x9999), true, BreedingController.CollectionSex.Male);
    }

    function test_SetHoodchanGenesBatch_OperatorOnly() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = hoodchan.mint(matronOwner);
        uint8[5][] memory g = new uint8[5][](1);
        g[0] = hcGenesA;

        vm.prank(stranger);
        vm.expectRevert(BreedingController.NotOperator.selector);
        controller.setHoodchanGenesBatch(ids, g);

        // Owner can always call it (onlyOperator allows owner() OR
        // isOperator[msg.sender]).
        controller.setHoodchanGenesBatch(ids, g);
        assertTrue(controller.hoodchanGenesSet(ids[0]));

        // Designated operator can too.
        controller.setOperator(stranger, true);
        ids[0] = hoodchan.mint(matronOwner);
        vm.prank(stranger);
        controller.setHoodchanGenesBatch(ids, g);
        assertTrue(controller.hoodchanGenesSet(ids[0]));
    }

    // ---------------------------------------------------------------
    // Siring listings
    // ---------------------------------------------------------------

    function test_ListSiring_OnlyCurrentOwner() public {
        uint256 sireId = _mintGirlfriend(sireOwner, gfGenesA);
        vm.prank(stranger);
        vm.expectRevert(BreedingController.NotTokenOwner.selector);
        controller.listSiring(address(girlfriends), sireId, 1 ether);
    }

    function test_ListSiring_PriceZeroIsExplicitlyListedNotDefaultFree() public {
        uint256 sireId = _mintGirlfriend(sireOwner, gfGenesA);
        (uint128 priceBefore, bool listedBefore,) = controller.siringListings(address(girlfriends), sireId);
        assertFalse(listedBefore, "unlisted by default");
        assertEq(priceBefore, 0);

        vm.prank(sireOwner);
        controller.listSiring(address(girlfriends), sireId, 0);
        (uint128 priceAfter, bool listedAfter,) = controller.siringListings(address(girlfriends), sireId);
        assertTrue(listedAfter, "explicit price-0 listing must be marked listed");
        assertEq(priceAfter, 0);
    }

    function test_UnlistSiring_OnlyCurrentOwner() public {
        uint256 sireId = _mintGirlfriend(sireOwner, gfGenesA);
        vm.prank(sireOwner);
        controller.listSiring(address(girlfriends), sireId, 5 ether);

        vm.prank(stranger);
        vm.expectRevert(BreedingController.NotTokenOwner.selector);
        controller.unlistSiring(address(girlfriends), sireId);

        vm.prank(sireOwner);
        controller.unlistSiring(address(girlfriends), sireId);
        (, bool listed,) = controller.siringListings(address(girlfriends), sireId);
        assertFalse(listed);
    }

    // ---------------------------------------------------------------
    // Ownership rules
    // ---------------------------------------------------------------

    function test_Breed_RevertsIfCallerDoesNotOwnOrApproveMatron() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(matronOwner, hcGenesA);

        vm.prank(stranger);
        vm.expectRevert(BreedingController.NotTokenOwnerOrApproved.selector);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, type(uint256).max, type(uint256).max);
    }

    function test_Breed_ApprovedOperatorCanCallButBabyMintsToMatronOwner() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        // Sire owned by a THIRD party (sireOwner), listed free - keeps this
        // test isolated to the one thing it's checking (matron approval),
        // without also requiring the operator to be separately
        // approved/listed on the sire's collection.
        uint256 sireId = _mintHoodchan(sireOwner, hcGenesA);
        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), sireId, 0);

        address operator = address(0x0BE5A7017);
        _fund(operator);
        vm.prank(matronOwner);
        girlfriends.setApprovalForAll(operator, true);

        uint256 babyId = _breed(operator, address(girlfriends), matronId, address(hoodchan), sireId);

        assertEq(babies.ownerOf(babyId), matronOwner, "baby must mint to the MATRON's owner, not the operator");
        assertEq(chan.balanceOf(operator), FUND_AMOUNT - BIRTH_FEE, "operator (caller) pays the birth fee");
        assertEq(chan.balanceOf(matronOwner), FUND_AMOUNT, "matron owner pays nothing just for being the owner");
    }

    function test_Breed_UnlistedForeignSireRevertsEvenAtImplicitZeroPrice() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(sireOwner, hcGenesA); // never listed

        vm.prank(matronOwner);
        vm.expectRevert(BreedingController.SireNotAvailable.selector);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, type(uint256).max, type(uint256).max);
    }

    function test_Breed_ListedAtPriceZeroForeignSireSucceedsFree() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(sireOwner, hcGenesA);

        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), sireId, 0);

        uint256 sireOwnerBalBefore = chan.balanceOf(sireOwner);
        uint256 burnBalBefore = chan.balanceOf(burnAddr);
        uint256 multisigBalBefore = chan.balanceOf(multisig);

        _breed(matronOwner, address(girlfriends), matronId, address(hoodchan), sireId);

        assertEq(chan.balanceOf(sireOwner), sireOwnerBalBefore, "free listing: sire owner receives nothing");
        assertEq(chan.balanceOf(burnAddr), burnBalBefore, "8% of 0 is 0: no burn");
        assertEq(chan.balanceOf(multisig), multisigBalBefore, "8% of 0 is 0: no multisig cut");
        assertEq(chan.balanceOf(matronOwner), FUND_AMOUNT - BIRTH_FEE, "caller still pays the birth fee");
    }

    function test_Breed_SameTokenReverts() public {
        uint256 tokenId = _mintGirlfriend(matronOwner, gfGenesA);
        vm.prank(matronOwner);
        vm.expectRevert(BreedingController.SameToken.selector);
        controller.breed(address(girlfriends), tokenId, address(girlfriends), tokenId, type(uint256).max, type(uint256).max);
    }

    function test_Breed_RevertsIfEitherCollectionNotAllowlisted() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintGirlfriend(matronOwner, gfGenesB);
        address rogue = address(0xBADC011EC7104);

        vm.prank(matronOwner);
        vm.expectRevert(BreedingController.CollectionNotAllowlisted.selector);
        controller.breed(rogue, matronId, address(girlfriends), sireId, type(uint256).max, type(uint256).max);

        vm.prank(matronOwner);
        vm.expectRevert(BreedingController.CollectionNotAllowlisted.selector);
        controller.breed(address(girlfriends), matronId, rogue, sireId, type(uint256).max, type(uint256).max);
    }

    // ---------------------------------------------------------------
    // Fee math, to the wei
    // ---------------------------------------------------------------

    function test_Fee_SelfSiringPaysBirthFeeOnlyZeroProtocolFee() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(matronOwner, hcGenesA); // opposite sex, isolates from multiplier

        uint256 treasuryBefore = chan.balanceOf(treasury);
        uint256 burnBefore = chan.balanceOf(burnAddr);
        uint256 multisigBefore = chan.balanceOf(multisig);

        _breed(matronOwner, address(girlfriends), matronId, address(hoodchan), sireId);

        assertEq(chan.balanceOf(matronOwner), FUND_AMOUNT - BIRTH_FEE, "self-siring: exactly the birth fee, no more");
        assertEq(chan.balanceOf(treasury), treasuryBefore + BIRTH_FEE, "birth fee goes entirely to treasury");
        assertEq(chan.balanceOf(burnAddr), burnBefore, "self-siring: zero burn (no protocol fee)");
        assertEq(chan.balanceOf(multisig), multisigBefore, "self-siring: zero multisig cut (no protocol fee)");
    }

    function test_Fee_BorrowedSireExactSplit() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(sireOwner, hcGenesA); // opposite sex
        uint256 listedFee = 1_000 ether;

        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), sireId, uint128(listedFee));

        uint256 callerBefore = chan.balanceOf(matronOwner);
        uint256 sireOwnerBefore = chan.balanceOf(sireOwner);
        uint256 treasuryBefore = chan.balanceOf(treasury);
        uint256 burnBefore = chan.balanceOf(burnAddr);
        uint256 multisigBefore = chan.balanceOf(multisig);

        _breed(matronOwner, address(girlfriends), matronId, address(hoodchan), sireId);

        uint256 expectedBurn = (listedFee * 500) / 10000; // exactly 5%, 1000e18*500/10000 = 50e18
        uint256 expectedMultisig = (listedFee * 300) / 10000; // exactly 3%, = 30e18
        uint256 expectedTotalCallerDebit = BIRTH_FEE + (listedFee * 10800) / 10000; // 100 + 1080 = 1180 CHAN

        assertEq(expectedBurn, 50 ether);
        assertEq(expectedMultisig, 30 ether);
        assertEq(chan.balanceOf(sireOwner), sireOwnerBefore + listedFee, "sire owner gets exactly 100% of listedFee");
        assertEq(chan.balanceOf(burnAddr), burnBefore + expectedBurn, "exactly 5% burned");
        assertEq(chan.balanceOf(multisig), multisigBefore + expectedMultisig, "exactly 3% to multisig");
        assertEq(chan.balanceOf(treasury), treasuryBefore + BIRTH_FEE, "treasury still only gets the flat birth fee");
        assertEq(
            callerBefore - chan.balanceOf(matronOwner),
            expectedTotalCallerDebit,
            "total caller debit == birthFee + listedFee*10800/10000"
        );
    }

    function test_Fee_SameSexMultipliesOnlyBirthFeeNotSiringFee() public {
        uint256 listedFee = 500 ether;

        // Opposite-sex control.
        uint256 matronOpp = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireOpp = _mintHoodchan(sireOwner, hcGenesA);
        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), sireOpp, uint128(listedFee));
        uint256 callerBeforeOpp = chan.balanceOf(matronOwner);
        _breed(matronOwner, address(girlfriends), matronOpp, address(hoodchan), sireOpp);
        uint256 debitOpp = callerBeforeOpp - chan.balanceOf(matronOwner);

        // Same-sex (Girlfriend x Girlfriend) test subject, identical
        // listedFee.
        uint256 matronSame = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireSame = _mintGirlfriend(sireOwner, gfGenesB);
        vm.prank(sireOwner);
        controller.listSiring(address(girlfriends), sireSame, uint128(listedFee));
        uint256 sireOwnerBefore = chan.balanceOf(sireOwner);
        uint256 burnBefore = chan.balanceOf(burnAddr);
        uint256 multisigBefore = chan.balanceOf(multisig);
        uint256 callerBeforeSame = chan.balanceOf(matronOwner);

        _breed(matronOwner, address(girlfriends), matronSame, address(girlfriends), sireSame);

        uint256 debitSame = callerBeforeSame - chan.balanceOf(matronOwner);

        // Siring-portion legs are byte-for-byte identical between the two
        // scenarios - only the birth-fee leg differs.
        assertEq(chan.balanceOf(sireOwner), sireOwnerBefore + listedFee, "siring fee unaffected by same-sex tier");
        assertEq(
            chan.balanceOf(burnAddr), burnBefore + (listedFee * 500) / 10000, "burn leg unaffected by same-sex tier"
        );
        assertEq(
            chan.balanceOf(multisig),
            multisigBefore + (listedFee * 300) / 10000,
            "multisig leg unaffected by same-sex tier"
        );
        assertEq(
            debitSame - debitOpp,
            BIRTH_FEE * (SAME_SEX_MULTIPLIER - 1),
            "same-sex tier only adds the extra birth-fee multiplier, nothing else"
        );
    }

    /// @notice Exact-wei rounding-direction case named in the task brief:
    /// price=3 truncates BOTH legs to 0 (0.15 and 0.09 floor to 0), so the
    /// caller's total debit is birthFee + 3, not birthFee + 3 + dust - the
    /// uncollected ~0.24 is simply never charged, in the caller's favor.
    function test_Fee_RoundingDustNeverOvercharges() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(sireOwner, hcGenesA);
        uint256 listedFee = 3;

        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), sireId, uint128(listedFee));

        uint256 callerBefore = chan.balanceOf(matronOwner);
        uint256 sireOwnerBefore = chan.balanceOf(sireOwner);
        uint256 burnBefore = chan.balanceOf(burnAddr);
        uint256 multisigBefore = chan.balanceOf(multisig);

        _breed(matronOwner, address(girlfriends), matronId, address(hoodchan), sireId);

        assertEq(chan.balanceOf(sireOwner), sireOwnerBefore + 3);
        assertEq(chan.balanceOf(burnAddr), burnBefore, "3*500/10000 floors to 0");
        assertEq(chan.balanceOf(multisig), multisigBefore, "3*300/10000 floors to 0");
        assertEq(callerBefore - chan.balanceOf(matronOwner), BIRTH_FEE + 3, "no dust ever collected beyond the floor");
    }

    /// @notice REQUIRED COVERAGE: fuzz listedFee including dust where bps
    /// truncates - the sum of the parts (sireOwner + burn + multisig) must
    /// never exceed the caller's total debit for the siring leg.
    function testFuzz_Fee_SiringPartsNeverExceedDebit(uint96 listedFeeRaw) public {
        uint256 listedFee = uint256(listedFeeRaw) % 10_000_000 ether; // keep caller solvent (FUND_AMOUNT headroom)
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(sireOwner, hcGenesA);

        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), sireId, uint128(listedFee));

        // Fund the caller exactly enough (plus a small safety margin) so a
        // silent overcharge would be caught by the transferFrom running out
        // of allowance/balance, not just by the assertion below.
        uint256 exactDebit = BIRTH_FEE + listedFee + (listedFee * 500) / 10000 + (listedFee * 300) / 10000;
        chan.mint(matronOwner, exactDebit); // top up in case FUND_AMOUNT is short for large fuzzed fees

        uint256 callerBefore = chan.balanceOf(matronOwner);
        uint256 sireOwnerBefore = chan.balanceOf(sireOwner);
        uint256 burnBefore = chan.balanceOf(burnAddr);
        uint256 multisigBefore = chan.balanceOf(multisig);

        _breed(matronOwner, address(girlfriends), matronId, address(hoodchan), sireId);

        uint256 sireOwnerGain = chan.balanceOf(sireOwner) - sireOwnerBefore;
        uint256 burnGain = chan.balanceOf(burnAddr) - burnBefore;
        uint256 multisigGain = chan.balanceOf(multisig) - multisigBefore;
        uint256 totalDebit = callerBefore - chan.balanceOf(matronOwner);

        assertEq(sireOwnerGain, listedFee);
        assertEq(burnGain, (listedFee * 500) / 10000);
        assertEq(multisigGain, (listedFee * 300) / 10000);
        assertLe(
            sireOwnerGain + burnGain + multisigGain + BIRTH_FEE,
            totalDebit + 0, // parts must sum to exactly the debit (never exceed it)
            "sum of parts must never exceed the caller's total debit"
        );
        assertEq(sireOwnerGain + burnGain + multisigGain + BIRTH_FEE, totalDebit, "parts must reconcile exactly");
    }

    // ---------------------------------------------------------------
    // Cooldowns
    // ---------------------------------------------------------------

    function test_Cooldown_LadderEscalatesExactlyAndCaps() public {
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

        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);

        for (uint256 i = 0; i < 16; i++) {
            uint256 sireId = _mintGirlfriend(matronOwner, gfGenesB); // fresh, self-owned disposable sire each round
            uint256 t0 = block.timestamp;

            _breed(matronOwner, address(girlfriends), matronId, address(girlfriends), sireId);

            (uint32 breedCount, uint64 cooldownEnd) = controller.breedState(address(girlfriends), matronId);
            uint256 expectedIdx = i >= ladder.length ? ladder.length - 1 : i;
            assertEq(breedCount, i + 1, "breedCount must increment by exactly 1 each breed");
            assertEq(cooldownEnd, t0 + ladder[expectedIdx], "cooldownEnd must follow the ladder exactly");

            vm.warp(cooldownEnd); // exactly at cooldownEnd - >= means this has legitimately elapsed
        }
    }

    function test_Cooldown_BreedingDuringMatronCooldownReverts() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId1 = _mintGirlfriend(matronOwner, gfGenesB);
        _breed(matronOwner, address(girlfriends), matronId, address(girlfriends), sireId1);

        uint256 sireId2 = _mintGirlfriend(matronOwner, gfGenesB);
        vm.prank(matronOwner);
        vm.expectRevert(BreedingController.MatronOnCooldown.selector);
        controller.breed(address(girlfriends), matronId, address(girlfriends), sireId2, type(uint256).max, type(uint256).max);
    }

    function test_Cooldown_BreedingDuringSireCooldownReverts() public {
        uint256 matronId1 = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintGirlfriend(matronOwner, gfGenesB);
        _breed(matronOwner, address(girlfriends), matronId1, address(girlfriends), sireId);

        uint256 matronId2 = _mintGirlfriend(matronOwner, gfGenesA);
        vm.prank(matronOwner);
        vm.expectRevert(BreedingController.SireOnCooldown.selector);
        controller.breed(address(girlfriends), matronId2, address(girlfriends), sireId, type(uint256).max, type(uint256).max);
    }

    function test_Cooldown_FreshBabyStartsAtLadderBottom() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(sireOwner, hcGenesA);
        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), sireId, 0);

        uint256 babyId = _breed(matronOwner, address(girlfriends), matronId, address(hoodchan), sireId);
        (uint32 breedCountBefore,) = controller.breedState(address(babies), babyId);
        assertEq(breedCountBefore, 0, "a fresh baby has never bred - breedCount 0");

        // Immediately breedable (no cooldown yet) - baby as matron, a fresh
        // disposable sire.
        uint256 freshSireId = _mintGirlfriend(matronOwner, gfGenesB);
        uint256 t0 = block.timestamp;
        _breed(matronOwner, address(babies), babyId, address(girlfriends), freshSireId);

        (uint32 breedCountAfter, uint64 cooldownEndAfter) = controller.breedState(address(babies), babyId);
        assertEq(breedCountAfter, 1);
        assertEq(cooldownEndAfter, t0 + 60, "a baby's first cooldown is the ladder's bottom rung (60s)");
    }

    function test_Cooldown_KeyedByCollectionAndTokenId_HoodchanAndBabiesDoNotCollide() public {
        // HOODCHAN token #1 as SIRE for the very first breed() call in this
        // test - a single breed both (a) puts HOODCHAN #1 on cooldown (any
        // participation, matron OR sire, enters cooldown) and (b) mints the
        // FIRST-EVER Baby, which (HoodchanBabies.nextTokenId starting at 1,
        // same as MockHoodchan) also gets tokenId 1 - the numeric-id
        // collision this test exists to prove is harmless.
        uint256 hcId = _mintHoodchan(sireOwner, hcGenesA);
        assertEq(hcId, 1, "test assumes this is the first HOODCHAN token minted");
        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), hcId, 0);

        uint256 gfMatron = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 babyId = _breed(matronOwner, address(girlfriends), gfMatron, address(hoodchan), hcId);
        assertEq(babyId, 1, "test assumes this is the first Baby token minted");

        (uint32 hcBreedCount, uint64 hcCooldownEnd) = controller.breedState(address(hoodchan), hcId);
        assertEq(hcBreedCount, 1);
        assertGt(hcCooldownEnd, block.timestamp, "HOODCHAN #1 must be on cooldown now (used as sire)");

        (uint32 babyBreedCount, uint64 babyCooldownEnd) = controller.breedState(address(babies), babyId);
        assertEq(babyBreedCount, 0, "Babies #1's cooldown state must be independent of HOODCHAN #1's");
        assertEq(babyCooldownEnd, 0, "Babies #1 has never bred - composite (collection,tokenId) key proves it");

        // Behavioral proof: Babies #1 can breed immediately even though
        // HOODCHAN #1 (same numeric id, different collection) cannot.
        // hcId is owned by sireOwner (see setup above) - caller must be
        // sireOwner to reach the cooldown check at all, rather than
        // reverting earlier on ownership. Mint the disposable sire BEFORE
        // pranking - vm.prank only affects the very next CALL, and
        // evaluating this as an inline argument would consume the prank on
        // the mint instead of on breed().
        uint256 stillOnCooldownSire = _mintGirlfriend(sireOwner, gfGenesB);
        vm.prank(sireOwner);
        vm.expectRevert(BreedingController.MatronOnCooldown.selector);
        controller.breed(address(hoodchan), hcId, address(girlfriends), stillOnCooldownSire, type(uint256).max, type(uint256).max);

        uint256 freshSire = _mintGirlfriend(matronOwner, gfGenesB);
        _breed(matronOwner, address(babies), babyId, address(girlfriends), freshSire); // must NOT revert
    }

    // ---------------------------------------------------------------
    // Reentrancy
    // ---------------------------------------------------------------

    function test_Reentrancy_MaliciousOwnerOfMustFailWholeBreed() public {
        MaliciousReentrant evil = new MaliciousReentrant();
        controller.setBreedableCollection(address(evil), true, BreedingController.CollectionSex.Male);
        evil.setController(address(controller));
        evil.mintTo(matronOwner, 1, hcGenesA);

        uint256 realSire = _mintGirlfriend(sireOwner, gfGenesB);
        vm.prank(sireOwner);
        controller.listSiring(address(girlfriends), realSire, 0);

        evil.setReentryArgs(address(evil), 1, address(girlfriends), realSire);
        evil.setReenterOnOwnerOf(true);

        vm.prank(matronOwner);
        // Reverts regardless of exact reason - either the STATICCALL's own
        // read-only restriction or the nonReentrant guard rejects the
        // nested breed() call, and that revert must bubble all the way up.
        vm.expectRevert();
        controller.breed(address(evil), 1, address(girlfriends), realSire, type(uint256).max, type(uint256).max);
    }

    function test_Reentrancy_MaliciousGenesOfMustFailWholeBreed() public {
        MaliciousReentrant evil = new MaliciousReentrant();
        controller.setBreedableCollection(address(evil), true, BreedingController.CollectionSex.Male);
        evil.setController(address(controller));
        evil.mintTo(sireOwner, 1, hcGenesA);

        uint256 realMatron = _mintGirlfriend(matronOwner, gfGenesA);
        evil.setReentryArgs(address(girlfriends), realMatron, address(evil), 1);
        evil.setReenterOnGenesOf(true);

        vm.prank(sireOwner);
        controller.listSiring(address(evil), 1, 0);

        vm.prank(matronOwner);
        vm.expectRevert();
        controller.breed(address(girlfriends), realMatron, address(evil), 1, type(uint256).max, type(uint256).max);
    }

    function test_Reentrancy_MaliciousOnERC721ReceivedMustFailWholeBreed() public {
        MaliciousReentrant evil = new MaliciousReentrant();
        // The matron is OWNED by `evil` - the baby mint's _safeMint call
        // targets `evil`, reaching its onERC721Received hook.
        uint256 matronId = _mintGirlfriend(address(evil), gfGenesA);
        uint256 sireId = _mintHoodchan(sireOwner, hcGenesA);
        vm.prank(sireOwner);
        controller.listSiring(address(hoodchan), sireId, 0);

        evil.setController(address(controller));
        evil.setReentryArgs(address(girlfriends), matronId, address(hoodchan), sireId);
        evil.setReenterOnReceive(true);
        _fund(address(evil));

        vm.prank(address(evil));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, type(uint256).max, type(uint256).max);
    }

    // ---------------------------------------------------------------
    // HOODCHAN adapter trust point
    // ---------------------------------------------------------------

    function test_Breed_HoodchanUnsyncedGenesReverts() public {
        uint256 hcId = hoodchan.mint(matronOwner); // never synced
        uint256 sireId = _mintGirlfriend(matronOwner, gfGenesB);

        vm.prank(matronOwner);
        vm.expectRevert(BreedingController.GenesNotSet.selector);
        controller.breed(address(hoodchan), hcId, address(girlfriends), sireId, type(uint256).max, type(uint256).max);
    }

    // ---------------------------------------------------------------
    // Cross-collection pairings + interface parity
    // ---------------------------------------------------------------

    function test_Breed_HoodchanMatronXGirlfriendSire() public {
        uint256 matronId = _mintHoodchan(matronOwner, hcGenesA);
        uint256 sireId = _mintGirlfriend(matronOwner, gfGenesB);
        uint256 babyId = _breed(matronOwner, address(hoodchan), matronId, address(girlfriends), sireId);
        assertEq(babies.ownerOf(babyId), matronOwner);
    }

    function test_Breed_GirlfriendMatronXHoodchanSire() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(matronOwner, hcGenesB);
        uint256 babyId = _breed(matronOwner, address(girlfriends), matronId, address(hoodchan), sireId);
        assertEq(babies.ownerOf(babyId), matronOwner);
    }

    function test_Breed_HoodchanXHoodchanSameSexFeeApplies() public {
        uint256 matronId = _mintHoodchan(matronOwner, hcGenesA);
        uint256 sireId = _mintHoodchan(matronOwner, hcGenesB); // both Male -> same-sex tier
        uint256 before = chan.balanceOf(matronOwner);
        _breed(matronOwner, address(hoodchan), matronId, address(hoodchan), sireId);
        assertEq(before - chan.balanceOf(matronOwner), BIRTH_FEE * SAME_SEX_MULTIPLIER);
    }

    function test_Breed_GirlfriendXGirlfriendSameSexFeeApplies() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintGirlfriend(matronOwner, gfGenesB); // both Female -> same-sex tier
        uint256 before = chan.balanceOf(matronOwner);
        _breed(matronOwner, address(girlfriends), matronId, address(girlfriends), sireId);
        assertEq(before - chan.balanceOf(matronOwner), BIRTH_FEE * SAME_SEX_MULTIPLIER);
    }

    function test_Breed_BabyXBabyBothDirections() public {
        // Produce two independent babies first (opposite-sex parents so we
        // get a mix of baby sexes cheaply across runs; either sex works for
        // this test since Baby collection is PerToken either way).
        uint256 gfM1 = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 hcS1 = _mintHoodchan(matronOwner, hcGenesA);
        uint256 babyA = _breed(matronOwner, address(girlfriends), gfM1, address(hoodchan), hcS1);

        uint256 gfM2 = _mintGirlfriend(matronOwner, gfGenesB);
        uint256 hcS2 = _mintHoodchan(matronOwner, hcGenesB);
        uint256 babyB = _breed(matronOwner, address(girlfriends), gfM2, address(hoodchan), hcS2);

        assertTrue(babyA != babyB);

        // Baby as matron AND Baby as sire, in the same breed.
        uint256 grandbaby = _breed(matronOwner, address(babies), babyA, address(babies), babyB);
        assertEq(babies.ownerOf(grandbaby), matronOwner);

        // Role-reversed: same two babies, swap matron/sire (need fresh
        // cooldown - warp far past the ladder cap).
        vm.warp(block.timestamp + 8 days);
        uint256 grandbaby2 = _breed(matronOwner, address(babies), babyB, address(babies), babyA);
        assertEq(babies.ownerOf(grandbaby2), matronOwner);
        assertTrue(grandbaby2 != grandbaby);
    }

    function test_InterfaceParity_GenesOfWorksAcrossGirlfriendsAndBabies() public {
        uint256 gfId = _mintGirlfriend(matronOwner, gfGenesA);
        assertEq(IBreedable(address(girlfriends)).genesOf(gfId)[0], gfGenesA[0]);

        uint256 hcS = _mintHoodchan(matronOwner, hcGenesA);
        uint256 babyId = _breed(matronOwner, address(girlfriends), gfId, address(hoodchan), hcS);
        uint8[5] memory babyGenes = IBreedable(address(babies)).genesOf(babyId);
        assertEq(babyGenes.length, 5);
    }

    // ---------------------------------------------------------------
    // Genetics end-to-end: determinism, sex bit, test-tube badge
    // ---------------------------------------------------------------

    function test_Genome_MatchesGeneticsLibDirectly() public {
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(matronOwner, hcGenesA);

        uint256 nonceBefore = controller.breedNonce();
        uint256 expectedSeed =
            GeneticsLib.breedingSeed(address(girlfriends), matronId, address(hoodchan), sireId, nonceBefore);
        uint8[5] memory expectedGenome = GeneticsLib.resolveGenome(gfGenesA, hcGenesA, expectedSeed);
        bool expectedBabyIsMale = GeneticsLib.resolveBabyIsMale(expectedSeed);

        uint256 babyId = _breed(matronOwner, address(girlfriends), matronId, address(hoodchan), sireId);

        assertEq(controller.breedNonce(), nonceBefore + 1, "breedNonce must increment exactly once per breed");
        assertEq(babies.breedingSeedOf(babyId), expectedSeed);
        uint8[5] memory genome = babies.genesOf(babyId);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(genome[i], expectedGenome[i]);
        }
        assertEq(babies.sexOf(babyId), expectedBabyIsMale);
    }

    function test_Genome_IsTestTubeBadgeSetIffSameSex() public {
        // Opposite sex (Girlfriend x Hoodchan) -> not a test-tube baby.
        uint256 gfM = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 hcS = _mintHoodchan(matronOwner, hcGenesA);
        uint256 babyOpp = _breed(matronOwner, address(girlfriends), gfM, address(hoodchan), hcS);
        assertFalse(babies.isTestTubeBaby(babyOpp));

        // Same sex (Girlfriend x Girlfriend) -> test-tube baby.
        uint256 gfM2 = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 gfS2 = _mintGirlfriend(matronOwner, gfGenesB);
        uint256 babySame = _breed(matronOwner, address(girlfriends), gfM2, address(girlfriends), gfS2);
        assertTrue(babies.isTestTubeBaby(babySame));
    }

    function testFuzz_Genetics_DeterminismAcrossRepeatedBreedsWithSameInputs(uint8 seedSalt) public {
        // Two independent breed() calls can never share identical
        // (matronCollection,matronId,sireCollection,sireId,nonce) inputs in
        // practice (nonce is global and monotonic), but the underlying
        // library call is pure and deterministic - assert that directly as
        // the on-chain integration's foundation.
        uint256 matronId = _mintGirlfriend(matronOwner, gfGenesA);
        uint256 sireId = _mintHoodchan(matronOwner, hcGenesA);
        uint256 nonce = uint256(seedSalt);
        uint256 seedA =
            GeneticsLib.breedingSeed(address(girlfriends), matronId, address(hoodchan), sireId, nonce);
        uint256 seedB =
            GeneticsLib.breedingSeed(address(girlfriends), matronId, address(hoodchan), sireId, nonce);
        assertEq(seedA, seedB);
    }
}
