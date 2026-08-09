import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { computeHunks, hunkId } from './diffEngine';
import { findFileDocument, findFileEditor, revealHunkPosition } from './editorUtils';
import { log } from './log';

import {
  acceptAllFiles,
  discardAllFiles,
  acceptFileByPath,
  discardFileByPath,
  acceptHunk,
  discardHunk,
} from './commands';

interface PanelState {
  enabled: boolean;
  ignorePatterns: string[];
  respectGitignore: boolean;
  clearOnBranchSwitch: boolean;
  quoteRotationInterval: number;
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  reviewComplete: boolean;
  files: PanelFile[];
}

interface PanelFile {
  filePath: string;
  fileName: string;
  dirName: string;
  addedLines: number;
  removedLines: number;
  pendingCount: number;
  isNew: boolean;
  isDeleted: boolean;
  hunks: PanelHunk[];
}

interface PanelHunk {
  id: string;
  filePath: string;
  newStart: number;
  newLines: number;
  oldLines: number;
}

export class ReviewPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private _loading: boolean = false;

  get loading(): boolean { return this._loading; }

  constructor(
    private context: vscode.ExtensionContext,
    private stateManager: StateManager,
    private fileWatcher: FileWatcher,
    private onStateChanged: () => void,
    private onBaselineChanged?: (filePath: string) => void,
    private onAfterHunkAction?: () => Promise<void>
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'ready') {
        if (this._loading) {
          this.view?.webview.postMessage({ type: 'loading', loading: true });
        } else {
          this.refresh();
        }
        return;
      }
      this.handleMessage(msg);
    });
  }

  refresh(): void {
    if (!this.view || this._loading) return;
    const state = this.buildPanelState();
    this.view.webview.postMessage({ type: 'update', state });
  }

  setLoading(loading: boolean): void {
    this._loading = loading;
    if (!this.view) return;
    if (loading) {
      this.view.webview.postMessage({ type: 'loading', loading: true });
    } else {
      // Send the real state immediately so there's no flash of the disabled screen
      const state = this.buildPanelState();
      this.view.webview.postMessage({ type: 'update', state });
    }
  }

  openSettings(): void {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'openSettings' });
  }

  /** Test-visibility: the panel state that would be posted to the webview. */
  panelStateForTest(): PanelState {
    return this.buildPanelState();
  }

  private buildPanelState(): PanelState {
    const files: PanelFile[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const [filePath, fileState] of this.stateManager.getAllFiles()) {
      if (fileState.status !== 'reviewing') continue;

      const fileExists = fs.existsSync(filePath);
      let currentContent: string;
      if (!fileExists) {
        currentContent = '';
      } else {
        // findFileDocument's scheme filter is essential here: without it we could
        // read the read-only baseline doc and see zero changes. See editorUtils.
        const doc = findFileDocument(filePath);
        currentContent = doc ? doc.getText() : '';
        if (!doc) {
          try { currentContent = fs.readFileSync(filePath, 'utf-8'); } catch { currentContent = ''; }
        }
      }

      const pendingHunks = computeHunks(fileState.baseline, currentContent);
      const isNew = fileState.baseline === null;
      // Same predicate as StateManager.isDeleted, but reusing the `fileExists` stat
      // taken above rather than re-stat'ing: one filesystem read per file per refresh,
      // so `currentContent` and `isDeleted` can't describe two different moments.
      const isDeleted = !fileExists && fileState.baseline !== null;
      // Show 0-hunk entries for new files (null baseline, e.g. new empty file)
      // and deleted files (file missing from disk) so accept/discard remain available.
      if (pendingHunks.length === 0 && !isNew && !isDeleted) continue;

      const addedLines = pendingHunks.reduce((s, h) => s + h.newLines, 0);
      const removedLines = pendingHunks.reduce((s, h) => s + h.oldLines, 0);
      totalAdded += addedLines;
      totalRemoved += removedLines;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? '';
      const relPath = path.relative(rootPath, filePath);
      const fileName = path.basename(filePath);
      const dirName = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);

      files.push({
        filePath,
        fileName,
        dirName,
        addedLines,
        removedLines,
        pendingCount: pendingHunks.length,
        isNew,
        isDeleted,
        hunks: pendingHunks.map(h => ({
          id: hunkId(h),
          filePath,
          newStart: h.newStart,
          newLines: h.newLines,
          oldLines: h.oldLines,
        })),
      });
    }

    files.sort((a, b) => a.filePath.localeCompare(b.filePath));

    return {
      enabled: this.stateManager.enabled,
      ignorePatterns: this.stateManager.ignorePatterns,
      respectGitignore: this.stateManager.respectGitignore,
      clearOnBranchSwitch: this.stateManager.clearOnBranchSwitch,
      quoteRotationInterval: this.stateManager.quoteRotationInterval,
      totalFiles: files.length,
      totalAdded,
      totalRemoved,
      reviewComplete: this.stateManager.reviewComplete,
      files,
    };
  }

  private async handleMessage(msg: {
    command: string;
    filePath?: string;
    hunkId?: string;
    folders?: string[];
    value?: boolean;
  }): Promise<void> {
    switch (msg.command) {
      case 'beginReview':
        await vscode.commands.executeCommand('interactiveReview.beginReview');
        break;
      case 'endReview':
        await vscode.commands.executeCommand('interactiveReview.endReview');
        break;
      case 'setIgnorePatterns':
        if (msg.folders !== undefined) {
          await vscode.commands.executeCommand('interactiveReview.setIgnorePatterns', msg.folders);
        }
        break;
      case 'setRespectGitignore':
        if (msg.value !== undefined) {
          await vscode.commands.executeCommand('interactiveReview.setRespectGitignore', msg.value);
        }
        break;
      case 'setClearOnBranchSwitch':
        if (msg.value !== undefined) {
          this.stateManager.setClearOnBranchSwitch(msg.value);
        }
        break;
      case 'setQuoteRotationInterval': {
        const interval = Number(msg.value);
        if (Number.isFinite(interval) && interval >= 0) {
          this.stateManager.setQuoteRotationInterval(interval);
          this.refresh();
        }
        break;
      }
      case 'acceptAll':
        await acceptAllFiles(this.stateManager, this.onStateChanged);
        break;
      case 'discardAll':
        await discardAllFiles(this.stateManager, this.fileWatcher, this.onStateChanged);
        break;
      case 'acceptFile':
        if (msg.filePath) {
          acceptFileByPath(this.stateManager, msg.filePath, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          });
        }
        break;
      case 'discardFile':
        if (msg.filePath) {
          await discardFileByPath(this.stateManager, this.fileWatcher, msg.filePath, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          });
        }
        break;
      case 'acceptHunk':
        if (msg.filePath && msg.hunkId) {
          acceptHunk(this.stateManager, msg.filePath, msg.hunkId, () => {
            this.onStateChanged();
            this.onBaselineChanged?.(msg.filePath!);
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          }, 'panel');
        }
        break;
      case 'discardHunk':
        if (msg.filePath && msg.hunkId) {
          await discardHunk(this.stateManager, this.fileWatcher, msg.filePath, msg.hunkId, () => {
            this.onStateChanged();
            void this.onAfterHunkAction?.().catch(err => log(`onAfterHunkAction: ${err}`));
          }, 'panel');
        }
        break;
      case 'openFile':
        if (msg.filePath) {
          log(`openFile(${path.basename(msg.filePath)}): opening in diffEditor`);
          await this.openDiffEditor(msg.filePath);
        }
        break;
      case 'openDeletedDiff':
        if (msg.filePath) {
          // Route through openDiffEditor rather than straight to the empty-diff
          // view: the panel's `isDeleted` state can be stale by the time the
          // click lands (file recreated since the last refresh), and
          // openDiffEditor re-checks live state and falls back to the normal
          // baseline ⟷ file diff.
          log(`openDeletedDiff(${path.basename(msg.filePath)}): opening in diffEditor`);
          await this.openDiffEditor(msg.filePath);
        }
        break;
      case 'jumpToHunk':
        if (msg.filePath && msg.hunkId) {
          log(`jumpToHunk(${path.basename(msg.filePath)}): hunkId=${msg.hunkId}, opening in diffEditor`);
          await this.openDiffEditor(msg.filePath, msg.hunkId);
        }
        break;
    }
  }

  /**
   * Force the review diff to render as a single-column inline (unified) view —
   * removed baseline lines in red directly above the added lines in green — rather
   * than the default side-by-side panes. `vscode.diff` exposes no per-call override,
   * so the only levers are global `diffEditor.*` settings; we nudge them (idempotent
   * — only writes when they differ) whenever we open a review diff:
   *   - `renderSideBySide` → false: single-column unified view.
   *   - `codeLens` → true: the diff editor hides CodeLenses by default, which would
   *     swallow our per-hunk Accept/Discard actions; opt back in.
   * These are deliberately global: they also affect git and other diffs while the
   * extension is in use.
   */
  private async ensureInlineDiff(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('diffEditor');
    if (cfg.get<boolean>('renderSideBySide') !== false) {
      await cfg.update('renderSideBySide', false, vscode.ConfigurationTarget.Global);
    }
    if (cfg.get<boolean>('codeLens') !== true) {
      await cfg.update('codeLens', true, vscode.ConfigurationTarget.Global);
    }
  }

  /**
   * Open a deleted file's diff as baseline ⟷ empty modified doc. This is what the
   * bottom panel already does on click; routing queue navigation through it too
   * means auto-advancing onto a deleted file no longer opens VS Code's
   * "file not found" error on the missing modified side.
   */
  private async openDeletedDiffEditor(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const baselineUri = vscode.Uri.file(filePath).with({ scheme: 'interactive-review-baseline' });
    // Empty modified side keyed to the real fsPath (see the content provider in
    // extension.ts) so the file-level Accept/Restore lenses render on this side.
    const emptyUri = vscode.Uri.file(filePath).with({ scheme: 'interactive-review-deleted' });
    await this.ensureInlineDiff();
    await vscode.commands.executeCommand('vscode.diff', baselineUri, emptyUri, `${fileName} (deleted)`);
  }

  private async openDiffEditor(filePath: string, targetHunkId?: string): Promise<void> {
    // Deleted files have no live modified side — route them to the empty-diff view
    // so navigation (and cross-file queue advance) never errors on a missing file.
    if (this.stateManager.isDeleted(filePath)) {
      await this.openDeletedDiffEditor(filePath);
      return;
    }

    const fileName = path.basename(filePath);
    const baselineUri = vscode.Uri.file(filePath).with({ scheme: 'interactive-review-baseline' });
    const currentUri = vscode.Uri.file(filePath);

    await this.ensureInlineDiff();
    await vscode.commands.executeCommand('vscode.diff', baselineUri, currentUri, `${fileName} (interactive-review)`);

    // Jump to the target hunk position in the diff editor's modified side.
    // findFileEditor prefers the embedded modified pane over a normal editor.
    const fileState = this.stateManager.getFile(filePath);
    const editor = findFileEditor(filePath);
    if (fileState && editor) {
      const hunks = computeHunks(fileState.baseline, editor.document.getText());
      const target = targetHunkId
        ? hunks.find(h => hunkId(h) === targetHunkId)
        : hunks[0];
      if (target) {
        revealHunkPosition(editor, target.newStart);
      }
    }
  }

  /**
   * Cross-file advance: after a file's last hunk is resolved, open the next
   * reviewing file at its first hunk so the user keeps walking the queue across
   * files without returning to the panel. Together with the existing within-file
   * revealNextHunk, this makes the whole changeset a single walkable queue.
   *
   * No-op if the just-resolved file still has pending hunks (within-file advance
   * handled it), or if no reviewing files remain (the review-complete state
   * surfaces closure instead).
   */
  async advanceToNextFile(resolvedFilePath: string): Promise<void> {
    if (this.stateManager.getFile(resolvedFilePath)?.status === 'reviewing') return;
    // resolvedFilePath has already exited reviewing, so it won't be a candidate.
    await this.openNextReviewingFile(resolvedFilePath);
  }

  /**
   * Open the next reviewing file after `fromPath` (sorted order, wrapping, excluding
   * `fromPath` itself) at its first hunk. Returns false if there is no other reviewing
   * file. Used both by post-resolution cross-file advance and by keyboard next-hunk
   * navigation past the last hunk of a file that is still being reviewed.
   */
  async openNextReviewingFile(fromPath: string): Promise<boolean> {
    const others = Array.from(this.stateManager.getAllFiles().entries())
      .filter(([fp, s]) => s.status === 'reviewing' && fp !== fromPath)
      .map(([fp]) => fp)
      .sort((a, b) => a.localeCompare(b));
    if (others.length === 0) return false;
    const next = others.find(fp => fp.localeCompare(fromPath) > 0) ?? others[0];
    await this.openReviewingFile(next);
    return true;
  }

  /** Open a reviewing file in the diff editor at its first hunk. */
  private async openReviewingFile(filePath: string): Promise<void> {
    await this.openDiffEditor(filePath);
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'panel.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'panel.js'));
    let html = fs.readFileSync(
      path.join(this.context.extensionUri.fsPath, 'media', 'panel.html'),
      'utf-8'
    );
    html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
    html = html.replace(/\{\{jsUri\}\}/g, jsUri.toString());
    html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
    return html;
  }
}
