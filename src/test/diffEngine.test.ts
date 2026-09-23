import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks, hasReportableDiff, hunkAtLine, hunkId, lensLineForHunk, splitHunkByRange } from '../diffEngine';
import { cases } from './generators';

/** UTF-8 byte-order mark, spelled out — it is invisible in source otherwise. */
const BOM = '\uFEFF';

describe('hasReportableDiff', () => {
  /**
   * The invariant that matters: this predicate and computeHunks must never disagree.
   * When they did, an EOL-only write entered `reviewing` with zero hunks — invisible in
   * the panel, still counted by the status bar, and blocking `reviewComplete` forever.
   */
  const agrees = (baseline: string | null, current: string) =>
    assert.equal(
      hasReportableDiff(baseline, current),
      computeHunks(baseline, current).length > 0,
      `disagreed on ${JSON.stringify({ baseline, current })}`
    );

  it('reports no diff for an LF→CRLF conversion', () => {
    assert.equal(hasReportableDiff('a\nb\nc\n', 'a\r\nb\r\nc\r\n'), false);
    agrees('a\nb\nc\n', 'a\r\nb\r\nc\r\n');
  });

  it('reports no diff for a CRLF→LF conversion', () => {
    assert.equal(hasReportableDiff('a\r\nb\r\n', 'a\nb\n'), false);
    agrees('a\r\nb\r\n', 'a\nb\n');
  });

  it('reports identical content as unchanged', () => {
    assert.equal(hasReportableDiff('a\nb\n', 'a\nb\n'), false);
    agrees('a\nb\n', 'a\nb\n');
  });

  it('still reports a real edit made in the same write as an EOL conversion', () => {
    // The case the EOL-insensitivity exists to protect: one changed word must not be
    // swallowed just because the line endings flipped alongside it.
    assert.equal(hasReportableDiff('a\nb\nc\n', 'a\r\nB\r\nc\r\n'), true);
    agrees('a\nb\nc\n', 'a\r\nB\r\nc\r\n');
  });

  it('reports ordinary edits, additions and deletions', () => {
    agrees('a\nb\n', 'a\nb\nc\n');
    agrees('a\nb\nc\n', 'a\nc\n');
    agrees('a\n', 'z\n');
  });

  it('treats a null baseline (new file) as changed', () => {
    assert.equal(hasReportableDiff(null, 'anything\n'), true);
  });

  it('does not ignore whitespace changes other than line endings', () => {
    // Deliberately narrower than ignoreWhitespace — a reindent still costs what it costs.
    assert.equal(hasReportableDiff('a\n', '  a\n'), true);
    agrees('a\n', '  a\n');
  });

  it('reports no diff when only a leading BOM differs', () => {
    // The live shape: baseline from `git show` keeps the BOM, `doc.getText()` has none.
    assert.equal(hasReportableDiff(`${BOM}a\nb\n`, 'a\nb\n'), false);
    agrees(`${BOM}a\nb\n`, 'a\nb\n');
  });

  it('still reports an edit to the first line of a BOM file', () => {
    // The BOM must not mask a real change to the line it sits on.
    assert.equal(hasReportableDiff(`${BOM}a\nb\n`, 'z\nb\n'), true);
    agrees(`${BOM}a\nb\n`, 'z\nb\n');
  });

  it('does not strip a U+FEFF that is not the first character', () => {
    // Only position 0 is an encoding marker; elsewhere it is a zero-width no-break space,
    // i.e. real content, and removing it would hide a genuine edit.
    assert.equal(hasReportableDiff('a\nb\n', `a\n${BOM}b\n`), true);
    agrees('a\nb\n', `a\n${BOM}b\n`);
  });
});

