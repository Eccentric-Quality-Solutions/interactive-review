import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateManager } from '../stateManager';
import * as vscode from 'vscode';
import { acceptAllFiles, acceptFileByPath, discardAllFiles, confirmAndUndo, editorUndoIO, undoChoices, undoReport } from '../commands';
import { __setTestEditors, TestDocument } from './__mocks__/vscode';
import type { FileWatcher } from '../fileWatcher';
import { recordUndo, undoHistory, UNDO_LIMIT, UndoEntry, UndoIO } from '../undoHistory';
import { FileState } from '../types';

declare const global: Record<string, unknown>;

/**
 * The panel's Undo: every accept and discard is recorded with the review entry and the
 * bytes on disk of each file it touched, and undo puts both back, newest first.
 *
 * Runs against a real StateManager and baseline repo, and checks after each undo that a
 * reload agrees with memory, since undo writes both. Accepts go through the real commands;
 * discards need an editor (`replaceEntireDocument`), so `discard` below performs one the
 * way `discardFileByPath` does, under the same recorder.
 */

let root: string;
let sm: StateManager;
let trashed: string[];
let written: string[];

const inStateDir = (fp: string) => fp === path.join(root, '.vscode') || fp.startsWith(path.join(root, '.vscode') + path.sep);
const abs = (rel: string) => path.join(root, rel);
const read = (fp: string) => fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : undefined;

function write(fp: string, content: string): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

/** Begin review over what is on disk now. */
async function begin(): Promise<void> {
  sm = new StateManager();
  await sm.setEnabled(true);
  await sm.snapshotWorkspace(inStateDir);
  undoHistory.clear();
}

/** An agent's edit, as the watcher would record it. */
function agentEdit(fp: string, content: string): void {
  const before = sm.getFile(fp);
  if (!before) {
    const existed = fs.existsSync(fp);
    const baseline = existed ? fs.readFileSync(fp, 'utf-8') : null;
    sm.setFile(fp, { status: 'reviewing', baseline, ...(baseline === null ? { nullReason: 'created' as const } : {}) }, true);
  }
  write(fp, content);
}

/** Discard a file the way `discardFileByPath` does, recorded like it. */
function discard(fp: string): void {
  recordUndo(sm, `Discard ${path.basename(fp)}`, [fp], () => {}, () => {
    const st = sm.getFile(fp)!;
    if (st.baseline === null) { fs.rmSync(fp); sm.removeFile(fp); }
    else { write(fp, st.baseline); sm.exitReviewing(fp); }
  });
}

const io: UndoIO = {
  deleteFile: async fp => { trashed.push(fp); fs.rmSync(fp); return true; },
  writeFile: async (fp, bytes) => { written.push(fp); write(fp, bytes.toString('utf-8')); },
  hasUnsavedEdits: () => false,
  markSelfEdit: () => {},
  clearSelfEdit: () => {},
};
const defaultIO = undoHistory.io;

async function undo(count = 1, withIo: UndoIO = io) {
  undoHistory.io = withIo;
  const entries = undoHistory.list(sm);
  return undoHistory.undo(sm, count, entries[entries.length - 1]);
}

function queue(m: StateManager): Record<string, FileState> {
  const out: Record<string, FileState> = {};
  for (const [fp, st] of m.getAllFiles()) {
    out[path.relative(root, fp)] = {
      status: st.status,
      baseline: st.baseline,
      ...(st.baseline === null ? { nullReason: st.nullReason ?? 'unbaselined' } : {}),
    };
  }
  return out;
}

async function assertReloadEqualsMemory(context: string): Promise<void> {
  await sm.flush();
  const fresh = new StateManager();
  await fresh.load(inStateDir);
  await fresh.flush();
  assert.deepEqual(queue(fresh), queue(sm), `reload disagrees with memory ${context}`);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-undo-'));
  global.__reviewTestRoot = root;
  trashed = [];
  written = [];
  undoHistory.io = io;
});

