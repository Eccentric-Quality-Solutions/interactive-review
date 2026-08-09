import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ignoreLib: ((options?: { ignoreCase?: boolean }) => import('ignore').Ignore) & typeof import('ignore') = require('ignore');
type Ignore = import('ignore').Ignore;
import { StateManager } from './stateManager';
import { computeHunks } from './diffEngine';
import { log } from './log';
import { normalizePath } from './pathNormalize';

// Transform gitignore rules from a sub-directory so they work in a single
// root-level matcher. Adds the directory's relative path as prefix, handling
// anchored (/), unanchored (any-depth), negation (!) and comment lines.
function prefixGitignoreRules(content: string, prefix: string): string {
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    const neg = trimmed.startsWith('!');
    let pattern = neg ? trimmed.slice(1) : trimmed;

    if (pattern.startsWith('/')) {
      // Anchored to directory: /dist → prefix/dist
      pattern = prefix + pattern;
    } else if (!pattern.includes('/') || (pattern.endsWith('/') && !pattern.slice(0, -1).includes('/'))) {
      // No internal slash (or only trailing slash): matches any depth
      // *.tmp → prefix/**/*.tmp, build/ → prefix/**/build/
      pattern = prefix + '/**/' + pattern;
    } else {
      // Has internal slash: relative to directory: foo/bar → prefix/foo/bar
      pattern = prefix + '/' + pattern;
    }

    return (neg ? '!' : '') + pattern;
  }).join('\n');
}

export class FileWatcher {
  private disposables: vscode.Disposable[] = [];
  private selfEditFiles: Set<string> = new Set();
  // Content VSCode itself just saved (manual save or auto-save), keyed by path.
  // A disk change whose content matches a pending save is a user save → absorbed
  // into the baseline. Anything else is an external/AI write → surfaced for review.
  // This replaces the old buffer-match heuristic, which VSCode's silent reload of
  // clean open buffers made unreliable (see docs/terminal-edits-not-captured.md).
  private pendingManualSaves: Map<string, string> = new Map();
  // Files being deleted by the user via VSCode (explorer / applyEdit)
  private pendingUserDeletes: Set<string> = new Set();
  // Old paths of in-progress user renames — suppress onDiskDelete without extra git ops
  private pendingRenameOldPaths: Set<string> = new Set();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private onStateChanged: () => void;
  private onIgnoreRulesChanged: (() => void) | undefined;
  // Compiled ignore instance from workspace .gitignore
  private gitignoreMatcher: Ignore = ignoreLib();
  // When true, all file-system events are suppressed (used during branch switch)
  private _suppressed: boolean = false;

  constructor(
    private stateManager: StateManager,
    onStateChanged: () => void,
    onIgnoreRulesChanged?: () => void
  ) {
    this.onStateChanged = onStateChanged;
    this.onIgnoreRulesChanged = onIgnoreRulesChanged;
  }

