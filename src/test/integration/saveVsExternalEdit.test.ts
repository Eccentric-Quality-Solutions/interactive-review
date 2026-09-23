import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';

import {
  getWorkspaceRoot, gitGetBaseline, sleep, waitForCondition,
  enableReview, disableReview, writeFileExternally, cleanWorkspace,
  getStateManager, getFileWatcher, openDocInEditor, findOpenDoc,
} from './helpers';

/** UTF-8 byte-order mark, spelled out — it is invisible in source otherwise. */
const BOM = '\uFEFF';

/**
 * Regression coverage for the "Claude/terminal edits not captured" bug.
 * See docs/terminal-edits-not-captured.md.
 *
 * The extension must surface an external (AI/terminal) write for review while still
 * silently absorbing the user's own saves. The old heuristic distinguished the two by
 * comparing the open editor buffer against disk — which VSCode's silent reload of a
 * clean open buffer defeats. These tests exercise the classification directly.
 *
 * Scope: we invoke the private onDiskChange handler through the getFileWatcher() seam
 * rather than writing to disk, so these tests cover classification alone and cannot fail
 * for a delivery reason. (The seam predates the 2026-08-10 retraction of the "headless
 * Linux drops external events" premise — design.md §4c.1 — but isolating classification
 * is worth keeping on its own merits.) Live watcher delivery of the same path is covered
 * end-to-end, without a seam or a rescan fallback, in liveSaveEvent.test.ts.
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

    // Not-reviewing on its own is a weak claim: `FileStatus` is 'idle' | 'reviewing', so
    // `?.status` on a file that was dropped from tracking is undefined and passes too.
    // Absorb has a positive signal — fileWatcher.ts:747 folds the save into the baseline
    // with no hunk — so pin the baseline advancing. The write is queued, hence the wait.
    const absorbed = 'original\ntyped by user\n';
    try {
      await waitForCondition(() => gitGetBaseline(root, rel) === absorbed);
    } catch {
      throw new Error('user save was not absorbed into the baseline: '
        + `baselineInGit=${JSON.stringify(gitGetBaseline(root, rel))} `
        + `expected=${JSON.stringify(absorbed)} `
        + `state=${JSON.stringify(sm.getFile(filePath))}`);
    }
  });

  test('external change with no baseline is reviewed as a new file (former Cause B)', async () => {
    // Was the ADR-0008 characterization test pinning the silent absorb; flipped by
    // ADR-0012. A missed CREATE that surfaces only as a CHANGE is a genuine agent edit
    // and must reach the queue rather than being adopted as baseline.
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'no-baseline.txt');
    const rel = path.relative(root, filePath);

    await enableReview();

    // File exists on disk but was never snapshotted and never seen by onDiskCreate,
    // so it has no baseline — the Cause B precondition.
    writeFileExternally(filePath, 'appeared without a create event\n');
    assert.strictEqual(gitGetBaseline(root, rel), undefined, 'precondition: no baseline');

    await fireDiskChange(filePath);

    const sm = getStateManager();
    assert.strictEqual(
      sm.getFile(filePath)?.status, 'reviewing',
      'A no-baseline external change must be reviewed, not silently absorbed',
    );
    assert.strictEqual(
      sm.getFile(filePath)?.baseline, null,
      'Null baseline is what renders it as a new file',
    );
  });

  test('external change to a pre-existing binary with no baseline is skipped, not reviewed as new', async () => {
    // Enable skips binaries (`readBatch`), so a pre-existing asset has no baseline.
    // ADR-0012's fallthrough would otherwise queue it as a new file; Discard would then
    // trash an asset that already existed. Create of a new binary stays reviewable —
    // this test drives only the CHANGE handler (same seam as the Cause B test).
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'logo.png');
    const rel = path.relative(root, filePath);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    fs.writeFileSync(filePath, bytes);
    await enableReview();
    assert.strictEqual(gitGetBaseline(root, rel), undefined, 'precondition: binary never baselined');

    const sm = getStateManager();
    const watcher = getFileWatcher();
    // Drop a reviewing entry a late host-watcher create may have installed (create path
    // is intentionally open for new binaries). Suppress around the rewrite so only the
    // explicit fireDiskChange below exercises the change-path guard.
    if (sm.getFile(filePath)?.status === 'reviewing') {
      sm.removeFile(filePath);
    }
    watcher.suppressAll();
    try {
      fs.writeFileSync(filePath, Buffer.concat([bytes, Buffer.from([0x01])]));
    } finally {
      watcher.resumeAll();
    }
    await fireDiskChange(filePath);

    assert.notStrictEqual(
      sm.getFile(filePath)?.status, 'reviewing',
      'A rewrite of a pre-existing binary must not appear as a new file',
    );
    assert.strictEqual(gitGetBaseline(root, rel), undefined, 'And must still not become a baseline');
  });

  test('a change during the enable snapshot is still absorbed, not shown as new', async () => {
    // The other half of ADR-0012: the absorb survives where it was actually justified.
    // Without this, the flip above would repaint every file the enable snapshot has not
    // reached yet as a whole-file "new file" hunk.
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'during-snapshot.txt');

    await enableReview();

    const sm = getStateManager();
    const watcher = getFileWatcher();
    // Reopen the enable window by hand via the same methods `enableReview` uses.
    // Reproducing the real race would need a snapshot slow enough to fire a change
    // inside it — a timing test, not a behaviour one.
    watcher.beginSnapshot();
    try {
      // Created after enable and never seen by onDiskCreate: no baseline, no state
      // entry — the same precondition as the test above, differing only in the window.
      writeFileExternally(filePath, 'appeared mid-snapshot\n');
      await fireDiskChange(filePath);
      assert.notStrictEqual(
        sm.getFile(filePath)?.status, 'reviewing',
        'Mid-snapshot change must be adopted as baseline, not surfaced as a new file',
      );
      await waitForCondition(() => gitGetBaseline(root, path.relative(root, filePath)) !== undefined);
    } finally {
      watcher.endSnapshot();
    }
  });

  test('a hand-save of a BOM file is absorbed, not queued', async () => {
    // VS Code strips the BOM on open, so the save token holds BOM-less text while the
    // bytes it just wrote still carry one. The comparison used to be exact, so a user's
    // own save of any BOM'd file failed to match and landed in the review queue.
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'bom-save.txt');
    const rel = path.relative(root, filePath);

    fs.writeFileSync(filePath, BOM + 'original\n', 'utf-8');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined);

    const editor = await openDocInEditor(filePath);
    assert.ok(
      !editor.document.getText().startsWith(BOM),
      'precondition: VS Code strips the BOM from the buffer',
    );
    await editor.edit(b => b.insert(new vscode.Position(1, 0), 'typed by user\n'));
    assert.ok(await editor.document.save(), 'document.save() should succeed');
    await sleep(100); // let the save listener record the token

    await fireDiskChange(filePath);

    assert.notStrictEqual(
      getStateManager().getFile(filePath)?.status, 'reviewing',
      'A user save of a BOM file must not enter the review queue',
    );
  });

  test('an external edit to a BOM file still enters review', async () => {
    // The other side of the same normalization: absorbing on BOM difference must not
    // absorb anything else. This is the edit the tool exists to surface.
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'bom-external.txt');
    const rel = path.relative(root, filePath);

    fs.writeFileSync(filePath, BOM + 'original\n', 'utf-8');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined);

    fs.writeFileSync(filePath, BOM + 'original\nagent edit\n', 'utf-8');
    await fireDiskChange(filePath);

    assert.strictEqual(
      getStateManager().getFile(filePath)?.status, 'reviewing',
      'An external edit to a BOM file must still be reviewed',
    );
  });

  test('binary content is never written to the baseline', async () => {
    // `fs.readFile(path, 'utf-8')` does not throw on binary — it returns replacement
    // characters — so the adopt branches used to store a lossy decode as the baseline.
    // A baseline is what `discardHunk` writes back, so that decode could later overwrite
    // the real file. Pinned against the same adopt path the text case above exercises:
    // identical flow, identical window, opposite outcome.
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'asset.bin');
    const rel = path.relative(root, filePath);

    await enableReview();

    const sm = getStateManager();
    const watcher = getFileWatcher();
    watcher.beginSnapshot();
    try {
      fs.writeFileSync(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]));
      await fireDiskChange(filePath);
      await sleep(300); // the text case would have drained its git write by now

      assert.strictEqual(
        gitGetBaseline(root, rel), undefined,
        'Binary content must not become a baseline',
      );
      assert.notStrictEqual(
        sm.getFile(filePath)?.status, 'reviewing',
        'Nor should it be diffed as text',
      );
    } finally {
      watcher.endSnapshot();
    }
  });
});
