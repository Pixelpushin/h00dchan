// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// DO NOT RUN THIS AGAINST ANY RPC WITHOUT EXPLICIT HUMAN APPROVAL.
//
// This script is written and ready but has never been executed with
// --broadcast, on Robinhood Chain or anywhere else, by the agent that
// authored it. `forge script` without --broadcast (a dry run) is safe to
// use to sanity-check this file compiles and simulates correctly; adding
// --broadcast --rpc-url <url> is the actual deployment step and is a
// deliberate, separate, human-approved action - not something to run as
// part of building/testing this contracts package.
//
// Prerequisites before a real run (see also the task report):
//   1. A funded Pixelpushin deployer key on Robinhood Chain (id 4663),
//      imported via `cast wallet import` into a Foundry keystore - NOT an
//      env var private key (see .claude/rules/credentials.md's "NEVER
//      store secrets in plaintext files" / ".env" rules and this repo's
//      own note in AQUAPRIME_RPG/foundry that contract deployment uses
//      Foundry keystore, not env vars).
//   2. DEPLOYER_ADDRESS env var set to that key's address (used as
//      initialOwner for all three contracts below - can be re-owned to a
//      multisig later via each contract's Ownable.transferOwnership).
//   3. Real HOODCHAN_GIRLFRIENDS_ADDRESS decided: this script defaults to
//      deploying the dummy HoodchanGirlfriends from this same package
//      (per the design spec: "clearly throwaway - swapped for the real
//      contract address once the official team deploys"). Swapping to a
//      real collection later means passing its address into
//      BreedingController's constructor instead of a freshly deployed
//      HoodchanGirlfriends - no code change needed here, just a different
//      constructor arg.
//   4. After deploy: run the off-chain HOODCHAN metadata-sync script
//      (not yet written - out of scope for this contracts package) to
//      call BreedingController.setHoodchanGenes/setHoodchanGenesBatch for
//      every live HOODCHAN token, and
//      setUpgradedAllowlist/setUpgradedAllowlistBatch for the
//      STATUS:"Upgraded" tokens (confirmed live: #531, #777, #1067, per
//      the design spec - there may be more, this list isn't exhaustive).
//      commitBreed reverts for any father whose genes were never synced
//      (GenesNotSet) - the collection is unusable for siring until this
//      step runs.
//   5. Breeding itself is a two-step commitBreed/revealBreed flow (see
//      BreedingController's SEED-FAIRNESS MITIGATION note and this
//      package's README) - no constructor/deploy-time wiring change from
//      that, it's purely a runtime call-flow change on the already-
//      deployed BreedingController.
//   6. Minting into a mother's TBA works immediately after deploy even
//      though the ERC-6551 implementation (TBA_IMPLEMENTATION below) is
//      not yet deployed on Robinhood Chain as of this writing - see
//      HoodchanBabies.mint's doc comment and the README's "Why _mint, not
//      _safeMint" section. TBA execute() FROM a baby/mother's TBA will not
//      work until that implementation is separately deployed; nothing in
//      this deploy script needs it to.
// ============================================================

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {HoodchanGirlfriends} from "../src/HoodchanGirlfriends.sol";
import {HoodchanBabies} from "../src/HoodchanBabies.sol";
import {BreedingController} from "../src/BreedingController.sol";

contract DeployScript is Script {
    // HOODCHAN itself - existing, untouched, external. Confirmed live
    // deployed address (lib/chain.ts's CONTRACT constant in the parent
    // h00dchan app, independently verified there via eth_call - see that
    // file's header comment for the verification method).
    address internal constant HOODCHAN = 0x774Db2207D26570F5638028839c816702A40aBC2;

    // CHAN token - already wired into this app as the access-gating token
    // (lib/holderAuth.ts). Per the design spec: breeding fees reinforce
    // CHAN, not compete with it.
    address internal constant CHAN_TOKEN = 0xB36fD5d3392C78E70c3E08f46b46F242e7EF654F;

    // Same ERC-6551 registry + implementation @pixelpushin/tba-kit uses on
    // Robinhood Chain (node_modules/@pixelpushin/tba-kit/dist/index.js) -
    // load-bearing, not guessed (see that file's own header comment for
    // the independent eth_getCode verification history).
    address internal constant TBA_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address internal constant TBA_IMPLEMENTATION = 0x41C8f39463A868d3A88af00cd0fe7102F30E44eC;

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");

        vm.startBroadcast(deployer);

        // Deploy order matters: Girlfriends and Babies must exist before
        // BreedingController (its constructor takes both addresses);
        // Babies must exist before it can be told its controller.
        HoodchanGirlfriends girlfriends = new HoodchanGirlfriends(deployer);
        HoodchanBabies babies = new HoodchanBabies(deployer);

        BreedingController controller = new BreedingController(
            deployer, HOODCHAN, address(girlfriends), address(babies), CHAN_TOKEN, TBA_REGISTRY, TBA_IMPLEMENTATION
        );

        // Wiring: Babies only accepts mint() calls from this address.
        babies.setBreedingController(address(controller));

        vm.stopBroadcast();

        console2.log("HoodchanGirlfriends:", address(girlfriends));
        console2.log("HoodchanBabies:", address(babies));
        console2.log("BreedingController:", address(controller));
        console2.log("-- Next step: mint ~12 HoodchanGirlfriends tokens, then run the");
        console2.log("-- off-chain HOODCHAN gene/allowlist sync script before any commitBreed() call.");
    }
}