afterEach(async () => {
  await sm?.flush();
  undoHistory.clear();
  undoHistory.io = defaultIO;
  __setTestEditors([]);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('undo history', () => {
  it('undoing Accept All puts every file back in review against its original', async () => {
    write(abs('a.txt'), 'a0\n');
    write(abs('b.txt'), 'b0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    agentEdit(abs('b.txt'), 'b1\n');
    const beforeAccept = queue(sm);

    await acceptAllFiles(sm, () => {});
    assert.deepEqual(queue(sm), {});
    await assertReloadEqualsMemory('after Accept All');

    assert.equal((await undo())?.undone, 1);
    assert.deepEqual(queue(sm), beforeAccept);
    assert.equal(read(abs('a.txt')), 'a1\n', 'accepting never touched the disk, and neither does undoing it');
    await assertReloadEqualsMemory('after undoing Accept All');
  });

  it('undoing an accept of a new file makes it new again, after a reload too', async () => {
    await begin();
    agentEdit(abs('new.txt'), 'n\n');
    acceptFileByPath(sm, abs('new.txt'), () => {});
    assert.equal(sm.getFile(abs('new.txt')), undefined);

    await undo();
    assert.deepEqual(queue(sm), { 'new.txt': { status: 'reviewing', baseline: null, nullReason: 'created' } });
    await assertReloadEqualsMemory('after undoing the accept of a new file');
  });

  it('undoing a discard writes the discarded content back, and recreates a deleted new file', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    agentEdit(abs('new.txt'), 'n\n');
    discard(abs('a.txt'));
    discard(abs('new.txt'));
    assert.equal(read(abs('a.txt')), 'a0\n');
    assert.equal(read(abs('new.txt')), undefined);

    await undo(2);
    assert.equal(read(abs('a.txt')), 'a1\n');
    assert.equal(read(abs('new.txt')), 'n\n');
    assert.deepEqual(queue(sm), {
      'a.txt': { status: 'reviewing', baseline: 'a0\n' },
      'new.txt': { status: 'reviewing', baseline: null, nullReason: 'created' },
    });
    await assertReloadEqualsMemory('after undoing two discards');
  });

  it('undoing the restore of a deleted file deletes it again, recoverably', async () => {
    write(abs('gone.txt'), 'g\n');
    await begin();
    sm.setFile(abs('gone.txt'), { status: 'reviewing', baseline: 'g\n' }, true);
    fs.rmSync(abs('gone.txt'));
    discard(abs('gone.txt'));
    assert.equal(read(abs('gone.txt')), 'g\n');

    await undo();
    assert.deepEqual(trashed, [abs('gone.txt')]);
    assert.equal(sm.isDeleted(abs('gone.txt')), true);
    await assertReloadEqualsMemory('after undoing a restore');
  });

  it('leaves a file edited since the action as it is, and puts it back in review', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    discard(abs('a.txt'));
    write(abs('a.txt'), 'later\n');

    const result = await undo();
    assert.deepEqual(result?.keptOnDisk, [abs('a.txt')]);
    assert.equal(read(abs('a.txt')), 'later\n', 'undo never overwrites work done after the action');
    assert.deepEqual(queue(sm), { 'a.txt': { status: 'reviewing', baseline: 'a0\n' } });
  });

  it('leaves a file with unsaved editor changes as it is on disk', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    discard(abs('a.txt'));

    const result = await undo(1, { ...io, hasUnsavedEdits: () => true });
    assert.deepEqual(result?.keptOnDisk, [abs('a.txt')]);
    assert.equal(read(abs('a.txt')), 'a0\n');
  });

  it('undoes several actions on one file newest first, chaining back to the start', async () => {
    write(abs('a.txt'), 'x0\ny0\n');
    await begin();
    agentEdit(abs('a.txt'), 'x1\ny1\n');
    // Accept the first hunk, as `acceptHunk` folds it into the baseline.
    recordUndo(sm, 'Accept hunk in a.txt', [abs('a.txt')], () => {},
      () => sm.setFile(abs('a.txt'), { status: 'reviewing', baseline: 'x1\ny0\n' }));
    discard(abs('a.txt'));
    assert.equal(read(abs('a.txt')), 'x1\ny0\n');

    const result = await undo(2);
    assert.deepEqual(result?.keptOnDisk, []);
    assert.equal(read(abs('a.txt')), 'x1\ny1\n');
    assert.deepEqual(queue(sm), { 'a.txt': { status: 'reviewing', baseline: 'x0\ny0\n' } });
    await assertReloadEqualsMemory('after undoing a hunk accept and a discard');
  });

  it('keeps an edit that landed between two undone actions', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    discard(abs('a.txt'));
    agentEdit(abs('a.txt'), 'a2\n');
    discard(abs('a.txt'));

    const result = await undo(2);
    // Undoing the newer discard brings back a2; the older one's "after" was a0, so a2 is
    // work done since it, and stays.
    assert.equal(read(abs('a.txt')), 'a2\n');
    assert.deepEqual(result?.keptOnDisk, [abs('a.txt')]);
    assert.deepEqual(queue(sm), { 'a.txt': { status: 'reviewing', baseline: 'a0\n' } });
  });

  it('does not write back a file that had unsaved changes when the discard ran', async () => {
    // The discard saves the buffer, so the unsaved typing reached disk only as the action's
    // "after"; the "before" on disk never held it, and writing that back would lose it.
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    undoHistory.io = { ...io, hasUnsavedEdits: () => true };
    discard(abs('a.txt'));
    undoHistory.io = io;

    const result = await undo();
    assert.deepEqual(result?.keptOnDisk, [abs('a.txt')]);
    assert.equal(read(abs('a.txt')), 'a0\n');
    // Left on disk equal to its baseline, so there is nothing to review.
    assert.deepEqual(queue(sm), {});
    await assertReloadEqualsMemory('after an undo that kept a file');
  });

  it('reports a file it could not trash as not deleted, not as changed', async () => {
    write(abs('gone.txt'), 'g\n');
    await begin();
    sm.setFile(abs('gone.txt'), { status: 'reviewing', baseline: 'g\n' }, true);
    fs.rmSync(abs('gone.txt'));
    discard(abs('gone.txt'));

    const result = await undo(1, { ...io, deleteFile: async () => false });
    assert.deepEqual(result?.notDeleted, [abs('gone.txt')]);
    assert.deepEqual(result?.keptOnDisk, []);
    // The file still equals its baseline, so a restored entry would have no hunks and no
    // panel row. Undo resolves it instead.
    assert.equal(sm.getFile(abs('gone.txt')), undefined);
    await assertReloadEqualsMemory('after an undo that could not trash');
  });

  it('keeps the restored entry and reports a failed baseline write', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    acceptFileByPath(sm, abs('a.txt'), () => {});
    await sm.flush();
    // Replace the object database with a file, so `git hash-object -w` cannot write
    // (as in stateManagerGit.test.ts).
    const objects = path.join(root, '.vscode', 'interactive-review', 'git', 'objects');
    fs.rmSync(objects, { recursive: true, force: true });
    fs.writeFileSync(objects, 'not a directory');

    const result = await undo();
    assert.deepEqual(result?.baselineFailed, [abs('a.txt')]);
    // Rolling back would hide the change undo just put back; it stays in review.
    assert.deepEqual(queue(sm), { 'a.txt': { status: 'reviewing', baseline: 'a0\n' } });
  });

  it("holds the action's own refresh until its entry is recorded", async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    const seen: number[] = [];
    acceptFileByPath(sm, abs('a.txt'), () => { seen.push(undoHistory.list(sm).length); });
    assert.deepEqual(seen, [1], 'one refresh, and it sees the entry');
  });

  it('keeps only a hash of a file the action left alone', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    acceptFileByPath(sm, abs('a.txt'), () => {});
    const [f] = undoHistory.list(sm)[0].files;
    assert.equal(typeof f.printBefore, 'string');
    assert.equal(f.bytesBefore, undefined, 'an accept keeps a hash, not the file');

    agentEdit(abs('a.txt'), 'a2\n');
    discard(abs('a.txt'));
    assert.ok(undoHistory.list(sm)[1].files[0].bytesBefore instanceof Buffer, 'a discard keeps what it overwrote');
  });

  it('releases a finished session\'s entries', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    acceptFileByPath(sm, abs('a.txt'), () => {});
    await sm.setEnabled(false);
    assert.deepEqual(undoHistory.list(sm), []);
    assert.equal(undoHistory.retained, 0);
  });

  it('writes a file back through the installed io, so an open editor is updated', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    discard(abs('a.txt'));

    await undo();
    assert.deepEqual(written, [abs('a.txt')]);
    assert.equal(read(abs('a.txt')), 'a1\n');
  });

  it('stops at a failed write, keeping that entry and older ones to retry', async () => {
    write(abs('a.txt'), 'a0\n');
    write(abs('b.txt'), 'b0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    agentEdit(abs('b.txt'), 'b1\n');
    discard(abs('a.txt'));
    discard(abs('b.txt'));
    const failing: UndoIO = {
      ...io,
      writeFile: async (fp, bytes) => {
        if (fp === abs('a.txt')) throw new Error('disk full');
        await io.writeFile(fp, bytes);
      },
    };

    await assert.rejects(() => undo(2, failing), /disk full/);
    assert.equal(read(abs('b.txt')), 'b1\n', 'the newer entry was undone');
    assert.deepEqual(undoHistory.list(sm).map(e => e.label), ['Discard a.txt'], 'the failed one stays');

    // Retrying finishes the job.
    await undo(1);
    assert.equal(read(abs('a.txt')), 'a1\n');
    assert.deepEqual(undoHistory.list(sm), []);
  });

  it('records unsaved changes from open editors by default', async () => {
    // The default io, before registerCommands installs the editor one, must still see a
    // dirty buffer: recording it as clean would let undo write over the typing.
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    undoHistory.io = defaultIO;
    __setTestEditors([{ uri: { scheme: 'file', fsPath: abs('a.txt') }, isDirty: true } as TestDocument]);
    discard(abs('a.txt'));
    assert.equal(undoHistory.list(sm)[0].files[0].unsavedBefore, true);
  });

  it('empties when the review queue is cleared', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    acceptFileByPath(sm, abs('a.txt'), () => {});
    assert.equal(undoHistory.list(sm).length, 1);

    await sm.clearHunksOnBranchSwitch(inStateDir);
    assert.deepEqual(undoHistory.list(sm), []);
  });

  it('does not report a file as left alone when the action never changed it', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    acceptFileByPath(sm, abs('a.txt'), () => {});
    agentEdit(abs('a.txt'), 'a2\n');

    const result = await undo();
    assert.deepEqual(result?.keptOnDisk, []);
    assert.equal(read(abs('a.txt')), 'a2\n');
    assert.deepEqual(queue(sm), { 'a.txt': { status: 'reviewing', baseline: 'a0\n' } });
  });

  it('records nothing for an action that changed nothing on a file it cannot read', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    // A directory where the file was: reading it fails with something other than ENOENT.
    fs.rmSync(abs('a.txt'));
    fs.mkdirSync(abs('a.txt'));
    recordUndo(sm, 'Accept a.txt', [abs('a.txt')], () => {}, () => {});
    assert.equal(undoHistory.list(sm).length, 0);
  });

  it('describes Undo Everything as the last N actions once older ones were dropped', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    for (let i = 0; i <= UNDO_LIMIT; i++) {
      recordUndo(sm, 'Accept hunk in a.txt', [abs('a.txt')], () => {},
        () => sm.setFile(abs('a.txt'), { status: 'reviewing', baseline: `b${i}\n` }, true));
    }
    const win = vscode.window as unknown as { showWarningMessage: (...a: unknown[]) => Promise<unknown> };
    const original = win.showWarningMessage;
    let detail = '';
    win.showWarningMessage = async (_msg, opts) => { detail = (opts as { detail: string }).detail; return undefined; };
    try { await confirmAndUndo(sm, () => {}); } finally { win.showWarningMessage = original; }
    assert.match(detail, new RegExp(`Undo Everything: the last ${UNDO_LIMIT} actions\\.`));
  });

  it('keeps an agent write made while Discard All was still running', async () => {
    write(abs('a.txt'), 'a0\n');
    write(abs('b.txt'), 'b0\n');
    await begin();
    // The agent deleted both; Discard All restores them one after the other.
    for (const f of ['a', 'b']) sm.setFile(abs(`${f}.txt`), { status: 'reviewing', baseline: `${f}0\n` }, true);
    fs.rmSync(abs('a.txt'));
    fs.rmSync(abs('b.txt'));
    // The agent rewrites a.txt, already discarded, as Discard All starts on b.txt.
    const fw = {
      markSelfEdit: (fp: string) => { if (fp === abs('b.txt')) write(abs('a.txt'), 'a2\n'); },
      clearSelfEdit: () => {},
    } as unknown as FileWatcher;
    await discardAllFiles(sm, fw, () => {});
    assert.equal(read(abs('a.txt')), 'a2\n');

    const result = await undo();
    assert.equal(read(abs('a.txt')), 'a2\n', "the agent's write stays");
    assert.deepEqual(trashed, [abs('b.txt')]);
    assert.deepEqual(result?.keptOnDisk, [abs('a.txt')]);
  });

  it('puts back what Discard All discarded, not what a file held when it started', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    // a.txt deleted by the agent, b.txt created by it; Discard All restores a.txt first.
    sm.setFile(abs('a.txt'), { status: 'reviewing', baseline: 'a0\n' }, true);
    fs.rmSync(abs('a.txt'));
    agentEdit(abs('b.txt'), 'b1\n');
    // The agent rewrites b.txt while Discard All is still on a.txt, before b.txt's turn.
    const fw = {
      markSelfEdit: (fp: string) => { if (fp === abs('a.txt')) write(abs('b.txt'), 'b2\n'); },
      clearSelfEdit: () => {},
    } as unknown as FileWatcher;
    await discardAllFiles(sm, fw, () => {});
    assert.equal(read(abs('b.txt')), undefined, 'b.txt was discarded');

    const result = await undo();
    assert.equal(read(abs('b.txt')), 'b2\n', "the agent's latest content comes back");
    assert.deepEqual(result?.keptOnDisk, []);
  });

  it('drops an action recorded while a queue clear is running', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    const clearing = sm.clearHunksOnBranchSwitch(inStateDir);
    // The clear has started but not yet emptied the queue.
    acceptFileByPath(sm, abs('a.txt'), () => {});
    await clearing;
    assert.deepEqual(undoHistory.list(sm), []);
  });

  it('empties the moment a branch switch is seen, before its clear starts', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    acceptFileByPath(sm, abs('a.txt'), () => {});
    sm.markQueueClearing();
    assert.deepEqual(undoHistory.list(sm), []);
  });

  it('stops, keeping the entry, when a write does not put the bytes back', async () => {
    // An editor write can fail silently (a refused edit, a save conflict).
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    discard(abs('a.txt'));

    await assert.rejects(() => undo(1, { ...io, writeFile: async () => {} }), /could not be written back/);
    assert.deepEqual(undoHistory.list(sm).map(e => e.label), ['Discard a.txt']);
  });

  it('stops an undo in flight when the review queue is cleared', async () => {
    write(abs('a.txt'), 'a0\n');
    write(abs('b.txt'), 'b0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    agentEdit(abs('b.txt'), 'b1\n');
    discard(abs('a.txt'));
    discard(abs('b.txt'));
    let clearing: Promise<void> | undefined;
    const clearsMidway: UndoIO = {
      ...io,
      writeFile: async (fp, bytes) => {
        await io.writeFile(fp, bytes);
        clearing ??= sm.clearHunksOnBranchSwitch(inStateDir);
      },
    };

    const result = await undo(2, clearsMidway);
    await clearing;
    assert.equal(result?.interrupted, true);
    assert.equal(result?.undone, 0);
    assert.equal(read(abs('a.txt')), 'a0\n', 'the older entry was not touched');
    assert.deepEqual(queue(sm), {}, 'nothing was restored into the cleared queue');
  });

  it("the editor io checks open editors itself, whatever io was installed before", () => {
    undoHistory.io = { ...io, hasUnsavedEdits: () => false };
    const live = editorUndoIO({} as FileWatcher);
    __setTestEditors([{ uri: { scheme: 'file', fsPath: abs('a.txt') }, isDirty: true } as TestDocument]);
    assert.equal(live.hasUnsavedEdits(abs('a.txt')), true);
  });

  it('the editor io writes exact bytes to an open file, not through an editor save', async () => {
    // An editor save runs save participants (whitespace trimming, format on save) and
    // re-encodes, so it cannot put back the bytes undo recorded.
    write(abs('a.txt'), 'x\n');
    __setTestEditors([{ uri: { scheme: 'file', fsPath: abs('a.txt') }, isDirty: false } as TestDocument]);
    const bytes = Buffer.from('a1   \r\nb\n\u00e9');
    await editorUndoIO({} as FileWatcher).writeFile(abs('a.txt'), bytes);
    assert.deepEqual(fs.readFileSync(abs('a.txt')), bytes);
  });

  it('undoes nothing if another action landed after the one the caller saw', async () => {
    write(abs('a.txt'), 'a0\n');
    write(abs('b.txt'), 'b0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    agentEdit(abs('b.txt'), 'b1\n');
    acceptFileByPath(sm, abs('a.txt'), () => {});
    const seen = undoHistory.list(sm).at(-1)!;
    acceptFileByPath(sm, abs('b.txt'), () => {});

    assert.equal(await undoHistory.undo(sm, 1, seen), undefined);
    assert.equal(undoHistory.list(sm).length, 2);
  });

  it('records nothing for an action that changed nothing', async () => {
    await begin();
    acceptFileByPath(sm, abs('untracked.txt'), () => {});
    assert.equal(undoHistory.list(sm).length, 0);
  });

  it('is empty in a new session', async () => {
    write(abs('a.txt'), 'a0\n');
    await begin();
    agentEdit(abs('a.txt'), 'a1\n');
    acceptFileByPath(sm, abs('a.txt'), () => {});
    assert.equal(undoHistory.list(sm).length, 1);
    await sm.setEnabled(false);
    await sm.setEnabled(true);
    assert.equal(undoHistory.list(sm).length, 0);
  });
});

