import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FALLBACK_BUYBACK, FALLBACK_STANDARD, FALLBACK_V5_BUYBACK, FALLBACK_V5_STANDARD, fallbackDefaults } from './abi/launcher';
import { AI_CLIENTS, aiClient, ASK_TO_CONNECT, KEEP_RUNNING_FACTS, KEEP_RUNNING_MINUTES, keepRunningRecipe, keepRunningRecipes, PICTURES_NOTE, turnPrompt } from './keep-running';
import { onboardingComplete, onboardingItems, OWN_SECTION_HINTS, SECTION_HINTS } from './onboarding';

const README = readFileSync(path.resolve(import.meta.dirname, '../../../packages/mcp/README.md'), 'utf8');
/** Words that name how Bootr is built, which public copy never uses. */
const JARGON = /session key|kernel|relay|runner|supervisor|x402|hosted\b|\bHMAC\b|credential/i;

describe('connecting an AI client', () => {
  it('names the five clients of the connect step, each with one block to paste', () => {
    expect(AI_CLIENTS.map((c) => c.id)).toEqual(['claude-code', 'claude-desktop', 'cursor', 'codex', 'other']);
    for (const c of AI_CLIENTS) {
      expect(c.install.text).toContain('@bootrfun/mcp');
      expect(c.intro.length).toBeGreaterThan(10);
      expect(aiClient(c.id)).toBe(c);
    }
  });

  it('uses the very lines the MCP package’s README carries', () => {
    expect(README).toContain(aiClient('claude-code').install.text);
    expect(README).toContain(aiClient('codex').install.text);
    const config = JSON.parse(aiClient('claude-desktop').install.text) as { mcpServers: { bootr: { command: string; args: string[] } } };
    expect(config.mcpServers.bootr).toEqual({ command: 'npx', args: ['-y', '@bootrfun/mcp'] });
    expect(README.replace(/\s+/g, '')).toContain(JSON.stringify(config).replace(/\s+/g, ''));
    expect(aiClient('cursor').install.text).toBe(aiClient('claude-desktop').install.text);
  });

  it('asks the client in plain words and never for a key', () => {
    expect(ASK_TO_CONNECT).toBe('Connect to Bootr and show me the link.');
    for (const c of AI_CLIENTS) expect(`${c.intro} ${c.install.text} ${c.note ?? ''}`).not.toMatch(/private key|seed phrase|api key:|token:/i);
  });
});

describe('keep it running', () => {
  it('has one recipe per client, in the same order, with the coin’s symbol in what is copied', () => {
    const recipes = keepRunningRecipes('qeng');
    expect(recipes.map((r) => r.client)).toEqual(AI_CLIENTS.map((c) => c.id));
    for (const r of recipes) {
      expect(r.title).toBe(aiClient(r.client).label);
      expect(r.steps.length).toBeGreaterThan(1);
      expect(r.summary.length).toBeGreaterThan(10);
      expect(`${r.copy?.text ?? ''} ${r.steps.join(' ')}`, r.client).toContain(r.client === 'other' ? 'bootr own watch' : '$QENG');
    }
  });

  it('the sentence that starts a round of work names the coin, or "my coin" before there is a symbol', () => {
    expect(turnPrompt('QENG')).toBe('Use only the Bootr tools. For $QENG: ask Bootr what is due, do each due role in its own turn, then finish.');
    expect(turnPrompt('$qeng')).toContain('For $QENG:');
    for (const none of ['', null, undefined, 'x', 'has space']) expect(turnPrompt(none)).toContain('For my coin:');
  });

  it('Claude Code: a schedule line that starts a fresh run with only Bootr’s tools, the symbol safe from the shell', () => {
    const { copy, steps } = keepRunningRecipe('claude-code', 'QENG');
    expect(copy!.text).toBe(`*/${KEEP_RUNNING_MINUTES} * * * * claude -p '${turnPrompt('QENG')}' --allowedTools "mcp__bootr__*"`);
    // single quotes: `$QENG` is not a shell variable there
    expect(copy!.text).toMatch(/'[^']*\$QENG[^']*'/);
    expect(steps.join(' ')).toContain(`/loop ${KEEP_RUNNING_MINUTES}m`);
  });

  it('Codex gets a schedule line too; clients without a schedule get the sentence or the Bootr command line', () => {
    expect(keepRunningRecipe('codex', 'QENG').copy!.text).toBe(`*/${KEEP_RUNNING_MINUTES} * * * * codex exec '${turnPrompt('QENG')}'`);
    expect(keepRunningRecipe('claude-desktop', 'QENG').copy!.text).toBe(turnPrompt('QENG'));
    expect(keepRunningRecipe('cursor', 'QENG').copy!.text).toBe(turnPrompt('QENG'));
    expect(keepRunningRecipe('cursor', 'QENG').steps.join(' ')).toContain('bootr own watch --exec');
    expect(keepRunningRecipe('other', 'QENG').copy!.text).toContain('bootr own watch --exec');
  });

  it('says plainly that Bootr never takes over, in public words', () => {
    expect(KEEP_RUNNING_FACTS.join(' ')).toContain('Bootr never takes over');
    const copy = [...KEEP_RUNNING_FACTS, PICTURES_NOTE, ASK_TO_CONNECT, ...keepRunningRecipes('QENG').flatMap((r) => [r.summary, ...r.steps]), ...AI_CLIENTS.flatMap((c) => [c.intro, c.note ?? ''])].join('\n');
    expect(copy).not.toMatch(JARGON);
    expect(copy).not.toContain('—');
  });
});

