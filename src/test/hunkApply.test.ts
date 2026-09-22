import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeHunks, ParsedHunk } from '../diffEngine';
import {
  acceptHunkBaseline,
  acceptLinesBaseline,
  discardHunkText,
  minimalSplice,
  rejectLinesText,
} from '../hunkApply';
import { cases, makeRng, randomLines } from './generators';

/**
 * The accept/discard invariants, as properties over generated inputs.
 *
 * Why properties rather than examples: every defect this file now guards survived review.
 * A passing example test covered `computeHunks` on content without a trailing newline while
 * discard, one layer up, left an unresolvable hunk on exactly that input. A careful
 * line-by-line read cleared `acceptHunk` of the same defect; the generator refuted it on its
 * fifth input. The partial-selection defects pinned at the bottom were found the same way,
 * on the first run of the selection properties.
 *
 * Inputs model production: `commands.ts` strips the BOM from the baseline before calling in
 * and the document never carries one, so every case is BOM-stripped here too. Asserting on
 * un-stripped text would test a composition production never runs.
 *
 * A failure message always carries the seed. `cases(n)` in ./generators regenerates it.
 */

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

interface Totals { hunks: number; added: number; removed: number }
function totals(baseline: string, current: string): Totals {
  const h = computeHunks(baseline, current);
  return {
    hunks: h.length,
    added: h.reduce((n, x) => n + x.newLines, 0),
    removed: h.reduce((n, x) => n + x.oldLines, 0),
  };
}

/** Text split the way jsdiff counts lines — see hunkApply.ts `toLines`. */
function jsdiffLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

const CASES = 1500;

// The properties below are only as broad as their inputs. `randomCase` draws the baseline's
// line count first, so this replays that draw for every seed the suite uses.
describe('generator coverage', () => {
  it('the generator reaches every baseline length', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= CASES; seed++) seen.add(randomLines(makeRng(seed), 12).length);
    for (let n = 0; n < 12; n++) assert.ok(seen.has(n), `no seed in 1..${CASES} yields a ${n}-line baseline`);
  });
});

// ── whole-hunk operations ────────────────────────────────────────────────────

describe('property: discarding a hunk', () => {
  it('always makes progress, and discarding them all restores the baseline', () => {
    for (const c of cases(CASES)) {
      const baseline = stripBom(c.baseline);
      let text = stripBom(c.current);
      const ctx = () => `seed=${c.seed} baseline=${JSON.stringify(baseline)} current=${JSON.stringify(c.current)}`;

      for (let guard = 0; guard < 100; guard++) {
        const hunks = computeHunks(baseline, text);
        if (hunks.length === 0) break;
        // A random hunk, not always the first: position-dependent bugs hide behind hunks[0].
        const next = discardHunkText(baseline, text, pick(c.rnd, hunks));
        const after = computeHunks(baseline, next).length;
        // Strictly fewer, every time. "No change" was the failure shape of the original
        // trailing-newline bug: the file could never leave review.
        assert.ok(after < hunks.length, `${ctx()} — discard went ${hunks.length} → ${after} hunks`);
        text = next;
      }

      assert.strictEqual(computeHunks(baseline, text).length, 0, `${ctx()} — did not converge`);
      // Exact, not merely "zero hunks": computeHunks ignores EOL differences, so a discard
      // that rewrote line endings would still converge. Only asserted where the pure model is
      // faithful — with differing EOLs VS Code normalises the inserted text to the document's
      // own EOL, which a string-level model cannot.
      if (c.sameEol) assert.strictEqual(text, baseline, `${ctx()} — converged but not byte-identical`);
    }
  });
});

