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
import { SnapshotCreateTracker } from './snapshotCreateTracker';
import { PathSerializer } from './pathSerializer';
import { readFileForReview, stripBom } from './textFile';

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

/** What a disk event's handler needs to know about the moment the event arrived. */
interface EventArrival {
  duringSnapshot: boolean;
  session: number;
}

/** One VSCode-initiated save, tracked by object identity — see `pendingManualSaves`. */
interface SaveToken {
  content: string;
}

export class FileWatcher {
  private disposables: vscode.Disposable[] = [];
  private selfEditFiles: Set<string> = new Set();
  // Content VSCode itself just saved (manual save or auto-save), keyed by path.
  // A disk change whose content matches a pending save is a user save → absorbed
  // into the baseline. Anything else is an external/AI write → surfaced for review.
  // This replaces the old buffer-match heuristic, which VSCode's silent reload of
  // clean open buffers made unreliable (see docs/terminal-edits-not-captured.md).
  //
  // Boxed rather than a bare string so each save is a distinct *identity*: the disk-event
  // wrappers release only the token they started with, and two saves of byte-identical
  // content are still two tokens. A plain string map could not tell them apart.
  private pendingManualSaves: Map<string, SaveToken> = new Map();
  // Files being deleted by the user via VSCode (explorer / applyEdit)
  private pendingUserDeletes: Set<string> = new Set();
  // Old paths of in-progress user renames — suppress onDiskDelete without extra git ops
  private pendingRenameOldPaths: Set<string> = new Set();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private onStateChanged: () => void;
  private onIgnoreRulesChanged: (() => void) | undefined;
  /**
   * Called after a watcher-driven `exitReviewing`, to close the file's now-stale
   * diff tab. The command paths (accept/reject) already do this via
   * `walkAfterResolve`; these three sites are the ones that never did.
   *
   * It became load-bearing when `StateManager` started firing `onDidChangeBaseline`
   * on delete: the baseline document for a dropped entry now correctly re-renders as
   * `''`, so an open diff tab repaints the whole file as added. Undo-to-baseline with
   * the diff open is the reachable case. Closing the tab is the fix — suppressing the
   * notification instead would restore the old behaviour only by pairing two errors.
   *
   * Deliberately *not* driven off `onDidChangeBaseline` in `extension.ts`, which would
   * be the tidier seam: `clearState` fires once per path, so a teardown with N files
   * would run a full scan of every tab group N times.
   *
   * Takes no path for the same reason. The consumer scans every tab group and closes
   * whatever no longer reviews, so a path would be decoration — and decorating it would
   * invite one call per file in the directory-delete loop, which is the cost this whole
   * arrangement exists to avoid. One call per event, after the state settles.
   */
  private onFileLeftReview: (() => void) | undefined;
  // Compiled ignore instance from workspace .gitignore
  private gitignoreMatcher: Ignore = ignoreLib();
  // When true, all file-system events are suppressed (used during branch switch)
  private _suppressed: boolean = false;
  // Enable-window state: whether `snapshotWorkspace` is mid-flight (see
  // `snapshotInProgress`) plus the create handlers that began inside it.
  private snapshotCreates: SnapshotCreateTracker = new SnapshotCreateTracker();
  // Disk-event handlers for one path run one at a time, in arrival order — see PathSerializer.
  private perPath: PathSerializer = new PathSerializer();

