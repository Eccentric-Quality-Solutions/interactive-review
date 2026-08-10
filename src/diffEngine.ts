import * as Diff from 'diff';

/**
 * `stripTrailingCr` is implemented by the pinned runtime (`diff@5.2.2`, see
 * `lib/diff/line.js`) but missing from `@types/diff@5.2.3`'s `LinesOptions`. Augmenting is
 * preferred over casting the options object: a cast would silence a genuine typo just as
 * happily, whereas this keeps the call site type-checked and documents exactly which
 * upstream gap is being papered over. Delete this block when the typings gain the field.
 */
declare module 'diff' {
  interface LinesOptions {
    stripTrailingCr?: boolean | undefined;
  }
}

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removedContent: string[];  // lines from baseline that were removed
  addedContent: string[];    // lines in current content that were added
}

// Stable id derived from hunk position — same hunk always gets the same id
// within a single review session (no random component needed).
export function hunkId(hunk: ParsedHunk): string {
  return `${hunk.newStart}:${hunk.newLines}:${hunk.oldStart}:${hunk.oldLines}`;
}

/**
 * Resolve the pending hunk a 1-based document line falls into, else the first hunk starting
 * at/after that line, else undefined (the line sits past every hunk). `newLines` is floored
 * to 1 so a pure-removal hunk (newLines === 0) still occupies its anchor line.
 *
 * The single source of truth for "which hunk does this line resolve to", shared by the
 * cursor-driven (`hunkAtCursor`) and selection-driven (`acceptSelection`/`rejectSelection`)
 * commands. Callers that must always land on a hunk fall back to `hunks[0]` themselves —
 * that fallback is intentionally *not* baked in here, since selection commands treat
 * "past every hunk" as a skip rather than wrapping to the first hunk.
 */
export function hunkAtLine(hunks: ParsedHunk[], line1Based: number): ParsedHunk | undefined {
  return hunks.find(h => line1Based >= h.newStart && line1Based < h.newStart + Math.max(1, h.newLines))
    ?? hunks.find(h => h.newStart >= line1Based);
}

export interface HunkRangeSplit {
  hasAddedInRange: boolean;
  addedStartIdx: number; // inclusive index into hunk.addedContent
  addedEndIdx: number;   // exclusive
}

/**
 * Intersect a 0-based document line selection with a hunk's added-line span.
 *
 * A hunk's added lines occupy document lines
 * `[newStart-1 .. newStart-1+newLines-1]` (0-based). This returns the contiguous
 * slice of `addedContent` indices the selection covers — the lines a partial
 * reject would delete. `hasAddedInRange` is false for a pure-removal hunk
 * (`newLines === 0`) or a selection that touches no added lines (e.g. context
 * only), so callers can fall back to a whole-hunk action or no-op.
 *
 * Pure and VS-Code-free so it can be unit-tested in isolation.
 */
export function splitHunkByRange(
  hunk: ParsedHunk,
  selStartLine: number,
  selEndLine: number
): HunkRangeSplit {
  const empty: HunkRangeSplit = { hasAddedInRange: false, addedStartIdx: 0, addedEndIdx: 0 };
  if (hunk.newLines === 0) return empty;

  const addedFirst = hunk.newStart - 1;             // 0-based doc line of first added line
  const addedLast = addedFirst + hunk.newLines - 1; // 0-based doc line of last added line

  const lo = Math.max(selStartLine, addedFirst);
  const hi = Math.min(selEndLine, addedLast);
  if (lo > hi) return empty;

  return {
    hasAddedInRange: true,
    addedStartIdx: lo - addedFirst,
    addedEndIdx: hi - addedFirst + 1,
  };
}

/**
 * `stripTrailingCr` makes the comparison EOL-insensitive, and it is load-bearing rather
 * than cosmetic. jsdiff splits on `\n` and compares whole tokens with `===`, so the `\r`
 * of a CRLF file is part of every token: converting a file's line endings leaves no token
 * in the old sequence equal to any token in the new one, Myers finds a zero-length common
 * subsequence, and the loop below folds the resulting delete-all/insert-all into a SINGLE
 * hunk spanning the entire file. Measured on this repo: 696 of 697 lines of fileWatcher.ts
 * in one hunk, for a change no human would call a change — and it buries any real edit made
 * in the same write, which is the case that actually costs the user something.
 *
 * VSCode's diff editor cannot show an EOL difference at all: its text model stores lines
 * plus one EOL setting, so mixed endings are not representable. Without this option the
 * extension reports a whole-file hunk against a diff editor painting nothing.
 *
 * Safe for every consumer. Normalization cannot change line counts, so `newStart`/`newLines`
 * and the line-indexed splices in `acceptHunk`/`discardHunk` are unaffected — those build
 * their arrays from the raw baseline and document text and never read `addedContent`.
 * The only visible effect is that `addedContent`/`removedContent` come back without `\r`;
 * nothing in production reads them.
 *
 * Deliberately NOT paired with `ignoreWhitespace`. A whitespace-only change is sometimes
 * exactly what a reviewer needs to see, so reindents and trailing-whitespace strips keep
 * costing what they cost.
 */
export function computeHunks(baseline: string | null, current: string): ParsedHunk[] {
  const changes = Diff.diffLines(baseline ?? '', current, { stripTrailingCr: true });

  const hunks: ParsedHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];

    if (!change.added && !change.removed) {
      // Context lines — advance line counters using count field
      const lineCount = change.count ?? 0;
      oldLine += lineCount;
      newLine += lineCount;
      i++;
      continue;
    }

    // Start of a changed region — collect consecutive added/removed blocks
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const removed: string[] = [];
    const added: string[] = [];

    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const c = changes[i];
      // Split into lines; the value ends with \n for most lines
      const lines = c.value.endsWith('\n')
        ? c.value.slice(0, -1).split('\n')
        : c.value.split('\n');

      if (c.removed) {
        removed.push(...lines);
        oldLine += lines.length;
      } else if (c.added) {
        added.push(...lines);
        newLine += lines.length;
      }
      i++;
    }

    if (removed.length > 0 || added.length > 0) {
      hunks.push({
        oldStart: hunkOldStart,
        oldLines: removed.length,
        newStart: hunkNewStart,
        newLines: added.length,
        removedContent: removed,
        addedContent: added,
      });
    }
  }

  return hunks;
}

