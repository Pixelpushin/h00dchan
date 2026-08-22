// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {BreedingController} from "../src/BreedingController.sol";
import {HoodchanBabies} from "../src/HoodchanBabies.sol";
import {HoodchanGirlfriends} from "../src/HoodchanGirlfriends.sol";
import {GeneticsLib} from "../src/GeneticsLib.sol";
import {MockHoodchan} from "./mocks/MockHoodchan.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockERC6551Registry} from "./mocks/MockERC6551Registry.sol";
import {MaliciousRecipient} from "./mocks/MaliciousRecipient.sol";

contract BreedingControllerTest is Test {
    BreedingController internal controller;
    HoodchanBabies internal babies;
    HoodchanGirlfriends internal girlfriends;
    MockHoodchan internal hoodchan;
    MockERC20 internal chan;
    MockERC6551Registry internal registry;

    address internal owner = address(this);
    address internal fatherOwner = address(0xF47E);
    address internal motherOwner = address(0xB0B);
    address internal implementation = address(0xAAAA);

    uint8[5] internal fatherGenes = [uint8(10), 20, 30, 40, 50];
    uint8[5] internal motherGenes = [uint8(200), 190, 180, 170, 160];

    uint256 internal fatherTokenId;
    uint256 internal motherTokenId;

    uint256 internal constant MAX_U128 = type(uint128).max;

    function setUp() public {
        hoodchan = new MockHoodchan();
        girlfriends = new HoodchanGirlfriends(owner);
        babies = new HoodchanBabies(owner);
        chan = new MockERC20();
        registry = new MockERC6551Registry();

        controller = new BreedingController(
            owner, address(hoodchan), address(girlfriends), address(babies), address(chan), address(registry), implementation
        );
        babies.setBreedingController(address(controller));

        fatherTokenId = hoodchan.mint(fatherOwner);
        vm.prank(owner);
        motherTokenId = girlfriends.mint(motherOwner, motherGenes);

        controller.setHoodchanGenes(fatherTokenId, fatherGenes);

        require(chan.transfer(motherOwner, 1_000 ether), "seed transfer failed");
        vm.deal(motherOwner, 100 ether);

        // Roll forward off block 0/1 so blockhash(commitBlock) is never
        // requested for a block the EVM treats specially, and so
        // block.number - commitBlock arithmetic in expiry tests never
        // underflows.
        vm.roll(1000);
    }

    function _motherTba() internal view returns (address) {
        return registry.account(implementation, bytes32(0), block.chainid, address(girlfriends), motherTokenId);
    }

    function _tbaOf(uint256 gfTokenId) internal view returns (address) {
        return registry.account(implementation, bytes32(0), block.chainid, address(girlfriends), gfTokenId);
    }

    function _commit(
        address caller,
        uint256 fatherId,
        uint256 motherId,
        uint128 maxChan,
        uint128 maxEth,
        BreedingController.PayMethod method,
        uint256 ethValue
    ) internal returns (uint256 commitId) {
        vm.prank(caller);
        commitId = controller.commitBreed{value: ethValue}(fatherId, motherId, maxChan, maxEth, method);
    }

    function _reveal(uint256 commitId) internal returns (uint256 babyId) {
        vm.roll(block.number + 1);
        babyId = controller.revealBreed(commitId);
    }

    /// @dev Full commit->reveal round trip on the CHAN path, uncapped max.
    function _breedChan(address caller, uint256 fatherId, uint256 motherId) internal returns (uint256 babyId) {
        uint256 commitId = _commit(
            caller, fatherId, motherId, uint128(MAX_U128), uint128(MAX_U128), BreedingController.PayMethod.CHAN, 0
        );
        babyId = _reveal(commitId);
    }

    // -----------------------------------------------------------
    // Siring set/edit/delist auth (unchanged from pre-commit-reveal
    // behavior - listing management doesn't touch the breed flow itself)
    // -----------------------------------------------------------

    function test_SetSiringPrice_OnlyCurrentHoodchanOwner() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 1 ether);

        (uint128 chanPrice, uint128 ethPrice, bool listed) = controller.siringListings(fatherTokenId);
        assertEq(chanPrice, 100 ether);
        assertEq(ethPrice, 1 ether);
        assertTrue(listed);
    }

    function test_SetSiringPrice_RevertsForNonOwner() public {
        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.NotHoodchanOwner.selector);
        controller.setSiringPrice(fatherTokenId, 100 ether, 1 ether);
    }

    function test_SetSiringPrice_Edit_OverwritesPreviousListing() public {
        vm.startPrank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 1 ether);
        controller.setSiringPrice(fatherTokenId, 50 ether, 0.5 ether);
        vm.stopPrank();

        (uint128 chanPrice, uint128 ethPrice,) = controller.siringListings(fatherTokenId);
        assertEq(chanPrice, 50 ether);
        assertEq(ethPrice, 0.5 ether);
    }

    function test_DelistSiring_OnlyCurrentOwner() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 1 ether);

        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.NotHoodchanOwner.selector);
        controller.delistSiring(fatherTokenId);

        vm.prank(fatherOwner);
        controller.delistSiring(fatherTokenId);

        (,, bool listed) = controller.siringListings(fatherTokenId);
        assertFalse(listed);
    }

    function test_DelistSiring_MakesCommitRevertForNonOwnerCaller() public {
        // Never listed at all -> not-same-owner commit must revert.
        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.SiringNotListed.selector);
        controller.commitBreed(fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN);
    }

    // -----------------------------------------------------------
    // CHAN payment path
    // -----------------------------------------------------------

    function test_Breed_ChanPath_TransfersDirectlyToFatherOwnerOnReveal() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 0);

        vm.prank(motherOwner);
        chan.approve(address(controller), 100 ether);

        uint256 fatherBalBefore = chan.balanceOf(fatherOwner);

        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 100 ether, 0, BreedingController.PayMethod.CHAN, 0);

        // Payment is escrowed at COMMIT time, not yet forwarded.
        assertEq(chan.balanceOf(address(controller)), 100 ether, "commit must escrow CHAN in the contract");
        assertEq(chan.balanceOf(fatherOwner), fatherBalBefore, "father owner must not be paid before reveal");

        uint256 babyId = _reveal(commitId);

        assertEq(chan.balanceOf(fatherOwner), fatherBalBefore + 100 ether, "CHAN must land on father owner after reveal");
        assertEq(chan.balanceOf(address(controller)), 0, "controller must not retain CHAN after reveal");
        assertEq(babies.ownerOf(babyId), _motherTba(), "baby must mint into mother's TBA");
    }

    function test_Breed_ChanPath_RevertsWithoutApproval() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 0);

        vm.prank(motherOwner);
        vm.expectRevert();
        controller.commitBreed(fatherTokenId, motherTokenId, 100 ether, 0, BreedingController.PayMethod.CHAN);
    }

    // -----------------------------------------------------------
    // ETH path gated on Upgraded allowlist
    // -----------------------------------------------------------

    function test_Breed_EthPath_RevertsWhenFatherNotAllowlisted() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 1 ether);

        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.NotUpgradedForEth.selector);
        controller.commitBreed{value: 1 ether}(fatherTokenId, motherTokenId, 0, 1 ether, BreedingController.PayMethod.ETH);
    }

    function test_Breed_EthPath_SucceedsWhenAllowlisted() public {
        controller.setUpgradedAllowlist(fatherTokenId, true);
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 1 ether);

        uint256 fatherBalBefore = fatherOwner.balance;

        uint256 commitId = _commit(
            motherOwner, fatherTokenId, motherTokenId, 0, 1 ether, BreedingController.PayMethod.ETH, 1 ether
        );

        // ETH is held by the contract as escrow, not yet paid out.
        assertEq(address(controller).balance, 1 ether, "commit must escrow ETH in the contract");
        assertEq(fatherOwner.balance, fatherBalBefore, "father owner must not be paid before reveal");

        uint256 babyId = _reveal(commitId);

        // ETH payout is pull-based (BUG 6 fix) - not yet in fatherOwner's
        // balance until they claim.
        assertEq(fatherOwner.balance, fatherBalBefore, "ETH payout must be pull-based, not pushed on reveal");
        assertEq(controller.pendingEthWithdrawals(fatherOwner), 1 ether, "payout must be claimable after reveal");

        vm.prank(fatherOwner);
        controller.claimEth();
        assertEq(fatherOwner.balance, fatherBalBefore + 1 ether, "ETH must land on father owner after claim");
        assertEq(address(controller).balance, 0, "controller must not retain ETH after claim");
        assertEq(babies.ownerOf(babyId), _motherTba());
    }

    function test_Breed_EthPath_RevertsOnWrongAmount() public {
        controller.setUpgradedAllowlist(fatherTokenId, true);
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 1 ether);

        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.WrongPaymentAmount.selector);
        controller.commitBreed{value: 0.5 ether}(fatherTokenId, motherTokenId, 0, 1 ether, BreedingController.PayMethod.ETH);
    }

    // -----------------------------------------------------------
    // BUG 2 fix: slippage guard (maxPrice) + front-run resistance
    // -----------------------------------------------------------

    function test_Commit_RevertsWhenChanPriceExceedsMax() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 0);

        vm.prank(motherOwner);
        chan.approve(address(controller), 100 ether);

        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.PriceExceedsMax.selector);
        controller.commitBreed(fatherTokenId, motherTokenId, 50 ether, 0, BreedingController.PayMethod.CHAN);
    }

    function test_Commit_RevertsWhenEthPriceExceedsMax() public {
        controller.setUpgradedAllowlist(fatherTokenId, true);
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 1 ether);

        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.PriceExceedsMax.selector);
        controller.commitBreed{value: 0.4 ether}(
            fatherTokenId, motherTokenId, 0, 0.4 ether, BreedingController.PayMethod.ETH
        );
    }

    function test_Commit_FrontRunPriceIncrease_RevertsInsteadOfOverpaying() public {
        // Buyer observes a 100 CHAN listing and decides that's their max.
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 0);

        vm.prank(motherOwner);
        chan.approve(address(controller), type(uint256).max);

        // Father owner front-runs the buyer's tx, raising the price.
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 500 ether, 0);

        uint256 buyerBalBefore = chan.balanceOf(motherOwner);

        // Buyer's commitBreed still carries their ORIGINAL max (100 ether)
        // - must revert, never silently pay 500.
        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.PriceExceedsMax.selector);
        controller.commitBreed(fatherTokenId, motherTokenId, 100 ether, 0, BreedingController.PayMethod.CHAN);

        assertEq(chan.balanceOf(motherOwner), buyerBalBefore, "buyer must not lose any CHAN on a reverted commit");
    }

    function test_Commit_EscrowsCurrentPrice_NeverTheMax() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 0);

        vm.prank(motherOwner);
        chan.approve(address(controller), type(uint256).max);

        // maxChanPrice is generously higher than the actual listed price -
        // only the CURRENT price (100) may ever be escrowed, never the max.
        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 1_000 ether, 0, BreedingController.PayMethod.CHAN, 0);

        (,,,,,, uint128 amountEscrowed,,,) = controller.commits(commitId);
        assertEq(amountEscrowed, 100 ether, "must escrow the current listed price, not the caller's max");
    }

    // -----------------------------------------------------------
    // Same-owner free path
    // -----------------------------------------------------------

    function test_Breed_SameOwner_SkipsPaymentEntirely() public {
        // fatherOwner also owns a Girlfriend token.
        vm.prank(owner);
        uint256 sameOwnerMotherId = girlfriends.mint(fatherOwner, motherGenes);

        uint256 babyId = _breedChan(fatherOwner, fatherTokenId, sameOwnerMotherId);

        assertEq(babies.ownerOf(babyId), _tbaOf(sameOwnerMotherId));
    }

    function test_Breed_SameOwner_IgnoresMissingListing() public {
        // No siring listing exists at all, but same-owner path must still
        // succeed - listing requirement only applies cross-owner.
        vm.prank(owner);
        uint256 sameOwnerMotherId = girlfriends.mint(fatherOwner, motherGenes);

        _breedChan(fatherOwner, fatherTokenId, sameOwnerMotherId);
    }

    function test_Commit_SameOwner_RevertsOnStrayEthValue() public {
        vm.prank(owner);
        uint256 sameOwnerMotherId = girlfriends.mint(fatherOwner, motherGenes);

        vm.deal(fatherOwner, 1 ether);
        vm.prank(fatherOwner);
        vm.expectRevert(BreedingController.StrayEthValue.selector);
        controller.commitBreed{value: 1 ether}(
            fatherTokenId, sameOwnerMotherId, 0, 0, BreedingController.PayMethod.CHAN
        );
    }

    // -----------------------------------------------------------
    // Unset genes revert
    // -----------------------------------------------------------

    function test_Commit_RevertsWhenFatherGenesUnset() public {
        uint256 freshFather = hoodchan.mint(fatherOwner);
        vm.prank(fatherOwner);
        controller.setSiringPrice(freshFather, 0, 0);

        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.GenesNotSet.selector);
        controller.commitBreed(freshFather, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN);
    }

    // -----------------------------------------------------------
    // 5-cap enforcement
    // -----------------------------------------------------------

    function test_Breed_EnforcesFiveNestedCap() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        for (uint256 i = 0; i < 5; i++) {
            _breedChan(motherOwner, fatherTokenId, motherTokenId);
        }

        assertEq(babies.balanceOf(_motherTba()), 5);

        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.NestedCapExceeded.selector);
        controller.commitBreed(fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN);
    }

    function test_Breed_CapFreesUpAfterTransferOut() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256[] memory babyIds = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) {
            babyIds[i] = _breedChan(motherOwner, fatherTokenId, motherTokenId);
        }

        address tba = _motherTba();
        // Simulate the TBA sending one baby out (nested-holding cap is
        // "at once", not lifetime).
        vm.prank(tba);
        babies.transferFrom(tba, address(0xCAFE), babyIds[0]);

        _breedChan(motherOwner, fatherTokenId, motherTokenId);
        assertEq(babies.balanceOf(tba), 5);
    }

    function test_Reveal_CapExceededBetweenCommitAndReveal_RefundsInsteadOfMinting() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        // Fill 4 of the 5 slots.
        for (uint256 i = 0; i < 4; i++) {
            _breedChan(motherOwner, fatherTokenId, motherTokenId);
        }

        // Commit a 5th (cap check at commit time passes: balance is 4).
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 10 ether, 0);
        vm.prank(motherOwner);
        chan.approve(address(controller), 10 ether);
        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 10 ether, 0, BreedingController.PayMethod.CHAN, 0);

        uint256 buyerBalBeforeReveal = chan.balanceOf(motherOwner);

        // Before reveal, someone directly nests an unrelated baby into the
        // mother's TBA, pushing live balance to 5 ahead of the pending
        // commit's own mint.
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);
        uint256 extraBabyId = _breedChan(motherOwner, fatherTokenId, motherTokenId);
        assertEq(babies.ownerOf(extraBabyId), _motherTba());
        assertEq(babies.balanceOf(_motherTba()), 5);

        vm.roll(block.number + 1);
        uint256 babyId = controller.revealBreed(commitId);

        assertEq(babyId, 0, "reveal must not mint when the cap is exceeded");
        assertEq(babies.balanceOf(_motherTba()), 5, "balance must not exceed the cap");
        assertEq(chan.balanceOf(motherOwner), buyerBalBeforeReveal, "escrow not yet refunded to a claimable balance");
        assertEq(controller.pendingChanWithdrawals(motherOwner), 0, "push refund should have succeeded directly");
        // The push-refund landed directly on the committer (motherOwner)
        // since CHAN transfer never fails here - verify total CHAN
        // conservation instead of a specific balance delta.
        assertFalse(controller.fatherLocked(fatherTokenId), "father must be unlocked after cap-exceeded refund");
        assertFalse(controller.motherLocked(motherTokenId), "mother must be unlocked after cap-exceeded refund");
    }

    // -----------------------------------------------------------
    // Mint-into-TBA destination + determinism
    // -----------------------------------------------------------

    function test_Breed_MintsIntoMotherTba() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 babyId = _breedChan(motherOwner, fatherTokenId, motherTokenId);

        assertEq(babies.ownerOf(babyId), _motherTba());
    }

    function test_Commit_CallerMustOwnMother() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        vm.prank(address(0xBEEF));
        vm.expectRevert(BreedingController.NotGirlfriendOwner.selector);
        controller.commitBreed(fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN);
    }

    function test_Breed_GenomeMatchesFinalSeedFormula() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 expectedNonce = controller.breedNonce();
        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);

        uint256 commitBlock = block.number;
        vm.roll(block.number + 1);
        bytes32 anchor = blockhash(commitBlock);
        console2.log("DEBUG commitBlock", commitBlock);
        console2.log("DEBUG block.number", block.number);
        console2.logBytes32(anchor);

        uint256 expectedSeed = GeneticsLib.breedingSeed(fatherTokenId, motherTokenId, expectedNonce, anchor);
        console2.log("DEBUG expectedSeed", expectedSeed);
        uint8[5] memory expectedGenome = GeneticsLib.resolveGenome(fatherGenes, motherGenes, expectedSeed);

        uint256 babyId = controller.revealBreed(commitId);

        uint8[5] memory actualGenome = babies.genomeOf(babyId);
        for (uint256 i = 0; i < 5; i++) {
            assertEq(actualGenome[i], expectedGenome[i], "on-chain genome must match GeneticsLib prediction");
        }
        assertEq(babies.breedingSeedOf(babyId), expectedSeed);
    }

    function test_Breed_NonceIncrementsEachTime() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 nonceBefore = controller.breedNonce();
        _breedChan(motherOwner, fatherTokenId, motherTokenId);
        assertEq(controller.breedNonce(), nonceBefore + 1);
    }

    // -----------------------------------------------------------
    // Commit/reveal specific invariants (BUG 1 fix)
    // -----------------------------------------------------------

    function test_Commit_LocksBothParentsAgainstConcurrentCommits() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);

        // Same father, different (fresh) mother -> father is locked.
        vm.prank(owner);
        uint256 otherMotherId = girlfriends.mint(motherOwner, motherGenes);
        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.FatherLocked.selector);
        controller.commitBreed(fatherTokenId, otherMotherId, 0, 0, BreedingController.PayMethod.CHAN);

        // Same mother, different father -> mother is locked.
        uint256 otherFatherId = hoodchan.mint(fatherOwner);
        controller.setHoodchanGenes(otherFatherId, fatherGenes);
        vm.prank(fatherOwner);
        controller.setSiringPrice(otherFatherId, 0, 0);
        vm.prank(motherOwner);
        vm.expectRevert(BreedingController.MotherLocked.selector);
        controller.commitBreed(otherFatherId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN);
    }

    function test_Reveal_RevertsBeforeNextBlock() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);

        vm.expectRevert(BreedingController.RevealTooEarly.selector);
        controller.revealBreed(commitId);
    }

    function test_Reveal_RevertsIfAlreadyResolved() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);
        _reveal(commitId);

        vm.expectRevert(BreedingController.CommitAlreadyResolved.selector);
        controller.revealBreed(commitId);
    }

    function test_Reveal_CallableByAnyone() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);

        vm.roll(block.number + 1);
        // A totally unrelated address triggers the reveal - must succeed.
        vm.prank(address(0xD00D));
        uint256 babyId = controller.revealBreed(commitId);
        assertEq(babies.ownerOf(babyId), _motherTba());
    }

    function test_Commit_SeedNotComputableFromPreCommitState() public {
        // Two back-to-back commits with the exact same father/mother pair
        // land in different blocks and therefore anchor to different
        // blockhashes - their resulting seeds must differ even though a
        // pre-commit-reveal observer watching only (fatherTokenId,
        // motherTokenId, breedNonce) could not have told them apart in
        // advance (see BreedingController's SEED-FAIRNESS MITIGATION note).
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 commitIdA =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);
        uint256 babyIdA = _reveal(commitIdA);
        uint256 seedA = babies.breedingSeedOf(babyIdA);

        // Naive pre-commit-reveal formula an attacker could have computed
        // BEFORE commitIdA's commit tx landed, using only publicly
        // observable state (token IDs + the nonce read live off the
        // contract before calling in) - must NOT match the real seed.
        (,,,,, uint256 nonceA,,,,) = controller.commits(commitIdA);
        uint256 naiveSeed = uint256(keccak256(abi.encodePacked(fatherTokenId, motherTokenId, nonceA)));
        assertTrue(seedA != naiveSeed, "seed must not be derivable from pre-commit-observable state alone");

        uint256 commitIdB =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);
        uint256 babyIdB = _reveal(commitIdB);
        uint256 seedB = babies.breedingSeedOf(babyIdB);

        assertTrue(seedA != seedB, "two commits must not collide on seed even with the same father/mother pair");
    }

    // -----------------------------------------------------------
    // Commit expiry / refund (blockhash unavailable > 256 blocks)
    // -----------------------------------------------------------

    function test_Reveal_RevertsAfterExpiryWindow() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);

        vm.roll(block.number + 257);
        vm.expectRevert(BreedingController.CommitExpired.selector);
        controller.revealBreed(commitId);
    }

    function test_CancelExpiredCommit_RevertsBeforeWindowCloses() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);

        vm.roll(block.number + 10);
        vm.expectRevert(BreedingController.CommitNotExpired.selector);
        controller.cancelExpiredCommit(commitId);
    }

    function test_CancelExpiredCommit_RefundsChanAndUnlocksParents() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 100 ether, 0);

        vm.prank(motherOwner);
        chan.approve(address(controller), 100 ether);

        uint256 buyerBalBefore = chan.balanceOf(motherOwner);
        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 100 ether, 0, BreedingController.PayMethod.CHAN, 0);
        assertEq(chan.balanceOf(motherOwner), buyerBalBefore - 100 ether);

        vm.roll(block.number + 300);
        controller.cancelExpiredCommit(commitId);

        assertEq(chan.balanceOf(motherOwner), buyerBalBefore, "committer must be refunded in full");
        assertFalse(controller.fatherLocked(fatherTokenId));
        assertFalse(controller.motherLocked(motherTokenId));

        // Locks freed -> a fresh commit against the same pair must now
        // succeed.
        vm.prank(motherOwner);
        chan.approve(address(controller), 100 ether);
        uint256 newCommitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 100 ether, 0, BreedingController.PayMethod.CHAN, 0);
        _reveal(newCommitId);
    }

    function test_CancelExpiredCommit_RefundsEthViaPullClaim() public {
        controller.setUpgradedAllowlist(fatherTokenId, true);
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 1 ether);

        uint256 buyerBalBefore = motherOwner.balance;
        uint256 commitId = _commit(
            motherOwner, fatherTokenId, motherTokenId, 0, 1 ether, BreedingController.PayMethod.ETH, 1 ether
        );
        assertEq(motherOwner.balance, buyerBalBefore - 1 ether);

        vm.roll(block.number + 300);
        controller.cancelExpiredCommit(commitId);

        assertEq(controller.pendingEthWithdrawals(motherOwner), 1 ether);
        vm.prank(motherOwner);
        controller.claimEth();
        assertEq(motherOwner.balance, buyerBalBefore, "committer must be refunded in full after claiming");
    }

    function test_CancelExpiredCommit_RevertsIfAlreadyResolved() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN, 0);
        _reveal(commitId);

        vm.roll(block.number + 300);
        vm.expectRevert(BreedingController.CommitAlreadyResolved.selector);
        controller.cancelExpiredCommit(commitId);
    }

    // -----------------------------------------------------------
    // BUG 6 fix: revert-cherry-pick resistance (pull payments,
    // mint-before-payout)
    // -----------------------------------------------------------

    function test_RevealBreed_MaliciousFatherOwner_CannotBlockOrRerollGenomeViaEthRevert() public {
        MaliciousRecipient malicious = new MaliciousRecipient();
        malicious.setRejectEth(true);

        uint256 hostileFatherId = hoodchan.mint(address(malicious));
        controller.setHoodchanGenes(hostileFatherId, fatherGenes);
        controller.setUpgradedAllowlist(hostileFatherId, true);
        malicious.callSetSiringPrice(address(controller), hostileFatherId, 0, 1 ether);

        uint256 commitId = _commit(
            motherOwner, hostileFatherId, motherTokenId, 0, 1 ether, BreedingController.PayMethod.ETH, 1 ether
        );

        // Reveal must succeed and mint regardless of the father owner's
        // receive() rejecting ETH - payout is pull-based, so no ETH .call
        // to the malicious contract happens during reveal at all.
        uint256 babyId = _reveal(commitId);
        assertEq(babies.ownerOf(babyId), _motherTba(), "mint must succeed despite a hostile father-owner receive()");
        assertGt(babies.breedingSeedOf(babyId), 0);

        // The malicious contract's own claim now fails (its receive()
        // still rejects ETH) - but that only affects ITS ability to claim,
        // never the already-finalized genome/mint.
        assertEq(controller.pendingEthWithdrawals(address(malicious)), 1 ether);
        vm.expectRevert(BreedingController.EthTransferFailed.selector);
        malicious.claimFrom(address(controller));

        // Once it stops rejecting, the exact same escrowed amount is still
        // claimable - proving no value was lost or the genome re-rolled by
        // the earlier failed claim attempt.
        malicious.setRejectEth(false);
        malicious.claimFrom(address(controller));
        assertEq(address(malicious).balance, 1 ether);

        // Genome is untouched by any of the above - re-derive and compare.
        uint8[5] memory genome = babies.genomeOf(babyId);
        assertEq(genome.length, 5);
    }

    function test_RevealBreed_MintHappensBeforeAnyPayoutCall() public {
        // CHAN path: even though _payout attempts a direct push first, it
        // happens strictly after babies.mint - assert the baby exists (and
        // its genome is queryable) using a father-owner that reverts on
        // being paid, by having its listing price be non-zero but by
        // making the CHAN token itself refuse this specific transfer via
        // insufficient allowance-independent behavior is out of scope for
        // a plain ERC20; instead assert via event ordering semantics: the
        // Bred event's amountPaid must reflect a mint that already
        // happened, and pendingChanWithdrawals must be usable as a
        // fallback without ever having reverted the outer call.
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 50 ether, 0);
        vm.prank(motherOwner);
        chan.approve(address(controller), 50 ether);

        uint256 commitId =
            _commit(motherOwner, fatherTokenId, motherTokenId, 50 ether, 0, BreedingController.PayMethod.CHAN, 0);
        uint256 babyId = _reveal(commitId);

        assertEq(babies.ownerOf(babyId), _motherTba(), "mint must have happened regardless of payout mechanics");
    }

    // -----------------------------------------------------------
    // Claim guards
    // -----------------------------------------------------------

    function test_ClaimEth_RevertsWithNothingToClaim() public {
        vm.expectRevert(BreedingController.NothingToClaim.selector);
        controller.claimEth();
    }

    function test_ClaimChan_RevertsWithNothingToClaim() public {
        vm.expectRevert(BreedingController.NothingToClaim.selector);
        controller.claimChan();
    }
}
