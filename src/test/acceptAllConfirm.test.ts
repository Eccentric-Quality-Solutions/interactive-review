import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { acceptAllPrompt, confirmAndAcceptAll } from '../commands';
import type { StateManager } from '../stateManager';
import type { FileState } from '../types';

/**
 * The panel's Accept All button drops every file's saved original in one click, so it asks
 * first, and then accepts exactly what it asked about. `acceptAllFiles` itself stays
 * dialog-free for tests and programmatic callers.
 */

const edited: FileState = { status: 'reviewing', baseline: 'old\n' };
const idle: FileState = { status: 'idle', baseline: 'old\n' };

const entries = (...files: FileState[]): [string, FileState][] => files.map((f, i) => [`/ws/f${i}`, f]);

/**
 * A queue whose `getFile` records what the accept loop asked for and answers undefined,
 * so `acceptFileByPath` returns before touching disk.
 */
function stubState(files: FileState[]) {
  const map = new Map(entries(...files));
  const accepted: string[] = [];
  const sm = {
    getAllFiles: () => map,
    getFile: (fp: string) => { accepted.push(fp); return undefined; },
  } as unknown as StateManager;
  return { sm, map, accepted };
}

describe('acceptAllPrompt', () => {
  it('has nothing to ask when no file is under review', () => {
    assert.equal(acceptAllPrompt([]), undefined);
  });

  it('counts only files under review', () => {
    assert.equal(
      acceptAllPrompt(entries(edited, edited, idle)),
      'Accept all pending changes? This will keep 2 files as they are on disk and stop reviewing them.',
    );
  });

  it('uses the singular for one file', () => {
    assert.equal(
      acceptAllPrompt(entries(edited)),
      'Accept all pending changes? This will keep 1 file as it is on disk and stop reviewing it.',
    );
  });
});

describe('confirmAndAcceptAll', () => {
  const win = vscode.window as unknown as { showWarningMessage: (...a: unknown[]) => Promise<unknown> };
  const original = win.showWarningMessage;
  afterEach(() => { win.showWarningMessage = original; });

  it('accepts on the explicit Accept All choice, from a modal', async () => {
    const { sm, accepted } = stubState([edited, edited]);
    let options: unknown;
    win.showWarningMessage = async (_msg, opts, item) => { options = opts; return item; };
    assert.equal(await confirmAndAcceptAll(sm, () => {}), true);
    assert.deepEqual(options, { modal: true });
    assert.deepEqual(accepted, ['/ws/f0', '/ws/f1']);
  });

  it('accepts nothing when the dialog is dismissed', async () => {
    const { sm, accepted } = stubState([edited]);
    win.showWarningMessage = async () => undefined;
    assert.equal(await confirmAndAcceptAll(sm, () => {}), false);
    assert.deepEqual(accepted, []);
  });

  it('asks nothing when the queue is empty', async () => {
    const { sm } = stubState([]);
    let asked = false;
    win.showWarningMessage = async () => { asked = true; return 'Accept All'; };
    assert.equal(await confirmAndAcceptAll(sm, () => {}), false);
    assert.equal(asked, false);
  });

  it('leaves alone a file that joined the queue while the dialog was open', async () => {
    // The modal can sit open while an agent keeps writing. A file it touches meanwhile was
    // never in the count, and accepting it would drop its original unannounced.
    const { sm, map, accepted } = stubState([edited]);
    win.showWarningMessage = async (_msg, _opts, item) => { map.set('/ws/late', edited); return item; };
    await confirmAndAcceptAll(sm, () => {});
    assert.deepEqual(accepted, ['/ws/f0']);
  });
});
