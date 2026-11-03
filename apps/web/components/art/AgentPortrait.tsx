import type { AgentStatus } from '@/lib/types';
import { cn } from '@/components/ui/cn';

/**
 * An agent's face: a 16x16 dot-matrix sigil derived from its kernel address, so the same agent always wears the
 * same face and no two agents look alike. The left half is drawn from a seeded PRNG and mirrored, so every face
 * is symmetric; two tones of ink (strong dots and faint ones) on `canvas-soft`. Inline SVG, so it is crisp at any
 * size and renders on the server.
 *
 * `status` is the agent's runtime state: `awake` breathes and blinks (CSS steps, at most one change per second,
 * off under `prefers-reduced-motion`); `sleeping` is still and dimmed with its eyes shut; `paused`, `dormant`
 * and `claimed` are still and carry a small mark in the corner. No status = a still face (the launch preview).
 */

const N = 16; // cells per side
const CELL = 10; // viewBox units per cell
const SIZE = N * CELL;
const EMPTY = 0;
const FAINT = 1;
const STRONG = 2;
const EYE = 3;

type Tone = typeof EMPTY | typeof FAINT | typeof STRONG | typeof EYE;

/** FNV-1a over the lower-cased string: a 32-bit seed. Checksum case must not change the face. */
function seed32(s: string): number {
  let h = 0x811c9dc5;
  const t = s.trim().toLowerCase();
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PortraitCells {
  cells: Tone[]; // row-major, N*N
  eyes: { col: number; row: number }[]; // left eye cells (mirrored by the renderer)
  eyeWide: boolean;
}

/**
 * The face as a grid of tones, from the agent's address (any string works: a draft id gives the future agent a
 * face before its kernel exists). Pure and deterministic.
 */
export function portraitCells(address: string): PortraitCells {
  const rnd = prng(seed32(address));
  const pick = (n: number) => Math.floor(rnd() * n);
  const cells: Tone[] = new Array(N * N).fill(EMPTY);
  const at = (c: number, r: number) => r * N + c;
  const set = (c: number, r: number, v: Tone) => {
    if (c >= 0 && c < N && r >= 0 && r < N) cells[at(c, r)] = v;
  };

  // Head: an ellipse of faint dots with a jittered edge, rows top..bottom, mirrored about the centre line.
  const top = 2 + pick(2);
  const bottom = 12 + pick(2);
  const cy = (top + bottom) / 2;
  const ry = (bottom - top) / 2 + 0.5;
  const rx = 5.5 + rnd() * 2; // half width in cells
  const squareness = 0.6 + rnd() * 0.5; // >1 = boxy head
  for (let r = top; r <= bottom; r++) {
    const t = Math.min(1, Math.abs(r - cy) / ry);
    let w = rx * Math.pow(1 - Math.pow(t, 2 * squareness), 0.5);
    w += (rnd() - 0.5) * 0.8;
    const half = Math.max(1, Math.round(w));
    for (let c = 8 - half; c < 8; c++) set(c, r, FAINT);
  }

  // Texture: some of the faint cells go strong, then one smoothing pass turns the noise into blobs.
  const density = 0.18 + rnd() * 0.2;
  for (let r = 0; r < N; r++) for (let c = 0; c < 8; c++) if (cells[at(c, r)] === FAINT && rnd() < density) cells[at(c, r)] = STRONG;
  const before = cells.slice();
  const strongAt = (c: number, r: number) => c >= 0 && r >= 0 && r < N && (c < 8 ? before[at(c, r)] : before[at(15 - c, r)]) === STRONG;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < 8; c++) {
      if (before[at(c, r)] === EMPTY) continue;
      const n = Number(strongAt(c - 1, r)) + Number(strongAt(c + 1, r)) + Number(strongAt(c, r - 1)) + Number(strongAt(c, r + 1));
      if (n >= 3) cells[at(c, r)] = STRONG;
      else if (n <= 1 && before[at(c, r)] === STRONG) cells[at(c, r)] = FAINT;
    }
  }

  // Antenna or crest on some faces: strong cells above the head on the centre line.
  if (rnd() < 0.3) {
    const h = 1 + pick(2);
    for (let r = top - h; r < top; r++) set(7, r, STRONG);
  }
  // Ears on some: a strong cell outside the head edge at eye height.
  const eyeRow = Math.round(cy) - 2 + pick(2);
  if (rnd() < 0.4) {
    let edge = 7;
    while (edge > 0 && cells[at(edge - 1, eyeRow)] !== EMPTY) edge--;
    set(edge - 1, eyeRow, STRONG);
    set(edge - 1, eyeRow + 1, STRONG);
  }

  // Eyes: 1 or 2 cells, a faint halo around them so they read at every size.
  const eyeCol = 7 - (2 + pick(2)); // 4 or 5 from the left edge: 2-3 cells off centre
  const style = pick(3); // 0 dot, 1 wide, 2 tall
  const eyes = [{ col: eyeCol, row: eyeRow }];
  if (style === 1) eyes.push({ col: eyeCol - 1, row: eyeRow });
  if (style === 2) eyes.push({ col: eyeCol, row: eyeRow + 1 });
  for (const e of eyes) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (cells[at(e.col + dc, e.row + dr)] !== EMPTY) set(e.col + dc, e.row + dr, FAINT);
  }
  for (const e of eyes) set(e.col, e.row, EYE);

  // Mouth: a run of strong cells below the eyes; flat, a smile or a frown.
  const mouthRow = Math.min(bottom - 1, eyeRow + 3 + pick(2));
  const mouthHalf = 1 + pick(3); // 1..3 cells each side of centre
  const curve = pick(3) - 1; // -1 frown, 0 flat, 1 smile
  for (let c = 8 - mouthHalf; c < 8; c++) {
    const end = c === 8 - mouthHalf && mouthHalf > 1;
    const r = mouthRow - (end ? curve : 0);
    for (let dr = -1; dr <= 1; dr++) if (cells[at(c, r + dr)] === STRONG) set(c, r + dr, FAINT);
    set(c, r, STRONG);
  }

  // Mirror the left half onto the right.
  for (let r = 0; r < N; r++) for (let c = 0; c < 8; c++) cells[at(15 - c, r)] = cells[at(c, r)];

  return { cells, eyes, eyeWide: style === 1 };
}

