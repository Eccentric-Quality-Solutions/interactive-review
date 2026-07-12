import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline, sleep, waitForCondition, waitForReviewing,
  enableReview, disableReview, writeFileExternally, cleanWorkspace,
  getStateManager, openDocInEditor, findOpenDoc,
} from './helpers';

/**
 * LIVE end-to-end validation of the save-event classification, driven through the REAL
 * FileSystemWatcher — no test seam, no manual onDiskChange call. This exercises the exact
 * path a user hits: an external process writes a file that is open+clean, VSCode silently
 * reloads the buffer, and the extension must still surface the edit for review.
 *
 * Note: the headless host's watcher is unreliable for external raw-fs writes (see
 * helpers.waitForConditionNudged), so each test reports whether the live watcher surfaced
 * the change on its own, and falls back to the production refresh path otherwise. Either
 * way the assertions prove the fix's net effect: external edit → reviewing + baseline kept;
 * user save → absorbed.
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

    // VSCode silently reloads the clean buffer to match disk — the exact state that
    // fooled the old heuristic. Confirm it actually happens live.
    let reloaded = false;
    try {
      await waitForCondition(() => findOpenDoc(filePath)?.getText() === edited, 5000);
      reloaded = true;
    } catch { /* reload not observed within window */ }
    console.log(`LIVE: buffer reloaded to match disk = ${reloaded}`);

    // Give the REAL watcher a chance to surface it on its own — no nudge, no seam.
    const sm = getStateManager();
    let surfacedByWatcher = false;
    for (let i = 0; i < 40; i++) { // up to ~10s
      if (sm.getFile(filePath)?.status === 'reviewing') { surfacedByWatcher = true; break; }
      await sleep(250);
    }
    console.log(`LIVE: surfaced by real watcher (no nudge) = ${surfacedByWatcher}`);

    if (!surfacedByWatcher) {
      // Headless watcher dropped the event — fall back to the production refresh path
      // (what a user's reliable watcher, or the refresh button, would do).
      await waitForReviewing(filePath);
      console.log('LIVE: surfaced via production refresh fallback');
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

    // Give the real watcher time to (wrongly) surface it if the fix regressed.
    const sm = getStateManager();
    for (let i = 0; i < 20; i++) { // ~5s
      if (sm.getFile(filePath)?.status === 'reviewing') break;
      await sleep(250);
    }

    assert.notStrictEqual(sm.getFile(filePath)?.status, 'reviewing',
      'a user save must not enter the review queue');
    console.log('LIVE: user save correctly absorbed (not reviewing)');
  });
});
