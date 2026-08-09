import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, sleep,
  waitForReviewing, enableReview, disableReview,
  writeFileExternally, cleanWorkspace, getStateManager, getReviewPanel,
} from './helpers';
import { acceptFileByPath } from '../../commands';

// ── Test suite ────────────────────────────────────────────────────────────────
//
// Cross-file advance: resolving a file's last hunk auto-opens the next reviewing
// file, so the whole changeset walks as one queue. The advanced-to file is opened
// in the diff editor, whose modified side is a file-scheme editor for that path, so
// it becomes the active editor.

suite('interactive-review cross-file advance', function () {
  this.timeout(30000);

  setup(async function () {
    cleanWorkspace();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    cleanWorkspace();
  });

  test('opens the next reviewing file after one is resolved', async () => {
    const root = getWorkspaceRoot();
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    await enableReview();
    writeFileExternally(a, 'content a\n');
    writeFileExternally(b, 'content b\n');
    await waitForReviewing(a);
    await waitForReviewing(b);

    const sm = getStateManager();
    const panel = getReviewPanel();
    assert.ok(panel, 'ReviewPanel should be available');

    // Resolve a → it exits reviewing; b remains.
    acceptFileByPath(sm, a, () => {});
    assert.notStrictEqual(sm.getFile(a)?.status, 'reviewing', 'a resolved');

    await panel.advanceToNextFile(a);
    await sleep(100);

    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath, b,
      'advancing past a should open the next reviewing file b',
    );
  });

  test('no-op when the resolved file still has pending hunks', async () => {
    const root = getWorkspaceRoot();
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    await enableReview();
    writeFileExternally(a, 'content a\n');
    writeFileExternally(b, 'content b\n');
    await waitForReviewing(a);
    await waitForReviewing(b);

    const panel = getReviewPanel();
    // a is still reviewing → the guard must return early and NOT jump to b.
    await panel.advanceToNextFile(a);
    await sleep(100);

    assert.notStrictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath, b,
      'a still pending → must not auto-open the next file',
    );
  });

  test('no-op when no reviewing files remain', async () => {
    const root = getWorkspaceRoot();
    const a = path.join(root, 'a.txt');
    await enableReview();
    writeFileExternally(a, 'content a\n');
    await waitForReviewing(a);

    const sm = getStateManager();
    const panel = getReviewPanel();
    acceptFileByPath(sm, a, () => {});
    assert.strictEqual(sm.reviewingCount, 0, 'queue empty');

    // Should not throw and should open nothing new.
    await panel.advanceToNextFile(a);
    await sleep(100);
    assert.strictEqual(sm.reviewComplete, true, 'closure state, not a jump');
  });

  // ── Vanished new files ────────────────────────────────────────────────────
  //
  // A new file (null baseline) that is gone from disk has nothing left to review and
  // no side to render a diff from. FileWatcher.onDiskDelete normally drops it, but a
  // dropped watcher event can strand it in memory — so the state is injected directly
  // here, which is exactly the situation a missed event produces.

  /** Strand a null-baseline reviewing entry for a path that does not exist on disk. */
  function strandVanishedNewFile(filePath: string): void {
    getStateManager().setFile(filePath, { status: 'reviewing', baseline: null });
    assert.strictEqual(getStateManager().getFile(filePath)?.status, 'reviewing',
      'precondition: the stranded entry is in reviewing');
  }

  test('a vanished new file is dropped from the panel instead of listed as actionless', async () => {
    const root = getWorkspaceRoot();
    await enableReview();
    const ghost = path.join(root, 'ghost.txt'); // never created on disk
    strandVanishedNewFile(ghost);

    const state = getReviewPanel().panelStateForTest();

    assert.ok(!state.files.some((f: any) => f.filePath === ghost),
      'a new file with no file on disk must not be listed');
    assert.strictEqual(getStateManager().getFile(ghost), undefined,
      'building the panel reconciles the stranded entry out of state');
  });

  test('advancing over a vanished new file skips it rather than stalling the walk', async () => {
    const root = getWorkspaceRoot();
    const a = path.join(root, 'a.txt');
    const real = path.join(root, 'z-real.txt');
    await enableReview();
    writeFileExternally(a, 'content a\n');
    writeFileExternally(real, 'content real\n');
    await waitForReviewing(a);
    await waitForReviewing(real);

    // Sorts between a.txt and z-real.txt, so the walk reaches it first.
    const ghost = path.join(root, 'm-ghost.txt');
    strandVanishedNewFile(ghost);

    const sm = getStateManager();
    const panel = getReviewPanel();
    acceptFileByPath(sm, a, () => {});

    // Must not throw on the nonexistent file, and must not stop there.
    await panel.advanceToNextFile(a);
    await sleep(200);

    assert.strictEqual(sm.getFile(ghost), undefined, 'the vanished entry is reconciled away');
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath, real,
      'the walk steps over the vanished file and opens the next real one',
    );
  });
});