function dot(cx: number, cy: number, r: number): string {
  return `M${cx - r},${cy}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`;
}

const R_STRONG = 3.9;
const R_FAINT = 2.4;
const R_EYE = 4.4;

function centre(i: number) {
  return i * CELL + CELL / 2;
}

/** Path data for the two ink tones and the eyes (open and shut), from the grid. */
function paths(p: PortraitCells) {
  let strong = '';
  let faint = '';
  for (let i = 0; i < p.cells.length; i++) {
    const v = p.cells[i];
    if (v === EMPTY || v === EYE) continue;
    const cx = centre(i % N);
    const cy = centre(Math.floor(i / N));
    if (v === STRONG) strong += dot(cx, cy, R_STRONG);
    else faint += dot(cx, cy, R_FAINT);
  }
  let eyesOpen = '';
  let eyesShut = '';
  const seen: { col: number; row: number }[] = [];
  for (const e of p.eyes) seen.push(e, { col: 15 - e.col, row: e.row });
  for (const e of seen) eyesOpen += dot(centre(e.col), centre(e.row), R_EYE);
  // Shut: one dash per eye on the eye's top row, as wide as the eye (one cell, or two for a wide eye).
  const [first] = p.eyes;
  const leftmost = p.eyeWide ? first.col - 1 : first.col; // the wide eye's second cell sits one column outward
  const w = p.eyeWide ? CELL * 2 - 2 : CELL + 8;
  for (const col of [leftmost, 15 - first.col]) {
    const x0 = p.eyeWide ? col * CELL + 1 : col * CELL - CELL / 2 + 1;
    eyesShut += `M${x0},${centre(first.row) - 1.2}h${w}v2.4h${-w}z`;
  }
  return { strong, faint, eyesOpen, eyesShut };
}

/** The corner mark for the stopped states, in a 3x3 cell box bottom right. */
function mark(status: AgentStatus | undefined): string | null {
  const x = 12 * CELL + 4;
  const y = 12 * CELL + 4;
  const s = 3 * CELL - 8;
  if (status === 'paused') return `M${x + 5},${y}h4v${s}h-4zM${x + s - 9},${y}h4v${s}h-4z`;
  if (status === 'dormant') {
    const r = s / 2;
    const cx = x + r;
    const cy = y + r;
    return `M${cx - r},${cy}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0M${cx - r + 4},${cy}a${r - 4},${r - 4} 0 1,1 ${(r - 4) * 2},0a${r - 4},${r - 4} 0 1,1 ${-(r - 4) * 2},0`;
  }
  if (status === 'claimed') return `M${x},${y}h${s}v${s}h${-s}z`;
  return null;
}

const CSS = `
@keyframes ap-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes ap-blink{0%,88%,100%{transform:scaleY(1)}90%,96%{transform:scaleY(.12)}}
.ap-awake .ap-body{animation:ap-breathe 4s steps(4,end) infinite}
.ap-awake .ap-eyes{animation:ap-blink 7s steps(1,end) infinite;transform-box:fill-box;transform-origin:center}
@media (prefers-reduced-motion:reduce){.ap-awake .ap-body,.ap-awake .ap-eyes{animation:none}}
`;

export type PortraitSize = 32 | 56 | 96;

export function AgentPortrait({ address, status, size = 56, className }: { address: string; status?: AgentStatus; size?: PortraitSize; className?: string }) {
  const p = paths(portraitCells(address));
  const m = mark(status);
  const shut = status === 'sleeping';
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={size}
      height={size}
      aria-hidden="true"
      data-testid="agent-portrait"
      data-status={status ?? 'none'}
      className={cn('shrink-0 rounded-xs border border-hairline bg-canvas-soft text-ink', status === 'awake' && 'ap-awake', shut && 'opacity-50', className)}
      style={{ width: size, height: size }}
    >
      <style href="agent-portrait" precedence="default">
        {CSS}
      </style>
      <g className="ap-body" fill="currentColor">
        <path d={p.faint} fillOpacity={0.32} />
        <path d={p.strong} />
        {m ? <path d={m} fillRule="evenodd" /> : null}
        <path className="ap-eyes" d={shut ? p.eyesShut : p.eyesOpen} />
      </g>
    </svg>
  );
}

/**
 * The still face as a `data:` URL (for `<img>`, favicons, OG cards). Colours are fixed here because a data URL
 * cannot read CSS variables: Base Gray 100 on Gray 10, or Gray 0 on the dark soft canvas.
 */
export function agentSigilDataUrl(address: string, opts: { dark?: boolean } = {}): string {
  const p = paths(portraitCells(address));
  const ink = opts.dark ? '#ffffff' : '#0a0b0d';
  const bg = opts.dark ? '#141619' : '#eef0f3';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>` +
    `<g fill="${ink}"><path d="${p.faint}" fill-opacity=".32"/><path d="${p.strong}"/><path d="${p.eyesOpen}"/></g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
