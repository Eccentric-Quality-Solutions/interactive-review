import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline, sleep, waitForCondition,
  enableReview, disableReview, writeFileExternally, cleanWorkspace,
  getStateManager, getFileWatcher, openDocInEditor, findOpenDoc,
} from './helpers';

/**
 * Regression coverage for the "Claude/terminal edits not captured" bug.
 * See docs/terminal-edits-not-captured.md.
 *
 * The extension must surface an external (AI/terminal) write for review while still
 * silently absorbing the user's own saves. The old heuristic distinguished the two by
 * comparing the open editor buffer against disk — which VSCode's silent reload of a
 * clean open buffer defeats. These tests exercise the classification directly.
 *
 * Determinism: we invoke the private onDiskChange handler through the getFileWatcher()
 * seam instead of waiting on the headless-host FileSystemWatcher, whose external-write
 * events are dropped/delayed on Linux (see helpers.waitForConditionNudged). This tests
 * the exact classification logic without racing the flaky watcher.
 */
suite('interactive-review save-vs-external-edit classification', function () {
  this.timeout(30000);

  // Absorb cold-host flakiness: the very first enable against a freshly-booted extension
  // host can hit a transient EPIPE in the baseline git subprocess (git hash-object --stdin).
  // The full suite warms up in earlier files; when this suite runs first (e.g. via --grep),
  // do one throwaway enable/disable cycle so the real tests run against a warm host.
  suiteSetup(async function () {
    this.timeout(60000);
    cleanWorkspace();
    try { await enableReview(); } catch { /* warmup */ }
    try { await disableReview(); } catch { /* warmup */ }
    cleanWorkspace();
  });

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  // Drive the disk-change handler deterministically for a path.
  async function fireDiskChange(filePath: string): Promise<void> {
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    await fw.onDiskChange(vscode.Uri.file(filePath));
  }

  test('external edit to an OPEN file enters reviewing (not absorbed) — the reported bug', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'open-edit.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined);

    // The file is open and clean in the editor — the case the bug hinges on.
    await openDocInEditor(filePath);

    // Claude writes from the terminal.
    const edited = 'original\nclaude edit\n';
    writeFileExternally(filePath, edited);

    // Let VSCode silently reload the clean buffer to match disk, reproducing the exact
    // state that fooled the old buffer-match heuristic. Best-effort: the classification
    // is now buffer-independent, so proceed even if the reload hasn't landed.
    try {
      await waitForCondition(() => findOpenDoc(filePath)?.getText() === edited, 3000);
    } catch { /* reload timing is not required for correctness */ }

    await fireDiskChange(filePath);

    const sm = getStateManager();
    assert.strictEqual(
      sm.getFile(filePath)?.status, 'reviewing',
      'An external edit to an open file must enter reviewing, not be silently absorbed',
    );
    // Baseline must NOT be advanced to the edit — otherwise the edit is unrecoverable
    // even by a later refresh (rebuildState compares disk vs baseline).
    assert.strictEqual(
      gitGetBaseline(root, rel), 'original\n',
      'Baseline must be preserved so the edit stays reviewable',
    );
  });

  test('external edit to a CLOSED tracked file enters reviewing (baseline preserved)', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'closed-edit.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined);

    // No editor open for this file.
    assert.strictEqual(findOpenDoc(filePath), undefined, 'precondition: file not open');

    writeFileExternally(filePath, 'original\nexternal\n');
    await fireDiskChange(filePath);

    const sm = getStateManager();
    assert.strictEqual(sm.getFile(filePath)?.status, 'reviewing', 'Closed-file external edit must review');
    assert.strictEqual(gitGetBaseline(root, rel), 'original\n', 'Baseline must be preserved');
  });

  test('genuine manual save of an open file is absorbed (no review hunk)', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'user-save.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined);

    // User edits in the editor and saves → fires onDidSaveTextDocument.
    const editor = await openDocInEditor(filePath);
    await editor.edit(b => b.insert(new vscode.Position(1, 0), 'typed by user\n'));
    const saved = await editor.document.save();
    assert.ok(saved, 'document.save() should succeed');
    await sleep(100); // let the save listener record the token

    await fireDiskChange(filePath);

    const sm = getStateManager();
    assert.notStrictEqual(
      sm.getFile(filePath)?.status, 'reviewing',
      'A user save must not enter the review queue',
    );
  });

  test('KNOWN GAP (Cause B): external change with no baseline is silently absorbed', async () => {
    // Documents current behavior so a future intentional change is a visible test diff.
    // See docs/terminal-edits-not-captured.md §5 Cause B — a missed CREATE that surfaces
    // only as a CHANGE gets adopted as baseline with no review hunk. If we later decide
    // to surface these instead, flip this assertion.
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'no-baseline.txt');
    const rel = path.relative(root, filePath);

    await enableReview();

    // File exists on disk but was never snapshotted and never seen by onDiskCreate,
    // so it has no baseline — the Cause B precondition.
    writeFileExternally(filePath, 'appeared without a create event\n');
    assert.strictEqual(gitGetBaseline(root, rel), undefined, 'precondition: no baseline');

    await fireDiskChange(filePath);
    await sleep(300); // snapshotFile runs on the async git queue

    const sm = getStateManager();
    assert.notStrictEqual(
      sm.getFile(filePath)?.status, 'reviewing',
      'Current (documented) behavior: no-baseline external change is absorbed, not reviewed',
    );
  });
});
