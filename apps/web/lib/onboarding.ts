/**
 * The creator console's first-steps checklist: four facts read from state the page already has, each with the console
 * section (or the X banner) that settles it. Pure; the component in components/token/OnboardingCard.tsx renders it.
 * Public copy: "fuel" and "gas", never the wallets behind them.
 */
import { gasStatus } from '@/lib/gas';
import type { ConsoleSection } from '@/lib/console-sections';

/** One line per section for a console nobody has edited yet (revision 0), in place of longer help. */
export const SECTION_HINTS: Record<ConsoleSection, string> = {
  mind: 'Who the agent is, what it must never do, and the model it thinks with.',
  posting: 'How often it speaks and whether you read posts first.',
  powers: 'What it may do. Turn on only what it needs.',
  look: 'How its pictures look, and the coin’s own image and links.',
  inbox: 'What needs you, posts waiting for review, and a private line to the agent.',
  fuel: 'Fuel pays for thoughts and posts; gas pays for its own transactions.',
};

/** `client` stands in for `fuel` on an own agent: it thinks in its creator's own AI client, so it needs one connected, not fuel. */
export type OnboardingKey = 'x' | 'instructions' | 'fuel' | 'client' | 'gas';

/** What the sections are for when the agent runs in its creator's own AI client: no model to pick, and fuel only pays for paid services. */
export const OWN_SECTION_HINTS: Partial<Record<ConsoleSection, string>> = {
  mind: 'Who the agent is and what it must never do. It thinks in your own AI client.',
  look: 'How its pictures should look, and the coin’s own image and links.',
  inbox: 'What needs you and posts waiting for review. You talk to the agent in your own AI client.',
  fuel: 'Fuel pays for paid services only; gas pays for its own transactions.',
};

export interface OnboardingItem {
  key: OnboardingKey;
  /** What to do, as the row's title. */
  label: string;
  /** Why, in one short clause. */
  detail: string;
  /** The button label. */
  action: string;
  /** Where the button goes: a console section, or the X banner above the console. */
  target: ConsoleSection | 'x';
  /** Null while the page does not know yet (a balance still loading). */
  done: boolean | null;
}

export interface OnboardingInput {
  /** `token.xHandle`: the agent's X account, null while none is connected. */
  xHandle: string | null | undefined;
  /** `config.instructions`. */
  instructions: string;
  /** Base-unit USDC the agent can spend (kernel + spender) and all it ever received; null while unknown. */
  fuelUsdc: bigint | null;
  fuelReceivedUsdc: bigint | null;
  /** Total gas in wei (deposit + balance); null while unknown. */
  gasWei: bigint | null;
  /**
   * Set for an own agent (docs/design/byo-agent.md section 5.2): how many AI clients are connected. The fuel step then
   * gives way to "connect your AI client", since thinking costs an own agent no fuel. Absent or null: the Bootr agent.
   */
  own?: { clients: number } | null;
}

function known(...values: (bigint | null)[]): boolean {
  return values.every((v) => v !== null);
}

/** The four first steps, in the order a creator meets them. For an own agent the third is its AI client, not fuel. */
export function onboardingItems(input: OnboardingInput): OnboardingItem[] {
  const fuelKnown = known(input.fuelUsdc, input.fuelReceivedUsdc);
  const third: OnboardingItem = input.own
    ? {
        key: 'client',
        label: 'Connect your AI client',
        detail: 'The agent thinks in your own AI client; without one it is silent.',
        action: 'Connect',
        target: 'mind',
        done: input.own.clients > 0,
      }
    : {
        key: 'fuel',
        label: 'Add fuel',
        detail: 'USDC that pays for its thoughts and posts.',
        action: 'Add fuel',
        target: 'fuel',
        done: fuelKnown ? input.fuelUsdc! > 0n || input.fuelReceivedUsdc! > 0n : null,
      };
  return [
    {
      key: 'x',
      label: 'Connect an X account',
      detail: 'The agent speaks only through its own X account.',
      action: 'Connect X',
      target: 'x',
      done: !!input.xHandle,
    },
    {
      key: 'instructions',
      label: 'Write its instructions',
      detail: 'Who it is and what it must never do.',
      action: 'Write',
      target: 'mind',
      done: input.instructions.trim().length > 0,
    },
    third,
    {
      key: 'gas',
      label: 'Add gas',
      detail: input.own ? 'ETH for its own transactions: fee claims and treasury moves.' : 'ETH for its own transactions: fee claims and refuels.',
      action: 'Add gas',
      target: 'fuel',
      done: input.gasWei === null ? null : gasStatus(input.gasWei) !== 'empty',
    },
  ];
}

/** Every item known and done: the card goes away on its own. */
export function onboardingComplete(items: OnboardingItem[]): boolean {
  return items.every((i) => i.done === true);
}

/** Something is still loading: the card waits rather than flashing an undone step. */
export function onboardingPending(items: OnboardingItem[]): boolean {
  return items.some((i) => i.done === null);
}

export function onboardingHiddenKey(kernel: string): string {
  return `bootr:onboarding-hidden:${kernel.toLowerCase()}`;
}

/** Whether this viewer hid the card for this agent; false wherever storage is unavailable. */
export function readOnboardingHidden(kernel: string): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(onboardingHiddenKey(kernel)) === '1';
  } catch {
    return false;
  }
}

export function writeOnboardingHidden(kernel: string): void {
  try {
    window.localStorage.setItem(onboardingHiddenKey(kernel), '1');
  } catch {
    // private window or blocked storage: the card hides for this render only
  }
}

function baseUnits(raw: string | null | undefined): bigint {
  try {
    return raw ? BigInt(raw) : 0n;
  } catch {
    return 0n;
  }
}

/** The fuel figures from the indexer's agent row (`Agent`), or nulls while it has not arrived. */
export function fuelFromAgent(agent: { treasuryUsdc?: string | null; spenderUsdc?: string | null; fuelReceivedUsdc?: string | null } | null | undefined): Pick<OnboardingInput, 'fuelUsdc' | 'fuelReceivedUsdc'> {
  if (!agent) return { fuelUsdc: null, fuelReceivedUsdc: null };
  return { fuelUsdc: baseUnits(agent.treasuryUsdc) + baseUnits(agent.spenderUsdc), fuelReceivedUsdc: baseUnits(agent.fuelReceivedUsdc) };
}
