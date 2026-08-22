// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BreedingController} from "../src/BreedingController.sol";
import {HoodchanBabies} from "../src/HoodchanBabies.sol";
import {HoodchanGirlfriends} from "../src/HoodchanGirlfriends.sol";
import {MockHoodchan} from "./mocks/MockHoodchan.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract AdversarialTest is Test {
    BreedingController internal controller;
    HoodchanBabies internal babies;
    HoodchanGirlfriends internal girlfriends;
    MockHoodchan internal hoodchan;
    MockERC20 internal chan;

    address internal owner = address(this);
    address internal treasury = address(0x7EA5);
    address internal burnAddr = address(0xB0122);
    address internal multisig = address(0x115);

    address internal victim = address(0xC71C71);
    address internal attacker = address(0xA77AC);
    address internal buyer = address(0xB0FFE);

    uint256 internal constant BIRTH_FEE = 100 ether;
    uint256 internal constant FUND = 1_000_000 ether;

    uint8[5] internal gA = [uint8(10), 20, 30, 40, 50];
    uint8[5] internal gB = [uint8(200), 190, 180, 170, 160];

    function setUp() public {
        hoodchan = new MockHoodchan();
        girlfriends = new HoodchanGirlfriends(owner);
        babies = new HoodchanBabies(owner);
        chan = new MockERC20();
        controller = new BreedingController(
            owner, address(hoodchan), address(babies), address(chan), treasury, burnAddr, multisig, BIRTH_FEE, 2
        );
        babies.setBreedingController(address(controller));
        controller.setBreedableCollection(address(hoodchan), true, BreedingController.CollectionSex.Male);
        controller.setBreedableCollection(address(girlfriends), true, BreedingController.CollectionSex.Female);
        controller.setBreedableCollection(address(babies), true, BreedingController.CollectionSex.PerToken);
        vm.warp(1_000_000);
        _fund(victim);
        _fund(attacker);
        _fund(buyer);
    }

    function _fund(address who) internal {
        chan.mint(who, FUND);
        vm.prank(who);
        chan.approve(address(controller), type(uint256).max); // exactly what a normal frontend does
    }

    // =================================================================
    // REGRESSION (was: unbounded siring price). The sire's owner is an
    // UNTRUSTED counterparty who can raise `price` between the moment the
    // buyer reads it and the moment the buyer's tx executes. Without the
    // `maxSiringFee` bound this drained the buyer's whole CHAN allowance
    // (540,100 CHAN charged against a 1 CHAN quote, 100% to the attacker).
    // =================================================================
    function test_SiringPriceFrontRunIsRejectedByMaxSiringFee() public {
        uint256 sireId = hoodchan.mint(attacker);
        controller.setHoodchanGenes(sireId, gB);
        uint256 matronId = girlfriends.mint(buyer, gA);

        // Buyer reads the listing off-chain: 1 CHAN. Cheap, agrees, signs
        // with maxSiringFee == their quote.
        vm.prank(attacker);
        controller.listSiring(address(hoodchan), sireId, 1 ether);
        (uint128 quoted,,) = controller.siringListings(address(hoodchan), sireId);
        assertEq(quoted, 1 ether, "buyer's quote");

        // Attacker front-runs the buyer's pending breed() with a re-list.
        vm.prank(attacker);
        controller.listSiring(address(hoodchan), sireId, uint128(500_000 ether));

        uint256 buyerBefore = chan.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(BreedingController.SiringFeeTooHigh.selector);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, quoted, type(uint256).max);
        assertEq(chan.balanceOf(buyer), buyerBefore, "buyer must not be debited at all");

        // The honest path still works: at the quoted price the breed lands
        // and costs exactly quote + 8% + birth fee.
        vm.prank(attacker);
        controller.listSiring(address(hoodchan), sireId, 1 ether);
        vm.prank(buyer);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, quoted, type(uint256).max);
        assertEq(buyerBefore - chan.balanceOf(buyer), BIRTH_FEE + 1 ether + 0.08 ether);
    }

    /// @dev A price EQUAL to maxSiringFee must be accepted (the bound is a
    /// ceiling, not a strict inequality) - guards the obvious off-by-one.
    function test_MaxSiringFeeIsInclusive() public {
        uint256 sireId = girlfriends.mint(attacker, gB);
        uint256 matronId = hoodchan.mint(buyer);
        controller.setHoodchanGenes(matronId, gA);
        vm.prank(attacker);
        controller.listSiring(address(girlfriends), sireId, 7 ether);

        vm.prank(buyer);
        controller.breed(address(hoodchan), matronId, address(girlfriends), sireId, 7 ether, type(uint256).max);
        assertEq(chan.balanceOf(attacker), FUND + 7 ether, "exact-price match must succeed");
    }

    /// @dev Self-siring reads no listing at all, so maxSiringFee == 0 must
    /// never block it.
    function test_SelfSiringUnaffectedByZeroMaxSiringFee() public {
        uint256 matronId = girlfriends.mint(buyer, gA);
        uint256 sireId = hoodchan.mint(buyer);
        controller.setHoodchanGenes(sireId, gB);
        vm.prank(buyer);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, 0, type(uint256).max);
    }

    // =================================================================
    // REGRESSION (was: siring listings survived a transfer of the sire).
    // The NEW owner never opted in, yet their token was publicly
    // siring-available on the OLD owner's terms (here: free), letting
    // anyone permanently escalate its cooldown ladder for nothing.
    // =================================================================
    function test_StaleListingDoesNotSurviveTransfer() public {
        uint256 sireId = girlfriends.mint(attacker, gB);

        // Old owner lists it free, then sells it to the victim.
        vm.prank(attacker);
        controller.listSiring(address(girlfriends), sireId, 0);
        vm.prank(attacker);
        girlfriends.transferFrom(attacker, victim, sireId);
        assertEq(girlfriends.ownerOf(sireId), victim);

        // Victim never listed anything - the stale listing must confer
        // nothing.
        uint256 matronId = girlfriends.mint(buyer, gA);
        vm.prank(buyer);
        vm.expectRevert(BreedingController.SireNotAvailable.selector);
        controller.breed(address(girlfriends), matronId, address(girlfriends), sireId, type(uint256).max, type(uint256).max);

        (uint32 breedCount,) = controller.breedState(address(girlfriends), sireId);
        assertEq(breedCount, 0, "victim's token must not have been used as a sire");

        // The victim CAN re-list it themselves, and then it works again.
        vm.prank(victim);
        controller.listSiring(address(girlfriends), sireId, 0);
        vm.prank(buyer);
        controller.breed(address(girlfriends), matronId, address(girlfriends), sireId, type(uint256).max, type(uint256).max);
        (uint32 breedCountAfter,) = controller.breedState(address(girlfriends), sireId);
        assertEq(breedCountAfter, 1, "new owner's own explicit listing must work");
    }

    // =================================================================
    // clearStaleListing: HOODCHAN (and any other externally-owned
    // collection) exposes no transfer hook this contract can subscribe to,
    // so a listing cannot be cleared AT the moment the token moves. Instead
    // it goes stale-but-not-deleted (see test_StaleListingDoesNotSurviveTransfer
    // above - `breed()` already refuses to honor it once `lister !=
    // ownerOf`). The residual gap this section covers: if the token
    // ROUND-TRIPS back to the SAME `lister` address before anyone deletes
    // the stale listing, `lister == ownerOf` becomes true again and the
    // listing silently REVIVES. `clearStaleListing` is the permissionless
    // mitigation - anyone can delete a stale listing the instant they
    // observe it, closing the window if called in time.
    // =================================================================

    /// @dev REPLACES the old `test_ListingRevivesIfTokenReturnsToTheOriginalLister`,
    /// which asserted the revival as INTENDED with no mitigation at all.
    /// The v2-corrected design: revival is only a REAL risk if nobody calls
    /// `clearStaleListing` in the window before the token comes back - here
    /// an unrelated third party (`buyer`) does exactly that, and the
    /// round-trip must NOT revive the listing afterwards.
    function test_ClearStaleListing_PreventsRevivalWhenTokenReturnsToOriginalLister() public {
        uint256 sireId = girlfriends.mint(attacker, gB);
        vm.prank(attacker);
        controller.listSiring(address(girlfriends), sireId, 0);
        vm.prank(attacker);
        girlfriends.transferFrom(attacker, victim, sireId);

        // Permissionless: an unrelated third party clears the now-stale
        // listing before the token has any chance to round-trip back.
        vm.expectEmit(true, true, true, true, address(controller));
        emit BreedingController.StaleListingCleared(address(girlfriends), sireId, attacker, victim);
        vm.prank(buyer);
        controller.clearStaleListing(address(girlfriends), sireId);
        (, bool listedAfterClear,) = controller.siringListings(address(girlfriends), sireId);
        assertFalse(listedAfterClear, "clearStaleListing must delete the listing entirely");

        // Token round-trips back to the original lister.
        vm.prank(victim);
        girlfriends.transferFrom(victim, attacker, sireId);
        assertEq(girlfriends.ownerOf(sireId), attacker);

        // No revival: the listing was already deleted, so breeding against
        // it must revert exactly like any other never-listed token.
        uint256 matronId = girlfriends.mint(buyer, gA);
        vm.prank(buyer);
        vm.expectRevert(BreedingController.SireNotAvailable.selector);
        controller.breed(
            address(girlfriends), matronId, address(girlfriends), sireId, type(uint256).max, type(uint256).max
        );
        (uint32 breedCount,) = controller.breedState(address(girlfriends), sireId);
        assertEq(breedCount, 0, "cleared-then-returned token must not have been usable as a sire");
    }

    /// @dev The HONEST residual window, documented as a test rather than
    /// left implicit: if nobody calls `clearStaleListing` before the token
    /// round-trips back to the original lister, the listing DOES revive -
    /// this is the accepted gap `clearStaleListing` mitigates but cannot
    /// fully close on its own (no transfer hook exists to force it).
    function test_ListingRevivesIfNobodyClearsBeforeTokenReturns() public {
        uint256 sireId = girlfriends.mint(attacker, gB);
        vm.prank(attacker);
        controller.listSiring(address(girlfriends), sireId, 0);
        vm.prank(attacker);
        girlfriends.transferFrom(attacker, victim, sireId);
        // Nobody calls clearStaleListing here - the residual window.
        vm.prank(victim);
        girlfriends.transferFrom(victim, attacker, sireId);

        uint256 matronId = girlfriends.mint(buyer, gA);
        vm.prank(buyer);
        controller.breed(
            address(girlfriends), matronId, address(girlfriends), sireId, type(uint256).max, type(uint256).max
        );
        (uint32 breedCount,) = controller.breedState(address(girlfriends), sireId);
        assertEq(breedCount, 1, "uncleared listing legitimately revives once lister == ownerOf again");
    }

    /// @dev Calling clearStaleListing on a listing that is NOT actually
    /// stale (lister still owns the token) must revert - this is a
    /// targeted cleanup tool, not a way to grief a live listing.
    function test_ClearStaleListing_RevertsIfListingStillLive() public {
        uint256 sireId = girlfriends.mint(attacker, gB);
        vm.prank(attacker);
        controller.listSiring(address(girlfriends), sireId, 0);

        vm.expectRevert(BreedingController.ListingNotStale.selector);
        controller.clearStaleListing(address(girlfriends), sireId);
    }

    /// @dev Calling clearStaleListing on a token with no listing at all
    /// must revert distinctly from "listing still live".
    function test_ClearStaleListing_RevertsIfNoListingExists() public {
        uint256 sireId = girlfriends.mint(attacker, gB);
        vm.expectRevert(BreedingController.ListingDoesNotExist.selector);
        controller.clearStaleListing(address(girlfriends), sireId);
    }

    // =================================================================
    // REGRESSION (was: unbounded birth-fee front-run). `maxSiringFee`
    // bounds only the siring PRICE leg - it did nothing to stop the owner
    // from raising `birthFee` between the moment a caller reads it
    // off-chain and the moment their breed() tx lands, silently
    // overcharging the birth-fee leg with the caller's usual unlimited
    // CHAN allowance.
    // =================================================================
    function test_BirthFeeFrontRunIsRejectedByMaxTotalFee() public {
        uint256 matronId = girlfriends.mint(buyer, gA);
        uint256 sireId = hoodchan.mint(buyer);
        controller.setHoodchanGenes(sireId, gB);

        // Buyer reads the current birth fee off-chain and quotes it.
        uint256 quotedBirthFee = controller.birthFee();
        assertEq(quotedBirthFee, BIRTH_FEE);

        // Owner front-runs the buyer's pending breed() with a fee hike.
        controller.setBirthFee(BIRTH_FEE * 100);

        uint256 buyerBefore = chan.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(BreedingController.TotalFeeTooHigh.selector);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, 0, quotedBirthFee);
        assertEq(chan.balanceOf(buyer), buyerBefore, "buyer must not be debited at all");

        // Honest path: at the originally quoted fee, breed lands and costs
        // exactly the quote.
        controller.setBirthFee(BIRTH_FEE);
        vm.prank(buyer);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, 0, quotedBirthFee);
        assertEq(buyerBefore - chan.balanceOf(buyer), BIRTH_FEE, "honest path costs exactly the quoted birth fee");
    }

    /// @dev A total fee EQUAL to maxTotalFee must be accepted (ceiling, not
    /// a strict inequality) - same off-by-one guard as maxSiringFee's.
    function test_MaxTotalFeeIsInclusive() public {
        uint256 sireId = girlfriends.mint(attacker, gB);
        uint256 matronId = hoodchan.mint(buyer);
        controller.setHoodchanGenes(matronId, gA);
        vm.prank(attacker);
        controller.listSiring(address(girlfriends), sireId, 7 ether);

        uint256 exactTotal = BIRTH_FEE + 7 ether + (7 ether * 500) / 10000 + (7 ether * 300) / 10000;
        vm.prank(buyer);
        controller.breed(address(hoodchan), matronId, address(girlfriends), sireId, 7 ether, exactTotal);
        assertEq(chan.balanceOf(attacker), FUND + 7 ether, "exact-total match must succeed");
    }

    // =================================================================
    // Birth fee floor: a birth fee of 0 would make EVERY breed free (not
    // just same-sex ones), contradicting "birth fee charged on EVERY
    // breed, no exceptions" and defunding the per-baby art-gen cost.
    // =================================================================
    function test_BirthFeeOfZeroRejected() public {
        vm.expectRevert(BreedingController.InvalidBirthFee.selector);
        controller.setBirthFee(0);

        vm.expectRevert(BreedingController.InvalidBirthFee.selector);
        new BreedingController(
            owner, address(hoodchan), address(babies), address(chan), treasury, burnAddr, multisig, 0, 2
        );
    }

    // =================================================================
    // Same-sex multiplier floor: a multiplier of 0 would make same-sex
    // breeding entirely free, contradicting "birth fee charged on EVERY
    // breed, no exceptions".
    // =================================================================
    function test_SameSexMultiplierBelowOneRejected() public {
        vm.expectRevert(BreedingController.InvalidMultiplier.selector);
        controller.setSameSexFeeMultiplier(0);

        vm.expectRevert(BreedingController.InvalidMultiplier.selector);
        new BreedingController(
            owner, address(hoodchan), address(babies), address(chan), treasury, burnAddr, multisig, BIRTH_FEE, 0
        );
    }
}
