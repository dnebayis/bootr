/**
 * G5, number in evidence (docs/design/agent-behaviour.md section 6.3, rule R4): every number in a post that cites a
 * record is in that record's numbers, within rounding, or in the agent's own data of this turn. A number from nowhere
 * is what the gate finds. `NUMBER_GATE`: `shadow` unless set otherwise (it writes what it would refuse to
 * `sv_gate_shadow` under gate `G5` and changes nothing), `enforce`, `off`. Original posts that cite a record only: a
 * post that cites nothing is not asked, and costs nothing here. No model, one read of the stored turn.
 *
 * The numbers of a post are the ones the fingerprint reads (agent-core `postFacts`): dates, clock times, years,
 * windows ("24h", "7 days") and the numbers of names ("ERC-8004", "v5") are not numbers about anything. Left alone on
 * purpose, because a refusal costs a thought and a post: a plain count up to twelve with no unit ("3 reasons", "two
 * teams"), which is rarely a fact from a source.
 *
 * The evidence, in this order:
 *   - the cited records: their `numbers`, and the figures their headline and their summary state;
 *   - the agent's own data of this turn: the sections of the first observation that code built from Bootr's own index
 *     and chain reads (`OWN_DATA_SECTIONS`), and what `read_market`, `read_coin` and `read_chain` returned in the
 *     turn. Not the mentions, the watchlist, the agent's notes or its checkpoint: a number from memory or from a
 *     stranger is exactly what the rule is about;
 *   - a page the agent read in this turn with `read_url`, when the page is a cited record's own link: the record's
 *     source, read in full.
 *
 * "Within rounding": the figure as the post writes it is the evidence rounded, or cut, at the post's own last written
 * digit. 1,150,000 may be written 1.15M, 1.2M, 1.1M ("over 1.1M") or 1M; not 1.3M and not 2M. A percentage agrees
 * with a share given as a fraction (0.585) or in basis points (5850) as well.
 *
 * Two findings:
 *   - `number_not_in_evidence`: a number that none of the evidence holds;
 *   - `record_not_shown`: the post cites record ids, and none of them is a record this agent was handed.
 * A post sent by the scheduler is not asked again at its send: its text was asked when it was scheduled, with the turn
 * that wrote it in front of the gate, and neither has changed.
 */
import { postFacts, type PostFact } from '@bootr/agent-core';
import { linkKey } from './dataset/clean.js';
import type { CitedRecord } from './post-records.js';
import { plainFigure } from './records-section.js';

/** The sections of a first observation that are the agent's own data: built by code from Bootr's index and chain reads. */
export const OWN_DATA_SECTIONS: readonly string[] = ['market', 'coinFees', 'coinToday', 'yourCoin', 'platformNumbers', 'bootrToday', 'weeklyDigest', 'platformUpdate'];
/** The tools whose results are the agent's own data. */
export const OWN_DATA_TOOLS: readonly string[] = ['read_market', 'read_coin', 'read_chain'];
/** A plain count this small, with no unit, is not asked for evidence. */
export const SMALL_COUNT_MAX = 12;
/** Numbers read from one piece of evidence at most. */
const EVIDENCE_MAX = 2000;

/** A number the evidence holds; `pct` when it was written as a percentage. */
export interface EvidenceNumber {
  value: number;
  pct: boolean;
}

/** Significant figures of a number as a post wrote it, after its k / m / b: 1200000 has two, 1150000 three, 0.0475 three. */
function figuresOf(value: number): number {
  const digits = Math.abs(value).toExponential(11).split('e')[0]!.replace('.', '').replace(/0+$/, '');
  return Math.max(1, digits.length);
}

/** Whether `said` is `real` rounded or cut at the last digit `said` was written with. Pure. */
export function agrees(said: number, real: number): boolean {
  if (!Number.isFinite(said) || !Number.isFinite(real)) return false;
  if (said === real) return true;
  if (said === 0 || real === 0 || Math.sign(said) !== Math.sign(real)) return false;
  const a = Math.abs(said);
  const r = Math.abs(real);
  const place = 10 ** (Math.floor(Math.log10(a)) - figuresOf(a) + 1);
  const slack = place * 1e-9;
  // rounded to the nearest, or cut ("over 1.1M" for 1.15M)
  return Math.abs(a - r) <= place / 2 + slack || (r > a && r - a < place - slack);
}

/** Every number `value` holds: its numbers, and the figures its strings state (as `postFacts` reads them). Bounded. */
export function numbersIn(value: unknown, out: EvidenceNumber[] = [], depth = 0): EvidenceNumber[] {
  if (out.length >= EVIDENCE_MAX || depth > 8) return out;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.push({ value, pct: false });
  } else if (typeof value === 'string') {
    const text = value.slice(0, 20_000);
    if (/^-?\d+(?:\.\d+)?$/.test(text.trim())) out.push({ value: Number(text), pct: false });
    else for (const fact of postFacts(text)) out.push({ value: fact.value, pct: fact.unit === '%' });
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) numbersIn(item, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>).slice(0, 500)) numbersIn(item, out, depth + 1);
  }
  return out;
}

/** The numbers a cited record gives: its `numbers`, and the figures of its headline and summary. */
export function recordEvidence(records: readonly CitedRecord[]): EvidenceNumber[] {
  const out: EvidenceNumber[] = [];
  for (const record of records) {
    for (const n of Array.isArray(record.numbers) ? record.numbers : []) if (n && typeof n.value === 'number' && Number.isFinite(n.value)) out.push({ value: n.value, pct: n.unit === '%' });
    numbersIn(record.headline, out);
    numbersIn(record.summary ?? '', out);
  }
  return out;
}