describe('undoChoices', () => {
  const e = (label: string, bulk?: UndoEntry['bulk']): UndoEntry => ({ label, bulk, files: [] });

  it('offers nothing with no history', () => {
    assert.equal(undoChoices([]), undefined);
  });

  it('offers only Undo Last for a single action', () => {
    assert.deepEqual(undoChoices([e('Accept All (2 files)', 'Accept All')])!.choices, [{ button: 'Undo Last', count: 1 }]);
  });

  it('offers undoing back through the last bulk action, and everything before it', () => {
    const offer = undoChoices([
      e('Accept a.ts'),
      e('Discard All (3 files)', 'Discard All'),
      e('Accept hunk in b.ts'),
    ])!;
    assert.deepEqual(offer.choices, [
      { button: 'Undo Last', count: 1 },
      { button: 'Undo Through Discard All', count: 2 },
      { button: 'Undo Everything', count: 3 },
    ]);
    assert.match(offer.detail, /Undo Last: Accept hunk in b\.ts\./);
    assert.match(offer.detail, /back through Discard All \(3 files\)/);
  });

  it('does not offer a choice that undoes the same as the one before it', () => {
    // The bulk action is the oldest, so undoing through it is undoing everything.
    const offer = undoChoices([e('Accept All (1 file)', 'Accept All'), e('Discard x.ts')])!;
    assert.deepEqual(offer.choices.map(c => c.button), ['Undo Last', 'Undo Through Accept All']);
  });
});

