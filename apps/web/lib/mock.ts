/**
 * In-memory fixtures for NEXT_PUBLIC_USE_MOCK=1 (or when no indexer URL is set).
 * Deterministic (seeded) so reloads look the same; a small simulator mutates the store
 * and emits stream hints so live UI (reordering grid, ticking numbers) can be exercised.
 */
import type { Address, Hex } from 'viem';
import { ALWAYS_ON_CAPABILITIES, CAPABILITY_KEYS, DEFAULT_WORKER_TEMPLATE, POSTS_PER_DAY, postIntervalForPostsPerDay, workerTemplateByHash, workerTemplateById } from '@bootr/shared/workers';
import { agentCardUrl, contractUriUrl, mockLaunchId } from './agent-card';
import type { CoinPageLinks } from './coin-links';
import { DEFAULT_IMAGE_MODEL } from './models';
import { SERVICES_DEFAULTS } from './types';
import type {
  Agent,
  AgentActivityItem,
  AgentApproval,
  AgentApprovals,
  AgentChat,
  AgentChatMessage,
  AgentNotification,
  AgentNotifications,
  AgentConfig,
  AgentConfigChanges,
  AgentFuel,
  AgentPost,
  AgentStatus,
  AgentWithToken,
  ApprovalDecision,
  BoardId,
  BoardPeriod,
  CreatorCoin,
  CreatorProfile,
  DailyStat,
  FeesByKind,
  FuelEvent,
  Holding,
  LaunchSource,
  Leaderboard,
  LeaderboardRow,
  PlatformStats,
  StreamHint,
  Token,
  TokenDetail,
  TokenPage,
  TokenTab,
  Trade,
} from './types';
import { TRENDING_WINDOW_HOURS, trendingScore, type TrendingWallet } from '@bootr/shared/trending';
import { BOARD_META } from './leaderboards';
import { dayEndUnix, dayStartUnix, type TokenFilters } from './token-filters';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES: [string, string][] = [
  ['Ledger Owl', 'OWL'], ['Quiet Engine', 'QENG'], ['Paper Hands Club', 'PHC'], ['Basewatch', 'BWATCH'],
  ['Night Shift', 'SHIFT'], ['Mean Reversion', 'MEANR'], ['Small Caps Daily', 'SCD'], ['Gas Station', 'GAS'],
  ['Sigma Desk', 'SIGMA'], ['Orderflow', 'FLOW'], ['Liquidity Monk', 'MONK'], ['Bluechip Butler', 'BUTLR'],
  ['The Archivist', 'ARCH'], ['Delta Neutral', 'DNTRL'], ['Onchain Weather', 'WTHR'], ['Funding Rate', 'FUND'],
  ['Slow Money', 'SLOW'], ['Ticker Tape', 'TAPE'], ['Mempool Diver', 'DIVE'], ['Grid Bot', 'GRID'],
  ['Contrarian', 'CNTR'], ['Base Camp', 'CAMP'], ['Moon Clerk', 'CLERK'], ['Signal Fire', 'FIRE'],
  ['Block Poet', 'POET'], ['Vault Keeper', 'VAULT'], ['Index Fund', 'INDX'], ['Late Night Degen', 'LND'],
  ['Research Hamster', 'HAMS'], ['Thesis', 'THSS'], ['Narrative Scout', 'SCOUT'], ['Chart Monk', 'CMONK'],
  ['Burn Notice', 'BURN'], ['Community Manager', 'CMGR'], ['Alpha Leak', 'LEAK'], ['Market Maker', 'MM'],
  ['Floor Sweeper', 'SWEEP'], ['Yield Farmer', 'FARM'], ['Stable Mind', 'STBL'], ['Risk Off', 'ROFF'],
  ['Long Horizon', 'LONG'], ['Sentiment Bot', 'SENT'], ['On Call', 'ONCALL'], ['Fair Launch', 'FAIR'],
  ['Hard Fork', 'FORK'], ['Cold Wallet', 'COLD'], ['Hot Take', 'HOT'], ['Ape Index', 'APEX'],
  ['Builder Notes', 'NOTES'], ['Rug Detector', 'RUGD'], ['Unit Economics', 'UNIT'], ['Patient Capital', 'PTNT'],
  ['Retro Funding', 'RETRO'], ['Gm Machine', 'GMM'], ['Sequencer', 'SEQ'], ['Blob Space', 'BLOB'],
  ['Layer Two', 'LTWO'], ['Data Availability', 'DA'], ['Proof Reader', 'PROOF'], ['Validator', 'VALI'],
  ['Copy Trader', 'COPY'], ['Macro Desk', 'MACRO'], ['Bear Case', 'BEAR'], ['Bull Case', 'BULL'],
  ['Rotation', 'ROTN'], ['Dust Collector', 'DUST'], ['Fee Switch', 'FEES'], ['Treasury Ops', 'TOPS'],
  ['Governance Clerk', 'GOV'], ['Airdrop Hunter', 'DROP'], ['Bridge Troll', 'TROLL'], ['Oracle', 'ORCL'],
  ['Arb Window', 'ARB'], ['Slippage', 'SLIP'], ['Exit Liquidity', 'EXIT'], ['Lindy Effect', 'LINDY'],
  ['Base Builder', 'BBLD'], ['Pixel Press', 'PIXL'], ['Weekly Recap', 'RECAP'], ['Stoic Trader', 'STOIC'],
  ['Calm Before', 'CALM'], ['Second Brain', 'BRAIN'], ['Reply Guy', 'REPLY'], ['Tape Reader', 'READ'],
];

const MODELS = ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.6', 'openai/gpt-4.1-mini', 'deepseek/deepseek-chat'];

function hex(rand: () => number, bytes: number): Hex {
  let s = '0x';
  for (let i = 0; i < bytes; i++) s += Math.floor(rand() * 256).toString(16).padStart(2, '0');
  return s as Hex;
}

