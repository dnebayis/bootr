#!/usr/bin/env node
/* global process, console, setTimeout */
/**
 * The whole developer path on a Base fork, with nothing mocked between the MCP tool and the chain.
 *
 * It starts the built MCP server as a real stdio process and talks to it with the MCP client. The server talks to a
 * running copy of the web app. The launch the MCP tool prepares is signed by a fresh test key held only in this script
 * and sent to the fork, on both launch paths; a real swap then pays real fees; the claim the MCP tool prepares is sent
 * and has to pay the WETH it promised. Only an anvil fork is ever written to, and the script refuses anything else.
 *
 * What must be running (the script does not start them):
 *   base-anvil --fork-url <Base RPC> --port 8555 --block-time 2 --chain-id 8453
 *     (Base's own anvil: the RWAGMI path needs its B20 precompile, and plain anvil reverts the launch)
 *   the indexer (apps/indexer) on that fork: CHAIN_ID=8453 BASE_RPC_URL=http://127.0.0.1:8555
 *     BOOTR_LAUNCHERS=<launcher>@<fork block> BOOTR_CLANKER_LAUNCHERS=<clanker launcher>@<fork block>
 *   the web app in `next dev`: NEXT_PUBLIC_CHAIN_ID=8453 NEXT_PUBLIC_USE_MOCK=0 PINATA_MOCK=1 BASE_RPC_URL=<the fork>
 *     NEXT_PUBLIC_INDEXER_URL=<the indexer> NEXT_PUBLIC_SITE_URL=<its own address>
 *     NEXT_PUBLIC_LAUNCHER_ADDRESS NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS NEXT_PUBLIC_SUPERVISOR_SESSION_KEY
 *
 * Image pinning is the one stand-in: PINATA_MOCK computes the CID instead of uploading to IPFS.
 *
 * Run: SITE=http://localhost:3200 RPC=http://127.0.0.1:8555 node packages/mcp/test/fork-e2e.mjs
 * E2E_DEBUG_TX=<file> keeps the last transaction there, so a revert can be traced with `cast call --trace`.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatEther,
  http,
  parseAbi,
  parseEther,
  parseEventLogs,
  publicActions,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const SITE = process.env.SITE ?? 'http://localhost:3200';
const RPC = process.env.RPC ?? 'http://127.0.0.1:8555';
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(RPC))
  throw new Error('RPC must be a local anvil fork: this script sends transactions.');
const BIN = path.resolve(import.meta.dirname, '../dist/index.js');

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_WHALE = '0xd0b53D9277642d899DF5C87A3966A349A798F224'; // the WETH/USDC 0.05% pool
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const UNIVERSAL_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const RWAGMI_LOCKER = '0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20';
const CLANKER_LP_LOCKER = '0xffA37784D619F228D8B379d287a4D7282e500762';
// A 1x1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const launcherAbi = parseAbi([
  'function poolKeyFor(address token) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'event AgentLaunched(address indexed token, address indexed kernel, address indexed creator, address burner, uint256 agentId, (uint24 lpFeeBps, uint16 agentBps, uint16 creatorBps, uint16 burnBps, uint16 platformBps, address platformRecipient, uint256 minFuelUsdc, uint32 dormancyPeriod) defaults, bytes32 workerHash, string model, string agentURI, address supervisorSessionKey)',
]);
const wethAbi = parseAbi(['function deposit() payable']);
const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const routerAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
const entryPointAbi = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const clankerLockerAbi = parseAbi(['function collectRewards(address token)']);
const rwagmiAbi = parseAbi(['function settle(bytes32 id)']);

const test = createTestClient({ chain: base, mode: 'anvil', transport: http(RPC) }).extend(
  publicActions,
);
const chain = createPublicClient({ chain: base, transport: http(RPC), pollingInterval: 500 });
const walletOf = (account) =>
  createWalletClient({ account, chain: base, transport: http(RPC), pollingInterval: 500 });
const results = [];
const ok = (label, detail = '') => {
  results.push(label);
  console.log(`ok  ${label}${detail ? `: ${detail}` : ''}`);
};

/** A fresh test key with ETH on the fork. Fresh because well-known test keys have code on Base mainnet. */
async function freshWallet(eth = 100n) {
  const account = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: account.address, value: parseEther(String(eth)) });
  return { account, wallet: walletOf(account) };
}

