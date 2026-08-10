import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileState } from './types';
import { BaselineGit, BaselineUnreadableError, Settings } from './baselineGit';
import { hasReportableDiff } from './diffEngine';
import { log } from './log';
import { normalizePath } from './pathNormalize';

const DEFAULT_IGNORE_PATTERNS = process.platform === 'darwin' ? ['.git', '.DS_Store'] : ['.git'];

/** Format a list of absolute paths for logging: show relative paths, max 20. */
function logFileList(files: string[], rootPath: string | undefined): string {
  const rel = files.map(fp => rootPath ? path.relative(rootPath, fp) : fp);
  const shown = rel.slice(0, 20);
  const suffix = rel.length > 20 ? ` … and ${rel.length - 20} more` : '';
  return shown.join(', ') + suffix;
}

export class StateManager {
  // In-memory cache — rebuilt from git on load(), updated synchronously on mutations
  private state: Map<string, FileState> = new Map();
  private stateDir: string | undefined;
  private workspaceRoot: string | undefined;
  private _enabled: boolean = false;
  private _ignorePatterns: string[] = [...DEFAULT_IGNORE_PATTERNS];
  private _respectGitignore: boolean = true;
  private _clearOnBranchSwitch: boolean = false;
  private _quoteRotationInterval: number = 30;
  // Latched true once the current review session has seen ≥1 reviewing file; reset
  // when a session opens/closes. Drives reviewComplete (see noteReviewActivity).
  private _sawReviewingFiles: boolean = false;
  private _git: BaselineGit | undefined;

  // Serial queue: git ops run one at a time; flush() awaits the tail
  private gitQueue: Promise<void> = Promise.resolve();

  // Optional callback invoked when a git failure causes an in-memory rollback
  // (e.g. exitReviewing snapshot fails and reviewing state is restored).
  // Set by the extension to trigger UI refresh after unexpected state restoration.
  onRollback: (() => void) | undefined;

