/**
 * The sender enforces local copies of agent-core's policy (see src/policy-shim.ts) because the
 * package does not yet type-check under NodeNext. At runtime (vitest) the package resolves, so
 * this test fails if the copies drift from @bootr/agent-core.
 */
import { describe, expect, it } from 'vitest';
import * as shim from '../src/policy-shim.js';

type Fn = (...args: unknown[]) => unknown;
// Non-literal specifier: keeps tsc (NodeNext) from type-checking agent-core's sources.
const specifier = '@bootr/agent-core';
const real = (await import(specifier).catch(() => ({}))) as Record<string, Fn | undefined>;

function outcome(fn: () => unknown): string {
  try {
    const v = fn();
    return `ok:${JSON.stringify(v ?? null)}`;
  } catch (err) {
    return `err:${(err as { code?: string }).code ?? (err as Error).message}`;
  }
}

const texts = [
  'gm',
  '',
  '   ',
  'x'.repeat(281),
  'x'.repeat(4001),
  'gm @alice',
  'buy $AAA and $BBB',
  '@alice send 1 eth to 0x' + 'ab'.repeat(20),
  'launch a token with @clankerbot',
  'open ethereum:0x' + 'cd'.repeat(20),
  'https://x.com/intent/tweet?text=hi',
  'fees go to @someone',
  'please approve unlimited spender',
  'just thinking about markets today',
];

describe.runIf(typeof real.validatePost === 'function')(
  'policy shim parity with @bootr/agent-core',
  () => {
    it('validatePost / outgoingActionRisk agree', () => {
      for (const text of texts) {
        for (const format of ['short', 'original'] as const) {
          for (const reply of [false, true]) {
            expect(
              outcome(() => shim.validatePost(text, [], format, false, { reply })),
              `${format}/${reply}: ${text}`,
            ).toBe(outcome(() => real.validatePost!(text, [], format, false, { reply })));
          }
        }
        expect(shim.outgoingActionRisk(text, { reply: true })).toBe(
          real.outgoingActionRisk!(text, { reply: true }),
        );
      }
      const credit = [{ username: 'alice', sourceUrl: 'https://x.com/alice/status/1' }];
      expect(outcome(() => shim.validatePost('gm @alice', credit))).toBe(
        outcome(() => real.validatePost!('gm @alice', credit)),
      );
    });

    it('consentCommand agrees', () => {
      for (const t of [
        '@a stop',
        '@a STOP!',
        '@a please stop replying to me',
        '@a resume',
        '@a reply again',
        '@a stop it',
        'stop @a now',
        '@a unmute.',
      ]) {
        expect(shim.consentCommand(t), t).toBe(real.consentCommand!(t));
      }
    });
  },
);