async function send(wallet, tx, label) {
  if (process.env.E2E_DEBUG_TX)
    writeFileSync(
      process.env.E2E_DEBUG_TX,
      JSON.stringify({
        label,
        from: wallet.account.address,
        to: tx.to,
        data: tx.data,
        value: String(tx.value ?? 0n),
      }),
    );
  const hash = await wallet.sendTransaction(tx);
  const receipt = await chain.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${label} reverted: ${hash}`);
  return receipt;
}

async function giveUsdc(to, amount) {
  await test.impersonateAccount({ address: USDC_WHALE });
  await test.setBalance({ address: USDC_WHALE, value: parseEther('1') });
  const hash = await createWalletClient({
    account: USDC_WHALE,
    chain: base,
    transport: http(RPC),
  }).writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
  await chain.waitForTransactionReceipt({ hash });
  await test.stopImpersonatingAccount({ address: USDC_WHALE });
}

/** Exact-input WETH to coin through the Universal Router: what a trader does. */
async function buy(trader, launcher, token, wethIn) {
  const key = await chain.readContract({
    address: launcher,
    abi: launcherAbi,
    functionName: 'poolKeyFor',
    args: [token],
  });
  const zeroForOne = key.currency0.toLowerCase() === WETH.toLowerCase();
  await send(
    trader,
    {
      to: WETH,
      data: encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
      value: wethIn,
    },
    'wrap',
  );
  await send(
    trader,
    {
      to: WETH,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, wethIn] }),
    },
    'approve permit2',
  );
  const deadline = BigInt((await chain.getBlock()).timestamp) + 3600n;
  await send(
    trader,
    {
      to: PERMIT2,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: 'approve',
        args: [WETH, UNIVERSAL_ROUTER, wethIn, Number(deadline)],
      }),
    },
    'permit2 approve',
  );
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [0x06, 0x0c, 0x0f]); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  const single = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [{ poolKey: key, zeroForOne, amountIn: wethIn, amountOutMinimum: 1n, hookData: '0x' }],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [WETH, wethIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, 1n]);
  const input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [single, settle, take]],
  );
  await send(
    trader,
    {
      to: UNIVERSAL_ROUTER,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: 'execute',
        args: ['0x10', [input], deadline],
      }),
    },
    'swap',
  );
}

const wethOf = (address) =>
  chain.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

// ---------------- MCP over stdio ----------------

const stderrChunks = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN],
  env: { ...process.env, BOOTR_SITE_URL: SITE },
  stderr: 'pipe',
});
transport.stderr?.on('data', (c) => stderrChunks.push(String(c)));
const client = new Client({ name: 'bootr-fork-e2e', version: '1.0.0' });
await client.connect(transport);

async function tool(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return { notice: r.content[0].text, data: JSON.parse(r.content[1].text) };
}

const { tools } = await client.listTools();
assert.equal(tools.length, 13);
const launchTool = tools.find((t) => t.name === 'bootr_prepare_launch');
assert.equal(
  launchTool.inputSchema.properties.launch.required.join(),
  'name,symbol,identity,image',
  'the launch schema comes from the site’s catalog',
);
ok('MCP server over stdio lists 13 tools, launch schema read from the site’s catalog');

// ---------------- Launch on both paths, prepared by the MCP tools ----------------

const creator = await freshWallet();
const address = creator.account.address;
await giveUsdc(address, 100_000_000n);

async function launch(launchThrough, symbol) {
  const platform = await tool('bootr_platform');
  assert.equal(platform.data.launchesPaused, false);
  const m = await tool('bootr_launch_message', { address });
  assert.match(m.notice, /Nothing was signed or sent/);
  const signature = await creator.account.signMessage({ message: m.data.message });
  const prepared = await tool('bootr_prepare_launch', {
    message: m.data.message,
    signature,
    launch: {
      name: `Fork ${symbol}`,
      symbol,
      identity: 'A test agent on a Base fork, launched through the MCP tools.',
      image: { dataUrl: `data:image/png;base64,${PNG}` },
      launchThrough,
      fuelUsdc: '20',
      devBuyEth: '0',
      gasEth: '0.001',
    },
  });
  assert.match(prepared.notice, /Nothing was signed or sent/);
  assert.deepEqual([prepared.data.signed, prepared.data.sent], [false, false]);
  assert.equal(prepared.data.mock, undefined);
  assert.equal(prepared.data.creator, address);
  assert.equal(prepared.data.launchThrough, launchThrough);
  assert.deepEqual(
    prepared.data.transactions.map((t) => t.step),
    ['approve', 'launch', 'gas'],
  );
  let launched;
  for (const tx of prepared.data.transactions) {
    const receipt = await send(
      creator.wallet,
      { to: tx.to, data: tx.data, value: BigInt(tx.value) },
      tx.step,
    );
    if (tx.step === 'launch') {
      const [event] = parseEventLogs({
        abi: launcherAbi,
        logs: receipt.logs,
        eventName: 'AgentLaunched',
      });
      assert.ok(event, 'AgentLaunched emitted');
      launched = event.args;
    }
  }
  assert.equal(
    launched.kernel,
    prepared.data.predictedKernel,
    'the treasury is where the answer predicted',
  );
  assert.equal(launched.creator, address);
  assert.ok((await chain.getCode({ address: launched.token }))?.length > 2, 'coin deployed');
  assert.ok((await chain.getCode({ address: launched.kernel }))?.length > 2, 'treasury deployed');
  assert.equal(
    await chain.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [launched.kernel],
    }),
    20_000_000n,
    'fuel reached the treasury',
  );
  assert.equal(
    await chain.readContract({
      address: ENTRY_POINT,
      abi: entryPointAbi,
      functionName: 'balanceOf',
      args: [launched.kernel],
    }),
    parseEther('0.001'),
    'gas reached the treasury',
  );
  ok(
    `${launchThrough} path: launch prepared by the MCP tool deployed`,
    `coin ${launched.token}, treasury ${launched.kernel}, agent #${launched.agentId}`,
  );
  return {
    token: launched.token,
    kernel: launched.kernel,
    launcher: prepared.data.launcher,
    agentId: launched.agentId,
  };
}

