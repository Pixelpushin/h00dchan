// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IBreedingControllerLike {
    function breedNonce() external view returns (uint256);
    function claimEth() external;
}

/// @dev Test-only stand-in for a hostile HOODCHAN-owner contract, used to
/// prove BreedingController's BUG 6 fix: the outcome (genome + mint) can
/// never be re-rolled by a payout call reverting, because payout is
/// pull-based and strictly post-mint (see BreedingController._payout /
/// revealBreed). `rejectEth` toggles whether this contract's `receive()`
/// reverts, simulating an owner who tries to force a claim to fail after
/// having already seen (and disliked) the resulting genome.
contract MaliciousRecipient {
    bool public rejectEth;
    uint256 public lastObservedNonceInReceive;

    function setRejectEth(bool reject) external {
        rejectEth = reject;
    }

    /// @dev Needed so MockHoodchan's `_safeMint(address(this), ...)` (this
    /// contract IS a HOODCHAN father owner in the test) doesn't itself
    /// revert with ERC721InvalidReceiver - unrelated to the BUG 6
    /// scenario this mock exists to exercise, just standard ERC-721
    /// receiver plumbing.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @dev Exercised historically against the OLD single-tx breed() design
    /// (push-payment mid-flow) to show a hostile receive() hook could read
    /// breedNonce() before the genome/mint were finalized. Kept as a
    /// no-op-capable hook so the same contract type can be reused to prove
    /// the NEW commit/reveal + pull-payment design closes that window: this
    /// receive() is never invoked during BreedingController.revealBreed at
    /// all (ETH payout only ever credits pendingEthWithdrawals there), so
    /// there is nothing left for it to observe or grief mid-mint.
    receive() external payable {
        if (rejectEth) revert("rejecting ETH");
    }

    function claimFrom(address controller) external {
        IBreedingControllerLike(controller).claimEth();
    }

    function approveHoodchan(address hoodchan, address spender, uint256 tokenId) external {
        IERC721(hoodchan).approve(spender, tokenId);
    }

    function callSetSiringPrice(address controller, uint256 fatherTokenId, uint128 chanPrice, uint128 ethPrice)
        external
    {
        (bool ok,) = controller.call(
            abi.encodeWithSignature("setSiringPrice(uint256,uint128,uint128)", fatherTokenId, chanPrice, ethPrice)
        );
        require(ok, "setSiringPrice failed");
    }
}
