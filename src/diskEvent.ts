/**
 * What a create or change event does to a file that is not already under review: the
 * decision half of `FileWatcher.handleDiskCreate` and `handleDiskChange`, with the reads
 * done by the caller.
 *
 * Pure so that the answer to "is this file new" lives in one place. The two handlers used
 * to answer it separately, and `reloadEqualsMemory.test.ts` had to keep a hand copy of each
 * answer. It now calls this function, so the property tests the real decision.
 *
 * The third answer is a rescan's (`StateManager.adoptedNullReason`). It is not here because
 * its evidence is different: a rescan sees only the end state plus the session's own record,
 * never an event.
 */

export interface DiskEventFacts {
  kind: 'create' | 'change';
  /** The baseline repo's copy. `undefined` means none, or not read (see `manualSave`). */
  baseline: string | undefined;
  /** VS Code itself just saved exactly the bytes on disk. A change skips the baseline read then. */
  manualSave: boolean;
  /** The event arrived while the Begin review snapshot was running. */
  duringSnapshot: boolean;
  /** An ignore-rule sync is baselining files. Changes only; a create never consults it. */
  ignoreSyncActive: boolean;
  binary: boolean;
}

export type DiskEventDecision =
  /** Record the disk content as the baseline, with nothing to review. */
  | { action: 'adopt'; why: string }
  /** Queue the file. `nullReason` is set exactly when `baseline` is null. */
  | { action: 'review'; baseline: string | null; nullReason?: 'created' | 'unbaselined' }
  | { action: 'skip'; why: string };

export function classifyDiskEvent(f: DiskEventFacts): DiskEventDecision {
  // A change that VS Code saved is the user's own typing, whatever git holds. A create
  // checks git first: a baseline there means the file was not new after all.
  if (f.kind === 'change' && f.manualSave) return adoptUnlessBinary(f, 'matched VSCode save');
  if (f.baseline !== undefined) return { action: 'review', baseline: f.baseline };

  if (f.kind === 'create') {
    if (f.manualSave) return adoptUnlessBinary(f, 'matched VSCode save');
    // On disk when Begin review was pressed and not walked yet. See `handleDiskCreate`.
    if (f.duringSnapshot) return adoptUnlessBinary(f, 'create during enable snapshot');
    // Only a witnessed create may say 'created', which is what lets Discard delete the file.
    return { action: 'review', baseline: null, nullReason: 'created' };
  }

  // A change with no baseline: not new, just not baselined yet — or a missed create, or a
  // file unreadable at Begin review. ADR-0012 reviews the last two rather than absorbing them.
  if (f.duringSnapshot || f.ignoreSyncActive) {
    return adoptUnlessBinary(f, f.duringSnapshot ? 'no baseline during enable snapshot' : 'no baseline during ignore sync');
  }
  if (f.binary) return { action: 'skip', why: 'no baseline, binary — nothing legible to review' };
  // A change is no evidence the file is new, so it must not become deletable.
  return { action: 'review', baseline: null, nullReason: 'unbaselined' };
}

/** A binary is never baselined: its text decoding is not its bytes. */
function adoptUnlessBinary(f: DiskEventFacts, why: string): DiskEventDecision {
  return f.binary ? { action: 'skip', why: `${why}, but binary — not baselining` } : { action: 'adopt', why };
}
