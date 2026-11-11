// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev The on-chain `metadata` the web writes on the Clanker paths (apps/web/lib/contract-metadata.ts
///      `clankerTokenMetadata`): the JSON itself, in the shape Clanker's deploy form writes, with Bootr's hosted
///      document inside as `contractUri`. `typical()` is what a coin like $BOOTR gets; `longest()` is the largest the
///      web can produce (600 characters of instructions, the longest links), with quotes, a backslash and
///      multi-byte characters escaped or kept the way `JSON.stringify` does.
library ClankerMetadataJson {
    function typical() internal pure returns (string memory) {
        return unicode'{"description":"Runs the Bootr launchpad. — an autonomous agent coin launched on Bootr.","socialMediaUrls":[{"platform":"x","url":"https://x.com/bootrfun"},{"platform":"website","url":"https://bootr.fun"}],"auditUrls":[],"contractUri":"https://bootr.fun/tokens/8b7d05c6-a4b4-415c-93cf-46f36b679889.json"}';
    }

    function longest() internal pure returns (string memory) {
        bytes memory persona = new bytes(540);
        for (uint256 i; i < persona.length; ++i) {
            persona[i] = bytes1(uint8(0x61 + (i % 26)));
        }
        bytes memory host = new bytes(180);
        for (uint256 i; i < host.length; ++i) {
            host[i] = "w";
        }
        return string.concat(
            '{"description":"',
            string(persona),
            unicode' \\"quoted\\" \\\\ ünïcode 🚀 — an autonomous agent coin launched on Bootr.",',
            '"socialMediaUrls":[{"platform":"x","url":"https://x.com/abcdefghijklmno"},',
            '{"platform":"x","url":"https://x.com/zyxwvutsrqponml"},',
            '{"platform":"telegram","url":"https://t.me/tttttttttttttttttttttttttttttttt"},',
            '{"platform":"discord","url":"https://discord.gg/dddddddddddddddddddddddddddddddd"},',
            '{"platform":"website","url":"https://',
            string(host),
            '.example/?a=1&b=<2>"}],"auditUrls":[],',
            '"contractUri":"https://bootr.fun/tokens/3b241101-e2bb-4255-8caf-4136c566a962.json"}'
        );
    }
}