describe('property: accepting a hunk', () => {
  it('always makes progress, and accepting them all yields the document', () => {
    for (const c of cases(CASES)) {
      let baseline = stripBom(c.baseline);
      const current = stripBom(c.current);
      const ctx = () => `seed=${c.seed} baseline=${JSON.stringify(c.baseline)} current=${JSON.stringify(current)}`;

      for (let guard = 0; guard < 100; guard++) {
        const hunks = computeHunks(baseline, current);
        if (hunks.length === 0) break;
        const next = acceptHunkBaseline(baseline, current, pick(c.rnd, hunks));
        const after = computeHunks(next, current).length;
        assert.ok(after < hunks.length, `${ctx()} — accept went ${hunks.length} → ${after} hunks`);
        baseline = next;
      }

      assert.strictEqual(computeHunks(baseline, current).length, 0, `${ctx()} — did not converge`);
      if (c.sameEol) assert.strictEqual(baseline, current, `${ctx()} — converged but not byte-identical`);
    }
  });

  it('a new file (empty baseline) accepts to zero hunks', () => {
    // `acceptHunk` seeds a null baseline with '' before folding.
    for (const c of cases(300)) {
      const current = stripBom(c.current);
      let baseline = '';
      for (let guard = 0; guard < 100; guard++) {
        const hunks = computeHunks(baseline, current);
        if (hunks.length === 0) break;
        baseline = acceptHunkBaseline(baseline, current, pick(c.rnd, hunks));
      }
      assert.strictEqual(computeHunks(baseline, current).length, 0, `seed=${c.seed}`);
    }
  });
});

describe('property: interleaving accept and discard', () => {
  it('converges however the two are mixed', () => {
    // The real workflow: a reviewer accepts some hunks and rejects others, in any order.
    // Each operation moves a *different* side — discard the document, accept the baseline —
    // so a mix is a composition neither single-operation property exercises.
    for (const c of cases(CASES)) {
      let baseline = stripBom(c.baseline);
      let text = stripBom(c.current);
      for (let guard = 0; guard < 150; guard++) {
        const hunks = computeHunks(baseline, text);
        if (hunks.length === 0) break;
        const h = pick(c.rnd, hunks);
        if (c.rnd() < 0.5) text = discardHunkText(baseline, text, h);
        else baseline = acceptHunkBaseline(baseline, text, h);
      }
      assert.strictEqual(computeHunks(baseline, text).length, 0, `seed=${c.seed} — did not converge`);
    }
  });
});

// ── partial (selection) operations ───────────────────────────────────────────
//
// The invariant here is NOT "the hunk count never goes up". Accepting a line from the middle
// of a replace hunk legitimately splits it in two — baseline `X` replaced by `A B`, accept
// `A`, and what is left is "remove X" and "add B" — so the count rises while the pending
// work shrinks. What must hold is the work itself: selecting k added lines resolves at least
// those k additions, and never creates a removal.

/** A random hunk with added lines, and a random sub-range of those lines (document lines). */
function randomSelection(c: { rnd: () => number }, hunks: ParsedHunk[]) {
  const withAdded = hunks.filter(h => h.newLines > 0);
  if (withAdded.length === 0) return undefined;
  const hunk = pick(c.rnd, withAdded);
  const first = hunk.newStart - 1;
  const start = first + Math.floor(c.rnd() * hunk.newLines);
  const end = start + Math.floor(c.rnd() * (first + hunk.newLines - start));
  return { hunk, start, end, k: end - start + 1 };
}

describe('property: accepting a selection', () => {
  it('resolves at least the selected additions and never creates a removal', () => {
    for (const c of cases(CASES)) {
      const baseline = stripBom(c.baseline);
      const current = stripBom(c.current);
      const sel = randomSelection(c, computeHunks(baseline, current));
      if (!sel) continue;
      const before = totals(baseline, current);

      const after = totals(acceptLinesBaseline(baseline, current, sel.hunk, sel.start, sel.end), current);

      const ctx = `seed=${c.seed} lines ${sel.start}-${sel.end} baseline=${JSON.stringify(baseline)} current=${JSON.stringify(current)}`;
      assert.ok(after.added <= before.added - sel.k, `${ctx} — additions ${before.added} → ${after.added}, expected ≤ ${before.added - sel.k}`);
      assert.ok(after.removed <= before.removed, `${ctx} — removals rose ${before.removed} → ${after.removed}`);
    }
  });
});