  constructor(
    private stateManager: StateManager,
    onStateChanged: () => void,
    onIgnoreRulesChanged?: () => void,
    onFileLeftReview?: () => void
  ) {
    this.onStateChanged = onStateChanged;
    this.onIgnoreRulesChanged = onIgnoreRulesChanged;
    this.onFileLeftReview = onFileLeftReview;
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
    watcher.onDidDelete(uri => {
      const { session } = this.arrival();  // on arrival — see the create/change wrappers
      return this.perPath.run(normalizePath(uri.fsPath), () => this.onDiskDelete(uri, session));
    });
    watcher.onDidCreate(uri => this.snapshotCreates.track(this.onDiskCreate(uri)));
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
      this.pendingManualSaves.set(normalizePath(doc.uri.fsPath), { content: doc.getText() });
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
   * Mark `snapshotWorkspace` as running, so a create event that lands inside the enable
   * window is classified as pre-existing rather than new. See `handleDiskCreate`.
   *
   * Deliberately *not* `suppressAll`, which the obvious symmetry with activation would
   * suggest: `_suppressed` gates all four handlers, so it would also blind the watcher to
   * deletes and to changes against files the snapshot had already baselined. This flag
   * changes one classification decision and nothing else. It also fails safe — a flag
   * stuck true costs one file quietly baselined, whereas suppression stuck true is a
   * permanently deaf watcher.
   */
  beginSnapshot(): void {
    this.snapshotCreates.open();
  }

  /** Clear the enable-window flag. Must run even if the snapshot throws. */
  endSnapshot(): void {
    this.snapshotCreates.close();
  }

  /**
   * Wait for every create handler that began inside the enable window to finish, and
   * report how many there were.
   *
   * `snapshotWorkspace` returning does not mean the enable window's work is done. A
   * create adopted by `handleDiskCreate` enqueues its baseline write only after a disk
   * read and a git read, so a handler still in that prelude has put *nothing* on
   * `gitQueue` yet — and `StateManager.flush` awaits the queue as it stands when called.
   * Draining the queue without first draining these handlers therefore resolves
   * `beginReview` while the baseline for exactly the files the enable window exists to
   * protect is still unwritten; the agent's first edit to one then lands on an undefined
   * baseline, and — since ADR-0012 moved that branch from absorb to review — surfaces the
   * whole pre-existing file as a spurious "new file" hunk. Noisy rather than silent, which
   * is the direction we want, but still a bug this is here to prevent.
   *
   * The count lets the caller alternate settle/flush until a pass finds nothing, which is
   * the only sound stopping condition: waiting can itself admit new creates.
   */
  settleSnapshotCreates(): Promise<number> {
    return this.snapshotCreates.settle();
  }

  /**
   * Consume-once check: did VSCode itself just save exactly `diskContent` to `filePath`?
   * Returns true only when a pending save is recorded for the path AND its content matches
   * the bytes now on disk, then clears the token. Whole-file match is deliberate: a
   * mismatch falls through to the review path (safe — at worst a spurious hunk on your own
   * save), whereas a loose match risks absorbing a genuine external edit (silent data loss).
   * The single exception, and its reasoning, is at the comparison itself.
   */
  private consumeManualSave(filePath: string, diskContent: string): boolean {
    const saved = this.pendingManualSaves.get(filePath);
    if (saved === undefined) return false;
    this.pendingManualSaves.delete(filePath);
    // BOM-insensitive, and *only* BOM-insensitive. The token holds `doc.getText()`, which
    // VS Code has already stripped the BOM from, while `diskContent` is the raw bytes it
    // just wrote — BOM included. Comparing them directly meant every hand-save of a BOM'd
    // file failed to match and fell through to review, which is precisely the "your own
    // typing enters the queue" outcome this mechanism exists to prevent.
    //
    // This does not loosen the guarantee in ADR-0006. Equality still has to hold across
    // the entire file; the two strings simply have to agree about content rather than
    // about an encoding marker neither side chose. Nothing else is normalized here —
    // matching on EOL or whitespace would let a real external edit be mistaken for a save.
    return stripBom(saved.content) === stripBom(diskContent);
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

  /**
   * A pending-save token is valid for exactly one disk event: the one caused by the save
   * that recorded it. Every handler below therefore releases the token on *every* exit,
   * via the `finally` in these two wrappers, whether or not it was acted on.
   *
   * Letting a token outlive its event is not merely a leak (it retains the file's full
   * text): the next external write of byte-identical content would match it and be
   * absorbed into the baseline instead of surfaced for review — the silent data loss
   * `consumeManualSave`'s exact comparison exists to prevent. Handlers return early on
   * many paths (suppressed, ignored, not-enabled, read failure, already reviewing), and
   * each one used to strand the token.
   *
   * Discarding is always the safe direction: an unconsumed token costs at most a spurious
   * hunk on the user's own save, which they can accept in one keystroke.
   *
   * Only the token this handler *started with* is released. Handlers await disk and git
   * reads, and a second save of the same file can land in that window and replace the
   * entry; deleting by path alone would throw away the newer save's token and make the
   * user's own second save look like an external edit. Comparing identity leaves a
   * replacement token in place for the handler that will actually consume it.
   */
  //
  // Everything that describes the *event* is sampled here, on arrival, before the handler
  // waits its turn in `perPath`: the save token (a save landing while an earlier handler for
  // the same file runs is a later event's), whether the enable snapshot is running (arrival
  // time is the property that window tests), and the session (an event that arrived before
  // End review belongs to the ended session, even if its handler runs after a new Begin).
  private onDiskCreate(uri: vscode.Uri): Promise<void> {
    const filePath = normalizePath(uri.fsPath);
    const token = this.pendingManualSaves.get(filePath);
    const arrival = this.arrival();
    return this.perPath.run(filePath, async () => {
      try {
        await this.handleDiskCreate(filePath, arrival);
      } finally {
        this.releaseSaveToken(filePath, token);
      }
    });
  }

  private onDiskChange(uri: vscode.Uri): Promise<void> {
    const filePath = normalizePath(uri.fsPath);
    const token = this.pendingManualSaves.get(filePath);
    const arrival = this.arrival();
    return this.perPath.run(filePath, async () => {
      try {
        await this.handleDiskChange(filePath, arrival);
      } finally {
        this.releaseSaveToken(filePath, token);
      }
    });
  }

  private arrival(): EventArrival {
    return { duringSnapshot: this.snapshotCreates.active, session: this.stateManager.session };
  }

  /** Drop `token` if it is still the entry for `filePath` — see the wrappers above. */
  private releaseSaveToken(filePath: string, token: SaveToken | undefined): void {
    if (token !== undefined && this.pendingManualSaves.get(filePath) === token) {
      this.pendingManualSaves.delete(filePath);
    }
  }

  private async handleDiskCreate(filePath: string, { duringSnapshot, session }: EventArrival): Promise<void> {
    const basename = path.basename(filePath);
    // `duringSnapshot` and `session` were sampled on arrival, in the wrapper, not here and
    // not at the branch that consumes them. This handler awaits a disk read and a git read
    // before classifying, and `endSnapshot` can land in either gap — reading the flag late
    // would classify a create that arrived *inside* the enable window against a flag that
    // has since cleared, reinstating the exact false-new-file race the flag was added to
    // remove. Arrival time is the property being tested. Every write below comes after an
    // await, hence the `session` checks; see `StateManager.session`.
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (this.stateManager.session !== session) return;  // changed while queued in `perPath`
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
      if (this.stateManager.session !== session) return;
      log(`onDiskCreate(${basename}): reviewing, recompute hunks (baseline.len=${fileState.baseline?.length ?? 'null'}, disk.len=${diskContent.length})`);
      this.recomputeHunks(filePath, fileState.baseline, diskContent);
      return;
    }
    if (fileState) { log(`onDiskCreate(${basename}): has fileState but not reviewing, skip`); return; }

    const git = this.stateManager.git;
    if (!git) { log(`onDiskCreate(${basename}): no git, skip`); return; }

    let diskContent: string;
    let isBinary: boolean;
    try {
      ({ text: diskContent, binary: isBinary } = await readFileForReview(filePath));
    } catch {
      log(`onDiskCreate(${basename}): read failed, skip`);
      return;
    }

    const gitBaseline = await this.stateManager.readBaseline(filePath);
    if (this.stateManager.session !== session) { log(`onDiskCreate(${basename}): session changed while reading, skip`); return; }
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
      if (isBinary) { log(`onDiskCreate(${basename}): saved file is binary — not baselining`); return; }
      log(`onDiskCreate(${basename}): matched VSCode save, snapshot as baseline`);
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }

    // No baseline, but `snapshotWorkspace` is still running — the file was on disk when
    // Begin review was pressed and simply has not been walked yet. Silently adopt it as
    // baseline, matching what `handleDiskChange` already does for the identical race (see
    // its `gitBaseline === undefined` branch, which names this case explicitly). Without
    // this the outcome is a coin flip on filesystem timing: whichever of
    // `collectWorkspaceFiles` and the create event wins decides whether the user's first
    // sight of the session is an empty queue or every line of the file marked added.
    //
    // The cost is a genuine create landing inside the enable window being baselined
    // instead of queued. That window is the snapshot's duration, and `beginReview`'s
    // contract is "disk as it stands now is the baseline" — a quiet miss there is the
    // better failure than a nondeterministic false new-file at t=0.
    //
    // A residual sliver stays open by construction: a file created after
    // `collectWorkspaceFiles` returns but before `snapshotBatch` finishes gets no baseline
    // at all. Since ADR-0012 its next change is *reviewed* as a new file rather than
    // absorbed, so the sliver now costs a spurious whole-file hunk instead of a lost edit.
    // Closing it outright would mean making the snapshot atomic against the filesystem,
    // which it cannot be.
    if (duringSnapshot) {
      if (isBinary) { log(`onDiskCreate(${basename}): create during enable snapshot is binary — not baselining`); return; }
      log(`onDiskCreate(${basename}): create during enable snapshot, adopt as baseline`);
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }

    // External tool created this file — show as new file hunk. This is the one site that
    // actually witnessed the create, so it is the one site allowed to say 'created', which
    // is what licenses Discard to delete the file again.
    log(`onDiskCreate(${basename}): external create, enterReviewing as NEW`);
    this.enterReviewing(filePath, null, diskContent, 'created');
  }

