// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {BreedingController} from "../src/BreedingController.sol";
import {HoodchanBabies} from "../src/HoodchanBabies.sol";
import {HoodchanGirlfriends} from "../src/HoodchanGirlfriends.sol";
import {MockHoodchan} from "./mocks/MockHoodchan.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockERC6551Registry} from "./mocks/MockERC6551Registry.sol";

contract BlockhashDebugTest is Test {
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

        vm.roll(1000);
    }

    function test_debug() public {
        vm.prank(fatherOwner);
        controller.setSiringPrice(fatherTokenId, 0, 0);

        vm.prank(motherOwner);
        uint256 commitId = controller.commitBreed(fatherTokenId, motherTokenId, 0, 0, BreedingController.PayMethod.CHAN);

        uint256 commitBlock = block.number;
        console2.log("commitBlock", commitBlock);
        vm.roll(block.number + 1);
        console2.log("block.number after roll", block.number);
        bytes32 anchor = blockhash(commitBlock);
        console2.logBytes32(anchor);
    }
}
