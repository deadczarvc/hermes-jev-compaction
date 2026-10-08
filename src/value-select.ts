/**
 * Fact lines by learned token value (V4): the same model and selection as Hermes jev-context-engine v0.8.0
 * (`hermes-plugin/value_select.py` in deadczarvc/hermes-jev-compaction).
 *
 * A token's value is P(the agent uses it after the compaction): a logistic regression on 13 token features fitted on
 * 191 076 tokens of 85 Claude Code / Codex transcripts. Within the chars the regex fact lines would take, the selection
 * keeps the regex lines up to a third, then every error piece, then pieces by lazy greedy weighted coverage (most
 * not-yet-kept value per char; coverage is monotone submodular, so the lazy evaluation is exact).
 */
import { factLines, pieces } from './compact.js';

// Standardised model; "seen_before" is left out: constant in training (candidates exclude seen tokens), β = 0.
const MU = [0.400888, 0.240747, 0.240281, 0.016752, 2.832681, 0.13081, 0.871874, 0.004401, 0.007997, 3.024303, 0.478259, 9.281838, 0.050729];
const SD = [0.490078, 0.427537, 0.427254, 0.128343, 0.642327, 0.239112, 0.385938, 0.066197, 0.089067, 0.954716, 0.292466, 1.062772, 0.219443];
const INTERCEPT = -2.884622;
const BETA = [-0.227483, 0.122111, -0.003107, 0.097325, -0.170036, -0.058623, 0.360508, 0.183316, 0.152196, -0.008517, -0.118614, -0.332467, 0.520239];

const DIG = /[A-Za-z0-9][A-Za-z0-9_.:/@#-]{5,}/g;
const WRD = /[A-Za-z_][A-Za-z0-9_./-]{7,}/g;
const HEX = /^[0-9a-f]{8,}$/i;
const EXT = /\.[A-Za-z]{1,5}$/;
export const ERROR_PIECE = /error|failed|exception|traceback|denied|not found|timed out/i;
const strip = (t: string) => t.replace(/[.:,]+$/, '');

/** Candidate fact tokens: digit-bearing runs, and digit-free words of ≥ 8 chars with a / _ or . */
export function toks(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.match(DIG) ?? []) if (/\d/.test(t)) out.add(strip(t));
  for (const t of s.match(WRD) ?? []) if (/[/_.]/.test(t) && !/\d/.test(t) && strip(t).length >= 8) out.add(strip(t));
  return out;
}

/** What the model knows about one output: the last call's arguments before it, the last user text, outputs left to
 * the compaction point, and the tokens the agent already reused (named in a call or a reply after an output). */
export interface ValueContext {
  input: string;
  user: string;
  dist: number;
  reused: ReadonlySet<string>;
}

export function tokenValues(text: string, ctx: ValueContext): Map<string, number> {
  const values = new Map<string, number>();
  // Lengths and positions in code points, as the model was fitted (Python); differs from .length only past U+FFFF.
  const astral = /[\uD800-\uDFFF]/.test(text);
  const cp = (s: string) => (astral ? [...s].length : s.length);
  const length = cp(text);
  for (const t of toks(text)) {
    const x = [
      Number(/\d/.test(t)),
      Number(t.includes('/') || t.includes('\\')),
      Number(EXT.test(t)),
      Number(HEX.test(t)),
      Math.log(t.length),
      [...t].filter((c) => c >= '0' && c <= '9').length / t.length,
      Math.log1p(text.split(t).length - 1),
      Number(ctx.input.includes(t)),
      Number(ctx.user.includes(t)),
      Math.log1p(ctx.dist),
      cp(text.slice(0, text.indexOf(t))) / Math.max(1, length),
      Math.log(Math.max(1, length)),
      Number(ctx.reused.has(t)),
    ];
    const z = x.reduce((acc, v, k) => acc + (BETA[k]! * (v - MU[k]!)) / SD[k]!, INTERCEPT);
    values.set(t, 1 / (1 + Math.exp(-z)));
  }
  return values;
}

/** Within the chars `regex(text, budget)` would take: its lines up to a third, error pieces, then greedy coverage. */
export function valueLines(text: string, budget: number, values: ReadonlyMap<string, number>, regex: (text: string, budget: number) => string[] = factLines): string[] {
  const cap = regex(text, budget).reduce((n, l) => n + l.length + 1, 0);
  const units = text.split(/\r?\n/).flatMap((line) => pieces(line));
  const index = new Map(units.map((u, i) => [u, i] as const));
  const taken = new Set<number>();
  const covered = new Set<string>();
  let used = 0;
  const take = (i: number) => {
    taken.add(i);
    used += units[i]!.length + 1;
    for (const t of toks(units[i]!)) covered.add(t);
  };
  for (const line of regex(text, Math.floor(cap / 3))) {
    const i = index.get(line);
    if (i !== undefined && !taken.has(i) && used + line.length + 1 <= cap) take(i);
  }
  units.forEach((u, i) => {
    if (!taken.has(i) && ERROR_PIECE.test(u) && used + u.length + 1 <= cap) take(i);
  });
  const unitToks = units.map((u) => toks(u));
  const gain = (i: number) => [...unitToks[i]!].reduce((s, t) => s + (covered.has(t) ? 0 : (values.get(t) ?? 0)), 0) / (units[i]!.length + 1);
  const heap = new MinHeap();
  unitToks.forEach((ut, i) => {
    if (ut.size && !taken.has(i)) heap.push(-[...ut].reduce((s, t) => s + (values.get(t) ?? 0), 0) / (units[i]!.length + 1), i);
  });
  while (heap.size) {
    const i = heap.pop();
    const g = gain(i);
    if (g <= 0) continue;
    if (heap.size && g < -heap.peekKey() - 1e-12) {
      heap.push(-g, i); // lazy: a stale bound goes back with its true gain
      continue;
    }
    if (used + units[i]!.length + 1 <= cap) take(i);
  }
  return [...taken].sort((a, b) => a - b).map((i) => units[i]!);
}

/** Binary min-heap of (key, index), ties by index: the order Python's heapq gives the same tuples. */
class MinHeap {
  private items: Array<[number, number]> = [];
  get size(): number {
    return this.items.length;
  }
  peekKey(): number {
    return this.items[0]![0];
  }
  private less(a: [number, number], b: [number, number]): boolean {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }
  push(key: number, i: number): void {
    const h = this.items;
    h.push([key, i]);
    for (let k = h.length - 1; k > 0; ) {
      const p = (k - 1) >> 1;
      if (!this.less(h[k]!, h[p]!)) break;
      [h[k], h[p]] = [h[p]!, h[k]!];
      k = p;
    }
  }
  pop(): number {
    const h = this.items;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      for (let k = 0; ; ) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === k) break;
        [h[k], h[m]] = [h[m]!, h[k]!];
        k = m;
      }
    }
    return top[1];
  }
}
