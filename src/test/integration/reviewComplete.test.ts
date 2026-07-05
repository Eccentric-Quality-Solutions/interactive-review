import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot,
  waitForReviewing, enableReview, disableReview,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
} from './helpers';
import { acceptAllFiles, discardAllFiles } from '../../commands';

// ── Test suite ────────────────────────────────────────────────────────────────
//
// Review-complete terminal state: the session had pending files and drained them
// all. This is the closure the review-flow model demands. Distinct from "enabled
// but nothing was ever pending" (idle, not complete).

suite('interactive-review review-complete state', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('not complete on a fresh enable with nothing to review', async () => {
    await enableReview();
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    assert.strictEqual(sm.reviewingCount, 0, 'nothing pending');
    assert.strictEqual(sm.reviewComplete, false,
      'enabled with no pending work is idle, not complete');
  });

  test('not complete while a file is still pending', async () => {
    const root = getWorkspaceRoot();
    await enableReview();

    writeFileExternally(path.join(root, 'pending.txt'), 'new content\n');
    await waitForReviewing(path.join(root, 'pending.txt'));

    const sm = getStateManager();
    assert.strictEqual(sm.reviewComplete, false,
      'a pending file means the review is not complete');
  });

  test('becomes complete when the queue drains (accept all)', async () => {
    const root = getWorkspaceRoot();
    await enableReview();

    writeFileExternally(path.join(root, 'a.txt'), 'content a\n');
    writeFileExternally(path.join(root, 'b.txt'), 'content b\n');
    await waitForReviewing(path.join(root, 'a.txt'));
    await waitForReviewing(path.join(root, 'b.txt'));

    const sm = getStateManager();
    assert.ok(sm.reviewingCount >= 2, 'both files pending');
    assert.strictEqual(sm.reviewComplete, false, 'not complete yet');

    // Accept everything → queue drains → complete
    await acceptAllFiles(sm, () => {});
    assert.strictEqual(sm.reviewingCount, 0, 'queue drained');
    assert.strictEqual(sm.reviewComplete, true,
      'draining a non-empty queue reaches the complete terminal state');
  });

  test('becomes complete when the queue drains (discard all)', async () => {
    const root = getWorkspaceRoot();
    await enableReview();

    writeFileExternally(path.join(root, 'c.txt'), 'content c\n');
    await waitForReviewing(path.join(root, 'c.txt'));

    const sm = getStateManager();
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    assert.strictEqual(sm.reviewComplete, false, 'not complete yet');

    await discardAllFiles(sm, fw, () => {});
    assert.strictEqual(sm.reviewingCount, 0, 'queue drained');
    assert.strictEqual(sm.reviewComplete, true, 'discard-to-empty also completes');
  });

  test('a new session resets completion (disable → enable)', async () => {
    const root = getWorkspaceRoot();
    await enableReview();

    writeFileExternally(path.join(root, 'd.txt'), 'content d\n');
    await waitForReviewing(path.join(root, 'd.txt'));
    const sm = getStateManager();
    await acceptAllFiles(sm, () => {});
    assert.strictEqual(sm.reviewComplete, true, 'complete after draining');

    // Open a new session — completion memory resets
    await disableReview();
    await enableReview();
    assert.strictEqual(sm.reviewComplete, false,
      'a fresh session has not seen any pending work yet');
  });
});