/** What the gate reads of a stored turn: its messages (a hosted turn), or the observation an own turn was opened with. */
export interface TurnEvidenceSource {
  messages?: { role: string; content: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]; tool_call_id?: string }[];
  ownOpen?: { observation?: Record<string, unknown> } | null;
}

/** The first observation of a stored turn: an own turn keeps it as it was opened, a hosted turn as its first user message. Null when it cannot be read. Pure. */
export function observationOf(turn: TurnEvidenceSource | null | undefined): Record<string, unknown> | null {
  if (!turn) return null;
  let observation: Record<string, unknown> | null = turn.ownOpen?.observation ?? null;
  if (!observation) {
    const first = (Array.isArray(turn.messages) ? turn.messages : []).find((m) => m.role === 'user');
    try {
      observation = first?.content ? (JSON.parse(first.content) as Record<string, unknown>) : null;
    } catch {
      observation = null;
    }
  }
  return observation && typeof observation === 'object' ? observation : null;
}

/**
 * The agent's own data of a turn, as numbers: the own-data sections of its first observation, the results of its own
 * read tools, and a `read_url` of a cited record's own link. A turn that cannot be read gives none. Pure.
 */
export function turnEvidence(turn: TurnEvidenceSource | null | undefined, records: readonly CitedRecord[] = []): EvidenceNumber[] {
  const out: EvidenceNumber[] = [];
  if (!turn) return out;
  const messages = Array.isArray(turn.messages) ? turn.messages : [];
  const observation = observationOf(turn);
  if (observation) for (const key of OWN_DATA_SECTIONS) if (key in observation) numbersIn(observation[key], out);
  const links = new Set(records.map((r) => (r.link ? linkKey(r.link) : null)).filter((k): k is string => !!k));
  // The tool each result answers, and for a page read, the page.
  const calls = new Map<string, { name: string; url: string | null }>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      const name = call.function?.name ?? '';
      let url: string | null = null;
      if (name === 'read_url') {
        try {
          const args = JSON.parse(call.function?.arguments ?? '{}') as { url?: unknown };
          url = typeof args.url === 'string' ? args.url : null;
        } catch {
          url = null;
        }
      }
      if (call.id) calls.set(call.id, { name, url });
    }
    if (m.role !== 'tool' || !m.tool_call_id || !m.content) continue;
    const call = calls.get(m.tool_call_id);
    if (!call) continue;
    const ownRead = OWN_DATA_TOOLS.includes(call.name);
    const sourceRead = call.name === 'read_url' && !!call.url && links.has(linkKey(call.url.replace(/^http:\/\//, 'https://').replace(/[#?].*$/, '').replace(/\/+$/, '')));
    if (!ownRead && !sourceRead) continue;
    try {
      numbersIn(JSON.parse(m.content), out);
    } catch {
      numbersIn(m.content, out);
    }
  }
  return out;
}

/** Whether a number a post states is held by the evidence. A percentage also agrees with a fraction or with basis points. */
export function inEvidence(fact: Pick<PostFact, 'value' | 'unit'>, evidence: readonly EvidenceNumber[]): boolean {
  const pct = fact.unit === '%';
  return evidence.some((e) => agrees(fact.value, e.value) || (pct && !e.pct && (agrees(fact.value, e.value * 100) || agrees(fact.value, e.value / 100))));
}

/** A number as the finding names it. */
const written = (fact: Pick<PostFact, 'value' | 'unit'>): string => (fact.unit === '$' ? `$${plainFigure(fact.value)}` : fact.unit === '%' ? `${plainFigure(fact.value)}%` : fact.unit ? `${plainFigure(fact.value)} ${fact.unit.toUpperCase()}` : plainFigure(fact.value));

export interface NumberFinding {
  code: 'number_not_in_evidence' | 'record_not_shown';
  message: string;
  /** The text the finding is in. */
  text: string;
  detail: Record<string, unknown>;
}

/**
 * What the gate finds in an original post (`parts`: its text, or every post of a thread) that names `asked` record
 * ids, of which `records` are the ones the agent was handed. Null for a post that cites nothing, and for one whose
 * every number the evidence holds. Pure.
 */
export function numberProblem(parts: readonly string[], asked: readonly string[], records: readonly CitedRecord[], own: readonly EvidenceNumber[], done: 'posted' | 'scheduled' = 'posted'): NumberFinding | null {
  if (!asked.length) return null;
  const nothing = `Nothing was ${done}.`;
  if (!records.length) {
    return {
      code: 'record_not_shown',
      message: `record_not_shown: the record you cite (${asked.join(', ')}) is not one of the records you were shown. Cite a record by the id its item in your records section carries, or leave record out. ${nothing}`,
      text: parts.join('\n'),
      detail: { asked: [...asked] },
    };
  }
  const evidence = [...recordEvidence(records), ...own];
  for (const part of parts) {
    const missing = postFacts(part).filter((fact) => !(fact.unit === '' && Number.isInteger(fact.value) && Math.abs(fact.value) <= SMALL_COUNT_MAX) && !inEvidence(fact, evidence));
    if (!missing.length) continue;
    const named = missing.slice(0, 4).map(written);
    const given = records.flatMap((r) => (Array.isArray(r.numbers) ? r.numbers : []).map((n) => plainFigure(n.value))).slice(0, 6);
    return {
      code: 'number_not_in_evidence',
      message: `number_not_in_evidence: ${named.join(', ')} ${named.length === 1 ? 'is' : 'are'} not in the record you cite${given.length ? ` (its numbers: ${given.join(', ')})` : ' (it gives no number)'} and not in your own data of this turn. State a number as its source gives it, or leave it out. ${nothing}`,
      text: part,
      detail: { numbers: named, records: records.map((r) => r.id), recordNumbers: given },
    };
  }
  return null;
}
