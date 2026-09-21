import { ParsedHunk } from './diffEngine';

/**
 * The line arithmetic behind accept and discard, as pure functions over strings.
 *
 * This module exists because of a bug it now makes untestable-by-accident impossible.
 * `discardHunk` used to build a VS Code `Range` by hand and append `'\n'` to the
 * replacement text unconditionally. On a file with no trailing newline that re-added a
 * newline the file never had, so the discard *left a hunk behind* — and discarding again
 * reproduced it, permanently. Three shapes were reproduced (a modified last line, an
 * appended line, a removed last line); see `docs/code-review-2026-09-20.md` §1.1.
 *
 * The fix is not better range arithmetic, it is not doing range arithmetic at all. Each
 * function below answers "what should the whole text be afterwards?" by splicing arrays,
 * which round-trips losslessly, and `minimalSplice` then derives the edit. Callers convert
 * its offsets with `doc.positionAt`, so no code anywhere has to reason about where a
 * newline belongs relative to a range boundary.
 *
 * Everything here is VS Code-free on purpose: it is the surface the property test in
 * `test/hunkApply.test.ts` drives, and that test asserts the invariant the essays used to
 * argue — that resolving every hunk converges to zero hunks, for every generated input.
 *
 * **BOM is the caller's job.** These functions take text that has already been through
 * `stripBom` and return text in the same form; `commands.ts` re-attaches the marker with
 * `withBomFrom` before storing a baseline. Doing it here would re-open ADR-0013 from the
 * other side, since text destined for a *document* must not carry one.
 */

/** A single contiguous replacement, in absolute character offsets into the original text. */
export interface TextSplice {
  startOffset: number;
  /** Exclusive. Equal to `startOffset` for a pure insertion. */
  endOffset: number;
  replacement: string;
}

/**
 * The smallest single-range edit turning `from` into `to`, found by trimming the common
 * prefix and suffix.
 *
 * Minimal rather than whole-document for two reasons that both matter to the user: a
 * whole-document replace collapses to one enormous undo entry that swallows unrelated
 * edits, and it invalidates every decoration and fold in the file. Identical inputs yield
 * a zero-width no-op edit rather than a rewrite.
 */
export function minimalSplice(from: string, to: string): TextSplice {
  const maxStart = Math.min(from.length, to.length);
  let start = 0;
  while (start < maxStart && from.charCodeAt(start) === to.charCodeAt(start)) start++;

  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--;
    endTo--;
  }

  return { startOffset: start, endOffset: endFrom, replacement: to.slice(start, endTo) };
}

/**
 * Text split into lines *the way jsdiff counts them*, which is not the way `split('\n')`
 * does, and the difference is a bug the property test caught on its fifth input.
 *
 * `'a\nb\n'.split('\n')` is `['a', 'b', '']` — three elements for two lines — because a
 * terminating newline leaves an empty element behind. jsdiff tokenizes the same text as
 * two lines, and every index on a `ParsedHunk` is in *that* model. Splicing the
 * three-element array at hunk coordinates therefore leaves the phantom `''` stranded past
 * the end of the splice, which silently re-terminates a file that had no final newline.
 *
 * The failing pair was baseline `'delta\nbeta\n'` against document `'beta'`: the whole
 * file is one hunk, and both accept and discard produced text that still differed from
 * their target, so the next pass produced the same text again and the file could never
 * leave review. Note that this is a *second*, independent instance of the defect in
 * §1.1 of the review — the shipped `acceptHunk` carried it too, on the baseline side.
 *
 * So the terminator is tracked as a flag instead of as an array element. Round-tripping
 * `toLines`/`fromLines` is exact for every input including `''`.
 */
interface Lines {
  lines: string[];
  /** Did the text end with a newline? `false` for `''`, which has no lines at all. */
  terminated: boolean;
}

function toLines(text: string): Lines {
  if (text === '') return { lines: [], terminated: false };
  const terminated = text.endsWith('\n');
  return { lines: (terminated ? text.slice(0, -1) : text).split('\n'), terminated };
}

function fromLines(lines: readonly string[], terminated: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (terminated ? '\n' : '');
}

/**
 * Replace `lines[start .. start+count)` with `replacement`.
 *
 * `tailTerminator` decides the result's final newline for the case where the splice
 * consumes everything from `start` to the end: the text after the splice now ends with
 * content that came from the *other* side, so it is that side's terminator that survives.
 * Anything short of the end keeps its own tail, and therefore its own terminator.
 */
function spliceLines(
  target: Lines,
  start: number,
  count: number,
  replacement: readonly string[],
  tailTerminator: boolean,
): string {
  const out = target.lines.slice();
  out.splice(start, count, ...replacement);
  const consumedTail = start + count >= target.lines.length;
  return fromLines(out, consumedTail ? tailTerminator : target.terminated);
}

/**
 * The document text after reverting `hunk` — its added lines replaced by the baseline
 * lines it displaced.
 *
 * `baselineText` and `currentText` must both be BOM-stripped, and `hunk` must have come
 * from `computeHunks` over that same pair, since every index below is relative to it.
 */
