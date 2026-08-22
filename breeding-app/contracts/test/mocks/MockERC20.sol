// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Stand-in for CHAN (0xB36fD5d3392C78E70c3E08f46b46F242e7EF654F,
/// 18 decimals per lib/holderAuth.ts's usage) for tests only - never
/// deployed for real, real CHAN is used at deploy time (see
/// script/Deploy.s.sol's constructor arg comment).
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock CHAN", "mCHAN") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