describe('computeHunks', () => {
  it('returns empty for identical content', () => {
    assert.deepEqual(computeHunks('a\nb\n', 'a\nb\n'), []);
  });

  it('returns empty for both empty', () => {
    assert.deepEqual(computeHunks('', ''), []);
  });

  it('detects a single line addition', () => {
    const hunks = computeHunks('a\nb\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['c']);
    assert.deepEqual(hunks[0].removedContent, []);
  });

  it('detects a single line removal', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].removedContent, ['c']);
  });

  it('detects a line replacement', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].addedContent, ['X']);
    assert.deepEqual(hunks[0].removedContent, ['b']);
  });

  it('detects multiple separate hunks', () => {
    const baseline = 'a\nb\nc\nd\ne\n';
    const current  = 'A\nb\nc\nd\nE\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 2);
    assert.deepEqual(hunks[0].addedContent, ['A']);
    assert.deepEqual(hunks[1].addedContent, ['E']);
  });

  it('treats entire new content as one hunk when baseline is empty', () => {
    const hunks = computeHunks('', 'hello\nworld\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.equal(hunks[0].newLines, 2);
    assert.equal(hunks[0].newStart, 1);
  });

  it('treats entire deletion as one hunk when current is empty', () => {
    const hunks = computeHunks('hello\nworld\n', '');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 2);
  });

  // ── null baseline tests (file did not exist before) ──────────────────────
  it('null baseline with content treats as new file (same as empty baseline)', () => {
    const hunks = computeHunks(null, 'hello\nworld\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.equal(hunks[0].newLines, 2);
    assert.equal(hunks[0].newStart, 1);
  });

  it('null baseline with empty current returns no hunks', () => {
    const hunks = computeHunks(null, '');
    assert.equal(hunks.length, 0);
  });

  it('null baseline behaves identically to empty string baseline for diff', () => {
    const content = 'line1\nline2\nline3\n';
    const hunksNull = computeHunks(null, content);
    const hunksEmpty = computeHunks('', content);
    assert.deepEqual(hunksNull, hunksEmpty);
  });

  it('computes correct newStart line numbers', () => {
    const baseline = 'a\nb\nc\n';
    const current  = 'a\nb\nX\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks[0].newStart, 3);
    assert.equal(hunks[0].oldStart, 3);
  });

  it('a BOM on the baseline alone produces no hunk', () => {
    assert.deepEqual(computeHunks(`${BOM}a\nb\n`, 'a\nb\n'), []);
  });

  it('BOM stripping does not shift line numbers', () => {
    // The safety argument for normalizing here: `acceptHunk`/`discardHunk` splice the RAW
    // baseline and buffer by the line indices this returns, so a normalization that moved
    // them would corrupt the baseline. Removing a leading BOM cannot — same assertion as
    // the un-BOM'd case above, and it must match exactly.
    const hunks = computeHunks(`${BOM}a\nb\nc\n`, 'a\nb\nX\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 3);
    assert.equal(hunks[0].oldStart, 3);
    assert.deepEqual(hunks[0].removedContent, ['c']);
    assert.deepEqual(hunks[0].addedContent, ['X']);
  });

  it('an edit to the first line of a BOM file is reported on line 1', () => {
    const hunks = computeHunks(`${BOM}a\nb\n`, 'Z\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].oldStart, 1);
    assert.deepEqual(hunks[0].removedContent, ['a'], 'the BOM must not travel with the content');
    assert.deepEqual(hunks[0].addedContent, ['Z']);
  });

  it('adjacent changes are merged into one hunk', () => {
    const hunks = computeHunks('a\nb\n', 'X\nY\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 2);
    assert.equal(hunks[0].newLines, 2);
  });

  it('content without trailing newline', () => {
    const hunks = computeHunks('a\nb', 'a\nX');
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].removedContent, ['b']);
    assert.deepEqual(hunks[0].addedContent, ['X']);
  });

  it('insertion at the beginning', () => {
    const hunks = computeHunks('b\nc\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].oldStart, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['a']);
  });

  it('deletion at the beginning', () => {
    const hunks = computeHunks('a\nb\nc\n', 'b\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.deepEqual(hunks[0].removedContent, ['a']);
  });

  it('insertion at the end', () => {
    const hunks = computeHunks('a\nb\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.deepEqual(hunks[0].addedContent, ['c']);
  });

  it('deletion at the end', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nb\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunks[0].oldLines, 1);
    assert.deepEqual(hunks[0].removedContent, ['c']);
  });

  it('multiple non-adjacent hunks preserve correct line numbers', () => {
    // Change line 1 and line 5; lines 2-4 are context
    const baseline = '1\n2\n3\n4\n5\n';
    const current  = 'X\n2\n3\n4\nY\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].oldStart, 1);
    assert.equal(hunks[1].newStart, 5);
    assert.equal(hunks[1].oldStart, 5);
  });

  it('pure insertion (no removed lines) in the middle', () => {
    const hunks = computeHunks('a\nc\n', 'a\nb\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 0);
    assert.equal(hunks[0].newLines, 1);
    assert.deepEqual(hunks[0].addedContent, ['b']);
  });

  it('pure deletion (no added lines) in the middle', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nc\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 1);
    assert.equal(hunks[0].newLines, 0);
    assert.deepEqual(hunks[0].removedContent, ['b']);
  });

  it('large block replacement', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const current  = 'NEW\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].oldLines, 10);
    assert.equal(hunks[0].newLines, 1);
  });
  // ── line endings ──────────────────────────────────────────────────────────
  // Without `stripTrailingCr`, every one of these produced a single hunk spanning the
  // whole input, because the `\r` is part of the token jsdiff compares.

  it('ignores a pure LF -> CRLF conversion', () => {
    const baseline = 'a\nb\nc\n';
    const current  = 'a\r\nb\r\nc\r\n';
    assert.deepEqual(computeHunks(baseline, current), []);
  });

  it('ignores a pure CRLF -> LF conversion', () => {
    const baseline = 'a\r\nb\r\nc\r\n';
    const current  = 'a\nb\nc\n';
    assert.deepEqual(computeHunks(baseline, current), []);
  });

  it('surfaces only the real edit when it rides along with an EOL conversion', () => {
    // The case that actually costs the user something: an agent rewrites a file, changing
    // one word and normalizing line endings in the same write. The edit must not be buried.
    const baseline = 'alpha\nbeta\ngamma\ndelta\n';
    const current  = 'alpha\r\nbeta CHANGED\r\ngamma\r\ndelta\r\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 2);
    assert.equal(hunks[0].newLines, 1);
    assert.equal(hunks[0].oldLines, 1);
  });

  it('reports no carriage returns in hunk content for a CRLF file', () => {
    const baseline = 'a\r\nb\r\nc\r\n';
    const current  = 'a\r\nX\r\nc\r\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].addedContent, ['X']);
    assert.deepEqual(hunks[0].removedContent, ['b']);
  });

  it('ignores EOL differences confined to part of a file (mixed endings)', () => {
    const baseline = 'a\nb\nc\nd\n';
    const current  = 'a\nb\r\nc\r\nd\n';
    assert.deepEqual(computeHunks(baseline, current), []);
  });

  it('keeps acceptHunk line arithmetic valid across an EOL conversion', () => {
    // Guards the reason this option is safe: hunks are computed on EOL-normalized text but
    // `acceptHunk` splices the RAW baseline and document lines by index. Normalization
    // cannot change line counts, so the indices must still line up — replicated here
    // verbatim from commands.ts so a change to that arithmetic trips this test.
    const baseline = 'alpha\nbeta\ngamma\n';
    const current  = 'alpha\r\nbeta CHANGED\r\ngamma\r\n';
    const hunk = computeHunks(baseline, current)[0];

    const currentLines = current.split('\n');
    const baselineLines = baseline.split('\n');
    const newBaseline = [
      ...baselineLines.slice(0, hunk.oldStart - 1),
      ...currentLines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines),
      ...baselineLines.slice(hunk.oldStart - 1 + hunk.oldLines),
    ].join('\n');

    // The accepted line carries its CRLF over; the untouched lines keep the baseline's LF.
    assert.equal(newBaseline, 'alpha\nbeta CHANGED\r\ngamma\n');
    // Which is the point: the resulting baseline has mixed endings, and the next diff must
    // still see the file as fully resolved rather than re-reporting the line.
    assert.deepEqual(computeHunks(newBaseline, current), []);
  });
});  // end computeHunks

