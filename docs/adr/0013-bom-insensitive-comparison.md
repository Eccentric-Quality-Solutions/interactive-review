# ADR-0013 — Compare BOM-insensitively; store the BOM untouched

**Date:** 2026-08-17 · **Status:** Accepted · **Amends** [ADR-0006](0006-save-token-provenance.md)

## Context

Every comparison in the extension has a baseline on one side and current text on the other,
and the two sources disagree about the byte-order mark:

- Baselines come from `git show :path` (raw blob bytes) or `fs.readFile(…, 'utf-8')`. Both
  **keep** a leading U+FEFF.
- Current text usually comes from `doc.getText()`. VS Code strips the BOM on open, remembers
  it, and rewrites it on save, so the buffer **never** has one.

Nothing normalized this, which produced two symptoms with one cause. A BOM'd file showed a
phantom hunk on line 1 that could not be resolved — accepting it wrote a BOM-less first line
into the baseline while the file on disk kept its BOM, so the difference came straight back.
And every hand-save of such a file fell through to review, because `consumeManualSave`
compares the saved buffer text against the bytes just written to disk. The second symptom
contradicts the product property [ADR-0006](0006-save-token-provenance.md) exists to
deliver: your own typing must not enter the queue.

This is the same shape as [ADR-0009](0009-eol-insensitive-diffing.md). There, two sources
disagreed about `\r`; here they disagree about U+FEFF. In both cases the differ was working
correctly on inputs that were never made comparable.

## Decision

Normalize the BOM **at comparison, never at storage**, via `stripBom` in `textFile.ts`:

- `computeHunks` strips a leading BOM from both sides before `diffLines`, alongside
  `stripTrailingCr`.
- `hasReportableDiff` strips it too. The two must agree exactly — a gate stricter than the
  differ is the "reviewing with zero hunks, forever" failure ADR-0009 documents.
- `consumeManualSave` compares BOM-insensitively, and *only* BOM-insensitively.

Only position 0 is examined. A U+FEFF elsewhere is a zero-width no-break space — real
content, and not ours to remove.

**Storage keeps the BOM — by re-attaching it, not by never removing it.** The splices do
*not* run on raw text: `acceptHunk`/`acceptSelection` strip the baseline before splitting it
into lines, because the replacement lines come from the buffer and must line up with a
buffer-indexed hunk. `withBomFrom` then puts the marker back on the baseline that gets
stored, and `finishBaselineAdvance` does the same when the last hunk resolves and the buffer
itself becomes the new baseline. So the marker survives into the stored baseline and into the
file `discardFileByPath` writes back from it — but through an explicit re-attach at each
storage point, which is a thing that can be forgotten, rather than through the text never
having been touched. Normalizing on the way in and never restoring would have made every
restore of a BOM'd file silently drop its marker.

A **null** baseline has no marker to carry, so the accept commands seed it from disk with
`bomFromFile` — a new BOM'd file would otherwise be stored BOM-less, since neither the
absent baseline nor the buffer can say what the file holds.

## Consequences

- Safe for the line-indexed splices for the same reason `stripTrailingCr` is: removing a
  leading BOM cannot change a line count, so `newStart`/`newLines` are unaffected. Pinned by
  a test asserting a BOM'd baseline yields byte-identical hunk offsets to the un-BOM'd case.
- **This narrows ADR-0006's "exact content matching" consequence**, which argued that exact
  equality fails safe toward reviewing. It still does: equality must hold across the whole
  file, and the two sides now merely agree about content rather than about an encoding marker
  neither of them chose. Nothing else is normalized in that comparison — matching on EOL or
  whitespace there would let a real external edit pass as a save.
- Both halves are pinned by tests that were confirmed to fail with the fix reverted in place.

## Not done

- **Non-UTF-8 encodings remain unsupported**, not merely unhandled. UTF-16 and legacy code
  pages are read as UTF-8 and diff as nonsense. Declared in the README rather than detected:
  encoding detection is a rabbit hole, and VS Code exposes no reusable `files.encoding`
  machinery to extensions.

## References

`src/textFile.ts` (`stripBom`) · `src/diffEngine.ts` · `src/fileWatcher.ts`
(`consumeManualSave`) · `src/test/diffEngine.test.ts` · `src/test/textFile.test.ts` ·
`src/test/integration/saveVsExternalEdit.test.ts`.