describe('confirmAndUndo', () => {
  const win = vscode.window as unknown as { showWarningMessage: (...a: unknown[]) => Promise<unknown> };
  const original = win.showWarningMessage;
  afterEach(() => { win.showWarningMessage = original; });

  /** a.txt accepted, then Accept All over b.txt and c.txt, then c.txt edited and accepted. */
  async function threeActions(): Promise<void> {
    for (const f of ['a', 'b', 'c']) write(abs(`${f}.txt`), `${f}0\n`);
    await begin();
    for (const f of ['a', 'b', 'c']) agentEdit(abs(`${f}.txt`), `${f}1\n`);
    acceptFileByPath(sm, abs('a.txt'), () => {});
    await acceptAllFiles(sm, () => {});
    agentEdit(abs('c.txt'), 'c2\n');
    acceptFileByPath(sm, abs('c.txt'), () => {});
  }

  it('undoes as many actions as the chosen button names, from a modal', async () => {
    await threeActions();
    let buttons: unknown[] = [];
    let options: unknown;
    win.showWarningMessage = async (_msg, opts, ...items) => { options = opts; buttons = items; return 'Undo Through Accept All'; };
    assert.equal(await confirmAndUndo(sm, () => {}), 2);
    assert.equal((options as { modal: boolean }).modal, true);
    assert.deepEqual(buttons, ['Undo Last', 'Undo Through Accept All', 'Undo Everything']);
    assert.deepEqual(Object.keys(queue(sm)).sort(), ['b.txt', 'c.txt']);
    assert.equal(undoHistory.list(sm).length, 1);
  });

  it('undoes nothing when the dialog is dismissed', async () => {
    await threeActions();
    win.showWarningMessage = async () => undefined;
    assert.equal(await confirmAndUndo(sm, () => {}), 0);
    assert.equal(undoHistory.list(sm).length, 3);
  });
});

describe('undoReport', () => {
  const empty = { undone: 1, keptOnDisk: [], notDeleted: [], baselineFailed: [], interrupted: false };

  it('says nothing when everything went back', () => {
    assert.deepEqual(undoReport(empty), []);
  });

  it('does not claim a kept or undeleted file is back in review', () => {
    // A file that already equals its baseline has nothing left to review, and undo resolves it.
    const texts = undoReport({ ...empty, keptOnDisk: ['/ws/a.txt'], notDeleted: ['/ws/b.txt'] }).map(m => m.text);
    assert.equal(texts.length, 2);
    for (const t of texts) assert.doesNotMatch(t, /review/);
    assert.match(texts[1], /b\.txt.*still on disk\. Delete it yourself/);
  });

  it('reports an interrupted undo', () => {
    assert.deepEqual(undoReport({ ...empty, interrupted: true }).map(m => m.level), ['warning']);
  });
});