describe('hunkId', () => {
  it('produces stable id from hunk fields', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    const id = hunkId(hunks[0]);
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
    // Same hunk always produces the same id
    assert.equal(hunkId(hunks[0]), id);
  });

  it('different hunks have different ids', () => {
    const baseline = 'a\nb\nc\nd\ne\n';
    const current  = 'A\nb\nc\nd\nE\n';
    const hunks = computeHunks(baseline, current);
    assert.notEqual(hunkId(hunks[0]), hunkId(hunks[1]));
  });

  it('id starts with newStart:newLines:oldStart:oldLines', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    const h = hunks[0];
    assert.ok(hunkId(h).startsWith(`${h.newStart}:${h.newLines}:${h.oldStart}:${h.oldLines}:`));
  });

  // Defect: ids were positional only. An agent that rewrote the same line again after the
  // user saw it produced a hunk with identical coordinates, so a click on the old lens or
  // panel row accepted text the user never saw, or discarded the agent's newer version.
  it('a hunk at the same coordinates with different content gets a different id', () => {
    const seen = computeHunks('a\nb\nc\n', 'a\nX\nc\n')[0];
    const now = computeHunks('a\nb\nc\n', 'a\nY\nc\n')[0];
    assert.deepEqual(
      [seen.newStart, seen.newLines, seen.oldStart, seen.oldLines],
      [now.newStart, now.newLines, now.oldStart, now.oldLines],
      'precondition: the two hunks share coordinates');
    assert.notEqual(hunkId(seen), hunkId(now));
  });

  it('removed and added content are not interchangeable in the id', () => {
    // A naive concatenation would give 'ab' + '' and 'a' + 'b' the same hash input.
    const h = computeHunks('a\nb\nc\n', 'a\nX\nc\n')[0];
    const moved = { ...h, removedContent: [...h.removedContent, ...h.addedContent], addedContent: [] };
    assert.notEqual(hunkId(h), hunkId(moved));
  });
});

