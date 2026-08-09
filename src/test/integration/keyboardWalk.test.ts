import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import assert from 'assert';
import {
  getWorkspaceRoot, sleep, waitForCondition, waitForReviewing, gitGetBaseline,
  enableReview, disableReview, writeFileExternally, cleanWorkspace,
  getStateManager, getReviewPanel,
} from './helpers';

/**
 * Task 5.3 — the multi-file keyboard walk, driven end-to-end in a real VS Code window.
 *
 * Every action goes through the same commands the keybindings are bound to
 * (`interactiveReview.acceptHunk` = Alt+A, `.rejectHunk` = Alt+R, `.nextHunk` = Alt+N),
 * each of which resolves its target from `vscode.window.activeTextEditor` — so this
 * exercises the real cursor-resolution path, not a by-path shortcut.
 *
 * It logs the observable UI state at each step (active pane, cursor line, tab title,
 * queue depth) so the run reads as a transcript of what a user would see.
 */
suite('interactive-review multi-file keyboard walk (task 5.3)', function () {
  this.timeout(120000);

  setup(function () { cleanWorkspace(); });

  teardown(async function () {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try { await disableReview(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  /** Snapshot of what the user can see right now. */
  function ui(): string {
    const ed = vscode.window.activeTextEditor;
    const tab = vscode.window.tabGroups.all.flatMap(g => g.activeTab ? [g.activeTab] : [])[0];
    const panel = getReviewPanel();
    const st = panel?.panelStateForTest();
    const where = ed
      ? `${path.basename(ed.document.uri.fsPath)} [${ed.document.uri.scheme}] L${ed.selection.active.line + 1}`
      : 'no active editor';
    const queue = st ? `${st.totalFiles} file(s), +${st.totalAdded}/-${st.totalRemoved}` : 'panel n/a';
    return `active=${where} | tab="${tab?.label ?? 'none'}" | queue=${queue}`;
  }

  function pendingCount(filePath: string): number {
    const st = getReviewPanel()?.panelStateForTest();
    return st?.files.find((f: any) => f.filePath === filePath)?.pendingCount ?? 0;
  }

  test('walks a 3-file changeset to completion using only keybinding commands', async () => {
    const root = getWorkspaceRoot();
    const names = ['alpha.txt', 'bravo.txt', 'charlie.txt'];
    const paths = names.map(n => path.join(root, n));

    // ── Baseline: 3 files, 9 lines each ──
    const base = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    for (const p of paths) writeFileExternally(p, base);
    await sleep(500); // let the create-watcher settle before the snapshot

    await enableReview();
    // The baseline must actually be recorded before we edit, or the files get treated as
    // brand-new (null baseline) and the whole walk measures the wrong thing.
    await waitForCondition(() => names.every(n => gitGetBaseline(root, n) === base), 10000);
    await waitForCondition(() => getReviewPanel().panelStateForTest().totalFiles === 0, 10000);
    console.log(`\n[walk] begin review → ${ui()}`);

    // ── An "agent" edits all three, two separate hunks per file ──
    for (const p of paths) {
      const lines = base.split('\n');
      lines[1] = 'line 2 CHANGED';   // hunk 1 (near top)
      lines[7] = 'line 8 CHANGED';   // hunk 2 (near bottom)
      writeFileExternally(p, lines.join('\n'));
    }
    for (const p of paths) await waitForReviewing(p);

    const panel = getReviewPanel();
    const sm = getStateManager();
    let state = panel.panelStateForTest();
    console.log(`[walk] after edits → ${ui()}`);
    assert.strictEqual(state.totalFiles, 3, 'all three files should be queued');
    for (const p of paths) {
      assert.strictEqual(pendingCount(p), 2, `${path.basename(p)} should have 2 pending hunks`);
    }

    // ── Open the first file the way a panel click does ──
    await (panel as any).openDiffEditor(paths[0]);
    await sleep(600);
    console.log(`[walk] opened first file → ${ui()}`);

    const ed0 = vscode.window.activeTextEditor;
    assert.ok(ed0, 'a diff pane should be active');
    assert.strictEqual(ed0.document.uri.scheme, 'file',
      'the *modified* (editable) pane must be active — this is what activeReviewTarget requires');
    assert.strictEqual(ed0.document.uri.fsPath, paths[0], 'should be on the first queued file');

    // ── Alt+N: navigate between hunks within a file ──
    const lineBefore = vscode.window.activeTextEditor!.selection.active.line;
    await vscode.commands.executeCommand('interactiveReview.nextHunk');
    await sleep(250);
    const lineAfter = vscode.window.activeTextEditor!.selection.active.line;
    console.log(`[walk] Alt+N: cursor L${lineBefore + 1} → L${lineAfter + 1}`);
    assert.notStrictEqual(lineAfter, lineBefore, 'Alt+N should move the cursor to another hunk');

    // Alt+P back again — navigation is symmetric.
    await vscode.commands.executeCommand('interactiveReview.prevHunk');
    await sleep(250);
    console.log(`[walk] Alt+P: cursor → L${vscode.window.activeTextEditor!.selection.active.line + 1}`);

    // ── The walk: Alt+A / Alt+R until the queue drains ──
    // alpha: accept both hunks. bravo: reject both. charlie: mixed.
    const plan: Record<string, 'accept' | 'reject' | 'mixed'> = {
      'alpha.txt': 'accept', 'bravo.txt': 'reject', 'charlie.txt': 'mixed',
    };

    let steps = 0;
    let acceptedNext = true; // for 'mixed', alternate
    while (getReviewPanel().panelStateForTest().totalFiles > 0 && steps < 30) {
      const ed = vscode.window.activeTextEditor;
      assert.ok(ed && ed.document.uri.scheme === 'file',
        `step ${steps}: keybindings need a file-scheme active editor, got ${ed?.document.uri.scheme}`);
      const name = path.basename(ed.document.uri.fsPath);
      const mode = plan[name] ?? 'accept';
      const action = mode === 'mixed' ? (acceptedNext ? 'accept' : 'reject') : mode;
      if (mode === 'mixed') acceptedNext = !acceptedNext;

      const cmd = action === 'accept' ? 'interactiveReview.acceptHunk' : 'interactiveReview.rejectHunk';
      await vscode.commands.executeCommand(cmd);
      await sleep(700); // let the resolve → close-stale-tabs → cross-file advance settle
      steps++;
      console.log(`[walk] step ${steps}: ${action} on ${name} → ${ui()}`);
    }

    console.log(`[walk] complete after ${steps} step(s) → ${ui()}`);
    assert.ok(steps < 30, 'walk should terminate, not spin');

    // ── The queue drained and every file left reviewing ──
    const finalState = getReviewPanel().panelStateForTest();
    assert.strictEqual(finalState.totalFiles, 0, 'queue should be empty');
    for (const p of paths) {
      const f = sm.getFile(p);
      assert.ok(!f || f.status !== 'reviewing', `${path.basename(p)} should have exited reviewing`);
    }

    // ── Content matches the disposition: accepted kept, rejected reverted ──
    const alpha = fs.readFileSync(paths[0], 'utf-8');
    assert.ok(alpha.includes('line 2 CHANGED') && alpha.includes('line 8 CHANGED'),
      'alpha: both hunks accepted → both edits survive');

    const bravo = fs.readFileSync(paths[1], 'utf-8');
    assert.ok(!bravo.includes('CHANGED'), 'bravo: both hunks rejected → back to baseline');
    assert.strictEqual(bravo, base, 'bravo should be byte-identical to its baseline');

    const charlie = fs.readFileSync(paths[2], 'utf-8');
    const charlieChanges = (charlie.match(/CHANGED/g) ?? []).length;
    assert.strictEqual(charlieChanges, 1, 'charlie: one accepted, one rejected → exactly one edit survives');

    console.log(`[walk] alpha=${JSON.stringify(alpha.split('\n').filter(l => l.includes('CHANGED')))}`);
    console.log(`[walk] bravo=baseline-restored charlie=${charlieChanges} edit(s) kept\n`);
  });
});
