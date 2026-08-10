import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks, hunkAtLine, hunkId, splitHunkByRange } from '../diffEngine';

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

  it('id format is newStart:newLines:oldStart:oldLines', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nX\nc\n');
    const h = hunks[0];
    assert.equal(hunkId(h), `${h.newStart}:${h.newLines}:${h.oldStart}:${h.oldLines}`);
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

  it('returns undefined past every hunk — the asymmetry vs hunkAtCursor', () => {
    const hunks = twoHunks();
    // line 6 sits after the last hunk: no wrap to hunks[0], selection callers treat as skip
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
