/**
 * Shared input generators for the property tests.
 *
 * Seeded and deterministic, so every failure is reproducible from the seed it prints. A
 * plain LCG is enough: the point is broad *structural* coverage of text shapes, not
 * statistical quality.
 *
 * The shapes below are chosen from what has actually broken, not for completeness:
 *
 * - **No trailing newline**, decided independently per side. The asymmetric case — one side
 *   terminated, the other not — is the one that broke discard and accept, and it is
 *   unreachable if both sides always agree.
 * - **Independent EOLs per side.** A single shared EOL cannot reach the LF-baseline /
 *   CRLF-document case, which once reported an entire file as one hunk.
 * - **A leading BOM.** Once produced an unresolvable phantom hunk on line 1.
 * - **Empty text and single lines.** Degenerate splices live here.
 * - **Long lines, non-ASCII, and a stray `\r` inside a line.** Content the line model must
 *   carry through untouched rather than normalise.
 *
 * `randomCase` reports what it chose, so a test can restrict an *exact*-result assertion to
 * the regime where the pure model is faithful to production, and still assert convergence
 * everywhere else. See the tests for why that distinction exists.
 */

export function makeRng(seed: number): () => number {
  // Scramble the seed first. Unscrambled, the first draw is `a*seed + c`, which does not wrap
  // for small seeds: it rises almost linearly with the seed, so over seeds 1–1500 the first
  // `randomLines(rnd, 12)` only ever produced 2–9 lines — never an empty baseline. Guarded
  // by "the generator reaches every baseline length" in hunkApply.test.ts.
  let s = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) >>> 0;
  s = (s ^ (s >>> 16)) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const WORDS = [
  'alpha', 'beta', '', 'gamma()', '  indented', 'delta', '}', '// note',
  'café ☕ 日本語',                     // multi-byte UTF-8
  'x'.repeat(240),                       // long line
  'inner\rcarriage return',              // a \r that is content, not an EOL
];

export function randomLines(rnd: () => number, max: number): string[] {
  const n = Math.floor(rnd() * max);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  return out;
}

export interface GeneratedCase {
  baseline: string;
  current: string;
  /** Both sides use the same EOL. */
  sameEol: boolean;
  /** Both sides carry a leading BOM (they always agree on this — see below). */
  bom: boolean;
}

/**
 * A baseline and an edited version of it.
 *
 * The BOM is applied to both sides or neither. That mirrors reality: a BOM belongs to the
 * file, and the document side never carries one at all (VS Code strips it). Tests that
 * model production strip it before calling in, as `commands.ts` does.
 */
export function randomCase(rnd: () => number): GeneratedCase {
  const baseLines = randomLines(rnd, 12);

  const cur = baseLines.slice();
  const edits = 1 + Math.floor(rnd() * 3);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rnd() * (cur.length + 1));
    const kind = rnd();
    if (kind < 0.4) {
      cur.splice(at, 0, ...randomLines(rnd, 3));                       // insert
    } else if (kind < 0.7) {
      cur.splice(at, 1 + Math.floor(rnd() * 3));                        // delete
    } else {
      cur.splice(at, 1 + Math.floor(rnd() * 2), ...randomLines(rnd, 3)); // replace
    }
  }

  const eolOf = () => (rnd() < 0.25 ? '\r\n' : '\n');
  const baseEol = eolOf();
  const curEol = rnd() < 0.8 ? baseEol : eolOf();
  const bom = rnd() < 0.15;
  const prefix = bom ? '﻿' : '';
  const join = (lines: string[], eol: string, terminated: boolean) =>
    lines.length === 0 ? '' : lines.join(eol) + (terminated ? eol : '');

  return {
    baseline: prefix + join(baseLines, baseEol, rnd() < 0.7),
    current: prefix + join(cur, curEol, rnd() < 0.7),
    sameEol: baseEol === curEol,
    bom,
  };
}

/** Iterate `count` seeded cases, with the seed attached for failure messages. */
export function* cases(count: number): Generator<GeneratedCase & { seed: number; rnd: () => number }> {
  for (let seed = 1; seed <= count; seed++) {
    const rnd = makeRng(seed);
    yield { ...randomCase(rnd), seed, rnd };
  }
}
