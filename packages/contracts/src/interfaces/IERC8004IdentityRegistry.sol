// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev ERC-8004 Identity Registry, ABI confirmed from the verified implementation
/// (`IdentityRegistryUpgradeable`, getVersion() == "2.0.0") behind the Base Sepolia proxy
/// 0x8004A818BFB912233c491871b3d84c89A494BD9e. `register(string)` `_safeMint`s an ERC-721 to
/// msg.sender and records msg.sender as the "agentWallet" metadata (cleared on transfer).
interface IERC8004IdentityRegistry {
    event Registered(uint256 agentId, string agentURI, address owner);

    function register(string calldata agentURI) external returns (uint256 agentId);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
}