/** Monochrome geometric avatar as a data URI. No stock imagery. */
export function avatarFor(symbol: string, seed: number): string {
  const r = mulberry32(seed);
  const shade = ['#171717', '#2b2b2b', '#404040', '#e5e5e5', '#f5f5f5', '#d4d4d4'][Math.floor(r() * 6)]!;
  const dark = ['#171717', '#2b2b2b', '#404040'].includes(shade);
  const fg = dark ? '#ffffff' : '#171717';
  const kind = Math.floor(r() * 4);
  let shape = '';
  if (kind === 0) shape = `<circle cx="32" cy="32" r="${12 + Math.floor(r() * 8)}" fill="none" stroke="${fg}" stroke-width="3"/>`;
  else if (kind === 1) shape = `<rect x="18" y="18" width="28" height="28" fill="none" stroke="${fg}" stroke-width="3"/><rect x="28" y="28" width="8" height="8" fill="${fg}"/>`;
  else if (kind === 2) shape = `<path d="M16 46L32 18L48 46Z" fill="none" stroke="${fg}" stroke-width="3" stroke-linejoin="round"/>`;
  else shape = `<path d="M16 24H48M16 32H40M16 40H32" stroke="${fg}" stroke-width="3"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${shade}"/>${shape}<text x="60" y="60" text-anchor="end" font-family="monospace" font-size="9" fill="${fg}" opacity="0.6">${symbol.slice(0, 4)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface Store {
  now: number;
  tokens: Token[];
  agents: Map<string, Agent>;
  trades: Map<string, Trade[]>;
  daily: DailyStat[];
  platform: PlatformStats;
  seq: number;
  /** Supervisor-side state the coin page reads through /api/agent/[kernel]/*: built lazily per kernel. */
  configs: Map<string, AgentConfig>;
  activity: Map<string, AgentActivityItem[]>;
  /** The review queue per kernel (post approval mode), built lazily like the config. */
  approvals: Map<string, AgentApproval[]>;
  /** The creator's inbox per kernel, built lazily like the config. */
  inboxes: Map<string, MockInbox>;
  /** The creator's chat per kernel. */
  chats: Map<string, AgentChatMessage[]>;
  /** The coin's own links (what the hosted contract URI would carry), keyed by the token's `metadata` URL. */
  links: Map<string, CoinPageLinks>;
  /** The creators' off-chain images, by lowercase coin address. */
  images: Map<string, string>;
  /** Lowercase kernels of brand-new agents (`freshen`): no X account, no instructions, no fuel, no gas, an empty tape. */
  fresh: Set<string>;
}

let store: Store | null = null;
const listeners = new Set<(h: StreamHint) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const STATUS_WEIGHTS: [AgentStatus, number][] = [
  ['awake', 0.46],
  ['sleeping', 0.34],
  ['paused', 0.08],
  ['dormant', 0.09],
  ['claimed', 0.03],
];

function pickStatus(r: number): AgentStatus {
  let acc = 0;
  for (const [s, w] of STATUS_WEIGHTS) {
    acc += w;
    if (r < acc) return s;
  }
  return 'sleeping';
}

const CREATORS: Address[] = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
];

/** Mock wallets that hold the creator and the platform share of one coin: the shares told apart, and not. */
const TWO_SLOT_WALLETS: Record<string, CreatorCoin['creatorFees']> = {
  '0x3333333333333333333333333333333333333333': {
    earnedUsd: 7650.81,
    claimedUsd: 7751.57,
    earnedWeth: '3250024800138206000',
    claimedWeth: '3249735281041840478',
    otherShares: [{ kind: 'platform', earnedUsd: 5597.85, claimedUsd: 5670.5 }],
  },
  '0x4444444444444444444444444444444444444444': {
    earnedUsd: 7650.81,
    claimedUsd: null,
    earnedWeth: '3250024800138206000',
    claimedWeth: null,
    otherShares: [{ kind: 'platform', earnedUsd: 5597.85, claimedUsd: null }],
  },
};

function makeToken(i: number, name: string, symbol: string, launchedAt: number, rand: () => number): { token: Token; agent: Agent } {
  const id = hex(rand, 20) as Address;
  const kernel = hex(rand, 20) as Address;
  const buyback = rand() < 0.35;
  // Skewed: most coins are small; older coins drift larger. ~1 in 4 graduates.
  const mcap = Math.round(Math.pow(10, 3.4 + Math.pow(rand(), 1.7) * 2.6 + Math.min(1, i / 40) * 0.5));
  const priceUsd = mcap / 1_000_000_000;
  const vol = mcap * (0.05 + rand() * 0.5);
  const status = pickStatus(rand());
  const lastActivityAt =
    status === 'dormant' || status === 'claimed'
      ? launchedAt + 3600 * 24 * Math.floor(rand() * 10)
      : Math.floor(Date.now() / 1000) - Math.floor(rand() * 3600 * 8);
  const graduated = mcap >= 50_000;
  const treasuryUsd = Math.round(5 + rand() * 900);
  // x402 spender float (deterministic, no rand() draw so the rest of the mock stays stable):
  // a few USDC carved out of the treasury's USDC share; every 4th agent's spender is empty.
  const spenderUsdc = i % 4 === 3 ? 0 : Math.round(Math.min(treasuryUsd * 0.05, 4.5) * 1e6);
  const token: Token = {
    id,
    chainId: 84532,
    name,
    symbol,
    image: avatarFor(symbol, i + 7),
    creator: i % 9 === 0 ? CREATORS[0]! : (hex(rand, 20) as Address),
    kernel,
    burner: buyback ? (hex(rand, 20) as Address) : null,
    agentId: String(100 + i),
    poolId: hex(rand, 32),
    pairedToken: '0x4200000000000000000000000000000000000006',
    lpFeeBps: 10000,
    source: 'bootr',
    // BootrLauncher presets (out of 10000; the locker holds them as 9000-bps slots).
    agentBps: 500,
    creatorBps: buyback ? 5000 : 6500,
    burnBps: buyback ? 1500 : 0,
    platformBps: 3000,
    workerHash: hex(rand, 32),
    model: MODELS[Math.floor(rand() * MODELS.length)]!,
    agentUri: agentCardUrl(mockLaunchId(id)),
    metadata: contractUriUrl(mockLaunchId(id)),
    xHandle: rand() < 0.9 ? symbol.toLowerCase() + '_agent' : null,
    launchedAt,
    launchBlock: String(18_000_000 + i * 1000),
    priceUsd,
    marketCapUsd: mcap,
    liquidityUsd: mcap * 0.18,
    volume24hUsd: vol,
    volume7dUsd: vol * (3 + rand() * 4),
    fees24hUsd: vol * 0.01,
    holders: Math.round(20 + Math.sqrt(mcap) * (1 + rand())),
    graduated,
    graduatedAt: graduated ? launchedAt + Math.floor(rand() * 86400 * 3) : null,
    change24hPct: (rand() - 0.45) * 60,
    agent: { id: kernel, status },
  };
  const agent: Agent = {
    id: kernel,
    token: id,
    status,
    lastActivityAt,
    dormancyPeriod: 90 * 86400,
    dormantSince: status === 'dormant' || status === 'claimed' ? lastActivityAt + 90 * 86400 : null,
    treasuryUsdc: String(Math.round(treasuryUsd * 0.6 * 1e6) - spenderUsdc),
    treasuryWeth: (BigInt(Math.round(treasuryUsd * 0.3 * 1e6)) * 10n ** 12n / 3000n).toString(),
    treasuryEth: (BigInt(Math.round(treasuryUsd * 0.02 * 1e6)) * 10n ** 12n / 3000n).toString(),
    treasuryOwnToken: (BigInt(Math.round(rand() * 5_000_000)) * 10n ** 18n).toString(),
    spender: `0x${kernel.slice(2, 40)}5e` as Address,
    spenderUsdc: String(spenderUsdc),
    treasuryUsd,
    fuelReceivedUsdc: String(Math.round((20 + rand() * 300) * 1e6)),
    feesClaimedUsd: Math.round(vol * 0.002 * 100) / 100,
    reputationScore: rand() < 0.85 ? Math.round((55 + rand() * 45) * 10) / 10 : null,
    reputationCount: Math.floor(rand() * 240),
    lastPostAt: status === 'awake' ? Math.floor(Date.now() / 1000) - Math.floor(rand() * 7200) : null,
    postsCount24h: status === 'awake' ? Math.floor(rand() * 18) : 0,
  };
  return { token, agent };
}

/** The one mock coin launched through Clanker (`Basewatch`): the fourth newest, so the newest coin stays a Bootr coin. */
const CLANKER_INDEX = 3;
/** The one mock coin whose agent is brand new (`Night Shift`): the fifth newest, so the tests' "first card" keeps a working agent. */
const FRESH_INDEX = 4;

/**
 * A coin just launched by a creator who has done nothing yet: no X account, a sleeping agent, an empty treasury,
 * no fuel ever received, no trades. With `fresh` in the store it also gets no gas, no instructions, no fuel rows,
 * nothing in the inbox or the review queue and only the launch on its tape, so the creator console's first-steps
 * card shows every step undone.
 */
function freshen(token: Token, agent: Agent) {
  token.xHandle = null;
  token.graduated = false;
  token.graduatedAt = null;
  token.marketCapUsd = 4200;
  token.priceUsd = token.marketCapUsd / 1e9;
  token.liquidityUsd = 760;
  token.volume24hUsd = 0;
  token.volume7dUsd = 0;
  token.fees24hUsd = 0;
  token.holders = 1;
  token.change24hPct = 0;
  token.agent = { id: agent.id, status: 'sleeping' };
  agent.status = 'sleeping';
  agent.lastActivityAt = token.launchedAt;
  agent.dormantSince = null;
  agent.treasuryUsdc = '0';
  agent.treasuryWeth = '0';
  agent.treasuryEth = '0';
  agent.treasuryOwnToken = '0';
  agent.spenderUsdc = '0';
  agent.treasuryUsd = 0;
  agent.fuelReceivedUsdc = '0';
  agent.feesClaimedUsd = 0;
  agent.reputationScore = null;
  agent.reputationCount = 0;
  agent.lastPostAt = null;
  agent.postsCount24h = 0;
}

function isFresh(kernel: string): boolean {
  return mockStore().fresh.has(kernel.toLowerCase());
}
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;

/** Turns a mock token into a Clanker-path coin: the slots share the whole 1% fee, a burn share goes to the dead address. */
function clankerize(token: Token, lpFeeBps = 10000) {
  token.source = 'clanker';
  token.lpFeeBps = lpFeeBps;
  token.burner = token.burnBps > 0 ? DEAD : null;
}

function makeTrades(t: Token, rand: () => number, now: number): Trade[] {
  const out: Trade[] = [];
  let ts = now - Math.floor(rand() * 120);
  for (let k = 0; k < 24; k++) {
    const side = rand() < 0.55 ? 'buy' : 'sell';
    const valueUsd = Math.round((10 + rand() * rand() * 4000) * 100) / 100;
    const p = t.priceUsd * (0.96 + rand() * 0.08);
    out.push({
      id: `${t.id}-${k}`,
      token: t.id,
      trader: hex(rand, 20) as Address,
      side,
      amountToken: (BigInt(Math.round((valueUsd / p) * 1e4)) * 10n ** 14n).toString(),
      amountPaired: (BigInt(Math.round((valueUsd / 3000) * 1e9)) * 10n ** 9n).toString(),
      priceUsd: p,
      valueUsd,
      timestamp: ts,
      txHash: hex(rand, 32),
    });
    ts -= Math.floor(30 + rand() * 900);
  }
  return out;
}

function init(): Store {
  const rand = mulberry32(8453);
  const now = Math.floor(Date.now() / 1000);
  const tokens: Token[] = [];
  const agents = new Map<string, Agent>();
  const trades = new Map<string, Trade[]>();
  let launchedAt = now - 60 * 4;
  const links = new Map<string, CoinPageLinks>();
  const fresh = new Set<string>();
  NAMES.forEach(([name, symbol], i) => {
    const { token, agent } = makeToken(i, name, symbol, launchedAt, rand);
    if (i === CLANKER_INDEX) clankerize(token);
    if (i === FRESH_INDEX) {
      freshen(token, agent);
      fresh.add(token.kernel.toLowerCase());
    }
    // The newest coin carries project links, its X account among them (distinct from its agent's handle).
    if (i === 0) links.set(token.metadata, { website: 'https://ledgerowl.example', x: 'https://x.com/ledgerowl', telegram: 'https://t.me/ledgerowl', discord: null });
    // The second one's only X account is its agent's own, as coins launched before the project X field carry it.
    if (i === 1) {
      token.xHandle ??= 'qeng_agent';
      links.set(token.metadata, { website: null, x: `https://x.com/${token.xHandle}`, telegram: null, discord: null });
    }
    tokens.push(token);
    agents.set(agent.id.toLowerCase(), agent);
    // The fresh coin's trades are still drawn so the other coins' numbers stay where they were; it keeps none.
    const tradeList = makeTrades(token, rand, now);
    trades.set(token.id.toLowerCase(), i === FRESH_INDEX ? [] : tradeList);
    launchedAt -= Math.floor(600 + rand() * 3600 * 9);
  });

  const daily: DailyStat[] = [];
  let awake = 6;
  let burned = 0;
  for (let d = 89; d >= 0; d--) {
    const date = new Date((now - d * 86400) * 1000).toISOString().slice(0, 10);
    const growth = 1 + (89 - d) / 30;
    const volumeUsd = Math.round(40_000 * growth * (0.6 + rand() * 0.8));
    const feesUsd = volumeUsd * 0.01;
    const lp = feesUsd * 0.9; // the reward slots get 90% of the 1% swap fee, RWAGMI 10%
    awake = Math.max(3, Math.round(awake + (rand() - 0.35) * 3));
    const burnedUsd = lp * 0.05;
    burned += burnedUsd;
    daily.push({
      id: date,
      launches: Math.max(0, Math.round(growth * (1 + rand() * 4))),
      volumeUsd,
      feesUsd,
      feesAgentUsd: lp * 0.05,
      feesCreatorUsd: lp * 0.6,
      feesBurnUsd: burnedUsd,
      feesPlatformUsd: lp * 0.3,
      activeAgents: awake + Math.round(rand() * 10),
      awakeAgents: awake,
      bootBurnedToken: (BigInt(Math.round(burnedUsd * 4000)) * 10n ** 18n).toString(),
      bootBurnedUsd: burnedUsd,
    });
  }

  const platform: PlatformStats = {
    tokens: tokens.length,
    agentsAwake: [...agents.values()].filter((a) => a.status === 'awake').length,
    volume24hUsd: daily[daily.length - 1]!.volumeUsd,
    volumeTotalUsd: daily.reduce((s, d) => s + d.volumeUsd, 0),
    feesTotalUsd: daily.reduce((s, d) => s + d.feesUsd, 0),
    bootToken: '0xb007b007b007b007b007b007b007b007b007b007',
    bootPriceUsd: 0.000248,
    bootMarketCapUsd: 248_000,
    bootChange24hPct: 6.4,
    bootBurnedTotal: (BigInt(Math.round(burned * 4000)) * 10n ** 18n).toString(),
    bootFeesToBurnUsd: 312.4,
    graduationThresholdUsd: 50_000,
    updatedAt: now,
  };

  return { now, tokens, agents, trades, daily, platform, seq: 0, configs: new Map(), activity: new Map(), inboxes: new Map(), chats: new Map(), approvals: new Map(), links, images: new Map(), fresh };
}

