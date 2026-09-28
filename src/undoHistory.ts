import * as fs from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileState } from './types';
import { log } from './log';
import { findFileDocument } from './editorUtils';
import { computeHunks } from './diffEngine';
import { readTextFileSync } from './textFile';

/**
 * The session's accept/discard history, for the panel's Undo button.
 *
 * Every accept and discard, at hunk, selection, file or queue level, records the review
 * entry and the content on disk of each file it touches, before and after. Undo walks the
 * stack back, newest first, putting both back. Guarded by `undoHistory.test.ts`.
 *
 * Content is held as a hash, plus the bytes from before the action only when the action
 * changed them: that is the one case undo writes them back. An accept, which never changes
 * a file, costs a hash per file.
 *
 * A file whose bytes are no longer what the action left (edited since, or with unsaved
 * changes in an editor) keeps its current content: undo never overwrites work done after
 * the action. Nor does it write back a file that had unsaved changes when the action ran:
 * a discard saves the buffer, so those changes reached disk only as the action's "after",
 * and the "before" on disk never held them. Either way the review entry is still restored,
 * so the change shows in the queue against the original baseline.
 *
 * In memory only, and scoped to one session and one queue: a reload, End review, Begin
 * review or a queue clear (`StateManager.clearCount`) empties it, releases its file bytes,
 * and stops an undo in flight.
 */

/** Bytes on disk: null when the file is absent, undefined when it could not be read. */
type Disk = Buffer | null | undefined;

/** Content on disk by hash: null when the file is absent, undefined when it could not be read. */
type Print = string | null | undefined;

interface FileSnapshot {
  filePath: string;
  before: FileState;
  /** An editor held unsaved changes to the file when the action ran. */
  unsavedBefore: boolean;
  printBefore: Print;
  printAfter: Print;
  /** The bytes from before the action, kept only when the action changed them. */
  bytesBefore?: Buffer;
}

export interface UndoEntry {
  /** What the user did, for the Undo dialog, e.g. "Discard hunk in foo.ts". */
  label: string;
  /** Set on Accept All and Discard All, which the dialog offers to undo back through. */
  bulk?: 'Accept All' | 'Discard All';
  files: FileSnapshot[];
}

/** Which session and queue an entry belongs to; see `scopeOf`. */
type Scope = string;

/** Changes on End review, Begin review and a queue clear. */
function scopeOf(sm: StateManager): Scope | undefined {
  return sm.enabled ? `${sm.session}/${sm.clearCount}` : undefined;
}

/** An action in flight: taken by `capture`, closed by `commit`. */
interface Pending {
  scope: Scope | undefined;
  label: string;
  bulk?: UndoEntry['bulk'];
  files: {
    filePath: string; before: FileState; unsavedBefore: boolean; diskBefore: Disk;
    /** Stamped by `files.done` when the file's part of a bulk action finished; see `recordUndo`. */
    after?: { print: Print };
  }[];
}

/**
 * The editor-side effects undo needs. `registerCommands` installs the real ones
 * (`undoHistory.io`); tests install their own.
 */
export interface UndoIO {
  /** Delete a file recoverably. False when it could not be, and the file is still there. */
  deleteFile(filePath: string): Promise<boolean>;
  /**
   * Put exactly `bytes` back on disk, and have an open editor show them at once, so the
   * buffer the hunk commands read is current when undo returns.
   */
  writeFile(filePath: string, bytes: Buffer): Promise<void>;
  /** An open editor holds edits to this file that are not on disk. */
  hasUnsavedEdits(filePath: string): boolean;
  markSelfEdit(filePath: string): void;
  clearSelfEdit(filePath: string): void;
}

/** Until `registerCommands` installs the editor-aware set: disk only, no deletes. */
const defaultIO: UndoIO = {
  deleteFile: async filePath => {
    log(`undo(${path.basename(filePath)}): no delete installed, leaving it on disk`);
    return false;
  },
  writeFile: async (filePath, bytes) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
  },
  hasUnsavedEdits: filePath => !!findFileDocument(filePath)?.isDirty,
  markSelfEdit: () => {},
  clearSelfEdit: () => {},
};

