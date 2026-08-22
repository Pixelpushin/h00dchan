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
//      store secrets in plaintext files" / ".env" rules).
//   2. DEPLOYER_ADDRESS env var set to that key's address (used as
//      initialOwner for all three contracts below - can be re-owned to a
//      multisig later via each contract's Ownable.transferOwnership).
//   3. TREASURY_ADDRESS / BURN_ADDRESS / MULTISIG_ADDRESS env vars - see
//      the config-value defaults below; these are NOT load-bearing to the
//      design spec (docs/superpowers/specs/2026-08-21-hoodchan-breeding-
//      design.md's "Open questions" section explicitly defers exact fee
//      amounts/recipients pending holder-balance data), but must be real
//      addresses before any real deploy - the placeholder constants below
//      are deliberately the deployer's own address so a dry run never
//      reverts on ZeroAddress, not a claim that they're correct for a real
//      deploy.
//   4. Real HOODCHAN_GIRLFRIENDS_ADDRESS decided: this script defaults to
//      deploying the dummy HoodchanGirlfriends from this same package
//      (per the design spec: "clearly throwaway - swapped for the real
//      contract address once the official team deploys"). Swapping to a
//      real collection later means calling
//      `controller.setBreedableCollection(realAddress, true,
//      CollectionSex.Female)` instead of allowlisting the dummy deploy -
//      no code change needed here.
//   5. After deploy: run the off-chain HOODCHAN gene-sync script (not yet
//      written - out of scope for this contracts package) to call
//      `controller.setHoodchanGenes`/`setHoodchanGenesBatch` for every
//      live HOODCHAN token. `breed()` reverts for any HOODCHAN parent
//      whose genes were never synced (GenesNotSet) - HOODCHAN is unusable
//      as a matron/sire until this step runs.
//   6. `breed()` is now a SINGLE atomic transaction (no commit/reveal) -
//      see BreedingController's header comment for why a predictable seed
//      is an accepted tradeoff, not a bug, for this design.
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
    // CHAN, not compete with it. Bytecode-verified as a plain
    // non-proxied OZ ERC20+Ownable (no fee-on-transfer, no hooks) - see
    // BreedingController's SafeERC20 usage, kept as a defensive default
    // anyway.
    address internal constant CHAN_TOKEN = 0xB36fD5d3392C78E70c3E08f46b46F242e7EF654F;

    // Config defaults, NOT load-bearing to the design spec (see this
    // file's header comment, prerequisite #3) - concrete starting points,
    // adjustable post-deploy via BreedingController's owner-only setters
    // (setBirthFee / setSameSexFeeMultiplier / setTreasury / etc.).
    uint256 internal constant DEFAULT_BIRTH_FEE = 100 ether; // 100 CHAN, 18 decimals
    uint256 internal constant DEFAULT_SAME_SEX_FEE_MULTIPLIER = 2; // 2x birth fee for "test tube baby" pairings

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        // Fee-recipient addresses are real config, not spec values (see
        // header comment #3) - default to the deployer so a dry run never
        // reverts on ZeroAddress; override via env vars for any real
        // deploy.
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address burnAddr = vm.envOr("BURN_ADDRESS", deployer);
        address multisigAddr = vm.envOr("MULTISIG_ADDRESS", deployer);

        vm.startBroadcast(deployer);

        // Deploy order matters: Girlfriends and Babies must exist before
        // BreedingController (its constructor takes Babies' address);
        // Babies must exist before it can be told its controller.
        HoodchanGirlfriends girlfriends = new HoodchanGirlfriends(deployer);
        HoodchanBabies babies = new HoodchanBabies(deployer);

        BreedingController controller = new BreedingController(
            deployer,
            HOODCHAN,
            address(babies),
            CHAN_TOKEN,
            treasury,
            burnAddr,
            multisigAddr,
            DEFAULT_BIRTH_FEE,
            DEFAULT_SAME_SEX_FEE_MULTIPLIER
        );

        // Wiring: Babies only accepts mint() calls from this address.
        babies.setBreedingController(address(controller));

        // Allowlist all three collections, each with its fixed/PerToken
        // sex config (see BreedingController.CollectionSex).
        controller.setBreedableCollection(HOODCHAN, true, BreedingController.CollectionSex.Male);
        controller.setBreedableCollection(address(girlfriends), true, BreedingController.CollectionSex.Female);
        controller.setBreedableCollection(address(babies), true, BreedingController.CollectionSex.PerToken);

        vm.stopBroadcast();

        console2.log("HoodchanGirlfriends:", address(girlfriends));
        console2.log("HoodchanBabies:", address(babies));
        console2.log("BreedingController:", address(controller));
        console2.log("-- Next step: mint ~12 HoodchanGirlfriends tokens, then run the");
        console2.log("-- off-chain HOODCHAN gene-sync script before any breed() call.");
    }
}