describe('hunkAtLine', () => {
  // Two hunks: replace line 1 (newStart 1, newLines 1) and line 5 (newStart 5, newLines 1);
  // lines 2-4 are context between them.
  const twoHunks = () => computeHunks('1\n2\n3\n4\n5\n', 'X\n2\n3\n4\nY\n');

  it('resolves the hunk a line falls inside', () => {
    const hunks = twoHunks();
    assert.equal(hunkAtLine(hunks, 1)?.newStart, 1);
    assert.equal(hunkAtLine(hunks, 5)?.newStart, 5);
  });

  it('falls forward to the first hunk at/after a context line', () => {
    const hunks = twoHunks();
    // lines 2-4 are between the hunks → resolve to the next one (newStart 5)
    assert.equal(hunkAtLine(hunks, 3)?.newStart, 5);
  });

  it('returns undefined past every hunk', () => {
    const hunks = twoHunks();
    // line 6 sits after the last hunk: no wrap to hunks[0], every caller treats it as a skip.
    // `hunkAtCursor` used to wrap on top of this and no longer does — see its doc comment.
    assert.equal(hunkAtLine(hunks, 6), undefined);
  });

  it('a pure-removal hunk (newLines 0) still occupies its anchor line', () => {
    // delete line 2 → newStart 2, newLines 0; Math.max(1, 0) keeps it selectable at line 2
    const hunks = computeHunks('a\nb\nc\n', 'a\nc\n');
    assert.equal(hunks[0].newLines, 0);
    assert.equal(hunkAtLine(hunks, 2)?.newStart, 2);
  });

  it('returns undefined for no hunks', () => {
    assert.equal(hunkAtLine([], 1), undefined);
  });
});