export interface UndoResult {
  undone: number;
  /** Files that could not safely be written back (see above), left as they are on disk. */
  keptOnDisk: string[];
  /** Files undo should have deleted but could not move to the trash, so still on disk. */
  notDeleted: string[];
  /** Files back in review in memory whose baseline could not be written to the repo. */
  baselineFailed: string[];
  /** The review ended or its queue was cleared partway; the rest was dropped, not undone. */
  interrupted: boolean;
}

/** Oldest entries fall off past this, bounding the file bytes held in memory. */
export const UNDO_LIMIT = 200;

function readDisk(filePath: string): Disk {
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

function printOf(d: Disk): Print {
  return d === null || d === undefined ? d : createHash('sha256').update(d).digest('hex');
}

/** Unreadable content matches nothing, not even itself. */
function samePrint(a: Print, b: Print): boolean {
  return a !== undefined && b !== undefined && a === b;
}

function sameState(a: FileState | undefined, b: FileState): boolean {
  return !!a && a.status === b.status && a.baseline === b.baseline && a.nullReason === b.nullReason;
}

export class UndoHistory {
  private entries: UndoEntry[] = [];
  private scope: Scope | undefined;
  private _dropped = false;
  /** Read when recording (unsaved changes) and when undoing (everything). */
  io: UndoIO = defaultIO;

  /**
   * Older entries of this session fell off past `UNDO_LIMIT`, so the list is not everything
   * done this session. Guarded by `undoHistory.test.ts` ("once older ones were dropped").
   */
  get dropped(): boolean { return this._dropped; }

  /** Entries held in memory, including a finished session's not yet released. For tests. */
  get retained(): number { return this.entries.length; }

  /**
   * The stack, oldest first. Empty outside the session it was recorded in, and releases a
   * finished session's entries: the panel reads this on every refresh, including the one
   * End review triggers.
   */
  list(sm: StateManager): readonly UndoEntry[] {
    if (scopeOf(sm) === undefined || scopeOf(sm) !== this.scope) {
      this.entries = [];
      return this.entries;
    }
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this._dropped = false;
  }

  /**
   * Snapshot `paths` before an action. Paths with no review entry are not recorded, and
   * nothing is outside a session. A bulk action's label gets the file count appended.
   */
  capture(sm: StateManager, label: string, paths: Iterable<string>, bulk?: UndoEntry['bulk']): Pending {
    const files: Pending['files'] = [];
    if (sm.enabled) {
      for (const filePath of paths) {
        const f = this.snapshot(sm, filePath);
        if (f) files.push(f);
      }
    }
    if (bulk) label = `${label} (${files.length} file${files.length === 1 ? '' : 's'})`;
    return { scope: scopeOf(sm), label, bulk, files };
  }

  /**
   * Take `filePath`'s "before" again as a bulk action reaches it, so it is what that file's
   * part overwrote; see `recordUndo`. A file whose entry went since is dropped.
   */
  retake(sm: StateManager, pending: Pending, filePath: string): void {
    const i = pending.files.findIndex(f => f.filePath === filePath);
    if (i < 0) return;
    const f = this.snapshot(sm, filePath);
    if (f) pending.files[i] = f;
    else pending.files.splice(i, 1);
  }

  private snapshot(sm: StateManager, filePath: string): Pending['files'][number] | undefined {
    const before = sm.getFile(filePath);
    if (!before) return undefined;
    return {
      filePath,
      before: { ...before },
      unsavedBefore: this.io.hasUnsavedEdits(filePath),
      diskBefore: readDisk(filePath),
    };
  }

  /**
   * Close an action. Recorded only if it changed a review entry or a file; content
   * unreadable before and after counts as unchanged. Guarded by `undoHistory.test.ts`
   * ("cannot read").
   */
  commit(sm: StateManager, pending: Pending): void {
    if (pending.scope === undefined || scopeOf(sm) !== pending.scope) return;
    const files: FileSnapshot[] = pending.files.map(f => {
      const printBefore = printOf(f.diskBefore);
      const printAfter = f.after ? f.after.print : printOf(readDisk(f.filePath));
      const changed = !samePrint(printAfter, printBefore);
      return {
        filePath: f.filePath, before: f.before, unsavedBefore: f.unsavedBefore, printBefore, printAfter,
        ...(changed && f.diskBefore instanceof Buffer ? { bytesBefore: f.diskBefore } : {}),
      };
    });
    if (files.every(f => sameState(sm.getFile(f.filePath), f.before) && f.printAfter === f.printBefore)) return;
    if (this.scope !== pending.scope) {
      this.entries = [];
      this._dropped = false;
      this.scope = pending.scope;
    }
    this.entries.push({ label: pending.label, bulk: pending.bulk, files });
    if (this.entries.length > UNDO_LIMIT) {
      this.entries.shift();
      this._dropped = true;
    }
  }

  /**
   * Undo the newest `count` entries, newest first. `top` is the entry the caller saw as
   * newest; if another action has landed since, nothing is undone and this returns
   * undefined, rather than undo work the user was not told about.
   *
   * Each entry leaves the stack only once it is fully undone. If a write throws, the undo
   * stops there and rethrows, and that entry and every older one stay, so Undo can retry:
   * the files already put back now match their "before" and are skipped. Guarded by
   * `undoHistory.test.ts` ("stops at a failed write").
   */
  async undo(sm: StateManager, count: number, top: UndoEntry): Promise<UndoResult | undefined> {
    const entries = this.list(sm);
    if (entries[entries.length - 1] !== top || count < 1 || count > entries.length) return undefined;
    const targets = entries.slice(entries.length - count).reverse();
    const kept = new Set<string>();
    const notDeleted = new Set<string>();
    const baselineFailed = new Set<string>();
    const scope = this.scope;
    let undone = 0;
    let interrupted = false;
    try {
      entries: for (const entry of targets) {
        log(`undo: ${entry.label}`);
        // Each await can let End review, Begin review or a queue clear in; writing on would
        // put this queue's files and entries into the next one.
        const ended = () => {
          if (scopeOf(sm) === scope) return false;
          log('undo: the review ended or was cleared, stopping');
          interrupted = true;
          return true;
        };
        for (const f of [...entry.files].reverse()) {
          if (ended()) break entries;
          await restoreDisk(f, this.io, kept, notDeleted);
          if (ended()) break entries;
          sm.restoreFile(f.filePath, f.before, err => {
            log(`undo(${path.basename(f.filePath)}): baseline write failed (${err})`);
            baselineFailed.add(f.filePath);
          });
          if (resolvedOnDisk(f)) sm.exitReviewing(f.filePath);
        }
        const i = this.entries.indexOf(entry);
        if (i >= 0) this.entries.splice(i, 1);
        undone++;
      }
    } finally {
      // The repo writes are queued; wait for them so their failures are in the result.
      await sm.flush();
    }
    return {
      undone, keptOnDisk: [...kept], notDeleted: [...notDeleted], baselineFailed: [...baselineFailed], interrupted,
    };
  }
}

/**
 * A restored review entry with nothing left to review: the file on disk already equals its
 * baseline, as when undo could not trash a file Discard had restored. The panel lists no
 * row for such an entry, so undo resolves it as the hunk commands do when the last hunk
 * goes. Guarded by `undoHistory.test.ts` ("could not trash").
 */
function resolvedOnDisk(f: FileSnapshot): boolean {
  if (f.before.status !== 'reviewing' || f.before.baseline === null) return false;
  let text: string | null;
  try { text = readTextFileSync(f.filePath); } catch { return false; }
  return text !== null && computeHunks(f.before.baseline, text).length === 0;
}

/** Put a file's bytes back as they were before the action, if nothing has touched them since. */
async function restoreDisk(f: FileSnapshot, io: UndoIO, kept: Set<string>, notDeleted: Set<string>): Promise<void> {
  // The action left the content alone (an accept), so there is nothing to put back, and a
  // later edit is not "left as it is". Guarded by `undoHistory.test.ts` ("never changed it").
  if (f.printBefore === f.printAfter) return;
  const now = printOf(readDisk(f.filePath));
  if (samePrint(now, f.printBefore)) return;
  if (f.printBefore === undefined || f.unsavedBefore || io.hasUnsavedEdits(f.filePath) || !samePrint(now, f.printAfter)) {
    log(`undo(${path.basename(f.filePath)}): unsaved changes then, or changed since; leaving it on disk`);
    kept.add(f.filePath);
    return;
  }
  io.markSelfEdit(f.filePath);
  try {
    if (f.printBefore === null) {
      if (!await io.deleteFile(f.filePath)) notDeleted.add(f.filePath);
    } else {
      // Present: the disk matches "after" but not "before", so the action changed it.
      if (!f.bytesBefore) throw new Error(`${path.basename(f.filePath)} has no saved content to write back`);
      await io.writeFile(f.filePath, f.bytesBefore);
      // An editor write can fail without saying so (a refused edit, a save conflict).
      // Throwing stops the undo with this entry kept, so Undo can retry.
      if (!samePrint(printOf(readDisk(f.filePath)), f.printBefore)) {
        throw new Error(`${path.basename(f.filePath)} could not be written back`);
      }
    }
  } finally {
    io.clearSelfEdit(f.filePath);
  }
}

export const undoHistory = new UndoHistory();

/**
 * Run `fn` as one undoable action over `paths`. Actions nested inside another (Discard All
 * discarding each file) run through the unrecorded internals, so each user gesture is one
 * entry; guarded by the "Accept All is not recorded" mutation on `undoHistory.test.ts`.
 *
 * `fn` gets a stand-in for `onStateChanged`, whose calls are held until the entry is
 * recorded and then replayed, so the one refresh the action triggers already shows it on
 * the Undo button. Guarded by `undoHistory.test.ts` ("the action's own refresh").
 *
 * A bulk action that awaits between files calls `files.start` and `files.done` around each
 * file's part, recording its "before" and "after" then. An agent write to a file before its
 * turn is what that part overwrote, and undo puts it back; one after its turn is later work
 * that undo keeps. Guarded by `undoHistory.test.ts` ("what Discard All discarded",
 * "while Discard All").
 */
/** Per-file hooks a bulk action calls around each file's part; see `recordUndo`. */
export interface BulkFiles {
  start(filePath: string): void;
  done(filePath: string): void;
}

export function recordUndo<T>(
  sm: StateManager,
  label: string,
  paths: Iterable<string>,
  onStateChanged: () => void,
  fn: (onStateChanged: () => void, files: BulkFiles) => T,
  bulk?: UndoEntry['bulk'],
): T {
  const pending = undoHistory.capture(sm, label, paths, bulk);
  let held = 0;
  const finish = () => {
    undoHistory.commit(sm, pending);
    for (; held > 0; held--) onStateChanged();
  };
  let result: T;
  try {
    result = fn(() => { held++; }, {
      start: filePath => undoHistory.retake(sm, pending, filePath),
      done: filePath => {
        for (const f of pending.files) if (f.filePath === filePath) f.after = { print: printOf(readDisk(filePath)) };
      },
    });
  } catch (err) {
    finish();
    throw err;
  }
  if (result instanceof Promise) {
    return result.then(
      value => { finish(); return value; },
      err => { finish(); throw err; },
    ) as T;
  }
  finish();
  return result;
}
