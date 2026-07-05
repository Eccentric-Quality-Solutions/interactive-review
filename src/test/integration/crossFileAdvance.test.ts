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
// file, so the whole changeset walks as one queue. Uses the normal-editor surface
// (useDiffEditor defaults false), so the advanced-to file becomes the active editor.

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
});