  constructor() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      this.workspaceRoot = workspaceFolders[0].uri.fsPath;
      this.stateDir = path.join(this.workspaceRoot, '.vscode', 'interactive-review');
    }
  }

  // ── accessors ─────────────────────────────────────────────────────────────

  get enabled(): boolean { return this._enabled; }

  /** Number of files currently in reviewing state. */
  get reviewingCount(): number {
    let n = 0;
    for (const fs of this.state.values()) if (fs.status === 'reviewing') n++;
    return n;
  }

  /**
   * Review-complete = the current review session had pending files and has now
   * drained them all. This is the "closure" the review-flow model demands. With
   * snapshot-on-command, a session opens on enable and its file set is bounded by
   * the snapshot; when the last hunk is dispositioned the set empties → complete.
   * Distinct from "enabled with nothing to review" (never had files → not complete).
   */
  get reviewComplete(): boolean {
    return this._enabled && this._sawReviewingFiles && this.reviewingCount === 0;
  }

  /**
   * Record whether the session has seen pending work. Called from the single
   * state-change funnel (extension.onStateChanged) so completion can be detected
   * without threading a flag through every mutation path. Latches true; reset only
   * when a new session opens (setEnabled) so a drain-to-zero reads as complete.
   */
  noteReviewActivity(): void {
    if (this.reviewingCount > 0) this._sawReviewingFiles = true;
  }
  get ignorePatterns(): string[] { return this._ignorePatterns; }
  get respectGitignore(): boolean { return this._respectGitignore; }
  get clearOnBranchSwitch(): boolean { return this._clearOnBranchSwitch; }
  get quoteRotationInterval(): number { return this._quoteRotationInterval; }
  get dir(): string | undefined { return this.stateDir; }
  get git(): BaselineGit | undefined { return this._git; }

  /**
   * Recursively collect absolute (normalized) paths of every non-ignored file
   * under the workspace root. Directories/files for which `shouldIgnore` returns
   * true are pruned. Unreadable directories are skipped silently. This is the
   * single shared workspace walk used by snapshot / sync / branch-switch logic.
   */
  private async collectWorkspaceFiles(
    shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean
  ): Promise<string[]> {
    if (!this.workspaceRoot) return [];
    const walk = async (dir: string): Promise<string[]> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const entry of entries) {
        const full = normalizePath(path.join(dir, entry.name));
        const isDir = entry.isDirectory();
        if (shouldIgnore?.(full, isDir)) continue;
        if (isDir) {
          // Element-wise, not `out.push(...await walk(full))`: spreading a large
          // subtree's file list as call arguments throws RangeError at scale.
          for (const f of await walk(full)) out.push(f);
        } else if (entry.isFile()) {
          out.push(full);
        }
      }
      return out;
    };
    return walk(this.workspaceRoot);
  }

  /**
   * Read a set of files into a snapshot batch. Files that fail to read are
   * silently dropped — this is deliberate and load-bearing: binary files and
   * unreadable files (permissions, transient races) must not abort the batch,
   * and their UTF-8 content would be meaningless as a baseline anyway.
   */
  private async readBatch(filePaths: string[]): Promise<{ filePath: string; content: string }[]> {
    const batch: { filePath: string; content: string }[] = [];
    await Promise.all(filePaths.map(async filePath => {
      try {
        batch.push({ filePath, content: await fs.promises.readFile(filePath, 'utf-8') });
      } catch {
        // Skip binary/unreadable files — see method doc.
      }
    }));
    return batch;
  }

  /**
   * Walk workspace and collect files that exist on disk but are not tracked in git.
   * These are externally created new files that should be shown with null baseline.
   */
  private async collectUntrackedFiles(
    trackedSet: Set<string>,
    shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean
  ): Promise<string[]> {
    const all = await this.collectWorkspaceFiles(shouldIgnore);
    const untracked: string[] = [];
    await Promise.all(all.map(async full => {
      if (trackedSet.has(full)) return;
      try {
        // Skip unreadable files (e.g. permission errors) to avoid downstream
        // failures when reading content as UTF-8.
        await fs.promises.access(full, fs.constants.R_OK);
        untracked.push(full);
      } catch {
        // unreadable — omit
      }
    }));
    return untracked;
  }

  // ── init / load ───────────────────────────────────────────────────────────

  private ensureGit(): BaselineGit | undefined {
    if (!this.stateDir || !this.workspaceRoot) return undefined;
    if (!this._git) {
      this._git = new BaselineGit(this.stateDir, this.workspaceRoot, log);
    }
    return this._git;
  }

  /**
   * Shared per-file scan of the git-tracked files, used by both `load()` and
   * `rebuildState()`. For each tracked file: skip if ignored, skip if it has no
   * baseline in the index, otherwise compare the baseline against current disk
   * content and enter `reviewing` on a real diff or a deletion (ENOENT). Files
   * with no diff, no baseline, or that are ignored are NOT added to `this.state`.
   *
   * Populates `this.state` and returns the classification buckets so each caller
   * can layer its own logging / cleanup / diffing on top. Untracked-file
   * detection and all surrounding orchestration stay with the callers, where the
   * intentional load-vs-rebuild differences live.
   */
  private async scanTrackedIntoState(
    g: BaselineGit,
    tracked: string[],
    shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean
  ): Promise<{ reviewing: string[]; idle: string[]; skippedNoBaseline: string[]; ignored: string[] }> {
    const ignored: string[] = [];
    const skippedNoBaseline: string[] = [];
    const reviewing: string[] = [];
    const idle: string[] = [];
    await Promise.all(tracked.map(async filePath => {
      if (shouldIgnore?.(filePath)) {
        ignored.push(filePath);
        return;
      }
      const baseline = await g.getBaseline(filePath);
      if (baseline === undefined) {
        skippedNoBaseline.push(filePath);
        return;
      }
      // Compare baseline with current disk content — enter reviewing if there's a real diff
      // or if the file has been deleted (so the user can restore it via discard).
      // Use a single readFile call to avoid TOCTOU race (existsSync + readFile).
      let diskContent: string | undefined;
      let fileDeleted = false;
      try {
        diskContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch (err: any) {
        if (err?.code === 'ENOENT') { fileDeleted = true; } // file doesn't exist
        // other errors (e.g. permissions) → diskContent stays undefined, treat as idle
      }
      if (fileDeleted || (diskContent !== undefined && hasReportableDiff(baseline, diskContent))) {
        this.state.set(filePath, { status: 'reviewing', baseline });
        reviewing.push(filePath);
      } else {
        idle.push(filePath);
      }
    }));
    return { reviewing, idle, skippedNoBaseline, ignored };
  }

  /**
   * Enter every on-disk file that git isn't tracking into `reviewing` with a null
   * baseline — i.e. treat it as externally created and new. The untracked half of the
   * shared load/rebuild scan (`scanTrackedIntoState` is the tracked half); kept here so
   * the two entry points can't drift on what counts as a new file. Returns the adopted
   * paths so `load()` can log them.
   */
  private async adoptUntrackedFiles(
    tracked: string[],
    shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean
  ): Promise<string[]> {
    const untracked = await this.collectUntrackedFiles(new Set(tracked), shouldIgnore);
    for (const filePath of untracked) {
      this.state.set(filePath, { status: 'reviewing', baseline: null });
    }
    return untracked;
  }

  /**
   * Recover from a baseline repo whose contents are gone or unreadable, without ever
   * routing through `adoptUntrackedFiles`.
   *
   * The baselines are unrecoverable, so the prior session's pending review cannot be
   * resumed — but the files on disk are untouched and correct. The safe reading of
   * "no trustworthy baseline" is therefore "nothing to review yet": reset the repo and
   * re-snapshot the workspace exactly as `Begin review` would, which leaves current
   * disk content as the new baseline and the review queue empty.
   *
   * The alternative — letting the caller fall through to adopting every untracked file
   * — is what turned one crashed VM into a 3807-file queue of null-baseline entries,
   * each of which `Discard` deletes from disk. A lost review session is a nuisance; a
   * "Discard all" that unlinks the whole workspace is not.
   *
   * Surfaced to the user rather than logged only: the session silently emptying looks
   * identical to having finished reviewing everything.
   */
  private async recoverLostBaseline(
    g: BaselineGit,
    reason: string,
    shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean
  ): Promise<void> {
    log(`load: ${reason} — prior baselines are unrecoverable, resetting to a fresh snapshot`);
    this.state.clear();
    let rebuilt = false;
    try {
      await g.resetRepo();
      await this.snapshotWorkspace((fp, isDir) => shouldIgnore?.(fp, isDir) ?? false);
      rebuilt = true;
      log('load: baseline rebuilt from current workspace contents; review queue is empty');
    } catch (err) {
      log(`load: baseline rebuild failed: ${err}`);
    }
    // Report what actually happened. A failed rebuild leaves review enabled over a repo
    // that cannot store baselines, so every subsequent edit goes uncaptured — the one
    // state where an empty panel does not mean "nothing to review". Claiming success
    // here would make that indistinguishable from a clean recovery.
    if (rebuilt) {
      void vscode.window.showWarningMessage(
        'Interactive Review: the saved baselines for this workspace were unreadable ' +
        '(most often an unclean shutdown) and could not be recovered. Your files are ' +
        'untouched, but the pending review was lost. A fresh baseline has been taken ' +
        'from the current contents.'
      );
    } else {
      void vscode.window.showErrorMessage(
        'Interactive Review: the saved baselines for this workspace were unreadable and ' +
        'a replacement could not be written. Your files are untouched, but changes are ' +
        'not being tracked. Run "Interactive Review: End review", then "Begin review".'
      );
    }
  }

  /**
   * Load persistent state from settings.json + git repo.
   * Must be called once at activation. Async because reading baselines
   * from git requires exec calls.
   */
  async load(shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this.ensureGit();
    if (!g) return;

    // enabled state is determined by whether the interactive-review git dir exists on disk
    const gitDir = path.join(this.stateDir!, 'git');
    if (!fs.existsSync(gitDir)) return;

    this._enabled = true;
    this.applySettings(g.loadSettings());

    // Initialize git (idempotent) then restore in-memory state from HEAD
    await g.initGit();
    // Both branches below mean "there is no baseline to restore from", which is only
    // ever a recovery case here: reaching load() at all means a previous session
    // enabled review and snapshotted, so its baselines should still be readable.
    if (g.baselineLost) {
      await this.recoverLostBaseline(g, 'baseline repo had to be re-initialized', shouldIgnore);
      return;
    }
    let tracked: string[];
    try {
      tracked = await g.listTrackedFiles();
    } catch (err) {
      if (!(err instanceof BaselineUnreadableError)) throw err;
      await this.recoverLostBaseline(g, `${err.message}`, shouldIgnore);
      return;
    }
    const { reviewing, idle, skippedNoBaseline, ignored } =
      await this.scanTrackedIntoState(g, tracked, shouldIgnore);
    if (skippedNoBaseline.length > 0) {
      log(`load: skipped ${skippedNoBaseline.length} file(s) with no baseline in index: ${logFileList(skippedNoBaseline, this.workspaceRoot)}`);
    }
    if (reviewing.length > 0) {
      log(`load: ${reviewing.length} file(s) have diffs: ${logFileList(reviewing, this.workspaceRoot)}`);
    }
    if (idle.length > 0) {
      log(`load: ${idle.length} file(s) unchanged, baseline preserved`);
    }
    // Clean up stale ignored entries from the git repo
    if (ignored.length > 0) {
      log(`load: removing ${ignored.length} ignored file(s) from git: ${logFileList(ignored, this.workspaceRoot)}`);
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(ignored)).catch(err => { log(`git queue error: ${err}`); });
    }

    // Detect files on disk not tracked in git — these are externally created new files
    const untrackedFiles = await this.adoptUntrackedFiles(tracked, shouldIgnore);
    if (untrackedFiles.length > 0) {
      log(`load: ${untrackedFiles.length} untracked new file(s): ${logFileList(untrackedFiles, this.workspaceRoot)}`);
    }
    this.noteReviewActivity();
  }

  /**
   * Rebuild in-memory state from git baselines, comparing with the current state.
   * Logs a diff report showing what changed.
   */
  async rebuildState(shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this._git;
    if (!g || !this._enabled) {
      log('rebuildState: not enabled or no git, skip');
      return;
    }

    log('rebuildState: begin');

    // Wait for pending git operations to complete before reading
    await this.gitQueue;

    // Snapshot old state for comparison
    const oldState = new Map<string, FileState>();
    for (const [fp, st] of this.state) {
      oldState.set(fp, { ...st });
    }

    // Rebuild: clear and reload from git via the shared tracked-file scan.
    // Read before clearing — an unreadable baseline must leave the in-memory state
    // intact (it is now the only surviving record of the session) rather than swap it
    // for a workspace-wide list of null-baseline "new" files.
    await g.initGit();
    let tracked: string[];
    try {
      tracked = await g.listTrackedFiles();
    } catch (err) {
      if (!(err instanceof BaselineUnreadableError)) throw err;
      log(`rebuildState: aborting, in-memory state left untouched — ${err.message}`);
      return;
    }
    this.state.clear();
    await this.scanTrackedIntoState(g, tracked, shouldIgnore);

    // Detect files on disk not tracked in git — these are externally created new files
    await this.adoptUntrackedFiles(tracked, shouldIgnore);
    this.noteReviewActivity();

    // Compare old vs new state
    const added: string[] = [];
    const removed: string[] = [];
    const baselineChanged: string[] = [];
    const statusChanged: string[] = [];

    const rootPath = this.workspaceRoot;
    const rel = (fp: string) => rootPath ? path.relative(rootPath, fp) : fp;

    for (const [fp, newFs] of this.state) {
      const oldFs = oldState.get(fp);
      if (!oldFs) {
        added.push(rel(fp));
      } else {
        if (oldFs.baseline !== newFs.baseline) baselineChanged.push(rel(fp));
        if (oldFs.status !== newFs.status) statusChanged.push(rel(fp));
      }
    }
    for (const fp of oldState.keys()) {
      if (!this.state.has(fp)) removed.push(rel(fp));
    }

    if (added.length === 0 && removed.length === 0 && baselineChanged.length === 0 && statusChanged.length === 0) {
      log('rebuildState: no differences found — memory state matches git');
    } else {
      log(`rebuildState: differences found:`);
      if (added.length > 0) log(`  added (found in git or on disk but was missing from memory): ${added.join(', ')}`);
      if (removed.length > 0) log(`  removed (in memory but not in git/disk): ${removed.join(', ')}`);
      if (baselineChanged.length > 0) log(`  baseline changed: ${baselineChanged.join(', ')}`);
      if (statusChanged.length > 0) log(`  status changed: ${statusChanged.join(', ')}`);
    }

    log(`rebuildState: done — ${this.state.size} file(s) in reviewing state`);
  }

  // ── file state ────────────────────────────────────────────────────────────

  getFile(filePath: string): FileState | undefined {
    return this.state.get(normalizePath(filePath));
  }

  /**
   * Canonical "is this a deleted file" test — the single source of truth shared by
   * the panel list, the diff-open routing, and the deleted-file CodeLenses so they
   * can never disagree. Deleted = tracked with a real baseline (a null baseline is a
   * *new* file, not a deletion) but no longer present on disk.
   */
  isDeleted(filePath: string): boolean {
    const fileState = this.getFile(filePath);
    return !!fileState && fileState.baseline !== null && !fs.existsSync(filePath);
  }

  /**
   * Drop a *new* (null-baseline) entry whose file is no longer on disk, reporting whether
   * one was dropped. The counterpart to `isDeleted`: a null baseline means the file did not
   * exist when review began, so once it is gone from disk there is nothing left to review —
   * no baseline to restore, no content to accept — and no diff to render, because neither
   * side exists. It is not a deletion the user needs to disposition; it is a non-event.
   *
   * `load()` and `rebuildState()` already reconcile these away for free, since they rebuild
   * from git-tracked plus on-disk files and a vanished new file is in neither. This covers
   * the live in-memory state *between* those rebuilds: FileWatcher.onDiskDelete normally
   * removes such an entry, but a dropped watcher event (the same class of miss documented
   * in docs/terminal-edits-not-captured.md) can strand one, where it shows as an actionless
   * panel row whose diff opens against a nonexistent file.
   *
   * Removal is in-memory only — `removeFile` skips the git op for a null baseline, which was
   * never stored in the index.
   */
  reconcileVanishedNewFile(filePath: string): boolean {
    const fileState = this.getFile(filePath);
    if (!fileState || fileState.baseline !== null) return false;
    if (fs.existsSync(filePath)) return false;
    log(`reconcile: dropping vanished new file ${path.basename(filePath)} (null baseline, not on disk)`);
    this.removeFile(filePath);
    return true;
  }

  setFile(filePath: string, state: FileState, skipSnapshot?: boolean): void {
    filePath = normalizePath(filePath);
    // Clone old state so callers mutating the FileState object don't corrupt the rollback snapshot
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath)! } : undefined;
    this.state.set(filePath, state);
    // Latch review activity at the mutation point so reviewComplete works regardless
    // of whether the caller routes through the extension's onStateChanged funnel.
    if (state.status === 'reviewing') this._sawReviewingFiles = true;
    if (!skipSnapshot && this._git && state.baseline !== null) {
      const g = this._git;
      const baseline = state.baseline;
      this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, baseline)).catch(err => {
        log(`git queue error (setFile rollback): ${err}`);
        // Only rollback if this exact state object is still current (no newer operation has updated it)
        if (this.state.get(filePath) === state) {
          if (oldState) { this.state.set(filePath, oldState); } else { this.state.delete(filePath); }
          this.onRollback?.();
        }
      });
    }
  }

  removeFile(filePath: string): void {
    filePath = normalizePath(filePath);
    // Clone old state so the rollback has an independent snapshot
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath)! } : undefined;
    this.state.delete(filePath);
    // Skip git removal only when we know the file had a null baseline (never stored in git).
    // If oldState is undefined (idle file, not in map) or has a real baseline, queue the removal.
    if (this._git && !(oldState !== undefined && oldState.baseline === null)) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.removeFile(filePath)).catch(err => {
        log(`git queue error (removeFile rollback): ${err}`);
        // Only rollback if no newer operation has re-added the entry
        if (!this.state.has(filePath) && oldState) {
          this.state.set(filePath, { ...oldState });
          this.onRollback?.();
        }
      });
    }
  }

  renameFile(oldFilePath: string, newFilePath: string): void {
    oldFilePath = normalizePath(oldFilePath);
    newFilePath = normalizePath(newFilePath);

    // Handle both single-file and directory renames in in-memory state.
    // For a directory rename, migrate all entries under the old prefix.
    const oldPrefix = oldFilePath + path.sep;
    let hasDirChildren = false;
    const fileState = this.state.get(oldFilePath);
    if (fileState) {
      // Exact match — single file rename
      this.state.delete(oldFilePath);
      this.state.set(newFilePath, fileState);
    }
    // Also check for directory children (entries whose path starts with oldFilePath + sep)
    for (const [fp, childState] of [...this.state.entries()]) {
      if (fp.startsWith(oldPrefix)) {
        this.state.delete(fp);
        const newFp = newFilePath + fp.slice(oldFilePath.length);
        this.state.set(newFp, childState);
        hasDirChildren = true;
      }
    }

    // Skip git rename only when we know it was a single file with null baseline (never stored in git).
    // For directories or idle files (not in map), always queue — git may have baselines.
    const skipGit = fileState && fileState.baseline === null && !hasDirChildren;
    if (this._git && !skipGit) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.renameFile(oldFilePath, newFilePath)).catch(err => {
        // Do not rollback in-memory path mapping: the file has already been renamed on disk,
        // so reverting to oldFilePath would desync state/UI from the filesystem.
        log(`git queue error (renameFile): ${err}`);
      });
    }
  }

  /**
   * Snapshot a file's content as baseline via the git queue (serialized).
   * Use this instead of calling git.snapshot() directly to avoid concurrent git ops.
   */
  snapshotFile(filePath: string, content: string): void {
    if (this._git) {
      const g = this._git;
      this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, content)).catch(err => { log(`git queue error: ${err}`); });
    }
  }

  getAllFiles(): ReadonlyMap<string, FileState> {
    return this.state;
  }

  isReviewing(filePath: string): boolean {
    return this.state.get(normalizePath(filePath))?.status === 'reviewing';
  }

  /**
   * Exit reviewing state without removing the file from git.
   * If newBaseline is provided as a non-null string, update the baseline in git (e.g. after accept).
   * If omitted or explicitly null, do not snapshot or update the git baseline; the existing baseline
   * is assumed to already be correct (e.g. hunks resolved to 0, or discard).
   */
  exitReviewing(filePath: string, newBaseline?: string | null): void {
    filePath = normalizePath(filePath);
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath)! } : undefined;
    this.state.delete(filePath);
    if (newBaseline !== undefined && newBaseline !== null) {
      if (this._git) {
        const g = this._git;
        const baseline = newBaseline;
        this.gitQueue = this.gitQueue.then(() => g.snapshot(filePath, baseline)).catch(err => {
          log(`git queue error (exitReviewing rollback): ${err}`);
          // Restore reviewing state so the user can retry rather than silently getting a stale baseline
          if (!this.state.has(filePath) && oldState) {
            this.state.set(filePath, { ...oldState });
            this.onRollback?.();
            void vscode.window.showErrorMessage(
              `Failed to update review baseline for ${path.basename(filePath)}. The file has been kept in reviewing so you can retry.`
            );
          }
        });
      }
    }
  }


  // ── settings ──────────────────────────────────────────────────────────────

  async setEnabled(value: boolean): Promise<void> {
    this._enabled = value;
    // A new session (open on enable, teardown on disable) starts fresh: no
    // pending work seen yet, so a subsequent drain-to-zero reads as complete.
    this._sawReviewingFiles = false;
    if (value) {
      const g = this.ensureGit();
      if (!g) return;
      await g.initGit();
      // Base the merge on persisted settings (loadSettings applies DEFAULT_SETTINGS
      // for an absent file or missing fields), NOT on currentSettings() — the latter
      // reflects stale in-memory values that survive across enable/disable cycles in a
      // long-lived host, so a fresh enable would silently inherit a prior session's
      // settings instead of resetting to disk/defaults.
      this.applySettings(g.mergeDefaultSettings(g.loadSettings()));
    } else {
      this.state.clear();
      this._git?.destroyGit();
      this._git = undefined;
    }
  }

  /**
   * Snapshot all current workspace files into interactive-review git as baselines.
   * Only snapshots files that don't already have a baseline recorded.
   * Should be called once after enable.
   */
  async snapshotWorkspace(shouldIgnore: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;

    const filePaths = await this.collectWorkspaceFiles(shouldIgnore);
    const batch = await this.readBatch(filePaths);
    if (batch.length > 0) {
      // Through `gitQueue`, not a bare await, matching every other `snapshotBatch` call
      // site. The queue exists because concurrent git invocations contend on
      // `.git/index.lock` and the loser throws — and every queue consumer swallows that
      // error, so a collision costs a file its baseline silently. Running off-queue was
      // survivable only while nothing else wrote git during enable; `handleDiskCreate`'s
      // adopt-during-snapshot branch now does exactly that.
      this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(batch)).catch(err => { log(`git queue error: ${err}`); });
    }
    await this.gitQueue;
  }

  private currentSettings(): Settings {
    return { ignorePatterns: this._ignorePatterns, respectGitignore: this._respectGitignore, clearOnBranchSwitch: this._clearOnBranchSwitch, quoteRotationInterval: this._quoteRotationInterval };
  }

  /**
   * Copy a full settings object into the backing fields. The single place the
   * in-memory settings are populated, so every source of settings (load from disk,
   * enable-time merge, external-edit reload, a panel setter) applies all fields —
   * a new setting cannot be half-adopted by one path and missed by another.
   */
  private applySettings(settings: Settings): void {
    this._ignorePatterns = settings.ignorePatterns;
    this._respectGitignore = settings.respectGitignore;
    this._clearOnBranchSwitch = settings.clearOnBranchSwitch;
    this._quoteRotationInterval = settings.quoteRotationInterval;
  }

  /**
   * Change one setting in memory, and persist the whole settings object when a review
   * session is active. Persisting only while enabled is deliberate: settings.json is
   * session state, and writing it from a disabled extension would resurrect a stale
   * state dir. The in-memory update happens either way so the panel reflects the change.
   */
  private updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const next: Settings = { ...this.currentSettings(), [key]: value };
    this.applySettings(next);
    if (this._enabled && this._git) {
      this._git.saveSettings(next);
    }
  }

  setIgnorePatterns(patterns: string[]): void {
    this.updateSetting('ignorePatterns', patterns);
  }

  setRespectGitignore(value: boolean): void {
    this.updateSetting('respectGitignore', value);
  }

  setClearOnBranchSwitch(value: boolean): void {
    this.updateSetting('clearOnBranchSwitch', value);
  }

  setQuoteRotationInterval(value: number): void {
    this.updateSetting('quoteRotationInterval', (Number.isFinite(value) && value >= 0) ? Math.floor(value) : 0);
  }

  /**
   * Reload all settings from settings.json (called when settings.json is modified externally).
   * Returns the new ignorePatterns if enabled, null if not enabled or no git.
   */
  reloadIgnorePatterns(): string[] | null {
    if (!this._enabled || !this._git) return null;
    this.applySettings(this._git.loadSettings());
    return this._ignorePatterns;
  }

  /**
   * Sync tracked files with current ignore rules.
   * - Removes baselines for files that are now ignored.
   * - Snapshots files newly allowed by current rules but not yet tracked.
   * Called after ignorePatterns / respectGitignore / .gitignore changes.
   */
  async syncIgnoreState(shouldIgnore: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;

    let allowedFiles: string[];
    let trackedFiles: string[];
    try {
      [allowedFiles, trackedFiles] = await Promise.all([
        this.collectWorkspaceFiles(shouldIgnore),
        g.listTrackedFiles(),
      ]);
    } catch (err) {
      if (!(err instanceof BaselineUnreadableError)) throw err;
      // Without a readable tracked list every allowed file looks un-snapshotted, so
      // proceeding would re-snapshot the entire workspace over a damaged repo.
      log(`syncIgnoreState: aborting — ${err.message}`);
      return;
    }

    // Remove tracked files that are now ignored (from git and from in-memory state).
    //
    // Test `shouldIgnore` directly rather than "missing from allowedFiles":
    // collectWorkspaceFiles only walks what exists on disk, so a *deleted* file
    // awaiting review is absent from it for a reason that has nothing to do with
    // ignore rules. Removing on absence git-rm'd its baseline, which permanently
    // dropped the pending deletion from review the moment any .gitignore changed.
    // Deletions are the file watcher's and rebuildState's business, not this
    // function's — it syncs ignore rules and nothing else.
    const toRemove = trackedFiles.filter(fp => shouldIgnore(fp));
    // Also remove in-memory state entries that are ignored but have no git baseline (e.g. new files in reviewing)
    const removeSet = new Set(toRemove);
    for (const fp of Array.from(this.state.keys())) {
      if (shouldIgnore(fp) && !removeSet.has(fp)) {
        this.state.delete(fp);
      }
    }
    if (toRemove.length > 0) {
      log(`syncIgnoreState: removing ${toRemove.length} file(s): ${logFileList(toRemove, this.workspaceRoot)}`);
    }
    for (const fp of toRemove) {
      this.state.delete(fp);
    }
    if (toRemove.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(toRemove)).catch(err => { log(`git queue error: ${err}`); });
    }

    // Add newly allowed files not yet tracked (check both git HEAD and in-memory state
    // to avoid re-adding files that were loaded from index but not yet committed to HEAD).
    //
    // These files are silently snapshotted with their current content as baseline,
    // rather than treated as "new" (baseline='') which would produce hunks. This is
    // intentional to avoid flooding the user with false positives when:
    // - ignore rules changed and previously-ignored files are now un-ignored
    // - a large number of files become visible at once
    // Genuine new files created while interactive-review is running are caught by
    // FileWatcher.onDidCreate, not this path. This is intentionally consistent
    // with the onDiskChange fallback which also silently adopts content.
    const trackedSet = new Set(trackedFiles);
    for (const fp of this.state.keys()) trackedSet.add(fp);
    const toAdd = allowedFiles.filter(fp => !trackedSet.has(fp));
    if (toAdd.length > 0) {
      log(`syncIgnoreState: adding ${toAdd.length} file(s): ${logFileList(toAdd, this.workspaceRoot)}`);
    }
    if (toAdd.length > 0) {
      const batch = await this.readBatch(toAdd);
      if (batch.length > 0) {
        this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(batch)).catch(err => { log(`git queue error: ${err}`); });
      }
    }

    // Wait for all queued git operations to complete
    await this.gitQueue;
  }

  /**
   * Called on branch switch when clearOnBranchSwitch is enabled.
   * Clears all reviewing state, re-snapshots every tracked file to the current
   * disk content, and removes baselines for files that no longer exist.
   * This must be called while FileWatcher events are suppressed so that
   * git-checkout-induced file changes don't race with the clear.
   */
  async clearHunksOnBranchSwitch(shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
    const g = this._git;
    if (!g || !this.workspaceRoot) return;

    const reviewingCount = Array.from(this.state.values()).filter(s => s.status === 'reviewing').length;
    log(`clearHunksOnBranchSwitch: clearing ${reviewingCount} reviewing file(s), re-syncing all baselines`);

    // Collect all current workspace files (respecting ignore rules).
    // Read before clearing, for the same reason as rebuildState: a damaged baseline
    // repo must not cost the caller its in-memory state on the way out.
    let diskFiles: string[];
    let trackedFiles: string[];
    try {
      [diskFiles, trackedFiles] = await Promise.all([
        this.collectWorkspaceFiles(shouldIgnore),
        g.listTrackedFiles(),
      ]);
    } catch (err) {
      if (!(err instanceof BaselineUnreadableError)) throw err;
      log(`clearHunksOnBranchSwitch: aborting — ${err.message}`);
      return;
    }

    // Clear all in-memory state — fresh start
    this.state.clear();

    // Snapshot all disk files as new baselines
    const diskSet = new Set(diskFiles);
    const batch = await this.readBatch(diskFiles);

    // Remove baselines for files that no longer exist on disk
    const toRemove = trackedFiles.filter(fp => !diskSet.has(fp));

    if (toRemove.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.removeFileBatch(toRemove)).catch(err => { log(`git queue error: ${err}`); });
    }
    if (batch.length > 0) {
      this.gitQueue = this.gitQueue.then(() => g.snapshotBatch(batch)).catch(err => { log(`git queue error: ${err}`); });
    }

    // Wait for all git ops to complete before returning
    await this.gitQueue;
  }

  /**
   * Reset extension to disabled state (called when stateDir is deleted externally).
   */
  resetToDisabled(): void {
    this._enabled = false;
    this._sawReviewingFiles = false;
    this._ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
    this.state.clear();
    this._git = undefined;
    this.gitQueue = Promise.resolve();
  }

  /** Wait for all pending git operations to complete. Call on deactivate. */
  async flush(): Promise<void> {
    await this.gitQueue;
  }
}