describe('first steps of an own agent', () => {
  const base = { xHandle: 'qeng_agent', instructions: 'A patient analyst.', fuelUsdc: 0n, fuelReceivedUsdc: 0n, gasWei: 10n ** 15n };

  it('the Bootr agent keeps its four steps, fuel among them', () => {
    expect(onboardingItems(base).map((i) => i.key)).toEqual(['x', 'instructions', 'fuel', 'gas']);
    expect(onboardingItems({ ...base, own: null }).map((i) => i.key)).toEqual(['x', 'instructions', 'fuel', 'gas']);
    expect(onboardingItems(base).find((i) => i.key === 'fuel')!.done).toBe(false);
  });

  it('an own agent has no fuel step: its third step is a connected AI client, settled on the Agent card', () => {
    const none = onboardingItems({ ...base, own: { clients: 0 } });
    expect(none.map((i) => i.key)).toEqual(['x', 'instructions', 'client', 'gas']);
    expect(none[2]).toMatchObject({ label: 'Connect your AI client', target: 'mind', done: false });
    const one = onboardingItems({ ...base, own: { clients: 1 } });
    expect(one[2]!.done).toBe(true);
    // with no fuel at all the card is complete: an own agent needs none
    expect(onboardingComplete(one)).toBe(true);
    // and the fuel balance still loading does not hold it back
    expect(onboardingItems({ ...base, fuelUsdc: null, fuelReceivedUsdc: null, own: { clients: 1 } }).every((i) => i.done === true)).toBe(true);
  });

  it('the section hints of an own agent name no model and say what fuel is for', () => {
    expect(OWN_SECTION_HINTS.mind).not.toMatch(/model/i);
    expect(OWN_SECTION_HINTS.fuel).toBe('Fuel pays for paid services only; gas pays for its own transactions.');
    expect(OWN_SECTION_HINTS.inbox).not.toMatch(/private line/i);
    expect(SECTION_HINTS.mind).toMatch(/model/);
    expect(Object.values(OWN_SECTION_HINTS).join(' ')).not.toMatch(JARGON);
  });
});

describe('no fuel minimum', () => {
  it('the launch form’s fallback presets ask for none, on every path', () => {
    for (const d of [FALLBACK_STANDARD, FALLBACK_BUYBACK, FALLBACK_V5_STANDARD, FALLBACK_V5_BUYBACK]) expect(d.minFuelUsdc).toBe(0n);
    for (const source of ['bootr', 'clanker', 'clanker-v5'] as const) for (const buyback of [false, true]) expect(fallbackDefaults(source, buyback).minFuelUsdc).toBe(0n);
  });
});
