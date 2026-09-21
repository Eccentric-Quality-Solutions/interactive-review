import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StateManager } from '../stateManager';

declare const global: Record<string, unknown>;

const ROOT = '/ws';
const FILE = '/ws/docs/note.md';

/**
 * `StateManager.onDidChangeBaseline` is what keeps VS Code's cached baseline
 * document equal to `stateManager`'s copy — the diff editor's original side is
 * served from the latter but rendered from the former. These tests pin the
 * contract at the state layer, where it is testable without an extension host.
 *
 * No git is attached (`load()` is never called), so every mutation is in-memory
 * only and the git queue stays untouched.
 */
describe('StateManager baseline change notification', () => {
  let sm: StateManager;
  let fired: string[];

  beforeEach(() => {
    global.__reviewTestRoot = ROOT;
    sm = new StateManager();
    fired = [];
    sm.onDidChangeBaseline(fp => fired.push(fp));
  });

  it('fires when a file acquires a baseline', () => {
    sm.setFile(FILE, { status: 'reviewing', baseline: 'a\n' });
    assert.deepEqual(fired, [FILE]);
  });

  it('fires when a file loses its baseline, because absent renders as empty', () => {
    // The content provider returns '' for an absent entry, so exitReviewing changes
    // what the diff editor would paint just as much as a content edit does.
    sm.setFile(FILE, { status: 'reviewing', baseline: 'a\n' });
    fired.length = 0;
    sm.exitReviewing(FILE);
    assert.deepEqual(fired, [FILE]);
  });

  it('does not fire when only the status moves and the baseline holds', () => {
    sm.setFile(FILE, { status: 'reviewing', baseline: 'a\n' });
    fired.length = 0;
    sm.setFile(FILE, { status: 'reviewing', baseline: 'a\n' });
    assert.deepEqual(fired, [], 'a no-op re-render is not worth invalidating the cache');
  });

  it('does not fire when a path that was never tracked is removed', () => {
    sm.removeFile(FILE);
    assert.deepEqual(fired, []);
  });

  /**
   * The regression. Observed sequence, from the extension log:
   *
   *   14:41:23  acceptHunk: last change, exitReviewing     → entry deleted
   *   14:41:27  onDiskCreate: enterReviewing(27849 chars)  → fresh baseline
   *   14:41:29  jumpToHunk 187:1:187:0, opening diffEditor
   *
   * The notification used to hang off the accept command and ran *after*
   * `exitReviewing`, so VS Code cached '' for the baseline document. Re-entering
   * reviewing then notified nobody, and the diff editor was served the stale empty
   * original — painting the whole file as changed while `computeHunks`, reading
   * state directly, correctly reported the single added line.
   *
   * The re-entry fire is the one that was missing; without it the diff editor has
   * no way to learn the baseline came back.
   */
  it('fires on re-entering review after a completed one (whole-file-diff regression)', () => {
    sm.setFile(FILE, { status: 'reviewing', baseline: 'old\n' });
    sm.exitReviewing(FILE);            // review completes — cache goes to ''
    fired.length = 0;

    sm.setFile(FILE, { status: 'reviewing', baseline: 'accepted\n' });  // next edit lands

    assert.deepEqual(fired, [FILE]);
    assert.equal(sm.getFile(FILE)?.baseline, 'accepted\n');
  });

  it('fires for a null baseline, which is a new file rather than no file', () => {
    // '' from a null baseline and '' from an absent entry paint identically but mean
    // different things, and only the former has hunks to accept — so the transition
    // between them still has to invalidate.
    sm.setFile(FILE, { status: 'reviewing', baseline: null });
    assert.deepEqual(fired, [FILE]);
    fired.length = 0;
    sm.setFile(FILE, { status: 'reviewing', baseline: 'now tracked\n' });
    assert.deepEqual(fired, [FILE]);
  });

  it('fires both paths of a rename', () => {
    sm.setFile(FILE, { status: 'reviewing', baseline: 'a\n' });
    fired.length = 0;
    sm.renameFile(FILE, '/ws/docs/renamed.md');
    assert.deepEqual(fired.sort(), [FILE, '/ws/docs/renamed.md'].sort());
  });

  it('fires once per tracked path when a session is torn down', async () => {
    sm.setFile(FILE, { status: 'reviewing', baseline: 'a\n' });
    sm.setFile('/ws/other.ts', { status: 'reviewing', baseline: 'b\n' });
    fired.length = 0;
    await sm.setEnabled(false);
    assert.deepEqual(fired.sort(), [FILE, '/ws/other.ts'].sort());
  });
});