export function discardHunkText(baselineText: string, currentText: string, hunk: ParsedHunk): string {
  const baseline = toLines(baselineText);
  const current = toLines(currentText);
  const originalLines = baseline.lines.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldLines);
  return spliceLines(current, hunk.newStart - 1, hunk.newLines, originalLines, baseline.terminated);
}

/**
 * The document text after deleting document lines `[delStartLine .. delEndLine]` (0-based,
 * inclusive) from within `hunk` — the partial-reject case, where reverting an added line
 * means removing it because the baseline never had it.
 *
 * Needs the baseline for one decision only: the final newline when the deletion runs
 * through the end of the document. The document then ends at line `delStartLine - 1`, and
 * what that line should end with depends on what it is:
 *
 * - **Unchanged context** (the selection starts at the hunk's first added line). The line
 *   exists on both sides, so it must end the way it does in the baseline: with a newline if
 *   the hunk's removed lines follow it there, otherwise with the baseline's own ending.
 * - **An earlier added line** of the same hunk. It has no baseline counterpart, so keep the
 *   document's own final newline — exactly what a plain editor delete would do.
 *
 * This used to keep the document's final newline in both cases, which is wrong for the
 * first. Found by the partial-selection property: baseline `'delta\n\n'`, document
 * `'delta\ncafé'`, reject `café` — keeping the document's missing final newline produced
 * `'delta'`, which jsdiff reads as a different token from the baseline's `'delta\n'`, so
 * rejecting one added line *created* a removal. That defect predated `hunkApply`; the old
 * range arithmetic in `rejectSelection` behaved identically.
 *
 * Measured across 14,755 generated selections: the old rule broke the invariant in 2,132,
 * this rule in none. It is not globally optimal — in 13 of those cases the other final
 * newline would have left one fewer pending line — but it never grows the change and never
 * creates a removal, which is the bar the property test enforces.
 */
export function rejectLinesText(
  baselineText: string,
  currentText: string,
  hunk: ParsedHunk,
  delStartLine: number,
  delEndLine: number,
): string {
  const baseline = toLines(baselineText);
  const current = toLines(currentText);
  const newTailIsContext = delStartLine === hunk.newStart - 1;
  const tailTerminator = newTailIsContext
    ? hunk.oldLines > 0 || baseline.terminated
    : current.terminated;
  return spliceLines(current, delStartLine, delEndLine - delStartLine + 1, [], tailTerminator);
}

/**
 * The baseline after accepting `hunk` — its added lines folded in, its removed lines
 * dropped, so the pair no longer reports it as a change.
 *
 * Note this never touches the document: the accepted content is already on disk, and only
 * the baseline moves forward.
 */
export function acceptHunkBaseline(baselineText: string, currentText: string, hunk: ParsedHunk): string {
  const baseline = toLines(baselineText);
  const current = toLines(currentText);
  const acceptedLines = current.lines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines);
  return spliceLines(baseline, hunk.oldStart - 1, hunk.oldLines, acceptedLines, current.terminated);
}

/**
 * The baseline after accepting only document lines `[acceptStartLine .. acceptEndLine]`
 * (0-based, inclusive) from within `hunk` — the partial-accept case.
 *
 * The selected lines are inserted at the hunk's anchor, just past its removed block, so a
 * re-diff realigns them as context while the still-present removed lines and any
 * unselected added lines stay pending.
 */
export function acceptLinesBaseline(
  baselineText: string,
  currentText: string,
  hunk: ParsedHunk,
  acceptStartLine: number,
  acceptEndLine: number,
): string {
  const baseline = toLines(baselineText);
  const current = toLines(currentText);
  const acceptedLines = current.lines.slice(acceptStartLine, acceptEndLine + 1);
  const insertAt = hunk.oldStart - 1 + hunk.oldLines;
  // When the accepted lines land at the end of the baseline they decide its final newline,
  // and it must be the one they actually have in the document. jsdiff treats a line's
  // terminator as part of the line, so an accepted line that ends up terminated differently
  // on the two sides is not "the same line" to the re-diff and stays pending — or worse,
  // turns its neighbours into changes too.
  //
  // In the document, the accepted block is newline-terminated unless it includes the
  // document's last line and the document has no final newline. This used to pass the
  // document's terminator unconditionally, which is wrong whenever the accepted lines are
  // *not* the document's last lines: accepting a middle line of a replace hunk at EOF made
  // the pending change larger. That specific failure was introduced by the move into this
  // module; the previous `split('\n')` code handled it by accident while failing the
  // opposite case. Across 14,755 generated selections: old code 3,288 violations, the first
  // version of this function 276, this rule 0.
  const acceptedTerminator = acceptEndLine < current.lines.length - 1 || current.terminated;
  return spliceLines(baseline, insertAt, 0, acceptedLines, acceptedTerminator);
}