describe('splitHunkByRange', () => {
  // A pure insertion of 3 lines after 'a': added lines occupy 0-based doc lines 1,2,3.
  //   baseline: a\ne\n   current: a\nB\nC\nD\ne\n   → newStart=2, newLines=3
  const mixed = () => computeHunks('a\ne\n', 'a\nB\nC\nD\ne\n')[0];

  it('selection fully inside the added span selects that slice', () => {
    const h = mixed();
    // select doc lines 2..2 (0-based) → the middle added line 'C' (index 1)
    const split = splitHunkByRange(h, 2, 2);
    assert.equal(split.hasAddedInRange, true);
    assert.equal(split.addedStartIdx, 1);
    assert.equal(split.addedEndIdx, 2);
  });

  it('selection covering all added lines selects the whole slice', () => {
    const h = mixed();
    const split = splitHunkByRange(h, 1, 3);
    assert.deepEqual(
      [split.hasAddedInRange, split.addedStartIdx, split.addedEndIdx],
      [true, 0, 3]
    );
  });

  it('selection spanning a hunk boundary is clamped to the added span', () => {
    const h = mixed();
    // select from context line 0 through line 2 → clamps to added indices [0,2)
    const split = splitHunkByRange(h, 0, 2);
    assert.equal(split.hasAddedInRange, true);
    assert.equal(split.addedStartIdx, 0);
    assert.equal(split.addedEndIdx, 2);
  });

  it('selection past the end of the added span is clamped', () => {
    const h = mixed();
    // select from line 2 through line 9 (past EOF) → clamps to added indices [1,3)
    const split = splitHunkByRange(h, 2, 9);
    assert.equal(split.hasAddedInRange, true);
    assert.equal(split.addedStartIdx, 1);
    assert.equal(split.addedEndIdx, 3);
  });

  it('selection covering only context lines has no added lines in range', () => {
    const h = mixed();
    // doc line 0 is context ('a'), before the added span at 1..3
    const split = splitHunkByRange(h, 0, 0);
    assert.equal(split.hasAddedInRange, false);
  });

  it('pure-removal hunk (newLines === 0) has no added lines in range', () => {
    // baseline: a\nb\nc\n  current: a\nc\n  → removal of 'b', newLines=0, newStart=2
    const h = computeHunks('a\nb\nc\n', 'a\nc\n')[0];
    assert.equal(h.newLines, 0);
    const split = splitHunkByRange(h, 1, 1);
    assert.equal(split.hasAddedInRange, false);
  });
});

describe('lensLineForHunk', () => {
  /**
   * Where a hunk's Accept/Discard buttons are drawn decides which block the user believes
   * they act on. The defect this guards: lenses were anchored on the line AFTER their hunk,
   * and a CodeLens renders above its anchor, so each hunk's buttons sat directly above the
   * NEXT block. A user clicked Accept beside a 13-line deletion and a one-line neighbour
   * resolved instead.
   *
   * Both properties fail immediately against the old anchor.
   */
  const lineCountOf = (text: string) => text.split('\n').length; // VS Code's own line count

  it('property: every anchor lies inside its own hunk', () => {
    for (const c of cases(1500)) {
      const hunks = computeHunks(c.baseline, c.current);
      const lineCount = lineCountOf(c.current);
      for (const h of hunks) {
        const anchor = lensLineForHunk(h, lineCount);
        const owner = hunkAtLine(hunks, anchor + 1);
        assert.equal(owner && hunkId(owner), hunkId(h),
          `seed=${c.seed} hunk ${hunkId(h)} anchored at line ${anchor + 1}, which belongs to ${owner && hunkId(owner)}`);
      }
    }
  });

  it('property: no two hunks share an anchor line', () => {
    // Two hunks' buttons on one line are indistinguishable, whichever block they sit by.
    for (const c of cases(1500)) {
      const hunks = computeHunks(c.baseline, c.current);
      const lineCount = lineCountOf(c.current);
      const anchors = hunks.map(h => lensLineForHunk(h, lineCount));
      assert.equal(new Set(anchors).size, anchors.length, `seed=${c.seed} anchors ${anchors.join(',')}`);
    }
  });

  it('regression: a large deletion next to a one-line change gets its own buttons', () => {
    // The shape from the live report: a 13-line removal that occupies a single modified
    // line, immediately followed by an unrelated one-line edit.
    const removed = Array.from({ length: 13 }, (_, i) => `old ${i}`);
    const baseline = ['head', ...removed, 'mid', 'tail-old', 'end'].join('\n') + '\n';
    const current = ['head', 'replacement', 'mid', 'tail-new', 'end'].join('\n') + '\n';
    const hunks = computeHunks(baseline, current);
    assert.equal(hunks.length, 2, 'precondition: the big deletion and the small edit are separate hunks');
    const [big, small] = hunks;
    assert.equal(big.oldLines, 13);

    const lineCount = lineCountOf(current);
    assert.equal(hunkId(hunkAtLine(hunks, lensLineForHunk(big, lineCount) + 1)!), hunkId(big));
    assert.equal(hunkId(hunkAtLine(hunks, lensLineForHunk(small, lineCount) + 1)!), hunkId(small));
  });

  it('clamps into the document for a hunk anchored past the last line', () => {
    assert.equal(lensLineForHunk({ oldStart: 3, oldLines: 1, newStart: 9, newLines: 0, removedContent: [], addedContent: [] }, 4), 3);
  });
});
