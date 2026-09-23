import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline, waitForCondition, waitForWatcher, settle, readSysctl,
  enableReview, disableReview, writeFileExternally, cleanWorkspace,
  getStateManager, openDocInEditor, findOpenDoc,
} from './helpers';

/**
 * LIVE end-to-end validation of the save-event classification, driven through the REAL
 * FileSystemWatcher — no test seam, no manual onDiskChange call. This exercises the exact
 * path a user hits: an external process writes a file that is open+clean, VSCode silently
 * reloads the buffer, and the extension must still surface the edit for review.
 *
 * These tests depend on real watcher delivery and must fail if it breaks. They used to
 * fall back to the refresh path when the watcher stayed quiet, on the belief that the
 * headless host dropped external raw-fs events — retracted 2026-08-10 (design.md §4c.1).
 * The fallback made the suite's only live-watcher coverage unfalsifiable: with the watcher
 * disconnected, the rescan reached the same end state and the test still passed. Waits here
 * are therefore `waitForWatcher` (no nudge) and negative assertions are gated on `settle`.
 * If one flakes, check inotify starvation first (docs/test-strategy.md), then treat it as a
 * watcher bug. Assertions prove the fix's net effect: external edit → reviewing + baseline
 * kept; user save → absorbed.
 */
suite('interactive-review LIVE save-event classification', function () {
  this.timeout(60000);

  suiteSetup(async function () {
    this.timeout(60000);
    cleanWorkspace();
    try { await enableReview(); } catch { /* warmup */ }
    try { await disableReview(); } catch { /* warmup */ }
    cleanWorkspace();
  });

  setup(function () { cleanWorkspace(); });
  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('LIVE: terminal edit to an open file surfaces for review via the real watcher', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'live-open.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined);

    // Really open the file, clean, in a real editor tab.
    await openDocInEditor(filePath);

    // Simulate Claude editing from the terminal (a real external write to disk).
    const edited = 'original\nedit from terminal\n';
    writeFileExternally(filePath, edited);

    // VSCode silently reloads the clean buffer to match disk — the exact state that fooled
    // the old heuristic, and the ONLY thing separating this test from the filewatch ones
    // (none of which open an editor). Asserted, not logged: when it was merely logged, a
    // run where the reload did not happen still passed green while testing nothing this
    // file is for.
    try {
      await waitForCondition(() => findOpenDoc(filePath)?.getText() === edited);
    } catch {
      throw new Error('precondition lost: VSCode did not silently reload the clean open buffer '
        + `to match disk. buffer=${JSON.stringify(findOpenDoc(filePath)?.getText())} `
        + `disk=${JSON.stringify(fs.readFileSync(filePath, 'utf-8'))}`);
    }

    // The REAL watcher must surface it on its own — no nudge, no seam. That is this
    // test's entire subject, so there is deliberately no rescan fallback here.
    // On timeout, report what actually happened: this is the test most likely to fail on
    // a starved box, and a bare "condition not met" cannot tell undelivered-event apart
    // from delivered-but-misclassified. (Same reason as deletedLens.setupDeletedFile.)
    const sm = getStateManager();
    try {
      await waitForWatcher(() => sm.getFile(filePath)?.status === 'reviewing');
    } catch {
      throw new Error('live watcher never surfaced the external edit: '
        + `state=${JSON.stringify(sm.getFile(filePath))} `
        + `onDisk=${JSON.stringify(fs.readFileSync(filePath, 'utf-8'))} `
        + `baselineInGit=${JSON.stringify(gitGetBaseline(root, rel))} `
        + `inotifyMaxInstances=${readSysctl('max_user_instances')}`);
    }

    assert.strictEqual(sm.getFile(filePath)?.status, 'reviewing',
      'external edit to an open file must surface for review');
    assert.strictEqual(gitGetBaseline(root, rel), 'original\n',
      'baseline must be preserved (edit stays reviewable, not absorbed)');
  });

  test('LIVE: a genuine manual save of an open file is NOT surfaced', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'live-save.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableReview();
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined);

    const editor = await openDocInEditor(filePath);
    await editor.edit(b => b.insert(new vscode.Position(1, 0), 'typed by user\n'));
    const saved = await editor.document.save(); // real save → real onDidSaveTextDocument
    assert.ok(saved, 'save should succeed');

    // Negative assertion: a fixed sleep here would pass whenever the event is merely
    // late, i.e. on broken code. Canary-settle instead — it proves the watcher has
    // delivered everything written before it, so "not reviewing" means absorbed.
    const sm = getStateManager();
    await settle({ canary: true });

    assert.notStrictEqual(sm.getFile(filePath)?.status, 'reviewing',
      'a user save must not enter the review queue');

    // "Not reviewing" alone is also true of a file that was dropped from tracking or never
    // seen — `FileStatus` is only 'idle' | 'reviewing', so `?.status` on an absent file is
    // undefined and passes. Absorb has a positive signal: fileWatcher.ts:747 folds the save
    // into the baseline with no hunk, so the baseline must ADVANCE to the saved content.
    // That is the exact mirror of the first test's "baseline preserved", and it is what
    // distinguishes absorbed from never-delivered. The write is queued, hence the wait.
    const absorbed = 'original\ntyped by user\n';
    try {
      await waitForCondition(() => gitGetBaseline(root, rel) === absorbed);
    } catch {
      throw new Error('user save was not absorbed into the baseline: '
        + `baselineInGit=${JSON.stringify(gitGetBaseline(root, rel))} `
        + `expected=${JSON.stringify(absorbed)} `
        + `onDisk=${JSON.stringify(fs.readFileSync(filePath, 'utf-8'))} `
        + `state=${JSON.stringify(sm.getFile(filePath))}`);
    }
  });
});
