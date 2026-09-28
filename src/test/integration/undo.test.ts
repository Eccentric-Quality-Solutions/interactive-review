import assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  disableReview, cleanWorkspace, getStateManager, getFileWatcher,
  setupReviewingFile, openDocInEditor, findOpenDoc,
} from './helpers';
import { discardFileByPath, editorUndoIO } from '../../commands';
import { undoHistory } from '../../undoHistory';

// ── Test suite ────────────────────────────────────────────────────────────────
//
// Undo writes a file's exact bytes with `workspace.fs.writeFile`, with the file open in an
// editor. These tests check the bytes on disk and the review queue. An open editor shows the
// bytes only once VS Code's file watcher reports the write, which sometimes does not happen,
// so the buffer is not checked here; see `todo.md` #8.
//
// This suite runs on its own copy of the modules (out-integration), so it installs the
// editor io on that copy's history rather than relying on the extension's.

suite('interactive-review undo', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableReview(); } catch { /* ignore */ }
    undoHistory.clear();
    cleanWorkspace();
  });

  test('undoing a discard of an open file puts its bytes back and it back in review', async () => {
    const filePath = await setupReviewingFile('undo-open.txt', 'before\n', 'after\n');
    await openDocInEditor(filePath);
    const sm = getStateManager();
    undoHistory.io = editorUndoIO(getFileWatcher());

    await discardFileByPath(sm, getFileWatcher(), filePath, () => {});
    assert.strictEqual(findOpenDoc(filePath)?.getText(), 'before\n', 'discard wrote through the editor');

    const entries = undoHistory.list(sm);
    assert.strictEqual(entries.length, 1, 'the discard was recorded');
    await undoHistory.undo(sm, 1, entries[0]);

    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'after\n', 'the discarded content is on disk');
    assert.strictEqual(sm.isReviewing(filePath), true, 'the file is back in review');
  });

  test('undoing a discard puts back exact bytes past save participants', async () => {
    const files = vscode.workspace.getConfiguration('files');
    await files.update('trimTrailingWhitespace', true, vscode.ConfigurationTarget.Global);
    try {
      const agent = 'after   \nkept  \n';
      const filePath = await setupReviewingFile('undo-trim.txt', 'before\n', agent);
      await openDocInEditor(filePath);
      const sm = getStateManager();
      undoHistory.io = editorUndoIO(getFileWatcher());

      await discardFileByPath(sm, getFileWatcher(), filePath, () => {});
      const entries = undoHistory.list(sm);
      assert.strictEqual(entries.length, 1, 'the discard was recorded');
      await undoHistory.undo(sm, 1, entries[0]);

      assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), agent, 'the agent\'s trailing spaces are on disk');
      assert.strictEqual(sm.isReviewing(filePath), true, 'the file is back in review');
    } finally {
      await files.update('trimTrailingWhitespace', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
