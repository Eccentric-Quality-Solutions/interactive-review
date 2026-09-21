import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import * as vscode from 'vscode';
import {
  getWorkspaceRoot, gitGetBaseline,
  sleep, waitForCondition, waitForReviewing, enableReview, disableReview,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher, settle,
} from './helpers';
import { acceptFileByPath, discardAllFiles } from '../../commands';

/**
 * The invariant these tests exist for:
 *
 *   **A file that was on disk before the review session began is never deleted by a
 *   discard, and never has its bytes replaced by a lossy decoding of itself.**
 *
 * Discard branches on `baseline === null` to decide whether to delete the file from
 * disk, and that is only correct when `null` means "this file did not exist before".
 * Several paths produce a `null` baseline for files that *did* exist — a binary or
 * unreadable file skipped by the enable snapshot, then re-adopted as "untracked" by
 * `load`/`rebuildState`. Those populations must reach the same queue by a different
 * door, and Discard must leave them on disk.
 *
 * Written as end-state assertions on the filesystem rather than unit tests of the
 * classifier: the classifier is what keeps being wrong, so asserting it would assert
 * the bug.
 */

/** A real PNG header — NUL bytes in the first block, which is the binary signal. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // \x89PNG\r\n\x1a\n
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // length + "IHDR"
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
]);

function writeBinaryExternally(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

/**
 * Let the watcher deliver (and discard) create events for the fixtures before the session
 * opens, which is what "predates the session" has to mean operationally.
 *
 * Without this the tests are racing their own setup: a file written milliseconds before
 * `beginReview` can have its `onDidCreate` land *after* the enable snapshot window closes,
 * and the extension then quite reasonably reports a witnessed create. The extension is not
 * wrong there — that ambiguity is the documented sliver in `settleSnapshotCreates` — but it
 * is not the situation these tests are about. The extension ignores events while disabled,
 * so draining here establishes the precondition rather than hiding a defect.
 */
async function settleFixtures(): Promise<void> {
  await sleep(600);
}

/** Drive the synchronous rescan — the `rebuildState` path that re-adopts untracked files. */
async function refresh(): Promise<void> {
  await vscode.commands.executeCommand('interactiveReview.refresh');
  await sleep(500);
}

suite('interactive-review pre-existing files survive review', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    // chmod back so cleanWorkspace can remove it
    const root = getWorkspaceRoot();
    const locked = path.join(root, 'locked.txt');
    if (fs.existsSync(locked)) { try { fs.chmodSync(locked, 0o644); } catch { /* ignore */ } }
    cleanWorkspace();
  });

  /**
   * The headline invariant. Every file here existed before `beginReview`, so whatever
   * the review queue decides to show, Discard All must leave all of them on disk.
   */
  test('discard never deletes a file that predates the session', async () => {
    const root = getWorkspaceRoot();
    const png = path.join(root, 'assets', 'logo.png');
    const text = path.join(root, 'notes.txt');
    const locked = path.join(root, 'locked.txt');

    writeBinaryExternally(png, PNG_BYTES);
    writeFileExternally(text, 'hello\n');
    writeFileExternally(locked, 'secret\n');
    // Unreadable at enable → skipped by readBatch → no baseline. Skipped when running
    // as root, where mode 000 is still readable and the case cannot be staged.
    const canStageUnreadable = (process.getuid?.() ?? 0) !== 0;
    if (canStageUnreadable) fs.chmodSync(locked, 0o000);

    await settleFixtures();
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'notes.txt') === 'hello\n');
    await refresh();

    await discardAllFiles(getStateManager(), getFileWatcher(), () => {});
    await sleep(500);

    assert.ok(fs.existsSync(png), 'pre-existing binary was deleted by discard');
    assert.ok(fs.existsSync(text), 'pre-existing text file was deleted by discard');
    if (canStageUnreadable) {
      assert.ok(fs.existsSync(locked), 'pre-existing unreadable file was deleted by discard');
    }
    assert.deepStrictEqual(fs.readFileSync(png), PNG_BYTES, 'pre-existing binary was rewritten by discard');
  });

  /**
   * Surfacing every asset in the repo as a pending "new file" is a broken queue even
   * once Discard is safe, so the queue membership is asserted separately from the
   * invariant above.
   */
  test('a pre-existing binary is not queued as a new file after a refresh', async () => {
    const root = getWorkspaceRoot();
    const png = path.join(root, 'assets', 'logo.png');
    writeBinaryExternally(png, PNG_BYTES);
    writeFileExternally(path.join(root, 'notes.txt'), 'hello\n');

    await settleFixtures();
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'notes.txt') === 'hello\n');
    await refresh();

    assert.strictEqual(
      getStateManager().getFile(png)?.status,
      undefined,
      'pre-existing binary entered the review queue',
    );
  });

  /**
   * A genuinely new binary still belongs in the queue (discarding it should delete it),
   * but accepting it must not store a UTF-8 decoding of it as a baseline — that baseline
   * is what a later discard would write back over the real bytes.
   */
  test('accepting a new binary does not store a lossy baseline', async () => {
    const root = getWorkspaceRoot();
    writeFileExternally(path.join(root, 'notes.txt'), 'hello\n');
    await settleFixtures();
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, 'notes.txt') === 'hello\n');

    // Created *after* enable → a real new file, null baseline, queued by onDidCreate.
    const png = path.join(root, 'new-asset.png');
    writeBinaryExternally(png, PNG_BYTES);
    await waitForReviewing(png);

    acceptFileByPath(getStateManager(), png, () => {});
    await settle();

    const stored = gitGetBaseline(root, 'new-asset.png');
    assert.strictEqual(stored, undefined, 'accepting a binary stored a decoded baseline');
    assert.deepStrictEqual(fs.readFileSync(png), PNG_BYTES, 'accepting a binary altered the file');
  });
});
