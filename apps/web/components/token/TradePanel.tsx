'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useConnection, useSwitchChain } from 'wagmi';
import { chainLabel, explorer, swapLink } from '@/lib/chains';
import { feeModelOf, traderPaysPct } from '@/lib/fee-split';
import { useNow } from '@/lib/hooks';
import type { Token } from '@/lib/types';
import { CLANKER_V5_ANTI_SNIPE_SECONDS, DEFAULT_SLIPPAGE_BPS, isErc20Paired, launchWindowActive, minReceived, pairedCurrency, v5TradingOpensIn, type SwapSide } from '@/lib/swap/core';
import { pairedAssetByAddress, v5SettingsOf } from '@/lib/token-settings';
import { SwapFailure } from '@/lib/swap/errors';
import { tradeChainId, tradePoolKey, useSellApprovals, useSwapBalances, useSwapQuote, useSwapRunner, type PayWith } from '@/lib/swap/use-swap';
import { amountInput, feeFigure, formatAmount, GAS_RESERVE_WEI, parseAmount, parseSlippage, percent } from '@/lib/swap/view';
import { Button } from '@/components/ui/Button';
import { ExternalLink } from '@/components/ui/ExternalLink';
import { Input } from '@/components/ui/Field';
import { Panel } from '@/components/ui/Panel';
import { Tab, TabList, Tabs } from '@/components/ui/Tabs';
import { cn } from '@/components/ui/cn';
import { ConnectButton } from '@/components/shell/ConnectButton';

const SLIPPAGE_PRESETS = [50, 100, 200];
const BUY_PRESETS = ['0.001', '0.01', '0.1'];
/** Buy presets on a USDC pool, in dollars. */
const BUY_PRESETS_USD = ['10', '50', '100'];
const SELL_PRESETS = [25, 50, 75];
/** Above this the panel says how far the amount moves the price; above the second, it says so in red. */
const IMPACT_NOTICE_PCT = 5;
const IMPACT_ALERT_PCT = 15;
const SLIPPAGE_NOTICE_BPS = 500;
const QUOTE_DEBOUNCE_MS = 350;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const chip = 'h-6 rounded-xs border border-hairline px-2 font-mono text-micro text-mute transition-colors hover:border-hairline-strong hover:text-ink';
const chipOn = 'border-ink bg-ink text-on-ink hover:text-on-ink';

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-caption text-mute">{label}</dt>
      <dd data-testid={testId} className="text-right font-mono text-caption text-ink tabular">
        {children}
      </dd>
    </div>
  );
}

/**
 * Buy and sell on the coin's own Uniswap v4 pool, signed by the user's wallet. Figures come from the v4 quoter; the
 * minimum received goes on chain as the swap's floor. `lib/swap/core.ts` has the calldata. A Clanker v5 coin's buys
 * wait out its first 20 seconds ("trading opens in n s") instead of paying Clanker's anti-snipe fee.
 */
export function TradePanel({ token }: { token: Token }) {
  const key = useMemo(() => tradePoolKey(token), [token]);
  const elsewhere = swapLink(token.id);

  if (!key) {
    return (
      <Panel id="trade" title="Trade" className="scroll-mt-20">
        <p className="text-sm text-body">This coin cannot be traded on this page.</p>
        <ExternalLink href={elsewhere} className="mt-3 inline-flex text-caption">
          Swap on another site
        </ExternalLink>
      </Panel>
    );
  }
  return <TradeForm token={token} poolKey={key} elsewhere={elsewhere} />;
}

