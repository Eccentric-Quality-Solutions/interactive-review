import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileState } from './types';
import { BaselineGit, BaselineUnreadableError, Settings } from './baselineGit';
import { hasReportableDiff } from './diffEngine';
import { log } from './log';
import { normalizePath } from './pathNormalize';
import { isBinaryFile, readTextFile } from './textFile';

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

  /**
   * Paths this session *witnessed being created* — the evidence behind
   * `nullReason: 'created'`, and therefore behind Discard's licence to delete a file.
   *
   * It exists because `rebuildState` (Refresh) throws the in-memory classification away
   * and re-derives it from the end state, which cannot distinguish "an agent created this
   * file" from "we never managed to baseline it". Without a memory of the witnessed
   * creates, a single Refresh would silently downgrade every genuinely-new file to
   * unbaselined and Discard would stop deleting agent output — the functionality this
   * whole mechanism is meant to protect, lost from the other direction.
   *
   * Session-scoped and monotonic: entries are added by `writeState`, moved by a rename,
   * and cleared only when a session starts or ends, never by `dropState` — `clearState`
   * fires `dropState` for every path, so shrinking it there would wipe the set on the very
   * rebuild it exists to survive. A path that leaves review and is later recreated is
   * simply re-witnessed. Because it only grows, a later `'unbaselined'` classification
   * outranks it; see `adoptedNullReason`.
   *
   * Saved beside the baseline repo and restored by `load()`, because it is the *only*
   * thing that makes an adopted file deletable: with no witness, a rescan answers
   * `'unbaselined'`. Unsaved, every agent-created file would become undeletable after a
   * window reload.
   */
  private sessionCreated = new Set<string>();
  /** A `saveCreated` write is scheduled but not yet done. See `saveCreated`. */
  private createdSavePending = false;

  /**
   * Paths this session classified `nullReason: 'unbaselined'` — the counterpart of
   * `sessionCreated`, and for the same reason: Refresh throws the classification away, and
   * `adoptUntrackedFiles` would otherwise re-adopt these as `'created'`, making a file the
   * session had decided to keep deletable. It holds only paths whose *most recent*
   * classification is `'unbaselined'`: a later witnessed create removes the path. Same
   * lifetime as `sessionCreated`, except that it is also saved beside the baseline repo
   * and restored by `load()`, so a window reload keeps it too.
   *
   * Guarded by `stateManagerGit.test.ts` ("keeps each null baseline's nullReason").
   */
  private sessionUnbaselined = new Set<string>();

  // Serial queue: git ops run one at a time; flush() awaits the tail
  private gitQueue: Promise<void> = Promise.resolve();
  /**
   * The teardown of the last End review: drain the queue, clear state, delete the repo.
   * Begin review waits on it before touching git — see `setEnabled`.
   */
  private teardown: Promise<void> = Promise.resolve();
  /** Bumped whenever a session opens or closes — see `session`. */
  private _session: number = 0;
  /** Overlapping-safe depth counter behind `ignoreSyncActive`. */
  private ignoreSyncDepth: number = 0;

  // Optional callback invoked when a git failure causes an in-memory rollback
  // (e.g. exitReviewing snapshot fails and reviewing state is restored).
  // Set by the extension to trigger UI refresh after unexpected state restoration.
  onRollback: (() => void) | undefined;

  /**
   * Fires the path whose baseline changed — including the path *acquiring* one
   * (enter reviewing) and *losing* one (exit / remove / clear).
   *
   * The diff editor's original side is a virtual document served from this map by
   * `extension.ts`'s content provider, and VS Code caches that document until told
   * otherwise. So the baseline has two representations — this map and VS Code's
   * cache — and only this event keeps them equal.
   *
   * It exists because the notification used to hang off the *accept* commands
   * instead, which got the ordering exactly backwards on the path that matters:
   * a final accept runs `exitReviewing` (entry deleted) and only *then* notified,
   * so the provider re-ran against an absent entry and cached `''`. Re-entering
   * reviewing after the next edit wrote a fresh baseline into the map and notified
   * nobody, so the next `vscode.diff` was served the empty cache and painted the
   * whole file as changed — while `computeHunks`, reading this map directly,
   * reported the one real hunk. Rejecting to completion did the same thing and
   * never notified at all.
   *
   * Hence: fired from the mutation, not from the caller. `writeState`/`dropState`/
   * `clearState` below are the only writers to `this.state` for that reason — a
   * bare `this.state.set` anywhere else silently reintroduces the bug.
   */
  private readonly baselineChanged = new vscode.EventEmitter<string>();
  readonly onDidChangeBaseline = this.baselineChanged.event;

  constructor() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      this.workspaceRoot = workspaceFolders[0].uri.fsPath;
      this.stateDir = path.join(this.workspaceRoot, '.vscode', 'interactive-review');
    }
  }

  // ── accessors ─────────────────────────────────────────────────────────────

  get enabled(): boolean { return this._enabled; }

  /**
   * Identifies the current review session. Changes on every Begin and End review.
   *
   * For async work that decides on one session's state and writes after an await: sample
   * it before, compare after, and drop the write on a mismatch. A disk-event handler that
   * reads a baseline across an End review would otherwise put a file into the review
   * queue *after* teardown cleared it, and since Begin review does not clear state, the
   * next session would open with that phantom entry. Comparing `enabled` alone misses an
   * End immediately followed by a Begin.
   */
  get session(): number { return this._session; }

  /**
   * Is a `syncIgnoreState` pass in flight?
   *
   * Read by `FileWatcher.handleDiskChange` to tell its two no-baseline cases apart: while
   * a sync runs, a newly un-ignored file legitimately has no baseline yet and must be
   * absorbed; outside one, a missing baseline means an edit we would otherwise drop
   * (ADR-0012). A counter rather than a boolean because the sync is fired from several
   * independent triggers (`enableReview`, the settings watcher, the `.gitignore` watcher)
   * and two passes can overlap — a boolean would let the first to finish reopen the gap
   * while the second is still adding baselines.
   */
  get ignoreSyncActive(): boolean { return this.ignoreSyncDepth > 0; }

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
   * Read a set of files into a snapshot batch. Binary and unreadable files are dropped:
   * neither must abort the batch, and neither has content that means anything as a
   * baseline.
   *
   * An unreadable file needs no record. Once readable, a rescan sees text with no blob and
   * no witnessed create, which `adoptedNullReason` answers `'unbaselined'`: Discard keeps
   * it. Guarded by `stateManagerGit.test.ts` ("a file unreadable at Begin review").
   *
   * The binary case needs an explicit test rather than the failed read this comment used
   * to claim. `fs.readFile(path, 'utf-8')` does not throw on binary input — it returns
   * replacement characters — so the old form baselined binaries as mush that a later
   * discard would write back over the real file. See `textFile.ts`.
   */
  private async readBatch(filePaths: string[]): Promise<{ filePath: string; content: string }[]> {
    const batch: { filePath: string; content: string }[] = [];
    let unreadable = 0;
    await Promise.all(filePaths.map(async filePath => {
      try {
        const content = await readTextFile(filePath);
        if (content === null) {
          log(`readBatch: skipping binary file ${path.basename(filePath)}`);
          return;
        }
        batch.push({ filePath, content });
      } catch {
        // Unreadable (permissions, transient race) — see method doc.
        unreadable++;
      }
    }));
    if (unreadable > 0) log(`readBatch: skipped ${unreadable} unreadable file(s)`);
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
      } catch {
        return; // unreadable — omit
      }
      // A binary nobody watched appear is a pre-existing asset, not a new file.
      //
      // "Untracked" here means only "the baseline repo has no blob for it", and
      // `readBatch` deliberately declines to make one for a binary — so without this,
      // every asset in the workspace reads as an externally created new file on the next
      // load/rebuild, floods the queue, and (before `nullReason`) was deletable by
      // Discard. A binary the watcher *did* see created is a genuinely new file and
      // belongs in the queue, which is what the witness check preserves across a Refresh.
      if (!this.sessionCreated.has(full) && await isBinaryFile(full)) return;
      untracked.push(full);
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
   * Put a baseline-repo write on the serial queue — the only way this class may reach
   * `BaselineGit`. Concurrent git invocations contend on `.git/index.lock` and the loser
   * throws, and every consumer here swallows that into the log, so a bare
   * `await g.snapshot(...)` costs a file its baseline silently. `onFailure` runs after the
   * log, for the callers that roll an in-memory write back.
   */
  private enqueue(
    label: string,
    op: (g: BaselineGit) => Promise<void>,
    onFailure?: (err: unknown) => void,
  ): void {
    const g = this._git;
    if (!g) return;
    this.gitQueue = this.gitQueue.then(() => op(g)).catch(err => {
      log(`git queue error (${label}): ${err}`);
      onFailure?.(err);
    });
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
        this.writeState(filePath, { status: 'reviewing', baseline });
        reviewing.push(filePath);
      } else {
        idle.push(filePath);
      }
    }));
    return { reviewing, idle, skippedNoBaseline, ignored };
  }

  /**
   * Enter every on-disk file that git isn't tracking into `reviewing` with a null
   * baseline. The untracked half of the shared load/rebuild scan (`scanTrackedIntoState`
   * is the tracked half); kept here so the two entry points can't drift on what counts as
   * an unbaselined file. Returns the adopted paths so `load()` can log them.
   *
   * A scan of the end state cannot distinguish a file an agent just created from one whose
   * baseline we failed to take, so the classification comes from `adoptedNullReason`:
   * `'created'` only for a witnessed create, `'unbaselined'` otherwise. See
   * `FileState.nullReason`.
   */
  private async adoptUntrackedFiles(
    tracked: string[],
    shouldIgnore?: (filePath: string, isDirectory?: boolean) => boolean
  ): Promise<string[]> {
    const untracked = await this.collectUntrackedFiles(new Set(tracked), shouldIgnore);
    for (const filePath of untracked) {
      // A rescan sees only the *result* — on disk, no blob — which a genuinely new file
      // and one we failed to baseline produce identically. The discrimination therefore
      // happens in `collectUntrackedFiles` above, not here.
      //
      this.writeState(filePath, { status: 'reviewing', baseline: null, nullReason: this.adoptedNullReason(filePath) });
    }
    return untracked;
  }

  /**
   * The `nullReason` for a file adopted by a rescan: `'created'` only when the session
   * witnessed the create and has not classified the path `'unbaselined'` since.
   *
   * No record reads as `'unbaselined'` — the value Discard keeps. This used to answer
   * `'created'` on the argument that readable text with no blob is "overwhelmingly" a new
   * file, and every way of losing the record then became a way of deleting a user's file:
   * a file ignored at Begin review and un-ignored before a reload, the children of a renamed
   * directory, a filename git reports C-quoted, a damaged record. Each was a separate bug
   * with a separate fix. Requiring positive evidence closes them as a class. The cost runs
   * the safe way: a new file whose witness was lost is kept on Discard, and the user
   * deletes it by hand. Guarded by `stateManagerGit.test.ts` ("a file with no record is
   * never adopted as deletable").
   *
   * Both sets are needed. `sessionCreated` is monotonic, so it still holds a witness for a
   * path discarded as 'created' and later restored by the user; `sessionUnbaselined` holds
   * that later classification, and `writeState` keeps the two consistent so the most recent
   * one wins.
   */
  private adoptedNullReason(filePath: string): 'created' | 'unbaselined' {
    return this.sessionCreated.has(filePath) && !this.sessionUnbaselined.has(filePath)
      ? 'created'
      : 'unbaselined';
  }

  /** Persist `sessionUnbaselined`, so a window reload keeps it. See `BaselineGit.loadUnbaselined`. */
  private saveUnbaselined(): void {
    this._git?.saveUnbaselined(this.sessionUnbaselined);
  }

  /**
   * Persist `sessionCreated`, so a window reload keeps it. See `BaselineGit.loadCreated`.
   *
   * Coalesced to one write per tick: the record is rewritten whole, so saving on every
   * create cost O(n²) and blocked the extension host for 17s over a 5000-file burst.
   * Deferring is safe only for this record: a write lost to a crash drops a witness, and
   * the file is then kept on Discard. `saveUnbaselined` stays synchronous because losing
   * it would let a stale witness win. `flush` writes a pending save.
   */
  private saveCreated(): void {
    if (this.createdSavePending) return;
    this.createdSavePending = true;
    setImmediate(() => this.writeCreatedRecord());
  }

  private writeCreatedRecord(): void {
    if (!this.createdSavePending) return;
    this.createdSavePending = false;
    this._git?.saveCreated(this.sessionCreated);
  }

  /**
   * Forget both classification sets, in memory and in the saved record. For session
   * boundaries only.
   *
   * The save matters after a branch switch, where the repo survives: a record left behind
   * would restore paths on the next reload that memory has forgotten, so a reload and
   * memory would disagree. Guarded by `stateManagerGit.test.ts` ("a branch switch forgets
   * the saved record"). End review and recovery remove the record with the repo anyway.
   */
  private forgetClassifications(): void {
    this.sessionCreated.clear();
    this.sessionUnbaselined.clear();
    this.saveCreated();
    this.saveUnbaselined();
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
    this.clearState();
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
    // Restore the previous window's classifications before anything is adopted. Without
    // the witnesses, every file an agent created would come back 'unbaselined' and stay on
    // disk through Discard; without the 'unbaselined' record, a restored witness would
    // outrank a later classification.
    for (const fp of g.loadCreated()) this.sessionCreated.add(normalizePath(fp));
    for (const fp of g.loadUnbaselined()) this.sessionUnbaselined.add(normalizePath(fp));
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
      this.enqueue('load: remove ignored', g2 => g2.removeFileBatch(ignored));
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
    this.clearState();
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

  // ── the only writers to `this.state` ──────────────────────────────────────
  //
  // Every mutation goes through these three so `onDidChangeBaseline` cannot be
  // forgotten. They take an already-normalized path: normalization is the public
  // methods' job, and doing it twice would hide a caller that skipped it.

  /** Set an entry, firing only if the baseline value actually moved. */
  private writeState(filePath: string, state: FileState): void {
    const prior = this.state.get(filePath);
    this.state.set(filePath, state);
    // `sessionUnbaselined` holds the paths whose most recent classification is
    // 'unbaselined', which is what `adoptedNullReason` reads. A path discarded as 'created'
    // and later restored by the user surfaces as an 'unbaselined' change, and must not stay
    // deletable because of the old witness.
    if (state.baseline === null && state.nullReason === 'created') {
      if (!this.sessionCreated.has(filePath)) {
        this.sessionCreated.add(filePath);
        this.saveCreated();
      }
      if (this.sessionUnbaselined.delete(filePath)) this.saveUnbaselined();
    } else if (state.baseline === null && !this.sessionUnbaselined.has(filePath)) {
      // Absent reads as 'unbaselined' (see FileState.nullReason), so record it the same way.
      this.sessionUnbaselined.add(filePath);
      this.saveUnbaselined();
    }
    // A status-only change (reviewing → reviewing with the same baseline) leaves the
    // virtual document correct, so it is not worth a re-fetch. `!prior` counts as a
    // move because an absent entry renders as `''`.
    if (!prior || prior.baseline !== state.baseline) this.baselineChanged.fire(filePath);
  }

  /** Delete an entry, firing only if one was actually there. */
  private dropState(filePath: string): void {
    if (this.state.delete(filePath)) this.baselineChanged.fire(filePath);
  }

  /**
   * Drop every entry, firing per path. Keys are snapshotted before the clear so the
   * listeners (which read `getFile`) observe the post-clear map, not a half-cleared one.
   */
  private clearState(): void {
    const paths = [...this.state.keys()];
    this.state.clear();
    for (const fp of paths) this.baselineChanged.fire(fp);
  }

  /** Releases the baseline-change emitter. Call from `deactivate`. */
  dispose(): void {
    this.baselineChanged.dispose();
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
    this.writeState(filePath, state);
    // Latch review activity at the mutation point so reviewComplete works regardless
    // of whether the caller routes through the extension's onStateChanged funnel.
    if (state.status === 'reviewing') this._sawReviewingFiles = true;
    if (!skipSnapshot && state.baseline !== null) {
      const baseline = state.baseline;
      this.enqueue('setFile', g => g.snapshot(filePath, baseline), () => {
        // Only rollback if this exact state object is still current (no newer operation has updated it)
        if (this.state.get(filePath) === state) {
          if (oldState) { this.writeState(filePath, oldState); } else { this.dropState(filePath); }
          this.onRollback?.();
        }
      });
    }
  }

  removeFile(filePath: string): void {
    filePath = normalizePath(filePath);
    // Clone old state so the rollback has an independent snapshot
    const oldState = this.state.has(filePath) ? { ...this.state.get(filePath)! } : undefined;
    this.dropState(filePath);
    // Skip git removal only when we know the file had a null baseline (never stored in git).
    // If oldState is undefined (idle file, not in map) or has a real baseline, queue the removal.
    if (!(oldState !== undefined && oldState.baseline === null)) {
      this.enqueue('removeFile', g => g.removeFile(filePath), () => {
        // Only rollback if no newer operation has re-added the entry
        if (!this.state.has(filePath) && oldState) {
          this.writeState(filePath, { ...oldState });
          this.onRollback?.();
        }
      });
    }
  }

  /**
   * Remove `dirPath` and everything beneath it, from memory and from the baseline repo.
   *
   * `removeFile` cannot do this job, and fails at it *silently*: it runs
   * `git update-index --force-remove -- <dir>`, which **exits 0 having removed nothing**
   * (confirmed against a scratch repo with two tracked files under one directory, both
   * still present afterwards). Git's index has no directory entries to remove.
   *
   * The visible consequence was a folder deleted in the Explorer leaving every file under
   * it still tracked with a baseline, so the next Refresh or window reload surfaced the
   * whole folder as a queue of pending deletions the user had already carried out.
   *
   * The in-memory sweep alone is not enough either, which is why this reads the tracked
   * list: a file that was never edited has a baseline in git but no entry in `state`, and
   * those are exactly the ones that came back as phantom deletions.
   *
   * No rollback, deliberately. The directory is already gone from disk, so restoring the
   * entries would only re-desync state from the filesystem — the same reasoning
   * `renameFile` gives for not rolling back a path migration.
   */
  removePathAndChildren(dirPath: string): void {
    dirPath = normalizePath(dirPath);
    const prefix = dirPath + path.sep;
    const under = (fp: string) => fp === dirPath || fp.startsWith(prefix);

    for (const fp of Array.from(this.state.keys())) {
      if (under(fp)) this.dropState(fp);
    }

    this.enqueue('removePathAndChildren', async g => {
      let tracked: string[];
      try {
        tracked = await g.listTrackedFiles();
      } catch (err) {
        // A damaged repo must not turn a delete into a workspace-wide reclassification;
        // leave the index alone and let load()/rebuildState's recovery handle it.
        log(`removePathAndChildren: skipping git removal — ${err}`);
        return;
      }
      const toRemove = tracked.filter(under);
      if (toRemove.length === 0) return;
      log(`removePathAndChildren: removing ${toRemove.length} baseline(s) under ${path.basename(dirPath)}`);
      await g.removeFileBatch(toRemove);
    });
  }

  renameFile(oldFilePath: string, newFilePath: string): void {
    oldFilePath = normalizePath(oldFilePath);
    newFilePath = normalizePath(newFilePath);

    // Handle both single-file and directory renames in in-memory state.
    // For a directory rename, migrate all entries under the old prefix.
    const oldPrefix = oldFilePath + path.sep;
    let hasDirChildren = false;
    const fileState = this.state.get(oldFilePath);
    // The source wins: a rename replaces whatever the target path held, including a
    // deletion still in review there. git moves the source's baseline over the target's, so
    // memory must drop the target's entry too, or the queue shows a change a reload does
    // not. Guarded by `reloadEqualsMemory.test.ts` ("renaming onto a pending deletion").
    if (!fileState && this.state.has(newFilePath)) this.dropState(newFilePath);
    // A source with no entry may have no baseline either, and then nothing says the moved
    // file is new, so a later rescan must not adopt it as deletable. Recording the target
    // is harmless when git does move a baseline there: adoption never consults it then.
    if (!fileState && !this.sessionUnbaselined.has(newFilePath)) {
      this.sessionUnbaselined.add(newFilePath);
      this.saveUnbaselined();
    }
    if (fileState) {
      // Exact match — single file rename
      this.dropState(oldFilePath);
      this.writeState(newFilePath, fileState);
      // The create was witnessed at the old path; a rename does not make the file any
      // less new, and losing the witness here would strand it as undeletable.
      if (this.sessionCreated.delete(oldFilePath)) {
        this.sessionCreated.add(newFilePath);
        this.saveCreated();
      }
    }
    // Also check for directory children (entries whose path starts with oldFilePath + sep)
    for (const [fp, childState] of [...this.state.entries()]) {
      if (fp.startsWith(oldPrefix)) {
        this.dropState(fp);
        const newFp = newFilePath + fp.slice(oldFilePath.length);
        this.writeState(newFp, childState);
        // As for a single file: the witness moves with the child.
        if (this.sessionCreated.delete(fp)) {
          this.sessionCreated.add(newFp);
          this.saveCreated();
        }
        hasDirChildren = true;
      }
    }

    // Skip git rename only when we know it was a single file with null baseline (never stored in git).
    // For directories or idle files (not in map), always queue — git may have baselines.
    const skipGit = fileState && fileState.baseline === null && !hasDirChildren;
    if (!skipGit) {
      // No rollback of the in-memory path mapping, deliberately: the file has already been
      // renamed on disk, so reverting to oldFilePath would desync state/UI from the
      // filesystem.
      this.enqueue('renameFile', g => g.renameFile(oldFilePath, newFilePath));
    } else {
      // No baseline to move, but the target may still hold one: a deletion in review, or a
      // file the rename overwrote. The source wins, so remove it, or a reload would review
      // the moved file as an edit of the old one. A no-op when the target is untracked.
      this.enqueue('renameFile: clearing target', g => g.removeFile(newFilePath));
    }
  }

  /**
   * Snapshot a file's content as baseline via the git queue (serialized).
   * Use this instead of calling git.snapshot() directly to avoid concurrent git ops.
   */
  snapshotFile(filePath: string, content: string): void {
    this.enqueue('snapshotFile', g => g.snapshot(filePath, content));
  }

  /**
   * The baseline repo's current baseline for `filePath`, read *after* every queued write.
   *
   * The event handlers must read baselines through this rather than `git.getBaseline`.
   * Writes to the repo are queued (`gitQueue`) while a direct read goes to the index at
   * once, so a read that lands behind a pending write answers with the value that write is
   * about to replace — and the handler then records that stale value in memory, where a
   * reload cannot agree with it:
   *
   * - accept a file, then delete it: the deletion is shown against the *pre-accept* text,
   *   so Discard restores content the user already accepted away;
   * - delete a folder from the Explorer, then recreate a file in it: the create finds the
   *   baseline the delete is about to remove and queues an edit instead of a new file.
   *
   * `handleDiskChange` once did this by hand (a `flush()` before its read); the other two
   * handlers did not. Owning the ordering here means a new caller cannot forget it.
   * Guarded by the pinned sequences in `reloadEqualsMemory.test.ts`.
   */
  async readBaseline(filePath: string): Promise<string | undefined> {
    await this.gitQueue;
    return this._git?.getBaseline(normalizePath(filePath));
  }

  /**
   * The baselined files under `dirPath`, read after queued git writes like `readBaseline`.
   * Empty with no repo. May throw `BaselineUnreadableError`.
   */
  async listTrackedUnder(dirPath: string): Promise<string[]> {
    await this.gitQueue;
    return (await this._git?.listTrackedUnder(normalizePath(dirPath))) ?? [];
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
    this.dropState(filePath);
    if (newBaseline !== undefined && newBaseline !== null) {
      const baseline = newBaseline;
      this.enqueue('exitReviewing', g => g.snapshot(filePath, baseline), () => {
        // Restore reviewing state so the user can retry rather than silently getting a stale baseline
        if (!this.state.has(filePath) && oldState) {
          this.writeState(filePath, { ...oldState });
          this.onRollback?.();
          void vscode.window.showErrorMessage(
            `Failed to update review baseline for ${path.basename(filePath)}. The file has been kept in reviewing so you can retry.`
          );
        }
      });
    }
  }


  // ── settings ──────────────────────────────────────────────────────────────

  async setEnabled(value: boolean): Promise<void> {
    this._enabled = value;
    const session = ++this._session;
    // A new session (open on enable, teardown on disable) starts fresh: no
    // pending work seen yet, so a subsequent drain-to-zero reads as complete.
    this._sawReviewingFiles = false;
    if (value) {
      // An End review may still be draining. Its teardown deletes the repo directory, which
      // a new BaselineGit would share, so nothing here may touch git until it has finished.
      await this.teardown;
      // An End review that arrived while this waited has already done its teardown — with
      // nothing attached to tear down. Carrying on would create and snapshot a repo for a
      // session that is over, and `load()` reads an existing repo as "review is on", so the
      // next window reload would reopen the session the user ended.
      if (this._session !== session) return;
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
      // Drain before tearing down. A write still queued behind the repo's deletion fails,
      // and its rollback then re-adds the entry to a session that has ended and tells the
      // user a baseline update failed "so you can retry" — after End review, for an accept
      // that happened before it. Guarded by `reloadEqualsMemory.test.ts` ("End review
      // straight after an accept").
      //
      // Draining opens a window, and two things keep a Begin review that lands in it from
      // being destroyed by this teardown. `_git` is detached now, synchronously, so Begin
      // cannot pick up this instance through `ensureGit` and snapshot into a repo about to
      // be deleted. And Begin waits for `teardown` before creating its own, so it cannot
      // initialise a repo at the same path that this then deletes. Guarded by
      // `stateManagerGit.test.ts` ("Begin review during End review's drain").
      const g = this._git;
      this._git = undefined;
      const drained = this.gitQueue;
      this.teardown = (async () => {
        await drained;
        this.clearState();
        this.forgetClassifications();
        g?.destroyGit();
      })();
      await this.teardown;
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
    let failure: unknown;
    if (batch.length > 0) {
      // Through `gitQueue`, not a bare await, matching every other `snapshotBatch` call
      // site. The queue exists because concurrent git invocations contend on
      // `.git/index.lock` and the loser throws — and every queue consumer swallows that
      // error, so a collision costs a file its baseline silently. Running off-queue was
      // survivable only while nothing else wrote git during enable; `handleDiskCreate`'s
      // adopt-during-snapshot branch now does exactly that.
      //
      // The failure is captured and re-thrown. A snapshot that fails leaves the session
      // enabled over a repo with no baselines, which renders as an empty review queue —
      // indistinguishable from a clean start with nothing to review, while every later edit
      // surfaces as a whole-file "unbaselined" hunk. That is the one state where silence
      // actively misleads.
      //
      // Re-thrown rather than reported from here, because the two callers must react
      // differently and only they know how. `enableReview` tells the user and rejects, so an
      // agent awaiting Begin review learns the baseline is not on disk instead of being told
      // it succeeded. `recoverLostBaseline` needs it to reach its own failure branch: it
      // sets `rebuilt = true` on the next line, so swallowing here made it announce "a fresh
      // baseline has been taken" *alongside* the failure message — two notifications
      // contradicting each other.
      //
      // `enqueue`'s own `.catch` stays in play: the chain must remain usable for later
      // operations, so the failure is captured out through `onFailure` rather than thrown.
      this.enqueue('snapshotWorkspace', g2 => g2.snapshotBatch(batch), err => { failure = err; });
    }
    await this.gitQueue;
    if (failure !== undefined) throw failure;
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
    // The flag must cover the whole pass including its awaits, and every exit from it —
    // the early returns and the `BaselineUnreadableError` abort as much as the success
    // path. A `finally` around a delegating call is the only form that cannot be defeated
    // by adding another `return` to the body later.
    this.ignoreSyncDepth++;
    try {
      await this.syncIgnoreStateInner(shouldIgnore);
    } finally {
      this.ignoreSyncDepth--;
    }
  }

  private async syncIgnoreStateInner(shouldIgnore: (filePath: string, isDirectory?: boolean) => boolean): Promise<void> {
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
        this.dropState(fp);
      }
    }
    if (toRemove.length > 0) {
      log(`syncIgnoreState: removing ${toRemove.length} file(s): ${logFileList(toRemove, this.workspaceRoot)}`);
    }
    for (const fp of toRemove) {
      this.dropState(fp);
    }
    if (toRemove.length > 0) {
      this.enqueue('syncIgnoreState: remove', g2 => g2.removeFileBatch(toRemove));
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
        this.enqueue('syncIgnoreState: add', g2 => g2.snapshotBatch(batch));
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
    this.clearState();
    this.forgetClassifications();

    // Snapshot all disk files as new baselines
    const diskSet = new Set(diskFiles);
    const batch = await this.readBatch(diskFiles);

    // Remove baselines for files that no longer exist on disk
    const toRemove = trackedFiles.filter(fp => !diskSet.has(fp));

    if (toRemove.length > 0) {
      this.enqueue('branchSwitch: remove', g2 => g2.removeFileBatch(toRemove));
    }
    if (batch.length > 0) {
      this.enqueue('branchSwitch: snapshot', g2 => g2.snapshotBatch(batch));
    }

    // Wait for all git ops to complete before returning
    await this.gitQueue;
  }

  /**
   * Reset extension to disabled state (called when stateDir is deleted externally).
   */
  resetToDisabled(): void {
    this._enabled = false;
    this._session++;
    this._sawReviewingFiles = false;
    this._ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
    this.clearState();
    this.forgetClassifications();
    this._git = undefined;
    this.gitQueue = Promise.resolve();
  }

  /** Wait for all pending git operations to complete. Call on deactivate. */
  async flush(): Promise<void> {
    await this.gitQueue;
    this.writeCreatedRecord();
  }
}