  register(context: vscode.ExtensionContext): void {
    this.loadGitignore();

    const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
    // `**/.gitignore` also matches the `*` gitignore the extension writes into its own
    // state dir on every beginReview. That file never affects which project files are
    // ignored (shouldIgnore short-circuits the whole state dir), so reacting to it just
    // schedules a pointless reload + ignore-sync that races whatever the user is doing.
    const onGitignoreEvent = (uri: vscode.Uri) => {
      const stateDir = this.stateManager.dir;
      if (stateDir && normalizePath(uri.fsPath).startsWith(stateDir + path.sep)) return;
      this.loadGitignore();
      this.onIgnoreRulesChanged?.();
    };
    gitignoreWatcher.onDidChange(onGitignoreEvent);
    gitignoreWatcher.onDidCreate(onGitignoreEvent);
    gitignoreWatcher.onDidDelete(onGitignoreEvent);
    this.disposables.push(gitignoreWatcher);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange(uri => this.onDiskChange(uri));
    watcher.onDidDelete(uri => this.onDiskDelete(uri));
    watcher.onDidCreate(uri => this.onDiskCreate(uri));
    this.disposables.push(watcher);

    // onWillDeleteFiles fires for user-initiated deletes (explorer, applyEdit),
    // but NOT for external tool deletes — use this to distinguish the two.
    // onDidDeleteFiles may fire before FileSystemWatcher.onDidDelete, so we use
    // a short timeout as fallback cleanup instead of removing immediately.
    this.disposables.push(
      vscode.workspace.onWillDeleteFiles(e => {
        for (const uri of e.files) {
          this.pendingUserDeletes.add(normalizePath(uri.fsPath));
        }
      }),
      vscode.workspace.onDidDeleteFiles(e => {
        setTimeout(() => {
          for (const uri of e.files) {
            this.pendingUserDeletes.delete(normalizePath(uri.fsPath));
          }
        }, 500);
      }),
      // onWillRenameFiles fires BEFORE the actual rename. Record paths so
      // the subsequent onDiskDelete/onDiskCreate events are suppressed, and
      // migrate state+git. UI refresh is deferred to onDidRenameFiles because
      // the new file doesn't exist on disk yet when onWill fires.
      vscode.workspace.onWillRenameFiles(e => {
        for (const { oldUri, newUri } of e.files) {
          const oldPath = normalizePath(oldUri.fsPath);
          const newPath = normalizePath(newUri.fsPath);
          if (!this.stateManager.enabled) continue;
          log(`rename: ${path.basename(oldPath)} → ${path.basename(newPath)}`);
          this.pendingRenameOldPaths.add(oldPath);
          this.selfEditFiles.add(newPath);
          this.stateManager.renameFile(oldPath, newPath);
        }
      }),
      vscode.workspace.onDidRenameFiles(e => {
        let needsRefresh = false;
        for (const { oldUri, newUri } of e.files) {
          this.pendingRenameOldPaths.delete(normalizePath(oldUri.fsPath));
          this.selfEditFiles.delete(normalizePath(newUri.fsPath));
          if (this.stateManager.getFile(normalizePath(newUri.fsPath))) {
            needsRefresh = true;
          }
        }
        if (needsRefresh) this.onStateChanged();
      }),
    );

    const docChange = vscode.workspace.onDidChangeTextDocument(e => {
      this.onDocumentChange(e);
    });
    this.disposables.push(docChange);

    // Record every VSCode-initiated save (manual Ctrl+S AND all auto-save modes) so
    // onDiskChange/onDiskCreate can tell a user save from an external write by event
    // provenance rather than by comparing buffer content — the only reliable signal,
    // since VSCode silently reloads a clean open buffer to match an external write,
    // making buffer==disk true for BOTH a user save and an AI edit to an open file.
    const saveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      // Only record while enabled: when disabled, onDiskChange early-returns before
      // consuming, so tokens would never be reclaimed. The listener lives for the whole
      // extension lifetime (register() runs once at activation), so without this guard
      // every save would retain the file's full content even for users who never enable.
      if (!this.stateManager.enabled) return;
      if (doc.uri.scheme !== 'file') return;
      this.pendingManualSaves.set(normalizePath(doc.uri.fsPath), doc.getText());
    });
    this.disposables.push(saveListener);

    context.subscriptions.push(...this.disposables);
  }

  /**
   * Re-read all workspace .gitignore files synchronously. Called on enable so the
   * snapshot respects gitignore rules that were created before enabling, without
   * waiting for the async filesystem watcher to fire (which is unreliable on Linux).
   */
  reloadGitignore(): void {
    this.loadGitignore();
  }

  private loadGitignore(): void {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.gitignoreMatcher = ignoreLib();
    if (!rootPath) return;

    // Load global gitignore (core.excludesfile or default ~/.config/git/ignore)
    try {
      const { execFileSync } = require('child_process');
      const globalPath = (execFileSync('git', ['config', '--global', 'core.excludesfile'], {
        encoding: 'utf-8',
        timeout: 3000,
      }) as string).trim();
      if (globalPath) {
        const resolved = globalPath.startsWith('~')
          ? path.join(require('os').homedir(), globalPath.slice(1))
          : globalPath;
        try {
          this.gitignoreMatcher.add(fs.readFileSync(resolved, 'utf-8'));
        } catch { /* file may not exist */ }
      }
    } catch {
      // No core.excludesfile configured — try default location
      try {
        const defaultPath = path.join(require('os').homedir(), '.config', 'git', 'ignore');
        this.gitignoreMatcher.add(fs.readFileSync(defaultPath, 'utf-8'));
      } catch { /* no global gitignore */ }
    }

    // Collect all .gitignore files recursively from workspace root.
    // Root .gitignore rules are added directly; sub-directory rules get a
    // relative-path prefix so the single matcher instance handles scoping.
    this.collectGitignores(rootPath, rootPath);
  }

  /**
   * Recursively collect .gitignore files starting from `dir`.
   * Skips directories already ignored by the current matcher state.
   */
  private collectGitignores(dir: string, rootPath: string): void {
    const gitignorePath = path.join(dir, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (dir === rootPath) {
        this.gitignoreMatcher.add(content);
      } else {
        const prefix = path.relative(rootPath, dir).replace(/\\/g, '/');
        this.gitignoreMatcher.add(prefixGitignoreRules(content, prefix));
      }
    } catch { /* no .gitignore in this directory */ }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootPath, full).replace(/\\/g, '/');
      // Skip directories already ignored — no need to descend
      if (this.gitignoreMatcher.ignores(rel + '/')) continue;
      this.collectGitignores(full, rootPath);
    }
  }

  /** Suppress all file-system event handling (used during branch switch). */
  suppressAll(): void {
    this._suppressed = true;
  }

  /** Resume file-system event handling after branch switch completes. */
  resumeAll(): void {
    this._suppressed = false;
  }

  /**
   * Consume-once check: did VSCode itself just save exactly `diskContent` to `filePath`?
   * Returns true only when a pending save is recorded for the path AND its content matches
   * the bytes now on disk, then clears the token. Exact match (not normalized) is deliberate:
   * a mismatch falls through to the review path (safe — at worst a spurious hunk on your own
   * save), whereas a loose match risks absorbing a genuine external edit (silent data loss).
   */
  private consumeManualSave(filePath: string, diskContent: string): boolean {
    const saved = this.pendingManualSaves.get(filePath);
    if (saved === undefined) return false;
    this.pendingManualSaves.delete(filePath);
    return saved === diskContent;
  }

  markSelfEdit(filePath: string): void {
    this.selfEditFiles.add(normalizePath(filePath));
  }

  clearSelfEdit(filePath: string): void {
    this.selfEditFiles.delete(normalizePath(filePath));
  }

  shouldIgnore(filePath: string, isDirectory?: boolean): boolean {
    if (!filePath) return false;

    const stateDir = this.stateManager.dir;
    if (stateDir && filePath.startsWith(stateDir + path.sep)) return true;
    if (stateDir && filePath === stateDir) return true;

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) return false;

    let relPath = '';
    try {
      relPath = vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false) || '';
    } catch {
      relPath = '';
    }

    if (!relPath) {
      try {
        relPath = path.relative(rootPath, filePath);
      } catch {
        relPath = '';
      }
    }

    relPath = relPath.replace(/\\/g, '/');
    if (!relPath || relPath === '.') return false;
    if (relPath.startsWith('..')) return false;

    // The `ignore` library requires a trailing slash to match directory-only
    // patterns (e.g. `.vscode-test/`). Without it, `ignores('.vscode-test')`
    // returns false even though the pattern is meant to ignore that directory.
    if (isDirectory) relPath += '/';

    const userMatcher = ignoreLib().add(this.stateManager.ignorePatterns);
    if (userMatcher.ignores(relPath)) return true;

    if (this.stateManager.respectGitignore && this.gitignoreMatcher.ignores(relPath)) return true;

    return false;
  }

  private async onDiskCreate(uri: vscode.Uri): Promise<void> {
    const filePath = normalizePath(uri.fsPath);
    const basename = path.basename(filePath);
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    log(`onDiskCreate(${basename}): fileState=${fileState ? `{status:${fileState.status}, baseline.len:${fileState.baseline?.length ?? 'null'}}` : 'undefined'}`);
    if (fileState?.status === 'reviewing') {
      // File was deleted (showing deletion hunk) but now re-created — recompute
      let diskContent: string;
      try {
        diskContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        log(`onDiskCreate(${basename}): read failed while reviewing, skip`);
        return;
      }
      log(`onDiskCreate(${basename}): reviewing, recompute hunks (baseline.len=${fileState.baseline?.length ?? 'null'}, disk.len=${diskContent.length})`);
      this.recomputeHunks(filePath, fileState.baseline, diskContent);
      return;
    }
    if (fileState) { log(`onDiskCreate(${basename}): has fileState but not reviewing, skip`); return; }

    const git = this.stateManager.git;
    if (!git) { log(`onDiskCreate(${basename}): no git, skip`); return; }

    let diskContent: string;
    try {
      diskContent = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      log(`onDiskCreate(${basename}): read failed, skip`);
      return;
    }

    const gitBaseline = await git.getBaseline(filePath);
    log(`onDiskCreate(${basename}): gitBaseline=${gitBaseline !== undefined ? `'${gitBaseline.length} chars'` : 'undefined'}`);
    if (gitBaseline !== undefined) {
      // Interactive Review already has a baseline — treat as a change
      log(`onDiskCreate(${basename}): has baseline, enterReviewing as change`);
      this.enterReviewing(filePath, gitBaseline, diskContent);
      return;
    }

    // Was this file just saved by VSCode itself (user created + saved a new file)?
    // Gated on the save event, not buffer==disk — same reasoning as onDiskChange.
    if (this.consumeManualSave(filePath, diskContent)) {
      log(`onDiskCreate(${basename}): matched VSCode save, snapshot as baseline`);
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }

    // External tool created this file — show as new file hunk (null = file didn't exist before)
    log(`onDiskCreate(${basename}): external create, enterReviewing as NEW`);
    this.enterReviewing(filePath, null, diskContent);
  }

  private async onDiskDelete(uri: vscode.Uri): Promise<void> {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    const filePath = normalizePath(uri.fsPath);
    const basename = path.basename(filePath);
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    const git = this.stateManager.git;

    if (this.pendingRenameOldPaths.has(filePath)) {
      // User-initiated rename — renameFile already migrated state+git, nothing to do
      this.pendingRenameOldPaths.delete(filePath);
      log(`onDiskDelete(${basename}): rename old path, skip`);
      return;
    }

    if (this.pendingUserDeletes.has(filePath)) {
      // User-initiated delete (explorer / VSCode API) — treat as manual, remove baseline.
      // Always go through stateManager.removeFile so git ops are serialized via gitQueue.
      this.pendingUserDeletes.delete(filePath);
      log(`onDiskDelete(${basename}): user delete, removeFile`);
      this.stateManager.removeFile(filePath);
      // Also clean up child files when a directory is deleted via VSCode
      const dirPrefix = filePath + path.sep;
      let needsRefresh = !!fileState;
      for (const [childPath] of this.stateManager.getAllFiles()) {
        if (childPath.startsWith(dirPrefix)) {
          this.stateManager.removeFile(childPath);
          needsRefresh = true;
        }
      }
      if (needsRefresh) {
        this.onStateChanged();
      }
      return;
    }

    // External tool deleted the file
    if (!git) { log(`onDiskDelete(${basename}): no git, skip`); return; }

    // If file was new (null baseline), just clean up — nothing to show, nothing in git
    if (fileState?.baseline === null) {
      log(`onDiskDelete(${basename}): new file (null baseline) deleted, removing fileState`);
      this.stateManager.exitReviewing(filePath);
      this.onStateChanged();
      return;
    }

    const gitBaseline = fileState?.baseline ?? await git.getBaseline(filePath);
    log(`onDiskDelete(${basename}): external delete, gitBaseline=${gitBaseline !== undefined ? `'${gitBaseline.length} chars'` : 'undefined'}`);
    if (gitBaseline === undefined) {
      // Not tracked at all — nothing to show
      if (fileState) {
        log(`onDiskDelete(${basename}): no baseline, removing fileState`);
        this.stateManager.removeFile(filePath);
        this.onStateChanged();
      }

      // When a directory is externally deleted, VSCode's FileSystemWatcher only
      // fires onDidDelete for the directory itself, not for individual files
      // inside it. Clean up any child state entries whose paths start with this
      // directory prefix so they don't remain as stale ghosts in the panel.
      const dirPrefix = filePath + path.sep;
      const allFiles = this.stateManager.getAllFiles();
      let childrenCleaned = 0;
      for (const [childPath, childState] of allFiles) {
        if (!childPath.startsWith(dirPrefix)) continue;
        if (childState.baseline === null) {
          // New file (no git baseline) — just remove from state
          this.stateManager.exitReviewing(childPath);
        } else {
          // Has baseline — show deletion diff
          this.enterReviewing(childPath, childState.baseline, '');
        }
        childrenCleaned++;
      }
      if (childrenCleaned > 0) {
        log(`onDiskDelete(${basename}): cleaned ${childrenCleaned} child file(s) from deleted directory`);
        this.onStateChanged();
      }
      return;
    }
    // gitBaseline is '' (empty file) or has content — show deletion diff.
    // Pass '' as current content since file no longer exists on disk.
    // enterReviewing will detect isDeleted via !fs.existsSync.
    this.enterReviewing(filePath, gitBaseline, '');
  }

  private async onDiskChange(uri: vscode.Uri): Promise<void> {
    const filePath = normalizePath(uri.fsPath);
    const basename = path.basename(filePath);
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;

    if (this.shouldIgnore(filePath)) { log(`onDiskChange(${basename}): ignored, skip`); return; }
    if (this.selfEditFiles.has(filePath)) {
      // The extension's own write (accept/reject) — its save fired onDidSaveTextDocument
      // too, so drop any pending token here rather than stranding the file's full content.
      this.pendingManualSaves.delete(filePath);
      log(`onDiskChange(${basename}): self-edit, skip`);
      return;
    }

    let diskContent: string;
    try {
      diskContent = await fs.promises.readFile(filePath, 'utf-8');
    } catch {
      log(`onDiskChange(${basename}): read failed, skip`);
      return;
    }

    // Resolve the save token now, before any early-return, so every branch below reclaims
    // it (a reviewing-file save would otherwise strand the file's full content for the
    // whole session). The result is only acted on in the manual-save branch.
    const wasManualSave = this.consumeManualSave(filePath, diskContent);

    const fileState = this.stateManager.getFile(filePath);

    if (fileState?.status === 'reviewing') {
      // Already has diff — recompute against known baseline
      log(`onDiskChange(${basename}): reviewing, recompute hunks`);
      this.recomputeHunks(filePath, fileState.baseline, diskContent);
      return;
    }

    const git = this.stateManager.git;
    if (!git) { log(`onDiskChange(${basename}): no git, skip`); return; }

    // A VSCode-initiated save (manual or auto) of exactly this content — absorb into
    // baseline, no hunk. Gated on the save EVENT (onDidSaveTextDocument), not on the
    // open buffer matching disk: VSCode silently reloads a clean open buffer to match
    // an external write, so buffer==disk is true even for an AI edit to an open file.
    if (wasManualSave) {
      log(`onDiskChange(${basename}): matched VSCode save, snapshot as baseline`);
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }

    // External change — compare against interactive-review baseline
    const gitBaseline = await git.getBaseline(filePath);
    if (gitBaseline === undefined) {
      // No baseline in git — silently adopt current content as baseline rather than
      // treating as a new file. This avoids false "new file" hunks in cases like:
      // - ignore rules just changed (file newly un-ignored, not actually new)
      // - syncIgnoreState hasn't finished its git queue yet
      // - first enable where snapshotWorkspace is still in progress
      // Genuine new files created while interactive-review is running are caught by onDidCreate,
      // not this path. This is intentionally consistent with syncIgnoreState's toAdd
      // behavior which also silently snapshots.
      // KNOWN GAP (Cause B): if an external CREATE was missed and only this CHANGE fired,
      // the edit is silently absorbed here with no review hunk. See
      // docs/terminal-edits-not-captured.md §5. Logged loudly so it is findable.
      log(`onDiskChange(${basename}): external change but NO baseline — silently adopting as baseline (Cause B; edit will NOT be reviewed)`);
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }
    log(`onDiskChange(${basename}): external change, enterReviewing`);
    this.enterReviewing(filePath, gitBaseline, diskContent);
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (e.document.uri.scheme !== 'file') return;
    const filePath = normalizePath(e.document.uri.fsPath);

    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    if (fileState?.status !== 'reviewing') return;

    // Already has diff — recompute hunks against baseline
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const latestState = this.stateManager.getFile(filePath);
      if (!latestState || latestState.status !== 'reviewing') return;
      this.recomputeHunks(filePath, latestState.baseline, e.document.getText());
    }, 50);
    this.debounceTimers.set(filePath, timer);
  }

  private enterReviewing(filePath: string, baseline: string | null, current: string): void {
    const hunks = computeHunks(baseline, current);
    const isNew = baseline === null;
    const isDeleted = !fs.existsSync(filePath) && baseline !== null;
    // Allow 0-hunk entry for new files (null baseline) and deleted files (file gone, nothing to diff)
    if (hunks.length === 0 && !isNew && !isDeleted) return;
    const tag = isNew ? ' (new)' : isDeleted ? ' (deleted)' : '';
    log(`reviewing: ${path.basename(filePath)}${tag}`);
    this.stateManager.setFile(filePath, { status: 'reviewing', baseline });
    this.onStateChanged();
  }

  private recomputeHunks(filePath: string, baseline: string | null, current: string): void {
    if (computeHunks(baseline, current).length === 0) {
      // No diff remaining — exit reviewing.
      // For null-baseline (new) files with empty current, keep reviewing
      // so the user can still accept/discard.
      if (baseline === null && current === '') {
        this.onStateChanged();
        return;
      }
      this.stateManager.exitReviewing(filePath);
    }
    this.onStateChanged();
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingManualSaves.clear();
    this.pendingUserDeletes.clear();
    this.pendingRenameOldPaths.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
