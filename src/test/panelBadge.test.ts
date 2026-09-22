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
});