describe('property: rejecting a selection', () => {
  it('resolves at least the selected additions and never creates a removal', () => {
    for (const c of cases(CASES)) {
      const baseline = stripBom(c.baseline);
      const current = stripBom(c.current);
      const sel = randomSelection(c, computeHunks(baseline, current));
      if (!sel) continue;
      const before = totals(baseline, current);

      const after = totals(baseline, rejectLinesText(baseline, current, sel.hunk, sel.start, sel.end));

      const ctx = `seed=${c.seed} lines ${sel.start}-${sel.end} baseline=${JSON.stringify(baseline)} current=${JSON.stringify(current)}`;
      assert.ok(after.added <= before.added - sel.k, `${ctx} — additions ${before.added} → ${after.added}, expected ≤ ${before.added - sel.k}`);
      assert.ok(after.removed <= before.removed, `${ctx} — removals rose ${before.removed} → ${after.removed}`);
    }
  });

  it('removes exactly the selected lines — the final newline is the only other freedom', () => {
    // The "it grabbed a bigger chunk" guard. Every line outside the selection survives, in
    // order. The final newline is exempt because the deletion may legitimately change which
    // line is last, and — an inherent ambiguity of the line model — an unterminated text
    // ending in an empty line is byte-identical to a terminated one a line shorter.
    for (const c of cases(CASES)) {
      const baseline = stripBom(c.baseline);
      const current = stripBom(c.current);
      const sel = randomSelection(c, computeHunks(baseline, current));
      if (!sel) continue;

      const result = rejectLinesText(baseline, current, sel.hunk, sel.start, sel.end);

      const lines = jsdiffLines(current);
      const kept = [...lines.slice(0, sel.start), ...lines.slice(sel.end + 1)];
      const asText = (terminated: boolean) => (kept.length === 0 ? '' : kept.join('\n') + (terminated ? '\n' : ''));
      assert.ok(result === asText(true) || result === asText(false),
        `seed=${c.seed} lines ${sel.start}-${sel.end} — expected the other ${kept.length} line(s) intact, got ${JSON.stringify(result)}`);
    }
  });
});

// ── pinned regressions ───────────────────────────────────────────────────────
//
// Every failure the properties above have ever found, as a fixed example. The properties
// would find them again, but a named case says what broke and survives a generator change.

describe('regression: whole-hunk operations at end of file', () => {
  // Reproduced in review (`git show 0e7c707:docs/code-review-2026-09-20.md`). Before the fix
  // each left exactly one hunk behind, permanently: discard appended a newline the file never had.
  const noTrailingNewline: [string, string, string][] = [
    ['modified last line', 'a\nc', 'a\nb'],
    ['appended line', 'a', 'a\nb'],
    ['removed last line', 'a\nb', 'a'],
  ];
  for (const [name, baseline, current] of noTrailingNewline) {
    it(`${name}: discard restores the baseline exactly`, () => {
      const [h] = computeHunks(baseline, current);
      assert.strictEqual(discardHunkText(baseline, current, h), baseline);
    });
    it(`${name}: accept resolves`, () => {
      const [h] = computeHunks(baseline, current);
      assert.strictEqual(computeHunks(acceptHunkBaseline(baseline, current, h), current).length, 0);
    });
  }

  it('split-model phantom element: baseline delta\\nbeta\\n vs document beta', () => {
    // Found by the generator on its fifth input. `split('\n')` has one more element than
    // jsdiff counts lines, and the stranded '' re-terminated the file, so neither accept nor
    // discard could converge.
    const baseline = 'delta\nbeta\n';
    const current = 'beta';
    const [h] = computeHunks(baseline, current);
    assert.strictEqual(discardHunkText(baseline, current, h), baseline);
    assert.strictEqual(computeHunks(acceptHunkBaseline(baseline, current, h), current).length, 0);
  });
});