function TradeForm({ token, poolKey, elsewhere }: { token: Token; poolKey: NonNullable<ReturnType<typeof tradePoolKey>>; elsewhere: string }) {
  const coin = token.id;
  const symbol = token.symbol;
  const coinLabel = `$${symbol}`;
  const [side, setSide] = useState<SwapSide>('buy');
  const [text, setText] = useState('');
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [customSlippage, setCustomSlippage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const now = useNow();
  const { address, chainId, isConnected } = useConnection();
  const switchChain = useSwitchChain();

  // The pool's paired side: ETH on the WETH and native-ETH pools, an ERC-20 the user pays and receives as is (USDC) on a
  // Clanker v5 coin launched paired with it.
  const erc20 = isErc20Paired(poolKey);
  const pairedAddr = erc20 ? pairedCurrency(poolKey) : null;
  const pairedAsset = pairedAssetByAddress(pairedAddr);
  const pairedSymbol = erc20 ? (pairedAsset?.symbol ?? 'USDC') : 'ETH';
  const pairedDecimals = erc20 ? (pairedAsset?.decimals ?? 6) : 18;
  // A buy on a USDC pool can also be paid with ETH: two hops in one transaction (ETH → USDC on Uniswap v3, USDC → coin).
  const [payWith, setPayWith] = useState<PayWith>('direct');
  const viaEth = erc20 && side === 'buy' && payWith === 'eth-via-paired';
  const paySymbol = viaEth ? 'ETH' : pairedSymbol;
  const inDecimals = side === 'buy' ? (viaEth ? 18 : pairedDecimals) : 18;
  const outDecimals = side === 'buy' ? 18 : pairedDecimals;
  const amountIn = parseAmount(text, inDecimals);
  const settledText = useDebounced(text, QUOTE_DEBOUNCE_MS);
  const settledAmount = settledText === text ? amountIn : null;
  // Clanker v5: a buy in the first 20 s pays up to 99%; the panel waits instead of quoting it (`now` is 0 on the server).
  const v5 = token.source === 'clanker-v5';
  // The 20 s sniper surcharge exists only when the coin launched with it on (`antiSnipe`); unknown counts as on.
  const sniperWindow = v5 && token.antiSnipe !== false;
  // The shared clock ticks every 30 s; the countdown needs seconds, so it keeps its own while the window runs.
  const [second, setSecond] = useState(0);
  useEffect(() => {
    if (!sniperWindow) return;
    const closesAt = (token.launchedAt + CLANKER_V5_ANTI_SNIPE_SECONDS + 1) * 1000;
    if (Date.now() > closesAt) return;
    const id = setInterval(() => {
      setSecond(Date.now());
      if (Date.now() > closesAt) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [sniperWindow, token.launchedAt]);
  const opensIn = sniperWindow && now > 0 ? v5TradingOpensIn(token.launchedAt, Math.max(now, second) / 1000) : 0;
  const buyClosed = side === 'buy' && opensIn > 0;
  const quote = useSwapQuote(token, poolKey, side, buyClosed ? null : settledAmount, viaEth ? 'eth-via-paired' : 'direct');
  const balances = useSwapBalances(coin, address, pairedAddr);
  // A sell spends the coin; a buy on a USDC pool spends USDC: both need the exact Permit2 approvals.
  const approvals = useSellApprovals(side === 'buy' && pairedAddr ? pairedAddr : coin, address, side === 'sell' || (erc20 && !viaEth) ? settledAmount : null);
  const runner = useSwapRunner();

  const wrongChain = isConnected && chainId !== tradeChainId;
  const payLabel = side === 'buy' ? paySymbol : coinLabel;
  const receiveLabel = side === 'buy' ? coinLabel : pairedSymbol;
  const balance = balances.data ? (side === 'buy' ? (erc20 && !viaEth ? balances.data.paired : balances.data.eth) : balances.data.coin) : null;
  const tooMuch = amountIn !== null && balance !== null && amountIn > balance;

  const customBps = parseSlippage(customSlippage);
  const customInvalid = customSlippage.trim() !== '' && customBps === null;
  const effectiveSlippage = customBps ?? slippageBps;

  const q = quote.data && settledAmount === quote.data.amountIn ? quote.data : null;
  const minOut = q ? minReceived(q.amountOut, effectiveSlippage) : null;
  // A v5 coin launched with settings may tax buys and sells differently.
  const v5Settings = v5SettingsOf(token);
  const normalFeePct = v5Settings ? (side === 'buy' ? v5Settings.buyTaxBps : v5Settings.sellTaxBps) / 10_000 : traderPaysPct(feeModelOf(token));
  const fee = q ? feeFigure(q.feePct, normalFeePct) : { pct: normalFeePct, raised: false };
  const quoteFailure = quote.error instanceof SwapFailure ? quote.error : null;
  const running = runner.stage !== null;
  const launchRaised = fee.raised && launchWindowActive(q?.launchWindow, now / 1000);
  const impact = q?.impactPct ?? null;

  const flip = (next: SwapSide) => {
    setSide(next);
    setText('');
    setProblem(null);
  };
  const setAmount = (value: string) => {
    setText(value);
    setProblem(null);
  };

  const submit = async () => {
    if (!q || minOut === null || amountIn === null) return;
    setProblem(null);
    try {
      const result = await runner.run({ side, coin, symbol, key: poolKey, amountIn, minOut, launchWindow: q.launchWindow, payWith: viaEth ? 'eth-via-paired' : 'direct' });
      if (result.status === 'repriced') {
        setProblem('The price moved past your slippage setting while you were reviewing. Check the new figures and confirm again.');
        return;
      }
      setText('');
      const hash = result.hash;
      toast.success(side === 'buy' ? `Bought ${coinLabel}` : `Sold ${coinLabel}`, {
        ...(hash ? { action: { label: 'View', onClick: () => window.open(explorer.tx(hash), '_blank', 'noopener') } } : {}),
      });
    } catch (e) {
      setProblem(SwapFailure.from(e).message);
    }
  };

  const switchToBase = async () => {
    setProblem(null);
    try {
      await switchChain.mutateAsync({ chainId: tradeChainId });
    } catch (e) {
      const failure = SwapFailure.from(e);
      setProblem(failure.code === 'rejected' ? failure.message : new SwapFailure('wrong_chain').message);
    }
  };

  const shownFailure = problem ?? quoteFailure?.message ?? null;
  const noBalance = balance === 0n;

  let action: React.ReactNode;
  if (!isConnected) {
    action = <ConnectButton block />;
  } else if (wrongChain) {
    action = (
      <Button variant="primary" size="lg" className="w-full" onClick={() => void switchToBase()} loading={switchChain.isPending} loadingLabel="Switching…">
        Switch to {chainLabel(tradeChainId)}
      </Button>
    );
  } else if (buyClosed) {
    action = (
      <Button variant="primary" size="lg" className="w-full" data-testid="trade-submit" disabled>
        Trading opens in {opensIn} s
      </Button>
    );
  } else {
    const verb = side === 'buy' ? `Buy ${coinLabel}` : `Sell ${coinLabel}`;
    const label =
      noBalance && side === 'sell'
        ? `No ${coinLabel} in this wallet`
        : noBalance
          ? `No ${paySymbol} in this wallet`
          : tooMuch
            ? `Not enough ${payLabel}`
            : amountIn === null
              ? 'Enter an amount'
              : quote.isFetching && !q
                ? 'Getting a quote…'
                : verb;
    action = (
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        data-testid="trade-submit"
        disabled={!q || tooMuch || noBalance || customInvalid || minOut === null || amountIn === null}
        loading={running}
        loadingLabel={runner.stage ?? undefined}
        onClick={() => void submit()}
      >
        {label}
      </Button>
    );
  }

  const presets =
    side === 'buy'
      ? (erc20 && !viaEth ? BUY_PRESETS_USD : BUY_PRESETS).map((p) => ({ label: p, value: p, on: text === p }))
      : SELL_PRESETS.map((p) => {
          const value = balance !== null && balance > 0n ? amountInput((balance * BigInt(p)) / 100n) : '';
          return { label: `${p}%`, value, on: value !== '' && text === value };
        });
  // "Max" on an ETH buy keeps some ETH for the network fee; USDC and the coin can go in full.
  const maxValue = balance === null ? '' : amountInput(side === 'buy' && (!erc20 || viaEth) ? (balance > GAS_RESERVE_WEI ? balance - GAS_RESERVE_WEI : 0n) : balance, inDecimals);
  const canMax = maxValue !== '' && maxValue !== '0';

  return (
    <Panel
      id="trade"
      title="Trade"
      className="scroll-mt-20"
      action={
        <Tabs value={side} onValueChange={(v) => flip(v as SwapSide)}>
          <TabList aria-label="Buy or sell">
            <Tab value="buy">Buy</Tab>
            <Tab value="sell">Sell</Tab>
          </TabList>
        </Tabs>
      }
    >
      <div data-testid="trade-panel" className="flex flex-col gap-3">
        {erc20 && side === 'buy' ? (
          <div className="flex items-center justify-between gap-3" data-testid="trade-pay-with">
            <span className="text-caption text-mute">Pay with</span>
            <div className="flex gap-1.5">
              {(
                [
                  ['direct', pairedSymbol],
                  ['eth-via-paired', 'ETH'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={payWith === value}
                  className={cn(chip, payWith === value && chipOn)}
                  onClick={() => {
                    setPayWith(value);
                    setAmount('');
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="trade-amount" className="text-caption text-mute">
              You pay
            </label>
            {isConnected && balance !== null ? (
              <span data-testid="trade-balance" className="font-mono text-micro text-mute tabular">
                Balance {formatAmount(balance, inDecimals)} {payLabel}
              </span>
            ) : null}
          </div>
          <Input
            id="trade-amount"
            inputMode="decimal"
            autoComplete="off"
            mono
            inputSize="lg"
            placeholder="0.0"
            suffix={payLabel}
            value={text}
            aria-invalid={tooMuch || (text.trim() !== '' && amountIn === null)}
            onChange={(e) => setAmount(e.target.value.trim())}
          />
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button key={p.label} type="button" disabled={!p.value} className={cn(chip, p.on && chipOn, 'disabled:opacity-50')} onClick={() => setAmount(p.value)}>
                {p.label}
              </button>
            ))}
            <button type="button" disabled={!canMax} className={cn(chip, canMax && text === maxValue && chipOn, 'disabled:opacity-50')} onClick={() => setAmount(maxValue)}>
              Max
            </button>
          </div>
        </div>

        <div className="rounded-sm border border-hairline bg-canvas-soft px-3 py-2">
          <div className="text-caption text-mute">You receive, about</div>
          <div data-testid="trade-out" className="truncate font-mono text-display-sm font-medium text-ink tabular">
            {q ? formatAmount(q.amountOut, outDecimals) : '0'} <span className="text-caption font-normal text-mute">{receiveLabel}</span>
          </div>
        </div>

        <dl>
          <Row label={v5 ? 'Trading tax' : 'Pool fee'} testId="trade-fee">
            {percent(fee.pct)}
            {q?.feeEth != null ? (
              <span className="text-mute">
                {' '}
                ({formatAmount(q.feeEth, pairedDecimals)} {pairedSymbol})
              </span>
            ) : null}
          </Row>
          <Row label="Price impact" testId="trade-impact">
            {impact === null ? '—' : percent(impact)}
          </Row>
          <Row label="Minimum received" testId="trade-min">
            {minOut === null ? '—' : `${formatAmount(minOut, outDecimals)} ${receiveLabel}`}
          </Row>
          <div className="flex items-center justify-between gap-3 py-1">
            <dt className="text-caption text-mute">Slippage</dt>
            <dd className="flex items-center gap-1.5">
              {SLIPPAGE_PRESETS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  aria-pressed={customSlippage === '' && slippageBps === bps}
                  className={cn(chip, customSlippage === '' && slippageBps === bps && chipOn)}
                  onClick={() => {
                    setSlippageBps(bps);
                    setCustomSlippage('');
                  }}
                >
                  {bps / 100}%
                </button>
              ))}
              <input
                aria-label="Custom slippage in percent"
                inputMode="decimal"
                placeholder="Custom"
                value={customSlippage}
                aria-invalid={customInvalid}
                onChange={(e) => setCustomSlippage(e.target.value.trim())}
                className="h-6 w-14 rounded-xs border border-hairline bg-canvas px-1.5 text-right font-mono text-micro text-ink placeholder:text-mute focus:border-accent focus:outline-none aria-invalid:border-danger"
              />
            </dd>
          </div>
        </dl>

        {customInvalid ? (
          <p role="alert" className="text-caption text-danger">
            Slippage goes from 0.01% to 20%.
          </p>
        ) : effectiveSlippage > SLIPPAGE_NOTICE_BPS ? (
          <p className="text-caption text-body">With this slippage the swap can fill up to {effectiveSlippage / 100}% below the quote.</p>
        ) : null}

        {buyClosed ? (
          <p data-testid="trade-opens-in" className="rounded-xs border border-warning-surface bg-warning-surface px-3 py-2 text-caption text-warning">
            Trading opens in {opensIn} s. For its first {CLANKER_V5_ANTI_SNIPE_SECONDS} seconds Clanker charges buyers of a new coin up to 99%, falling to the
            normal {percent(normalFeePct)} tax, so this page waits instead.
          </p>
        ) : null}

        {launchRaised ? (
          <p data-testid="trade-launch-fee" className="rounded-xs border border-warning-surface bg-warning-surface px-3 py-2 text-caption text-warning">
            Clanker&rsquo;s launch fee is running on this new coin: this swap pays {percent(fee.pct)} instead of {percent(normalFeePct)}. It falls to the normal fee about 16 seconds after launch.
          </p>
        ) : null}

        {impact !== null && impact >= IMPACT_NOTICE_PCT ? (
          <p
            data-testid="trade-impact-note"
            className={cn('rounded-xs border px-3 py-2 text-caption', impact >= IMPACT_ALERT_PCT ? 'border-danger text-danger' : 'border-warning-surface bg-warning-surface text-warning')}
          >
            This amount moves the pool&rsquo;s price by about {percent(impact)}.
          </p>
        ) : null}

        {(side === 'sell' || (erc20 && !viaEth)) && isConnected && !wrongChain && approvals.data && approvals.data.length > 0 && q ? (
          <p data-testid="trade-approvals" className="text-caption text-body">
            {runner.atomic
              ? `One confirmation in your wallet: approval for exactly this amount and the ${side}, together.`
              : `${approvals.data.length + 1} confirmations in your wallet: ${approvals.data.length === 1 ? 'one approval' : 'two approvals'} for exactly this amount, then the ${side}.`}
          </p>
        ) : null}

        {erc20 ? (
          <p data-testid="trade-paired" className="text-caption text-mute">
            {viaEth
              ? `This coin trades against ${pairedSymbol}: your ETH becomes ${pairedSymbol} on Uniswap (0.05%) and then the coin, in one transaction. The minimum received covers both steps.`
              : `This coin trades against ${pairedSymbol}: you ${side === 'buy' ? 'pay' : 'receive'} ${pairedSymbol}.`}
          </p>
        ) : null}

        {shownFailure ? (
          <p role="alert" data-testid="trade-error" className="rounded-xs border border-danger px-3 py-2 text-caption text-danger">
            {shownFailure}
          </p>
        ) : null}

        {action}

        <p className="text-caption text-mute">
          This is your own transaction, signed in your wallet. Bootr holds nothing and adds no fee.{' '}
          <ExternalLink href={elsewhere} className="whitespace-nowrap">
            Swap on another site
          </ExternalLink>
        </p>
      </div>
    </Panel>
  );
}
