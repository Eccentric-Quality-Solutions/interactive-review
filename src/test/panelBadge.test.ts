import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { panelBadge, ReviewPanel } from '../reviewPanel';
import type { FileWatcher } from '../fileWatcher';
import type { StateManager } from '../stateManager';
import type { FileState } from '../types';

declare const global: Record<string, unknown>;

/** The file count on the panel's tab, the way Problems and Ports show theirs. */
describe('panelBadge', () => {
  it('counts the files the panel lists', () => {
    assert.deepEqual(panelBadge({ enabled: true, totalFiles: 3 }), { value: 3, tooltip: '3 files to review' });
    assert.deepEqual(panelBadge({ enabled: true, totalFiles: 1 }), { value: 1, tooltip: '1 file to review' });
  });

  it('shows nothing once the queue is empty, rather than a 0', () => {
    assert.equal(panelBadge({ enabled: true, totalFiles: 0 }), undefined);
  });

  it('shows nothing outside a review session', () => {
    assert.equal(panelBadge({ enabled: false, totalFiles: 3 }), undefined);
  });
});

/**
 * The wiring, not just the arithmetic: a real `ReviewPanel` refreshing into a fake view
 * sets the badge from the same state it posts to the webview.
 */
describe('ReviewPanel badge wiring', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-badge-')); global.__reviewTestRoot = root; });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); delete global.__reviewTestRoot; });

  function panelWith(enabled: boolean, files: Map<string, FileState>) {
    const sm = {
      enabled, ignorePatterns: [], respectGitignore: true, clearOnBranchSwitch: false,
      quoteRotationInterval: 0, reviewComplete: false,
      getAllFiles: () => files,
    } as unknown as StateManager;
    const panel = new ReviewPanel({} as vscode.ExtensionContext, sm, {} as FileWatcher, () => {});
    const view = { badge: undefined as vscode.ViewBadge | undefined, webview: { postMessage: () => Promise.resolve(true) } };
    (panel as unknown as { view: unknown }).view = view;
    return { panel, view };
  }

  it('badges the number of files with pending changes on refresh, and clears it at the end', () => {
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    fs.writeFileSync(a, 'changed\n');
    fs.writeFileSync(b, 'changed\n');
    const files = new Map<string, FileState>([
      [a, { status: 'reviewing', baseline: 'original\n' }],
      [b, { status: 'reviewing', baseline: 'original\n' }],
    ]);
    const { panel, view } = panelWith(true, files);

    panel.refresh();
    assert.equal(view.badge?.value, 2);

    files.clear();
    panel.refresh();
    assert.equal(view.badge, undefined);
  });

  /**
   * The panel's "new" badge is a promise about what Discard will do, so it has to use the
   * same test Discard does — `nullReason === 'created'`, not "the baseline is null".
   *
   * A pre-existing binary, a file unreadable at Begin review, and one created inside the
   * enable snapshot's sliver all carry a null baseline, and `discardDeletesFile` leaves
   * every one of them on disk. Badging them "new" told the user the panel was about to
   * delete a file it will in fact leave exactly as it is. See `FileState.nullReason`.
   */
  it('badges a witnessed create "new" and an unbaselined file as unbaselined', () => {
    const created = path.join(root, 'created.txt');
    const unbaselined = path.join(root, 'unbaselined.txt');
    const edited = path.join(root, 'edited.txt');
    fs.writeFileSync(created, 'fresh\n');
    fs.writeFileSync(unbaselined, 'predates the session\n');
    fs.writeFileSync(edited, 'changed\n');
    const { panel } = panelWith(true, new Map<string, FileState>([
      [created, { status: 'reviewing', baseline: null, nullReason: 'created' }],
      [unbaselined, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }],
      [edited, { status: 'reviewing', baseline: 'original\n' }],
    ]));

    const byPath = new Map(panel.panelStateForTest().files.map(f => [f.filePath, f]));

    assert.deepEqual(
      { isNew: byPath.get(created)?.isNew, isUnbaselined: byPath.get(created)?.isUnbaselined },
      { isNew: true, isUnbaselined: false },
    );
    assert.deepEqual(
      { isNew: byPath.get(unbaselined)?.isNew, isUnbaselined: byPath.get(unbaselined)?.isUnbaselined },
      { isNew: false, isUnbaselined: true },
      'a null baseline with no witnessed create is not a new file',
    );
    assert.deepEqual(
      { isNew: byPath.get(edited)?.isNew, isUnbaselined: byPath.get(edited)?.isUnbaselined },
      { isNew: false, isUnbaselined: false },
    );
  });

  /**
   * `isNew` narrowed, but the rule deciding which rows are *listed* did not: it keys on the
   * null baseline, so a pre-existing empty file — 0 hunks, nothing to diff — still has a row
   * to accept or discard from. Narrowing that too would have dropped it out of the queue
   * with no way to resolve it.
   */
  it('still lists a 0-hunk unbaselined file', () => {
    const empty = path.join(root, 'empty.txt');
    fs.writeFileSync(empty, '');
    const { panel } = panelWith(true, new Map<string, FileState>([
      [empty, { status: 'reviewing', baseline: null, nullReason: 'unbaselined' }],
    ]));

    const listed = panel.panelStateForTest().files;
    assert.equal(listed.length, 1, 'an empty unbaselined file keeps its row');
    assert.equal(listed[0].pendingCount, 0);
  });
});