export function mockStore(): Store {
  if (!store) store = init();
  return store;
}

function emit(h: StreamHint) {
  for (const l of listeners) l(h);
}

/** Simulated SSE: small market moves every few seconds, a new launch every ~4th tick. */
export function subscribeMock(listener: (h: StreamHint) => void): () => void {
  listeners.add(listener);
  if (!timer && typeof window !== 'undefined') {
    const rand = mulberry32(Date.now() % 100000);
    timer = setInterval(() => {
      const s = mockStore();
      s.seq++;
      for (let k = 0; k < 3; k++) {
        const t = s.tokens[Math.floor(rand() * Math.min(30, s.tokens.length))]!;
        // A brand-new coin stays untraded, so its agent's first-steps card keeps its meaning.
        if (s.fresh.has(t.kernel.toLowerCase())) continue;
        const move = 1 + (rand() - 0.42) * 0.5;
        t.marketCapUsd = Math.max(1500, t.marketCapUsd * move);
        t.priceUsd = t.marketCapUsd / 1e9;
        const v = t.marketCapUsd * rand() * 0.05;
        t.volume24hUsd += v;
        t.fees24hUsd += v * 0.01;
        t.change24hPct = (t.change24hPct ?? 0) + (move - 1) * 100;
        t.lastTradeAt = Math.floor(Date.now() / 1000);
        if (!t.graduated && t.marketCapUsd >= s.platform.graduationThresholdUsd) {
          t.graduated = true;
          t.graduatedAt = Math.floor(Date.now() / 1000);
        }
        emit({ type: 'trade', tokenId: t.id });
      }
      s.platform.bootPriceUsd *= 1 + (rand() - 0.48) * 0.02;
      s.platform.bootMarketCapUsd = s.platform.bootPriceUsd * 1e9;
      s.platform.bootFeesToBurnUsd += rand() * 3;
      s.platform.volume24hUsd += rand() * 400;
      if (s.seq % 4 === 0) {
        const [name, symbol] = NAMES[Math.floor(rand() * NAMES.length)]!;
        const { token, agent } = makeToken(s.tokens.length + 1000, `${name} ${s.seq}`, `${symbol}${s.seq}`, Math.floor(Date.now() / 1000), rand);
        token.marketCapUsd = 4000 + rand() * 3000;
        token.priceUsd = token.marketCapUsd / 1e9;
        token.graduated = false;
        token.graduatedAt = null;
        token.volume24hUsd = 500 + rand() * 2000;
        agent.status = 'awake';
        token.agent = { id: agent.id, status: 'awake' };
        s.tokens.unshift(token);
        s.agents.set(agent.id.toLowerCase(), agent);
        s.trades.set(token.id.toLowerCase(), makeTrades(token, rand, Math.floor(Date.now() / 1000)));
        s.platform.tokens = s.tokens.length;
        emit({ type: 'launch', tokenId: token.id });
      }
    }, 5000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// ---- query helpers used by lib/indexer.ts in mock mode ----

const clone = <T,>(v: T): T => structuredClone(v);

/** Same meaning as the indexer's filters on `/tokens/list`. */
function matchesFilters(t: Token, f: TokenFilters): boolean {
  if (f.creator && t.creator.toLowerCase() !== f.creator) return false;
  if (f.path && (t.source ?? 'bootr') !== f.path) return false;
  if (f.from && t.launchedAt < dayStartUnix(f.from)) return false;
  if (f.to && t.launchedAt > dayEndUnix(f.to)) return false;
  if (f.agent === 'yes' && !t.agent) return false;
  if (f.agent === 'no' && t.agent) return false;
  return true;
}

/** Per-wallet trades inside the window, scored by the function the indexer uses. */
function mockTrending(trades: Trade[], now: number): number {
  const wallets = new Map<string, TrendingWallet>();
  for (const tr of trades) {
    if (tr.timestamp < now - TRENDING_WINDOW_HOURS * 3600) continue;
    const w = wallets.get(tr.trader) ?? { volumeUsd: 0, trades: 0 };
    w.volumeUsd += tr.valueUsd;
    w.trades += 1;
    wallets.set(tr.trader, w);
  }
  return trendingScore([...wallets.values()]);
}

/** A stable number in 0..1 per (address, salt), for mock figures with no field in the store. */
function stable(id: string, salt: string): number {
  let h = 2166136261;
  for (const ch of `${id.toLowerCase()}:${salt}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return mulberry32(h >>> 0)();
}

export const mock = {
  /**
   * Deterministic WETH fee balance (wei) for mock mode; some are zero. `scope` is a pool id for the unsettled
   * `pendingQuote(poolId, owner)` or `'settled'` for `claimableQuote(owner, WETH)`.
   */
  claimable(owner: string, scope: string): bigint {
    let h = 2166136261;
    for (const ch of `${owner.toLowerCase()}:${scope.toLowerCase()}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const r = mulberry32(h >>> 0);
    if (r() < 0.25) return 0n;
    // Up to ~0.05 WETH settled, ~0.01 WETH per pool unsettled.
    return BigInt(Math.floor(r() * (scope === 'settled' ? 5e4 : 1e4))) * 10n ** 12n;
  },
  /**
   * Deterministic WETH balance (wei) waiting in Clanker's fee locker for `owner`, in place of
   * `ClankerFeeLocker.availableFees(owner, WETH)`: between 0.001 and 0.05 WETH, never zero, so the creator panels
   * always have something to claim in mock mode.
   */
  clankerFees(owner: string): bigint {
    let h = 2166136261;
    for (const ch of `${owner.toLowerCase()}:clanker-fees`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const r = mulberry32(h >>> 0);
    return BigInt(1000 + Math.floor(r() * 49_000)) * 10n ** 12n;
  },
  /**
   * Deterministic agent gas (wei) for mock mode, in place of `EntryPoint.balanceOf(kernel)` and the kernel's
   * ETH balance. Most kernels are well funded; about one in five is low and one in ten is out of gas.
   */
  gas(kernel: string): { deposit: bigint; balance: bigint } {
    if (isFresh(kernel)) return { deposit: 0n, balance: 0n };
    let h = 2166136261;
    for (const ch of `${kernel.toLowerCase()}:gas`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const r = mulberry32(h >>> 0);
    const band = r();
    // ok: 0.0003–0.003 ETH; low: 0.00005–0.00019 ETH; empty: 0–0.00003 ETH
    const eth = band < 0.1 ? r() * 0.00003 : band < 0.3 ? 0.00005 + r() * 0.00014 : 0.0003 + r() * 0.0027;
    const total = BigInt(Math.floor(eth * 1e9)) * 10n ** 9n;
    const deposit = (total * BigInt(60 + Math.floor(r() * 40))) / 100n;
    return { deposit, balance: total - deposit };
  },
  tokens(tab: string, after: string | null, limit: number) {
    const s = mockStore();
    let list = [...s.tokens];
    if (tab === 'graduated') list = list.filter((t) => t.graduated).sort((a, b) => (b.graduatedAt ?? 0) - (a.graduatedAt ?? 0));
    else if (tab === 'mcap') list.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    else if (tab === 'active') list = list.filter((t) => t.agent?.status === 'awake').sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    else list.sort((a, b) => (b.lastTradeAt ?? b.launchedAt) - (a.lastTradeAt ?? a.launchedAt));
    const start = after ? Number(after) : 0;
    const items = list.slice(start, start + limit);
    const next = start + limit;
    return clone({ items, pageInfo: { endCursor: next < list.length ? String(next) : null, hasNextPage: next < list.length } });
  },
  /** The tokens page with filters and a sort, what `/tokens/list` and `/tokens/trending` answer on the real indexer. */
  tokenList(tab: TokenTab, filters: TokenFilters, after: string | null, limit: number): TokenPage {
    const s = mockStore();
    let list = s.tokens.filter((t) => matchesFilters(t, filters));
    if (tab === 'trending') {
      const now = Math.floor(Date.now() / 1000);
      const scored = list.map((t) => ({ t, score: mockTrending(s.trades.get(t.id.toLowerCase()) ?? [], now) }));
      list = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.t);
    } else {
      if (tab === 'graduated') list = list.filter((t) => t.graduated).sort((a, b) => (b.graduatedAt ?? 0) - (a.graduatedAt ?? 0));
      else if (tab === 'mcap') list.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
      else if (tab === 'active') list = list.filter((t) => t.agent?.status === 'awake').sort((a, b) => b.volume24hUsd - a.volume24hUsd);
      else list.sort((a, b) => (b.lastTradeAt ?? b.launchedAt) - (a.lastTradeAt ?? a.launchedAt));
      if (filters.sort === 'bumped') list.sort((a, b) => (b.lastTradeAt ?? b.launchedAt) - (a.lastTradeAt ?? a.launchedAt));
      if (filters.sort === 'launched') list.sort((a, b) => b.launchedAt - a.launchedAt);
      if (filters.sort === 'mcap') list.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
      if (filters.sort === 'volume24h') list.sort((a, b) => b.volume24hUsd - a.volume24hUsd);
      if (filters.sort === 'holders') list.sort((a, b) => b.holders - a.holders);
    }
    const start = after ? Number(after) : 0;
    const next = start + limit;
    return clone({ items: list.slice(start, next), pageInfo: { endCursor: next < list.length ? String(next) : null, hasNextPage: next < list.length } });
  },
  /** One board, what `GET /leaderboards/:board` answers on the real indexer. */
  leaderboard(board: BoardId, period: BoardPeriod): Leaderboard {
    const s = mockStore();
    const now = Math.floor(Date.now() / 1000);
    const part = period === '24h' ? 0.04 : period === '7d' ? 0.3 : 1;
    const figure = (t: Token): { value: number | null; detail?: LeaderboardRow['detail'] } => {
      const agent = s.agents.get(t.kernel.toLowerCase());
      if (board === 'volume') return { value: period === '24h' ? t.volume24hUsd : period === '7d' ? t.volume7dUsd : t.volume7dUsd * 3 };
      if (board === 'holders') return { value: t.holders };
      if (board === 'agent-fees') return { value: t.volume7dUsd * 0.01 * 4 * (t.agentBps / 10000) * part };
      // Every fifth agent has sent no report: unknown, not zero.
      if (board === 'agent-activity') return stable(t.id, 'report') < 0.2 ? { value: null } : { value: agent?.postsCount24h ?? 0, detail: { lastPostAt: agent?.lastPostAt ?? null } };
      if (t.burnBps === 0) return { value: 0 };
      const pct = 0.02 + stable(t.id, 'burned') * 6 * part;
      return { value: Math.round(pct * 10_000) / 10_000, detail: { amountToken: (BigInt(Math.round(pct * 1e7)) * 10n ** 18n).toString() } };
    };
    const rows = s.tokens.map((t) => ({ t, ...figure(t) }));
    const known = rows.filter((r): r is typeof r & { value: number } => r.value !== null && r.value > 0).sort((a, b) => b.value - a.value);
    const periods = BOARD_META.find((b) => b.id === board)!.periods;
    return clone({
      board,
      period,
      periods: [...periods],
      unit: board === 'burned' ? ('percent' as const) : board === 'holders' || board === 'agent-activity' ? ('count' as const) : ('usd' as const),
      readAt: now,
      indexedAt: now - 40,
      ranked: known.length,
      unknown: rows.filter((r) => r.value === null).length,
      items: known.slice(0, 50).map((r, i) => ({
        rank: i + 1,
        value: r.value,
        ...(r.detail ? { detail: r.detail } : {}),
        token: { id: r.t.id, name: r.t.name, symbol: r.t.symbol, image: r.t.image, creator: r.t.creator, source: r.t.source, xHandle: r.t.xHandle, kernel: r.t.kernel, agentId: r.t.agentId },
        agent: r.t.agent ?? null,
      })),
    });
  },
  /** What `GET /api/coin-images` answers. */
  coinImages(): Record<string, string> {
    return Object.fromEntries(mockStore().images);
  },
  /** The creator's image edit on the mock store; null goes back to the coin's own image. The token rows are not touched. */
  setCoinImage(token: string, image: string | null) {
    const { images } = mockStore();
    if (image) images.set(token.toLowerCase(), image);
    else images.delete(token.toLowerCase());
  },
  /** The mock coin with that address, as the image route reads it from the indexer: `null` when unknown. */
  coinOfId(id: string): { creator: Address } | null {
    const t = mockStore().tokens.find((x) => x.id.toLowerCase() === id.toLowerCase());
    return t ? { creator: t.creator } : null;
  },
  /** One creator's public record, what `GET /creator/:address` answers on the real indexer. */
  creatorProfile(address: string): CreatorProfile {
    const creator = address.toLowerCase() as Address;
    const twoSlots = TWO_SLOT_WALLETS[creator];
    const coins: CreatorCoin[] = twoSlots
      ? mockStore()
          .tokens.slice(0, 1)
          .map((t) => ({ ...t, creator, platformRecipient: creator, creatorFees: twoSlots }))
      : mockStore()
          .tokens.filter((t) => t.creator.toLowerCase() === creator)
          .map((t) => {
            const { accruedUsd, claimedUsd } = mock.fees(t.id).byKind.creator;
            return { ...t, creatorFees: { earnedUsd: accruedUsd, claimedUsd } };
          });
    const known = coins.filter((c) => c.creatorFees.claimedUsd !== null);
    return clone({
      address: creator,
      readAt: Math.floor(Date.now() / 1000),
      indexedAt: Math.floor(Date.now() / 1000) - 40,
      totals: {
        coins: coins.length,
        agents: coins.filter((c) => c.agent).length,
        earnedUsd: coins.reduce((s, c) => s + c.creatorFees.earnedUsd, 0),
        claimedUsd: coins.length > 0 && known.length === 0 ? null : known.reduce((s, c) => s + (c.creatorFees.claimedUsd ?? 0), 0),
        earnedWeth: twoSlots?.earnedWeth,
        claimedWeth: twoSlots?.claimedWeth,
      },
      coins,
    });
  },
  /** The coin's own links by its `metadata` URL (mock stand-in for the hosted contract URI); none for most coins. */
  coinLinks(metadata: string): CoinPageLinks {
    return mockStore().links.get(metadata) ?? { website: null, x: null, telegram: null, discord: null };
  },
  /**
   * The creator's links edit (`PUT /api/agent/[kernel]/links`) on the mock store: the coin's links map is replaced
   * under its `metadata` URL, so the coin page shows the new links. The route calls it on the server; the coin page
   * calls it again on its own copy of the store after a save. 404 when no coin has that treasury.
   */
  updateCoinLinks(kernel: string, links: CoinPageLinks): { ok: true; links: CoinPageLinks } | { ok: false; status: number; error: string; message: string } {
    const s = mockStore();
    const token = s.tokens.find((t) => t.kernel.toLowerCase() === kernel.toLowerCase());
    if (!token) return { ok: false, status: 404, error: 'unknown_coin', message: 'No indexed coin has that treasury.' };
    const next = { ...links };
    s.links.set(token.metadata, next);
    return { ok: true, links: { ...next } };
  },
  /** The mock coin with that treasury, as the creator routes read it from the indexer: `null` when unknown. */
  coinOfKernel(kernel: string): { metadata: string; symbol: string; xHandle: string | null; creator: Address } | null {
    const t = mockStore().tokens.find((x) => x.kernel.toLowerCase() === kernel.toLowerCase());
    return t ? { metadata: t.metadata, symbol: t.symbol, xHandle: t.xHandle, creator: t.creator } : null;
  },
  token(id: string): TokenDetail | null {
    const s = mockStore();
    const t = s.tokens.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!t) return null;
    const agent = s.agents.get(t.kernel.toLowerCase()) ?? null;
    return clone({ ...t, agent, trades: s.trades.get(t.id.toLowerCase())?.slice(0, 20) ?? [] });
  },
  agent(kernel: string): Agent | null {
    const a = mockStore().agents.get(kernel.toLowerCase());
    return a ? clone(a) : null;
  },
  agents(): AgentWithToken[] {
    const s = mockStore();
    return clone(
      [...s.agents.values()].map((a) => {
        const t = s.tokens.find((x) => x.id === a.token);
        return {
          ...a,
          tokenInfo: t ? { id: t.id, name: t.name, symbol: t.symbol, image: t.image, creator: t.creator, xHandle: t.xHandle, source: t.source, lpFeeBps: t.lpFeeBps } : null,
        };
      }),
    );
  },
  fees(id: string): FeesByKind {
    const t = mockStore().tokens.find((x) => x.id.toLowerCase() === id.toLowerCase());
    const total = (t?.volume7dUsd ?? 0) * 0.01 * 4;
    const k = (b: number) => ({ accruedUsd: (total * b) / 10000, claimedUsd: (total * b * 0.7) / 10000 });
    return {
      byKind: {
        agent: k(t?.agentBps ?? 500),
        creator: k(t?.creatorBps ?? 6500),
        burn: k(t?.burnBps ?? 0),
        platform: k(t?.platformBps ?? 3000),
      },
    };
  },
  daily(): DailyStat[] {
    return clone(mockStore().daily);
  },
  platform(): PlatformStats {
    return clone(mockStore().platform);
  },
  search(q: string) {
    const needle = q.trim().toLowerCase().replace(/^[@$]/, '');
    if (!needle) return [];
    return clone(
      mockStore()
        .tokens.filter(
          (t) =>
            t.name.toLowerCase().includes(needle) ||
            t.symbol.toLowerCase().includes(needle) ||
            t.id.toLowerCase().includes(needle) ||
            (t.xHandle ?? '').toLowerCase().includes(needle),
        )
        .slice(0, 20),
    );
  },
  tokensByCreator(creator: string): Token[] {
    const s = mockStore();
    const mine = s.tokens.filter((t) => t.creator.toLowerCase() === creator.toLowerCase());
    // Demo fallback so a freshly connected wallet sees a populated profile in mock mode.
    return clone(mine.length ? mine : s.tokens.slice(2, 5));
  },
  holdings(): Holding[] {
    const s = mockStore();
    return clone(
      s.tokens.slice(6, 11).map((t, i) => {
        const amount = (i + 1) * 1_250_000;
        return {
          token: { id: t.id, name: t.name, symbol: t.symbol, image: t.image, priceUsd: t.priceUsd, marketCapUsd: t.marketCapUsd },
          balance: (BigInt(amount) * 10n ** 18n).toString(),
          valueUsd: amount * t.priceUsd,
        };
      }),
    );
  },
  fuelHistory(): FuelEvent[] {
    const s = mockStore();
    return s.tokens.slice(2, 7).map((t, i) => ({
      txHash: `0x${'ab'.repeat(31)}${String(10 + i)}` as Hex,
      kernel: t.kernel,
      token: t.id,
      symbol: t.symbol,
      amountUsdc: String((20 + i * 15) * 1e6),
      timestamp: s.now - i * 86400 * 2 - 3600,
    }));
  },
  /** The agent's current configuration (lib/types AgentConfig); any valid kernel gets one so a fresh mock launch works. */
  agentConfig(kernel: string): AgentConfig {
    return clone(configFor(kernel));
  },
  /**
   * Applies the creator's changes the way the supervisor's PUT would: only the fields present, always-on powers forced
   * on, `revision` bumped, a `config_updated` row on the tape. `{ok: false}` with 409 when nothing changed.
   */
  updateAgentConfig(kernel: string, changes: AgentConfigChanges, by: string): { ok: true; config: AgentConfig } | { ok: false; status: number; error: string; message: string } {
    const cfg = configFor(kernel);
    const fields: string[] = [];
    if (changes.instructions !== undefined && changes.instructions !== cfg.instructions) {
      cfg.instructions = changes.instructions;
      fields.push('instructions');
    }
    if (changes.model !== undefined && changes.model !== cfg.model) {
      cfg.model = changes.model;
      fields.push('model');
    }
    const w = changes.worker;
    if (w?.capabilities) {
      const next = { ...cfg.worker.capabilities };
      for (const k of CAPABILITY_KEYS) if (!ALWAYS_ON_CAPABILITIES.includes(k) && typeof w.capabilities[k] === 'boolean') next[k] = w.capabilities[k]!;
      if (CAPABILITY_KEYS.some((k) => next[k] !== cfg.worker.capabilities[k])) {
        cfg.worker.capabilities = next;
        fields.push('capabilities');
      }
    }
    if (w?.postIntervalMs !== undefined && w.postIntervalMs !== cfg.worker.postIntervalMs) {
      cfg.worker.postIntervalMs = w.postIntervalMs;
      fields.push('postIntervalMs');
    }
    if (w?.jobLines !== undefined && JSON.stringify(w.jobLines) !== JSON.stringify(cfg.worker.jobLines)) {
      cfg.worker.jobLines = [...w.jobLines];
      fields.push('jobLines');
    }
    // The budget sets the quota (nothing to hold in mock mode) and the cadence follows it, as the supervisor does.
    if (changes.postsPerDay !== undefined && changes.postsPerDay !== cfg.postsPerDay) {
      cfg.postsPerDay = changes.postsPerDay;
      fields.push('posts per day');
      const interval = postIntervalForPostsPerDay(changes.postsPerDay);
      if (interval !== cfg.worker.postIntervalMs) {
        cfg.worker.postIntervalMs = interval;
        if (!fields.includes('postIntervalMs')) fields.push('cadence');
      }
    }
    if (changes.requireApproval !== undefined && changes.requireApproval !== cfg.requireApproval) {
      cfg.requireApproval = changes.requireApproval;
      fields.push('post review');
    }
    if (changes.routing !== undefined && changes.routing.decideModel !== cfg.routing.decideModel) {
      cfg.routing = { decideModel: changes.routing.decideModel };
      fields.push('economy mode');
    }
    if (changes.imageModel !== undefined && changes.imageModel !== cfg.imageModel) {
      cfg.imageModel = changes.imageModel;
      fields.push('image model');
    }
    if (changes.imageStyle) {
      const next = { reference: changes.imageStyle.reference !== undefined ? changes.imageStyle.reference : cfg.imageStyle.reference, notes: changes.imageStyle.notes ?? cfg.imageStyle.notes };
      if (next.reference !== cfg.imageStyle.reference || next.notes !== cfg.imageStyle.notes) {
        cfg.imageStyle = next;
        fields.push('image style');
      }
    }
    if (changes.services) {
      const next = { ...cfg.services, ...changes.services };
      if (JSON.stringify(next) !== JSON.stringify(cfg.services)) {
        cfg.services = next;
        fields.push('paid services caps');
      }
    }
    if (fields.length === 0) return { ok: false, status: 409, error: 'unchanged', message: 'Nothing changed.' };
    const workerFields = ['capabilities', 'postIntervalMs', 'cadence', 'jobLines'];
    if (fields.some((f) => workerFields.includes(f)) && cfg.worker.kind !== 'custom') cfg.worker.kind = 'custom';
    cfg.revision += 1;
    cfg.updatedAt = new Date().toISOString();
    activityFor(kernel).unshift({ at: cfg.updatedAt, kind: 'config_updated', summary: `Creator ${by.slice(0, 6)}…${by.slice(-4)} changed ${fields.join(', ')} (revision ${cfg.revision}).` });
    return { ok: true, config: clone(cfg) };
  },
  /** The creator's inbox (lib/types AgentNotifications). */
  agentNotifications(kernel: string): AgentNotifications {
    return inboxView(inboxFor(kernel));
  },
  /** Turns events off or on, as the supervisor's settings route would. */
  setNotificationOptOut(kernel: string, optOut: string[]): AgentNotifications {
    const inbox = inboxFor(kernel);
    inbox.optOut = optOut.filter((e) => MOCK_EVENTS.some((m) => m.key === e));
    return inboxView(inbox);
  },
  /** A pretend deep link; in mock mode the chat counts as linked at once, since no bot will answer. */
  telegramAction(kernel: string, action: 'link' | 'unlink'): { url: string | null } {
    const inbox = inboxFor(kernel);
    if (action === 'unlink') {
      inbox.telegram = { ...inbox.telegram, linked: false, linkedAt: null };
      return { url: null };
    }
    inbox.telegram = { ...inbox.telegram, linked: true, linkedAt: new Date().toISOString() };
    return { url: 'https://t.me/bootr_alerts_bot?start=mock-link-token' };
  },
  /** The creator's chat (lib/types AgentChat): no fuel or history checks in mock mode, only the limit. */
  agentChat(kernel: string): AgentChat {
    const messages = chatFor(kernel);
    const used = messages.filter((m) => m.role === 'creator').length;
    const limited = used >= MOCK_CHAT_LIMITS.perHour;
    return clone({
      messages,
      quote: {
        model: 'anthropic/claude-sonnet-4.6',
        approxMicroUsdc: Number(MOCK_CHAT_COST),
        basis: 'list_price' as const,
        maxMicroUsdc: 150_000,
        refusal: limited ? 'rate_limited' : null,
        refusalText: limited ? 'That is the chat limit for now: 20 messages an hour, 60 a day.' : null,
        limits: { ...MOCK_CHAT_LIMITS, usedHour: used, usedDay: used },
        maxChars: 1000,
      },
    });
  },
  /** One message and a canned answer. "Remember ..." pretends to store a note; everything else only talks. */
  sendAgentChat(kernel: string, text: string): { ok: true; reply: AgentChatMessage } | { ok: false; status: 409 | 429; error: string; message: string } {
    const messages = chatFor(kernel);
    if (messages.filter((m) => m.role === 'creator').length >= MOCK_CHAT_LIMITS.perHour) return { ok: false, status: 429, error: 'chat_rate_limited', message: 'That is the chat limit for now: 20 messages an hour, 60 a day.' };
    const at = new Date().toISOString();
    const n = messages.length;
    messages.push({ id: `msg_${n}`, role: 'creator', text, status: 'done', chargedMicroUsdc: null, remembered: false, at });
    const remembered = /\bremember\b/i.test(text);
    const reply: AgentChatMessage = {
      id: `msg_${n + 1}`,
      role: 'agent',
      text: remembered ? 'Noted. I will keep that in mind.' : /\b(post|tweet|swap|claim|send|transfer)\b/i.test(text) ? 'I can only talk here: posts and replies happen in my own turns, and treasury actions are not something I do from this chat.' : 'Quiet day so far: one post went out and the pool moved a little. Next I will look at the mentions when I wake.',
      status: 'done',
      chargedMicroUsdc: MOCK_CHAT_COST,
      remembered,
      at,
    };
    messages.push(reply);
    return { ok: true, reply: clone(reply) };
  },
  /** The review queue of the agent's posts (lib/types AgentApprovals); `all` includes decided items. */
  agentApprovals(kernel: string, status: 'pending' | 'all' = 'pending'): AgentApprovals {
    const list = approvalsFor(kernel);
    const items = status === 'all' ? list : list.filter((a) => a.status === 'pending_approval');
    return clone({ items, pending: list.filter((a) => a.status === 'pending_approval').length });
  },
  /**
   * Decides one queued item the way the supervisor would: approve "sends" it (a post row with a link lands on the
   * tape), reject marks it with the note. 404 unknown, 409 already decided.
   */
  decideApproval(kernel: string, approvalId: string, decision: ApprovalDecision, by: string, note: string | null): { ok: true; approval: AgentApproval } | { ok: false; status: number; error: string; message: string } {
    const item = approvalsFor(kernel).find((a) => a.id === approvalId);
    if (!item) return { ok: false, status: 404, error: 'not_found', message: 'No such item.' };
    if (item.status !== 'pending_approval') return { ok: false, status: 409, error: 'already_decided', message: `This item is ${item.status}.` };
    const t = mockStore().tokens.find((x) => x.kernel.toLowerCase() === kernel.toLowerCase());
    const at = new Date().toISOString();
    item.decision = decision;
    item.decidedBy = by;
    item.decidedAt = at;
    item.note = note;
    delete item.image?.dataUrl;
    const noun = item.kind === 'reply' ? 'Reply' : 'Post';
    if (decision === 'approve') {
      item.status = 'approved';
      const postId = String(1850000000000000000n + BigInt(parseInt(item.id.replace(/\D/g, '') || '0', 10)) * 10n + 7n);
      item.url = t?.xHandle ? `https://x.com/${t.xHandle}/status/${postId}` : null;
      activityFor(kernel).unshift({ at, kind: item.kind, summary: `${item.kind === 'reply' ? 'Replied' : 'Posted'}: ${item.text}`, ...(item.url ? { url: item.url } : {}) }, { at, kind: 'approval_approved', summary: `${noun} approved by the creator`, ...(item.url ? { url: item.url } : {}) });
    } else {
      item.status = 'rejected';
      activityFor(kernel).unshift({ at, kind: 'approval_rejected', summary: `${noun} rejected by the creator` });
    }
    const tape = activityFor(kernel);
    const idx = tape.findIndex((row) => row.kind === 'approval_pending' && row.at === item.createdAt);
    if (idx >= 0) tape.splice(idx, 1);
    return { ok: true, approval: clone(item) };
  },
  /** Fuel metering (lib/types AgentFuel): a week of thoughts split between the deciding model and the writer when economy mode is on. */
  agentFuel(kernel: string, days = 7): AgentFuel {
    const cfg = configFor(kernel);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    if (isFresh(kernel)) return { days, since, byModel: [], paidTo: null, picturesPaidTo: null };
    const decide = cfg.routing.decideModel;
    const turns = 6 * days;
    const byModel = decide
      ? [
          { model: decide, thoughts: turns * 4, chargedMicroUsdc: String(turns * 4 * 1_100), directThoughts: turns * 4 },
          { model: cfg.model, thoughts: turns, chargedMicroUsdc: String(turns * 9_400), directThoughts: turns },
        ]
      : [{ model: cfg.model, thoughts: turns * 5, chargedMicroUsdc: String(turns * 5 * 9_400), directThoughts: turns * 5 }];
    return { days, since, firstAt: since, byModel, paidTo: 'blockrun', picturesPaidTo: 'bootr' };
  },
  /** Activity tape, newest first; `before` (ISO) pages past the last item shown. */
  agentActivity(kernel: string, opts: { limit: number; before?: string | null }): { items: AgentActivityItem[] } {
    const cutoff = opts.before ? Date.parse(opts.before) : NaN;
    const list = activityFor(kernel).filter((it) => !Number.isFinite(cutoff) || Date.parse(it.at) < cutoff);
    return clone({ items: list.slice(0, opts.limit) });
  },
  /** Posts by ERC-8004 agent id; null for an id the mock store does not know. */
  postsByAgentId(agentId: string): { handle: string | null; items: AgentPost[] } | null {
    const t = mockStore().tokens.find((x) => x.agentId === agentId);
    if (!t) return null;
    if (!t.xHandle) return { handle: null, items: [] };
    const now = Math.floor(Date.now() / 1000);
    const item = (n: number, kind: AgentPost['kind'], text: string, ageS: number): AgentPost => {
      const postId = String(1850000000000000000n + BigInt(parseInt(agentId, 10) || 0) * 10n + BigInt(n));
      return { id: `mock-${agentId}-${n}`, kind, text, postId, url: `https://x.com/${t.xHandle}/status/${postId}`, createdAt: now - ageS };
    };
    return {
      handle: t.xHandle,
      items: [
        item(3, 'post', 'Treasury rebalanced: 40 USDC moved to WETH after the 24h volume crossed the weekly median.', 1800),
        item(2, 'reply', 'Fees are claimed every four hours. The split is locked on-chain, so nobody can change it.', 3 * 3600),
        item(1, 'post', 'Holder count passed 300 today. Thanks for reading the boring updates.', 9 * 3600),
      ],
    };
  },
};


// ---- agent config and activity (what the supervisor would hold) ----

const DEFAULT_INSTRUCTIONS = 'A patient onchain analyst for small Base coins. Reports what it sees as dated facts, never hypes, never tells anyone to buy or sell.';

/** The config a token's agent starts with: its preset (by on-chain hash) or the default template, the launch model. */
function buildConfig(t: Token, instructions = DEFAULT_INSTRUCTIONS): AgentConfig {
  const template = workerTemplateByHash(t.workerHash) ?? workerTemplateById(DEFAULT_WORKER_TEMPLATE)!;
  const kind = workerTemplateByHash(t.workerHash) ? template.id : 'custom';
  return {
    agentId: t.agentId,
    kernel: t.kernel,
    creator: t.creator,
    model: t.model,
    instructions,
    worker: { kind, capabilities: { services: false, bounties: false, ...template.preset.capabilities }, postIntervalMs: template.preset.postIntervalMs, jobLines: [...template.preset.identity] },
    workerHash: t.workerHash,
    postsPerDay: POSTS_PER_DAY.default,
    requireApproval: true,
    routing: { decideModel: null },
    imageModel: DEFAULT_IMAGE_MODEL,
    // the supervisor reads the coin picture from the agent card at onboarding
    imageStyle: { reference: /^https:\/\//i.test(t.image) ? t.image : null, notes: '' },
    services: { ...SERVICES_DEFAULTS, allow: [], deny: [] },
    revision: 0,
    updatedAt: new Date(t.launchedAt * 1000).toISOString(),
    xHold: null,
    xConnection: t.xHandle ? 'connected' : 'none',
  };
}

/** A config for a kernel the store never launched (a coin from another browser's mock launch): default worker, unknown creator. */
function orphanConfig(kernel: Address): AgentConfig {
  const template = workerTemplateById(DEFAULT_WORKER_TEMPLATE)!;
  return {
    agentId: String(900_000 + (parseInt(kernel.slice(-6), 16) % 90_000)),
    kernel,
    creator: '0x0000000000000000000000000000000000000000',
    model: MODELS[0]!,
    instructions: DEFAULT_INSTRUCTIONS,
    worker: { kind: template.id, capabilities: { services: false, bounties: false, ...template.preset.capabilities }, postIntervalMs: template.preset.postIntervalMs, jobLines: [...template.preset.identity] },
    workerHash: template.hash,
    postsPerDay: POSTS_PER_DAY.default,
    requireApproval: false,
    routing: { decideModel: null },
    imageModel: DEFAULT_IMAGE_MODEL,
    imageStyle: { reference: null, notes: '' },
    services: { ...SERVICES_DEFAULTS, allow: [], deny: [] },
    revision: 0,
    updatedAt: new Date().toISOString(),
    xHold: null,
    xConnection: 'none',
  };
}

/** A deterministic tape for a known token: the same three posts as `postsByAgentId`, treasury ops with tx hashes, sleeps and wakes. */
function buildActivity(t: Token, agent: Agent | null): AgentActivityItem[] {
  const now = Math.floor(Date.now() / 1000);
  const r = mulberry32(parseInt(t.kernel.slice(-8), 16) >>> 0);
  const at = (ageS: number) => new Date((now - ageS) * 1000).toISOString();
  const tx = () => hex(r, 32);
  const postUrl = (n: number) => `https://x.com/${t.xHandle}/status/${String(1850000000000000000n + BigInt(parseInt(t.agentId, 10) || 0) * 10n + BigInt(n))}`;
  const items: AgentActivityItem[] = [];
  if (isFresh(t.kernel)) return [{ at: new Date(t.launchedAt * 1000).toISOString(), kind: 'launch', summary: `Launched with the ${t.model} model.` }];
  if (t.xHandle) {
    items.push(
      { at: at(1800), kind: 'post', summary: 'Posted: Treasury rebalanced: 40 USDC moved to WETH after the 24h volume crossed the weekly median.', url: postUrl(3) },
      { at: at(3 * 3600), kind: 'reply', summary: 'Replied: Fees are claimed every four hours. The split is locked on-chain, so nobody can change it.', url: postUrl(2) },
      { at: at(9 * 3600), kind: 'post', summary: 'Posted: Holder count passed 300 today. Thanks for reading the boring updates.', url: postUrl(1) },
    );
  } else {
    items.push({ at: at(600), kind: 'sleep', summary: 'Sleeping: waiting for an X account.' });
  }
  items.push(
    { at: at(2 * 3600 + 300), kind: 'fee_claim', summary: `Claimed fees: ${(0.004 + r() * 0.02).toFixed(4)} WETH from the pool.`, txHash: tx() },
    { at: at(2 * 3600 + 200), kind: 'swap', summary: `Swapped ${(0.003 + r() * 0.01).toFixed(4)} WETH for ${(8 + r() * 30).toFixed(2)} USDC.`, txHash: tx() },
    { at: at(14 * 3600), kind: 'gas_topup', summary: `Gas refilled: ${(0.0005 + r() * 0.001).toFixed(4)} ETH deposited for the agent's own transactions.`, txHash: tx() },
    { at: at(20 * 3600), kind: 'wake', summary: 'Woke up: fuel arrived.' },
    { at: at(26 * 3600), kind: 'sleep', summary: 'Sleeping: fuel below 1 USDC.' },
    { at: at(2 * 86400), kind: 'fee_claim', summary: `Claimed fees: ${(0.004 + r() * 0.02).toFixed(4)} WETH from the pool.`, txHash: tx() },
    { at: at(2 * 86400 + 3600), kind: 'spender_topup', summary: `Moved ${(5 + r() * 10).toFixed(2)} USDC to the inference spender.`, txHash: tx() },
    { at: at(3 * 86400), kind: 'fuel', summary: `Fuel received: ${(20 + r() * 60).toFixed(2)} USDC from the creator.`, txHash: tx() },
  );
  if (t.xHandle) {
    for (let d = 1; d <= 5; d++) {
      items.push({ at: at(d * 86400 + 5 * 3600 + d * 700), kind: 'post', summary: `Posted: Day ${d} recap: volume ${usdShort(t.volume24hUsd * (0.6 + r() * 0.8))}, ${Math.round(2 + r() * 6)} new holders.`, url: postUrl(10 + d) });
    }
  }
  for (const a of buildApprovals(t)) {
    if (a.status === 'pending_approval') items.push({ at: a.createdAt, kind: 'approval_pending', summary: `A ${a.kind} is waiting for the creator's review` });
    else if (a.status === 'approved' && a.decidedAt) items.push({ at: a.decidedAt, kind: 'approval_approved', summary: `${a.kind === 'reply' ? 'Reply' : 'Post'} approved by the creator`, ...(a.url ? { url: a.url } : {}) });
  }
  if (agent?.status === 'paused') items.unshift({ at: at(300), kind: 'pause', summary: 'Paused by the creator.' });
  items.push({ at: new Date(t.launchedAt * 1000).toISOString(), kind: 'launch', summary: `Launched with the ${t.model} model.` });
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function usdShort(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;
}

function configFor(kernel: string): AgentConfig {
  const s = mockStore();
  const key = kernel.toLowerCase();
  let cfg = s.configs.get(key);
  if (!cfg) {
    const t = s.tokens.find((x) => x.kernel.toLowerCase() === key);
    cfg = t ? buildConfig(t, s.fresh.has(key) ? '' : DEFAULT_INSTRUCTIONS) : orphanConfig(kernel as Address);
    s.configs.set(key, cfg);
  }
  return cfg;
}

/** A tiny dot-matrix picture (SVG data URL) standing in for a generated image in the review queue. */
const MOCK_IMAGE_SVG = `data:image/svg+xml;base64,${typeof btoa === 'function' ? btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#111"/><g fill="#9cff57">' + Array.from({ length: 48 }, (_, i) => `<circle cx="${12 + (i % 12) * 12.5}" cy="${18 + Math.floor(i / 12) * 18}" r="${1.5 + ((i * 7) % 5) * 0.7}"/>`).join('') + '</g></svg>') : ''}`;

/** The review queue of a known token: two pending items (one with a picture, one reply) and one decided earlier. */
function buildApprovals(t: Token): AgentApproval[] {
  if (isFresh(t.kernel)) return [];
  const now = Date.now();
  const at = (ageS: number) => new Date(now - ageS * 1000).toISOString();
  const expiry = (ageS: number) => new Date(now - ageS * 1000 + 48 * 3_600_000).toISOString();
  const n = parseInt(t.agentId, 10) || 0;
  const postId = (k: number) => String(1850000000000000000n + BigInt(n) * 10n + BigInt(k));
  const base = { decision: null, decidedBy: null, note: null, url: null, decidedAt: null } as const;
  return [
    { id: `act_${n}q2`, kind: 'post', text: `Week in numbers for $${t.symbol}: ${t.holders} holders, ${usdShort(t.volume24hUsd)} traded in the last day, fees claimed on schedule. No predictions, just the ledger.`, inReplyTo: null, image: { alt: `A dot-matrix chart of $${t.symbol} holders over the week`, dataUrl: MOCK_IMAGE_SVG }, status: 'pending_approval', ...base, createdAt: at(900), expiresAt: expiry(900) },
    { id: `act_${n}q1`, kind: 'reply', text: 'Fees are claimed every four hours and the split is locked on-chain. The treasury address is on the coin page if you want to check it yourself.', inReplyTo: postId(2), image: null, status: 'pending_approval', ...base, createdAt: at(5400), expiresAt: expiry(5400) },
    { id: `act_${n}q0`, kind: 'post', text: 'Holder count passed 300 today. Thanks for reading the boring updates.', inReplyTo: null, image: null, status: 'approved', decision: 'approve', decidedBy: t.creator, note: null, url: t.xHandle ? `https://x.com/${t.xHandle}/status/${postId(1)}` : null, createdAt: at(9 * 3600 + 1800), decidedAt: at(9 * 3600), expiresAt: expiry(9 * 3600 + 1800) },
  ];
}

const MOCK_EVENTS: readonly { key: string; label: string }[] = [
  { key: 'review_waiting', label: 'Posts waiting for your review' },
  { key: 'review_expiring', label: 'Reviews about to expire' },
  { key: 'fuel_low', label: 'Low on fuel' },
  { key: 'gas_out', label: 'Out of gas' },
  { key: 'agent_asleep', label: 'Agent asleep' },
  { key: 'agent_stopped', label: 'Agent stopped' },
  { key: 'x_revoked', label: 'X connection lost' },
  { key: 'x_forbidden', label: 'X refused posting' },
  { key: 'key_rotation', label: 'Treasury permission renewal' },
  { key: 'model_changed', label: 'Model changed by the platform' },
  { key: 'model_unavailable', label: 'Model not available' },
];

type MockInbox = { items: AgentNotification[]; optOut: string[]; telegram: AgentNotifications['telegram']; available: boolean };

/** Mock mode has one inbox per coin, with one item of each kind a creator would first meet. */
function inboxFor(kernel: string): MockInbox {
  const s = mockStore();
  const key = kernel.toLowerCase();
  let inbox = s.inboxes.get(key);
  if (!inbox) {
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    inbox = {
      available: true,
      optOut: [],
      telegram: { available: true, linked: false, linkedAt: null },
      items: isFresh(key)
        ? []
        : [
        { id: 'ntf_mock_1', event: 'fuel_low', title: 'Low on fuel', body: 'About 1 day of fuel left at the recent rate. Add fuel to keep the agent thinking.', tone: 'warning', state: 'active', firstAt: at(5), lastSeenAt: at(0.1), resolvedAt: null },
        { id: 'ntf_mock_2', event: 'x_revoked', title: 'X connection lost', body: 'X no longer accepts this agent’s connection, so it cannot read or post. Connect the same X account again from the inbox in the creator console.', tone: 'danger', state: 'active', firstAt: at(2), lastSeenAt: at(0.1), resolvedAt: null },
        { id: 'ntf_mock_4', event: 'x_forbidden', title: 'X refused posting for this account', body: 'X answered “not permitted” when the agent tried to post, so posts and replies are paused. Log in to the X account and check for a lock, a restriction or a notice from X; if the connection was changed, connect it again from the creator console. It tries again in about 6 hours; while X keeps refusing, each pause is longer and no fuel is spent on posting.', tone: 'danger', state: 'active', firstAt: at(1), lastSeenAt: at(0.1), resolvedAt: null },
        { id: 'ntf_mock_3', event: 'gas_out', title: 'Out of gas', body: 'The agent cannot claim fees, trade or refuel until someone adds gas on the coin page.', tone: 'danger', state: 'resolved', firstAt: at(60), lastSeenAt: at(30), resolvedAt: at(30) },
      ],
    };
    s.inboxes.set(key, inbox);
  }
  return inbox;
}

const MOCK_CHAT_LIMITS = { perHour: 20, perDay: 60 };
const MOCK_CHAT_COST = '18000';

function chatFor(kernel: string): AgentChatMessage[] {
  const s = mockStore();
  const key = kernel.toLowerCase();
  let list = s.chats.get(key);
  if (!list) {
    list = [];
    s.chats.set(key, list);
  }
  return list;
}

function inboxView(inbox: MockInbox): AgentNotifications {
  const items = inbox.items.filter((i) => !inbox.optOut.includes(i.event));
  return clone({ items, active: items.filter((i) => i.state === 'active').length, events: MOCK_EVENTS.map((e) => ({ ...e, enabled: !inbox.optOut.includes(e.key) })), telegram: inbox.telegram });
}

function approvalsFor(kernel: string): AgentApproval[] {
  const s = mockStore();
  const key = kernel.toLowerCase();
  let list = s.approvals.get(key);
  if (!list) {
    const t = s.tokens.find((x) => x.kernel.toLowerCase() === key);
    list = t ? buildApprovals(t) : [];
    s.approvals.set(key, list);
  }
  return list;
}

function activityFor(kernel: string): AgentActivityItem[] {
  const s = mockStore();
  const key = kernel.toLowerCase();
  let list = s.activity.get(key);
  if (!list) {
    const t = s.tokens.find((x) => x.kernel.toLowerCase() === key);
    list = t ? buildActivity(t, s.agents.get(key) ?? null) : [];
    s.activity.set(key, list);
  }
  return list;
}

/** Mock-mode launch: inserts a token into the in-memory store and returns its address. */
export function mockLaunch(input: {
  name: string;
  symbol: string;
  image: string;
  model: string;
  buyback: boolean;
  xHandle: string | null;
  /** Which launcher the form chose; a Clanker coin shows its label and the whole-fee split. */
  source?: LaunchSource;
  /** Optional: what the creator typed; seeds the mock agent config the coin page's creator console shows. */
  instructions?: string;
  workerHash?: Hex;
  /** The coin's own links from the form, shown on the mock coin page like the hosted contract URI would. */
  links?: CoinPageLinks;
}): Address {
  const s = mockStore();
  const rand = mulberry32(Date.now() % 1_000_000);
  const { token, agent } = makeToken(s.tokens.length + 5000, input.name, input.symbol, Math.floor(Date.now() / 1000), rand);
  token.image = input.image || avatarFor(input.symbol, s.tokens.length);
  token.model = input.model;
  token.xHandle = input.xHandle;
  token.marketCapUsd = 3500;
  token.priceUsd = 3.5e-6;
  token.volume24hUsd = 0;
  token.fees24hUsd = 0;
  token.holders = 1;
  token.graduated = false;
  token.graduatedAt = null;
  token.creatorBps = input.buyback ? 5000 : 6500;
  token.burnBps = input.buyback ? 1500 : 0;
  if (input.source === 'clanker') clankerize(token);
  if (input.workerHash) token.workerHash = input.workerHash;
  if (input.links) s.links.set(token.metadata, { ...input.links });
  if (input.instructions) s.configs.set(token.kernel.toLowerCase(), buildConfig(token, input.instructions));
  agent.status = 'awake';
  token.agent = { id: agent.id, status: 'awake' };
  s.tokens.unshift(token);
  s.agents.set(agent.id.toLowerCase(), agent);
  s.trades.set(token.id.toLowerCase(), []);
  s.platform.tokens = s.tokens.length;
  emit({ type: 'launch', tokenId: token.id });
  return token.id;
}