describe('regression: partial operations at end of file', () => {
  it('accepting a middle line of a replace hunk at EOF does not grow the change (seed 8)', () => {
    // The accepted line landed at the end of the baseline and took the document's missing
    // final newline, so it no longer matched its twin: one removal became two. This case was
    // *introduced* by moving the splice into hunkApply.
    const baseline = 'alpha\ngamma()\n';
    const current = 'alpha\ndelta\ngamma()';
    const [h] = computeHunks(baseline, current);
    const before = totals(baseline, current);
    const after = totals(acceptLinesBaseline(baseline, current, h, 1, 1), current);
    assert.ok(after.added <= before.added - 1);
    assert.ok(after.removed <= before.removed);
  });

  it('accepting lines ahead of the last added line at EOF resolves them (seed 1067)', () => {
    const baseline = 'alpha\n  indented\nbeta\ndelta\n  indented\n\nbeta';
    const current = 'alpha\n  indented\nbeta\ndelta\n  indented\n\nbeta\ndelta\n}';
    const [h] = computeHunks(baseline, current);
    const before = totals(baseline, current);
    const after = totals(acceptLinesBaseline(baseline, current, h, 6, 7), current);
    assert.ok(after.added <= before.added - 2, `additions ${before.added} → ${after.added}`);
    assert.ok(after.removed <= before.removed);
  });

  it('rejecting the last line keeps the newline the baseline has there (seed 2)', () => {
    // Pre-existing: rejectSelection's old range arithmetic did the same. Keeping the
    // document's missing final newline gave 'delta', a different token from the baseline's
    // 'delta\n', so rejecting one addition created a removal.
    const baseline = 'delta\n\n';
    const current = 'delta\ncafé ☕ 日本語';
    const [h] = computeHunks(baseline, current);
    assert.strictEqual(rejectLinesText(baseline, current, h, 1, 1), 'delta\n');
  });

  it('rejecting the last line keeps it terminated when the baseline continues (seed 20)', () => {
    // The mirror case, and why the rule is not simply "use the baseline's terminator".
    const baseline = 'beta\ndelta';
    const current = 'beta\ndelta\n';
    const [h] = computeHunks(baseline, current);
    assert.strictEqual(rejectLinesText(baseline, current, h, 1, 1), 'beta\n');
  });
});

describe('rejectLinesText examples', () => {
  // Each case: a hunk that adds the lines being rejected, so the call is well-formed.
  const run = (baseline: string, current: string, s: number, e: number) => {
    const h = computeHunks(baseline, current).find(x => s >= x.newStart - 1 && e < x.newStart - 1 + x.newLines)!;
    return rejectLinesText(baseline, current, h, s, e);
  };

  it('deletes an interior line without disturbing the terminator', () => {
    assert.strictEqual(run('a\nc\n', 'a\nb\nc\n', 1, 1), 'a\nc\n');
  });
  it('deletes a run spanning to EOF', () => {
    assert.strictEqual(run('a', 'a\nb\nc', 1, 2), 'a');
  });
  it('deletes the only line', () => {
    assert.strictEqual(run('', 'a', 0, 0), '');
  });
});

describe('acceptLinesBaseline examples', () => {
  it('folds only the selected added lines, leaving the rest pending', () => {
    const baseline = 'a\nd\n';
    const current = 'a\nb\nc\nd\n';
    const [h] = computeHunks(baseline, current);
    const next = acceptLinesBaseline(baseline, current, h, 1, 1);
    assert.strictEqual(next, 'a\nb\nd\n');
    assert.strictEqual(computeHunks(next, current).length, 1);
  });
});

describe('minimalSplice', () => {
  it('applying the splice reproduces the target, over generated pairs', () => {
    for (const c of cases(CASES)) {
      const s = minimalSplice(c.baseline, c.current);
      const applied = c.baseline.slice(0, s.startOffset) + s.replacement + c.baseline.slice(s.endOffset);
      assert.strictEqual(applied, c.current, `seed=${c.seed}`);
    }
  });

  it('identical text yields a zero-width no-op rather than a rewrite', () => {
    const s = minimalSplice('a\nb\n', 'a\nb\n');
    assert.strictEqual(s.startOffset, s.endOffset);
    assert.strictEqual(s.replacement, '');
  });

  it('touches only the changed region', () => {
    const s = minimalSplice('keep\nOLD\nkeep', 'keep\nNEW\nkeep');
    assert.strictEqual(s.replacement, 'NEW');
    assert.strictEqual('keep\nOLD\nkeep'.slice(s.startOffset, s.endOffset), 'OLD');
  });
});