  private async onDiskDelete(uri: vscode.Uri, session: number): Promise<void> {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (this.stateManager.session !== session) return;  // changed while queued in `perPath`
    const filePath = normalizePath(uri.fsPath);
    const basename = path.basename(filePath);
    // `session` was sampled on arrival; the external-delete branch writes after an await.
    // See `StateManager.session`.
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
      // Always go through the state manager so git ops are serialized via gitQueue.
      //
      // `removePathAndChildren` rather than `removeFile` plus a loop over in-memory state:
      // the path may be a directory, in which case git removes nothing for it and every
      // tracked file underneath keeps its baseline. Files under that directory that were
      // never edited are not in `state` at all, so only a pass over the tracked list finds
      // them. See the method's own note for what that left behind.
      this.pendingUserDeletes.delete(filePath);
      log(`onDiskDelete(${basename}): user delete, removing path and any children`);
      const hadChildren = Array.from(this.stateManager.getAllFiles().keys())
        .some(childPath => childPath.startsWith(filePath + path.sep));
      this.stateManager.removePathAndChildren(filePath);
      if (fileState || hadChildren) {
        // These entries have left review, so their diff tabs are now stale — the same
        // sweep the other two exits from this handler already perform.
        this.onFileLeftReview?.();
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
      this.onFileLeftReview?.();
      this.onStateChanged();
      return;
    }

    const gitBaseline = fileState?.baseline ?? await this.stateManager.readBaseline(filePath);
    if (this.stateManager.session !== session) { log(`onDiskDelete(${basename}): session changed while reading, skip`); return; }
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
      // One tab sweep after the loop, not one per child — see `onFileLeftReview`.
      let childLeftReview = false;
      for (const [childPath, childState] of allFiles) {
        if (!childPath.startsWith(dirPrefix)) continue;
        if (childState.baseline === null) {
          // New file (no git baseline) — just remove from state
          this.stateManager.exitReviewing(childPath);
          childLeftReview = true;
        } else {
          // Has baseline — show deletion diff
          this.enterReviewing(childPath, childState.baseline, '');
        }
        childrenCleaned++;
      }
      if (childrenCleaned > 0) {
        log(`onDiskDelete(${basename}): cleaned ${childrenCleaned} child file(s) from deleted directory`);
        if (childLeftReview) this.onFileLeftReview?.();
        this.onStateChanged();
      }
      return;
    }
    // gitBaseline is '' (empty file) or has content — show deletion diff.
    // Pass '' as current content since file no longer exists on disk.
    // enterReviewing will detect isDeleted via !fs.existsSync.
    this.enterReviewing(filePath, gitBaseline, '');
  }

  private async handleDiskChange(filePath: string, { duringSnapshot, session }: EventArrival): Promise<void> {
    const basename = path.basename(filePath);
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (this.stateManager.session !== session) return;  // changed while queued in `perPath`

    // `duringSnapshot` and `session` were sampled on arrival, in the wrapper, for the same
    // reason as in `handleDiskCreate`: arrival time is the property being tested. This
    // handler awaits a disk read and a git read before reaching the no-baseline branch, so
    // a late read would see the window closed for an event that genuinely arrived inside
    // it — and would then show the enable snapshot's own files as new.

    if (this.shouldIgnore(filePath)) { log(`onDiskChange(${basename}): ignored, skip`); return; }
    if (this.selfEditFiles.has(filePath)) {
      // The extension's own write (accept/reject) — its save fired onDidSaveTextDocument
      // too. The wrapper's finally drops the resulting token.
      log(`onDiskChange(${basename}): self-edit, skip`);
      return;
    }

    let diskContent: string;
    let isBinary: boolean;
    try {
      ({ text: diskContent, binary: isBinary } = await readFileForReview(filePath));
    } catch {
      log(`onDiskChange(${basename}): read failed, skip`);
      return;
    }
    // Before the save-absorb and reviewing branches, which write without a further await.
    if (this.stateManager.session !== session) { log(`onDiskChange(${basename}): session changed while reading, skip`); return; }

    // Resolve the save token here, while the disk content needed to compare it is in
    // hand; the branches below only read the boolean. Reclamation itself is guaranteed
    // by the wrapper's finally, so an early return above this line is also safe.
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
      if (isBinary) { log(`onDiskChange(${basename}): saved file is binary — not baselining`); return; }
      log(`onDiskChange(${basename}): matched VSCode save, snapshot as baseline`);
      this.stateManager.snapshotFile(filePath, diskContent);
      return;
    }

    // External change — compare against interactive-review baseline.
    //
    // Drained first, because `snapshotFile` only *queues* its write while `getBaseline`
    // reads the index directly. One save can surface as two change deliveries; the first
    // consumes the save token and queues the new baseline, and without this the second
    // reads the pre-save baseline, finds a diff, and puts the user's own typing in the
    // queue — the exact outcome the save token exists to prevent. Reading a baseline
    // while writes to it are in flight was never sound, which is why `readBaseline` drains
    // the queue itself.
    const gitBaseline = await this.stateManager.readBaseline(filePath);
    if (this.stateManager.session !== session) { log(`onDiskChange(${basename}): session changed while reading, skip`); return; }
    if (gitBaseline === undefined) {
      // No baseline in git. Two populations reach here and they want opposite handling
      // (ADR-0012, superseding ADR-0008's blanket absorb):
      //
      // - A file the tool has not finished baselining *yet*: the enable snapshot or an
      //   ignore-rule sync is mid-flight. It is not new, we are just early, and showing
      //   it would flood the queue with whole-file "new file" hunks for files the user
      //   never touched. Absorb.
      // - Everything else: unreadable at enable, untracked at enable, or — the case this
      //   branch existed to swallow — an external CREATE the watcher missed, surfacing
      //   only as a CHANGE. That is a genuine agent edit, and absorbing it is the tool's
      //   worst failure mode. Review it as a new file.
      //
      // Both windows are explicit flags rather than inferred, so the fallthrough is the
      // safe direction: an unknown state reviews rather than drops.
      if (duringSnapshot || this.stateManager.ignoreSyncActive) {
        const why = duringSnapshot ? 'enable snapshot' : 'ignore sync';
        if (isBinary) { log(`onDiskChange(${basename}): no baseline during ${why}, but file is binary — not baselining`); return; }
        log(`onDiskChange(${basename}): no baseline during ${why} — adopting as baseline (not yet tracked, not new)`);
        this.stateManager.snapshotFile(filePath, diskContent);
        return;
      }
      // Binaries are skipped at enable (`readBatch`), so a pre-existing asset reaches
      // here with no baseline. Skipping is now a *display* decision rather than a safety
      // one — `nullReason: 'unbaselined'` below already keeps Discard's delete branch off
      // this population — but a whole-file hunk of replacement characters is not a review,
      // so there is nothing to gain by queueing it.
      if (isBinary) {
        log(`onDiskChange(${basename}): external change, no baseline, binary — skip (nothing legible to review)`);
        return;
      }
      // 'unbaselined', not 'created': this handler sees a *change*, so it has no evidence
      // the file is new — it may be an asset we never baselined or a create the watcher
      // missed. Reviewing it either way is the ADR-0012 decision; deleting it on discard
      // would not be.
      log(`onDiskChange(${basename}): external change with NO baseline and no snapshot in flight — reviewing as unbaselined (was Cause B)`);
      this.enterReviewing(filePath, null, diskContent, 'unbaselined');
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

  /**
   * `nullReason` is required in spirit whenever `baseline` is null and ignored otherwise;
   * it is what decides whether a later Discard *deletes* this file (see
   * `FileState.nullReason`). Only this class may claim `'created'`, because only the
   * watcher witnesses a create — every other producer of a null baseline is inferring
   * from the end state and must say `'unbaselined'`. Omitting it defaults to the
   * non-deleting reading.
   */
  private enterReviewing(
    filePath: string,
    baseline: string | null,
    current: string,
    nullReason: 'created' | 'unbaselined' = 'unbaselined',
  ): void {
    const hunks = computeHunks(baseline, current);
    const isNew = baseline === null && nullReason === 'created';
    const isDeleted = !fs.existsSync(filePath) && baseline !== null;
    // Allow 0-hunk entry for new/unbaselined files (null baseline) and deleted files
    // (file gone, nothing to diff)
    if (hunks.length === 0 && baseline !== null && !isDeleted) return;
    const tag = isNew ? ' (new)' : baseline === null ? ' (unbaselined)' : isDeleted ? ' (deleted)' : '';
    log(`reviewing: ${path.basename(filePath)}${tag}`);
    // `skipSnapshot`: every baseline that reaches here was *read from* the baseline repo
    // (or is null, which is never stored), so writing it back is at best redundant — and
    // at worst a revert. A duplicate change event arriving just after an accept re-enters
    // the file with the baseline it read a moment earlier, and without this that stale
    // value is queued back over the one the accept just stored, permanently undoing it.
    this.stateManager.setFile(filePath, {
      status: 'reviewing',
      baseline,
      ...(baseline === null ? { nullReason } : {}),
    }, true);
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
      this.onFileLeftReview?.();
    }
    this.onStateChanged();
  }

  /**
   * Resolves once nothing this watcher has received is still being handled: no disk-event
   * handler queued or running, no typing debounce pending, and the baseline writes they
   * queued drained. For integration tests, ahead of a negative assertion ("was not
   * queued"), where a fixed sleep passes whenever the extension is merely late and so can
   * pass on broken code.
   *
   * It cannot see an event the OS has not delivered yet. When the assertion is about a disk
   * event, pair it with a canary — `settle({ canary: true })` in the integration helpers.
   */
  async whenIdle(): Promise<void> {
    for (;;) {
      if (this.perPath.activeKeys === 0 && this.debounceTimers.size === 0) {
        // Every handler writes before it finishes, so its writes are queued by now.
        await this.stateManager.flush();
        if (this.perPath.activeKeys === 0 && this.debounceTimers.size === 0) return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
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
