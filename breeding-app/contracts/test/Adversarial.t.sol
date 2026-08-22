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
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, quoted);
        assertEq(chan.balanceOf(buyer), buyerBefore, "buyer must not be debited at all");

        // The honest path still works: at the quoted price the breed lands
        // and costs exactly quote + 8% + birth fee.
        vm.prank(attacker);
        controller.listSiring(address(hoodchan), sireId, 1 ether);
        vm.prank(buyer);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, quoted);
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
        controller.breed(address(hoodchan), matronId, address(girlfriends), sireId, 7 ether);
        assertEq(chan.balanceOf(attacker), FUND + 7 ether, "exact-price match must succeed");
    }

    /// @dev Self-siring reads no listing at all, so maxSiringFee == 0 must
    /// never block it.
    function test_SelfSiringUnaffectedByZeroMaxSiringFee() public {
        uint256 matronId = girlfriends.mint(buyer, gA);
        uint256 sireId = hoodchan.mint(buyer);
        controller.setHoodchanGenes(sireId, gB);
        vm.prank(buyer);
        controller.breed(address(girlfriends), matronId, address(hoodchan), sireId, 0);
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
        controller.breed(address(girlfriends), matronId, address(girlfriends), sireId, type(uint256).max);

        (uint32 breedCount,) = controller.breedState(address(girlfriends), sireId);
        assertEq(breedCount, 0, "victim's token must not have been used as a sire");

        // The victim CAN re-list it themselves, and then it works again.
        vm.prank(victim);
        controller.listSiring(address(girlfriends), sireId, 0);
        vm.prank(buyer);
        controller.breed(address(girlfriends), matronId, address(girlfriends), sireId, type(uint256).max);
        (uint32 breedCountAfter,) = controller.breedState(address(girlfriends), sireId);
        assertEq(breedCountAfter, 1, "new owner's own explicit listing must work");
    }

    /// @dev Round-trip: token leaves and comes BACK to the original lister.
    /// The listing is keyed to the lister identity, not a nonce, so it is
    /// live again - acceptable (that address did explicitly opt in and is
    /// the current owner), and asserted here so the behaviour is a
    /// decision rather than an accident.
    function test_ListingRevivesIfTokenReturnsToTheOriginalLister() public {
        uint256 sireId = girlfriends.mint(attacker, gB);
        vm.prank(attacker);
        controller.listSiring(address(girlfriends), sireId, 0);
        vm.prank(attacker);
        girlfriends.transferFrom(attacker, victim, sireId);
        vm.prank(victim);
        girlfriends.transferFrom(victim, attacker, sireId);

        uint256 matronId = girlfriends.mint(buyer, gA);
        vm.prank(buyer);
        controller.breed(address(girlfriends), matronId, address(girlfriends), sireId, type(uint256).max);
        (uint32 breedCount,) = controller.breedState(address(girlfriends), sireId);
        assertEq(breedCount, 1);
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
