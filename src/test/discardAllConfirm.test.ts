import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { confirmAndDiscardAll, discardAllPrompt } from '../commands';
import type { FileWatcher } from '../fileWatcher';
import type { StateManager } from '../stateManager';
import type { FileState } from '../types';

/**
 * The panel's Discard All button rewrites every file in the queue in one click, so it asks
 * first, and then discards exactly what it asked about. `discardAllFiles` itself stays
 * dialog-free for tests and programmatic callers.
 */

const edited: FileState = { status: 'reviewing', baseline: 'old\n' };
const created: FileState = { status: 'reviewing', baseline: null, nullReason: 'created' };
const unbaselined: FileState = { status: 'reviewing', baseline: null, nullReason: 'unbaselined' };

const onDisk = () => true;
const entries = (...files: FileState[]): [string, FileState][] => files.map((f, i) => [`/ws/f${i}`, f]);

/**
 * A queue whose `getFile` records what the discard loop asked for and answers undefined,
 * so `discardFileByPath` returns before touching disk or the watcher.
 */
function stubState(files: FileState[]) {
  const map = new Map(entries(...files));
  const discarded: string[] = [];
  const sm = {
    getAllFiles: () => map,
    getFile: (fp: string) => { discarded.push(fp); return undefined; },
  } as unknown as StateManager;
  return { sm, map, discarded };
}
const fw = {} as FileWatcher;

describe('discardAllPrompt', () => {
  it('has nothing to ask when no file is under review', () => {
    assert.equal(discardAllPrompt([], onDisk), undefined);
  });

  it('counts reverted and deleted files separately', () => {
    assert.equal(
      discardAllPrompt(entries(edited, edited, created), onDisk),
      'Discard all pending changes? This will revert 2 files to the start of the review and delete 1 new file.',
    );
  });

  it('says an unbaselined file is kept, not reverted', () => {
    // It predates the session with no saved original; discarding leaves it on disk.
    assert.equal(
      discardAllPrompt(entries(unbaselined), onDisk),
      'Discard all pending changes? This will stop reviewing 1 file it cannot revert, leaving it as it is.',
    );
  });

  it('does not count a created file already gone from disk as a delete', () => {
    assert.equal(
      discardAllPrompt(entries(edited, created, created), fp => fp !== '/ws/f2'),
      'Discard all pending changes? This will revert 1 file to the start of the review, delete 1 new file and stop reviewing 1 file it cannot revert, leaving it as it is.',
    );
  });
});

describe('confirmAndDiscardAll', () => {
  const win = vscode.window as unknown as { showWarningMessage: (...a: unknown[]) => Promise<unknown> };
  const original = win.showWarningMessage;
  afterEach(() => { win.showWarningMessage = original; });

  it('discards on the explicit Discard All choice, from a modal', async () => {
    const { sm, discarded } = stubState([edited, edited]);
    let options: unknown;
    win.showWarningMessage = async (_msg, opts, item) => { options = opts; return item; };
    assert.equal(await confirmAndDiscardAll(sm, fw, () => {}), true);
    assert.deepEqual(options, { modal: true });
    assert.deepEqual(discarded, ['/ws/f0', '/ws/f1']);
  });

  it('discards nothing when the dialog is dismissed', async () => {
    const { sm, discarded } = stubState([edited]);
    win.showWarningMessage = async () => undefined;
    assert.equal(await confirmAndDiscardAll(sm, fw, () => {}), false);
    assert.deepEqual(discarded, []);
  });

  it('asks nothing when the queue is empty', async () => {
    const { sm } = stubState([]);
    let asked = false;
    win.showWarningMessage = async () => { asked = true; return 'Discard All'; };
    assert.equal(await confirmAndDiscardAll(sm, fw, () => {}), false);
    assert.equal(asked, false);
  });

  it('leaves alone a file that joined the queue while the dialog was open', async () => {
    // The modal can sit open while an agent keeps writing. A file it creates meanwhile was
    // never in the count, and discarding it would delete it unannounced.
    const { sm, map, discarded } = stubState([edited]);
    win.showWarningMessage = async (_msg, _opts, item) => { map.set('/ws/late', created); return item; };
    await confirmAndDiscardAll(sm, fw, () => {});
    assert.deepEqual(discarded, ['/ws/f0']);
  });
});
