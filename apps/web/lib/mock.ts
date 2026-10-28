/**
 * In-memory fixtures for NEXT_PUBLIC_USE_MOCK=1 (or when no indexer URL is set).
 * Deterministic (seeded) so reloads look the same; a small simulator mutates the store
 * and emits stream hints so live UI (reordering grid, ticking numbers) can be exercised.
 */
import type { Address, Hex } from 'viem';
import { agentCardUrl, mockLaunchId } from './agent-card';
import type {
  Agent,
  AgentPost,
  AgentStatus,
  AgentWithToken,
  DailyStat,
  FeesByKind,
  FuelEvent,
  Holding,
  PlatformStats,
  StreamHint,
  Token,
  TokenDetail,
  Trade,
} from './types';

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

const MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'gpt-4.1-mini', 'llama-3.3-70b'];

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
    // BootrLauncher presets (out of 10000; the locker holds them as 9000-bps slots).
    agentBps: 500,
    creatorBps: buyback ? 5000 : 6500,
    burnBps: buyback ? 1500 : 0,
    platformBps: 3000,
    workerHash: hex(rand, 32),
    model: MODELS[Math.floor(rand() * MODELS.length)]!,
    agentUri: agentCardUrl(mockLaunchId(id)),
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
  NAMES.forEach(([name, symbol], i) => {
    const { token, agent } = makeToken(i, name, symbol, launchedAt, rand);
    tokens.push(token);
    agents.set(agent.id.toLowerCase(), agent);
    trades.set(token.id.toLowerCase(), makeTrades(token, rand, now));
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

  return { now, tokens, agents, trades, daily, platform, seq: 0 };
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
        const move = 1 + (rand() - 0.42) * 0.5;
        t.marketCapUsd = Math.max(1500, t.marketCapUsd * move);
        t.priceUsd = t.marketCapUsd / 1e9;
        const v = t.marketCapUsd * rand() * 0.05;
        t.volume24hUsd += v;
        t.fees24hUsd += v * 0.01;
        t.change24hPct = (t.change24hPct ?? 0) + (move - 1) * 100;
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
  tokens(tab: string, after: string | null, limit: number) {
    const s = mockStore();
    let list = [...s.tokens];
    if (tab === 'graduated') list = list.filter((t) => t.graduated).sort((a, b) => (b.graduatedAt ?? 0) - (a.graduatedAt ?? 0));
    else if (tab === 'mcap') list.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    else if (tab === 'active') list = list.filter((t) => t.agent?.status === 'awake').sort((a, b) => b.volume24hUsd - a.volume24hUsd);
    else list.sort((a, b) => b.launchedAt - a.launchedAt);
    const start = after ? Number(after) : 0;
    const items = list.slice(start, start + limit);
    const next = start + limit;
    return clone({ items, pageInfo: { endCursor: next < list.length ? String(next) : null, hasNextPage: next < list.length } });
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
          tokenInfo: t ? { id: t.id, name: t.name, symbol: t.symbol, image: t.image, creator: t.creator, xHandle: t.xHandle } : null,
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

/** Mock-mode launch: inserts a token into the in-memory store and returns its address. */
export function mockLaunch(input: { name: string; symbol: string; image: string; model: string; buyback: boolean; xHandle: string | null }): Address {
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
  agent.status = 'awake';
  token.agent = { id: agent.id, status: 'awake' };
  s.tokens.unshift(token);
  s.agents.set(agent.id.toLowerCase(), agent);
  s.trades.set(token.id.toLowerCase(), []);
  s.platform.tokens = s.tokens.length;
  emit({ type: 'launch', tokenId: token.id });
  return token.id;
}