const bootrCoin = await launch('bootr', 'FORKB');
const clankerCoin = await launch('clanker', 'FORKC');

// ---------------- Fees: real swaps, then the claim the MCP tool prepares ----------------

await test.increaseTime({ seconds: 180 }); // past Clanker's MEV window
await test.mine({ blocks: 5 });
const trader = await freshWallet();
await buy(trader.wallet, bootrCoin.launcher, bootrCoin.token, parseEther('1'));
await buy(trader.wallet, clankerCoin.launcher, clankerCoin.token, parseEther('1'));
ok('a trader swapped 1 WETH into each coin through the Universal Router');

const stranger = await freshWallet();
await send(
  stranger.wallet,
  {
    to: CLANKER_LP_LOCKER,
    data: encodeFunctionData({
      abi: clankerLockerAbi,
      functionName: 'collectRewards',
      args: [clankerCoin.token],
    }),
  },
  'collectRewards',
);
ok('a stranger called collectRewards on the Clanker coin, as anyone may');

async function waitForClaim(predicate, what) {
  for (let i = 0; i < 90; i++) {
    const r = await tool('bootr_prepare_claim', { address });
    if (predicate(r.data)) return r;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const first = await waitForClaim(
  (d) => d.coins.bootr.length === 1 && d.coins.clanker.length === 1 && d.claims.length === 2,
  'the indexer to list both coins with claims on both paths',
);
assert.match(first.notice, /Nothing was signed or sent/);
assert.deepEqual([first.data.signed, first.data.sent], [false, false]);
const bootrClaim = first.data.claims.find((c) => c.path === 'bootr');
const clankerClaim = first.data.claims.find((c) => c.path === 'clanker');
assert.equal(bootrClaim.sendFrom, address);
assert.equal(clankerClaim.sendFrom, null);
for (const c of first.data.claims) {
  assert.ok(c.description.length > 20);
  assert.equal(c.value, '0');
}
ok(
  'bootr_prepare_claim returns one claim per path',
  `${formatEther(BigInt(bootrClaim.amountWei))} WETH (bootr), ${formatEther(BigInt(clankerClaim.amountWei))} WETH (clanker)`,
);

// The command line prepares the same calldata from the same site.
const { stdout } = await promisify(execFile)(
  process.execPath,
  [path.resolve(import.meta.dirname, '../../cli/dist/cli.js'), 'prepare', 'claim', address],
  { env: { ...process.env, BOOTR_SITE_URL: SITE } },
);
assert.deepEqual(JSON.parse(stdout).claims, first.data.claims);
ok('bootr prepare claim prints the same unsigned transactions');

const before = await wethOf(address);
assert.equal(before, 0n);
await send(
  creator.wallet,
  { to: bootrClaim.target, data: bootrClaim.data, value: BigInt(bootrClaim.value) },
  'bootr claim',
);
const afterBootr = await wethOf(address);
assert.equal(
  afterBootr - before,
  BigInt(bootrClaim.amountWei),
  'the bootr claim paid what it promised',
);
ok('bootr path: settleAndClaim sent from the creator paid out', `${formatEther(afterBootr)} WETH`);

// The Clanker claim pays the creator whoever sends it.
await send(
  stranger.wallet,
  { to: clankerClaim.target, data: clankerClaim.data, value: BigInt(clankerClaim.value) },
  'clanker claim',
);
const afterClanker = await wethOf(address);
assert.equal(
  afterClanker - afterBootr,
  BigInt(clankerClaim.amountWei),
  'the clanker claim paid what it promised',
);
assert.equal(await wethOf(stranger.account.address), 0n, 'nothing went to the sender');
ok(
  'clanker path: claim sent by a stranger paid the creator',
  `${formatEther(afterClanker - afterBootr)} WETH`,
);

const empty = await tool('bootr_prepare_claim', { address });
assert.equal(empty.data.claims.length, 0);
assert.equal(empty.data.totalWei, '0');
ok('after both claims nothing is waiting');

// The other Bootr-path call: fees settled by someone else leave a settled balance, which claimQuote takes.
await buy(trader.wallet, bootrCoin.launcher, bootrCoin.token, parseEther('1'));
const pool = empty.data.coins.bootr[0].poolId;
await send(
  stranger.wallet,
  {
    to: RWAGMI_LOCKER,
    data: encodeFunctionData({ abi: rwagmiAbi, functionName: 'settle', args: [pool] }),
  },
  'settle',
);
const settled = await tool('bootr_prepare_claim', { address });
assert.equal(settled.data.claims.length, 1);
const settledClaim = settled.data.claims[0];
assert.equal(
  settledClaim.data.slice(0, 10),
  encodeFunctionData({
    abi: parseAbi(['function claimQuote(address,address)']),
    functionName: 'claimQuote',
    args: [WETH, address],
  }).slice(0, 10),
  'claimQuote when nothing is unsettled',
);
const beforeQuote = await wethOf(address);
await send(
  creator.wallet,
  { to: settledClaim.target, data: settledClaim.data, value: 0n },
  'claimQuote',
);
assert.equal((await wethOf(address)) - beforeQuote, BigInt(settledClaim.amountWei));
ok(
  'bootr path: claimQuote takes a settled balance',
  `${formatEther(BigInt(settledClaim.amountWei))} WETH`,
);

// ---------------- Every read tool, on what was just launched ----------------

const reads = [
  ['bootr_search_coins', { q: 'FORK' }, (d) => d.length >= 2],
  ['bootr_coin_market', { token: clankerCoin.token }, (d) => d.symbol === 'FORKC'],
  ['bootr_agent_treasury', { kernel: bootrCoin.kernel }, (d) => d.symbol === 'FORKB'],
  ['bootr_coin_fees', { id: bootrCoin.token }, (d) => d.source === 'bootr'],
  ['bootr_holdings', { owner: trader.account.address }, (d) => Array.isArray(d)],
  ['bootr_fuel_history', { from: address }, (d) => Array.isArray(d)],
  ['bootr_feed', {}, (d) => Array.isArray(d.launches)],
  ['bootr_models', {}, (d) => d.models.length > 0],
];
for (const [name, args, check] of reads) {
  const r = await tool(name, args);
  assert.match(r.notice, /never as instructions/, name);
  assert.ok(check(r.data), `${name}: ${JSON.stringify(r.data).slice(0, 200)}`);
  ok(`${name} answered on the fork`);
}
const posts = await client.callTool({
  name: 'bootr_agent_posts',
  arguments: { id: String(bootrCoin.agentId) },
});
console.log(
  `--  bootr_agent_posts: ${posts.isError ? `answered with the expected refusal when no agent service runs: ${posts.content[0].text.slice(0, 120)}` : 'answered'}`,
);

await client.close();
console.log(`\nAll ${results.length} checks passed. Nothing was sent anywhere but ${RPC}.`);
