import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { normalizePath } from './pathNormalize';

const execFileAsync = promisify(execFile);

export interface Settings {
  ignorePatterns: string[];
  respectGitignore: boolean;
  clearOnBranchSwitch: boolean;
  quoteRotationInterval: number;
}

/**
 * The baseline repo exists and claims to have a HEAD commit, but its object
 * database can't be read — the classic shape is zero-length object files left
 * behind when the machine died mid-write (ext4 delayed allocation), e.g. a VM
 * suspended while a snapshot was being committed.
 *
 * This is deliberately distinct from "the repo has no commits yet", which is a
 * legitimately empty baseline. Conflating the two is actively dangerous: callers
 * treat every file absent from the tracked list as *externally created*, so an
 * empty list turns the whole workspace into null-baseline "new" files — and
 * discarding a new file deletes it from disk.
 */
export class BaselineUnreadableError extends Error {
  constructor(operation: string, public readonly cause: unknown) {
    super(`baseline repo unreadable during ${operation}: ${cause}`);
    this.name = 'BaselineUnreadableError';
  }
}

/**
 * How many `git hash-object` processes may run at once during a batch snapshot.
 *
 * Each one is a process plus a pipe, so the ceiling that matters is the file-descriptor
 * limit, not the CPU count. 32 keeps a large workspace comfortably inside a 1024-fd
 * default while still being far faster than serial hashing — the work is dominated by
 * process startup, so concurrency past this buys very little.
 */
const HASH_CONCURRENCY = 32;

/**
 * `Promise.all` with a ceiling on how many run concurrently. Results keep input order.
 *
 * A worker-pool rather than chunked batches: chunking makes every batch wait for its
 * slowest member, which matters here because file sizes vary by orders of magnitude.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const DEFAULT_SETTINGS: Settings = {
  ignorePatterns: process.platform === 'darwin' ? ['.git', '.DS_Store'] : ['.git'],
  respectGitignore: true,
  clearOnBranchSwitch: false,
  quoteRotationInterval: 30,
};

/**
 * Manages all interactive-review persistent state via:
 *   .vscode/interactive-review/settings.json  — enabled flag + ignorePatterns
 *   .vscode/interactive-review/git/           — private git repo storing baselines
 *
 * The git repo uses the workspace root as its work tree but keeps all git
 * metadata inside the interactive-review directory, so it never touches the project's
 * own .git and works even when the project has no git at all.
 *
 *   GIT_DIR       = <stateDir>/git
 *   GIT_WORK_TREE = <workspaceRoot>
 *
 * Each tracked file has exactly one entry in the single HEAD commit.
 * Every mutation (snapshot / remove) rewrites that commit via --amend so
 * the repo always has at most one commit and stays compact.
 */
export class BaselineGit {
  private stateDir: string;
  private gitDir: string;
  private workTree: string;
  private gitInitialized = false;
  private destroyed = false;
  private initPromise: Promise<void> | undefined;
  private log: (message: string) => void;
  private _baselineLost = false;

  constructor(stateDir: string, workspaceRoot: string, logger?: (message: string) => void) {
    this.stateDir = stateDir;
    this.gitDir = path.join(stateDir, 'git');
    this.workTree = workspaceRoot;
    this.log = logger ?? ((msg: string) => console.warn(`[interactive-review] ${msg}`));
  }

  /**
   * True when `initGit` had to throw away an existing repo and start over, so the
   * empty tracked list it now returns reflects *destroyed* baselines rather than a
   * session that never had any. Callers must not read that emptiness as "every file
   * on disk is new" — see `BaselineUnreadableError`. Cleared by `resetRepo`.
   */
  get baselineLost(): boolean { return this._baselineLost; }

  // ── env / low-level git ───────────────────────────────────────────────────

  private get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      GIT_TERMINAL_PROMPT: '0',
      // Every path this class hands to git is a literal filename, never a pattern. Without
      // this git reads `[...]`, `*` and `?` in a pathspec as glob syntax, so a file named
      // `x[1].txt` matched `x1.txt` as well — confirmed against a scratch repo, where
      // renaming one file rewrote the other's baseline entry. Set on the environment rather
      // than per-call so `ls-files`, `update-index --force-remove` and any future pathspec
      // site are covered by construction.
      GIT_LITERAL_PATHSPECS: '1',
    };
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', [
      '-c', 'core.quotepath=false',
      // The baseline repo runs against the user's work tree and therefore inherits their
      // global git config. Two settings there break it outright: `commit.gpgsign=true`
      // makes every snapshot block on pinentry or fail, and `core.hooksPath` points our
      // private commits at the project's own hooks. Neither is ours to run.
      '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=',
      ...args,
    ], {
      cwd: this.workTree,
      env: this.env,
      maxBuffer: 10 * 1024 * 1024, // 10 MB — default 1 MB is too small for large files
    });
    return stdout;
  }

  // ── unbaselined.json ──────────────────────────────────────────────────────

  /**
   * The paths the session last classified `nullReason: 'unbaselined'`, so a window reload
   * does not re-adopt them as `'created'` and make them deletable. See
   * `StateManager.sessionUnbaselined`.
   *
   * Kept inside the git directory so it shares the baselines' lifetime: End review's
   * `destroyGit` and a recovery's `resetRepo` remove both together, and git ignores files
   * it does not know in its own directory.
   */
  private get unbaselinedPath(): string {
    return path.join(this.gitDir, 'interactive-review-unbaselined.json');
  }

  /**
   * Absolute paths, or none when the file is absent or unreadable. None is the behaviour
   * from before this file existed, so a damaged record costs the protection, not the review.
   */
  loadUnbaselined(): string[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.unbaselinedPath, 'utf-8');
    } catch {
      return []; // absent: nothing was recorded
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(p => typeof p === 'string')) {
        return parsed.map(rel => path.join(this.workTree, rel));
      }
    } catch { /* fall through */ }
    this.log('loadUnbaselined: record is unreadable, ignoring it');
    return [];
  }

  /** Replace the record. An empty set removes the file rather than writing `[]`. */
  saveUnbaselined(filePaths: Iterable<string>): void {
    if (this.destroyed) return;
    const rel = [...filePaths].map(fp => path.relative(this.workTree, fp).split(path.sep).join('/')).sort();
    try {
      if (rel.length === 0) {
        fs.rmSync(this.unbaselinedPath, { force: true });
        return;
      }
      // No mkdir: a git directory that is gone was removed on purpose, and recreating it
      // here would make `load()` read review as still on. Write-then-rename, so a crash
      // mid-write leaves the old record rather than a truncated one.
      const tmp = `${this.unbaselinedPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rel, null, 2), 'utf-8');
      fs.renameSync(tmp, this.unbaselinedPath);
    } catch (err) {
      this.log(`saveUnbaselined failed: ${err}`);
    }
  }

  // ── settings.json ─────────────────────────────────────────────────────────

  private get settingsPath(): string {
    return path.join(this.stateDir, 'settings.json');
  }

  loadSettings(): Settings {
    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        ignorePatterns: parsed.ignorePatterns ?? [...DEFAULT_SETTINGS.ignorePatterns],
        respectGitignore: parsed.respectGitignore ?? DEFAULT_SETTINGS.respectGitignore,
        clearOnBranchSwitch: parsed.clearOnBranchSwitch ?? DEFAULT_SETTINGS.clearOnBranchSwitch,
        quoteRotationInterval: (typeof parsed.quoteRotationInterval === 'number' && Number.isFinite(parsed.quoteRotationInterval) && parsed.quoteRotationInterval >= 0)
          ? parsed.quoteRotationInterval
          : DEFAULT_SETTINGS.quoteRotationInterval,
      };
    } catch {
      return { ...DEFAULT_SETTINGS, ignorePatterns: [...DEFAULT_SETTINGS.ignorePatterns] };
    }
  }

  saveSettings(settings: Settings): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      // Land the ignore rule in the same breath the folder is first created, so
      // settings written before review is enabled can't leak into the project's
      // git (settings.json can be persisted from the panel while still disabled).
      this.ensureGitignore();
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
      this.log(`saveSettings failed: ${err}`);
    }
  }

  /**
   * Merge defaults into existing settings.json.
   * Fields already present are kept; missing fields are added.
   * Returns the resulting settings.
   */
  mergeDefaultSettings(defaults: Settings): Settings {
    const existing = fs.existsSync(this.settingsPath) ? this.loadSettings() : ({} as Partial<Settings>);
    const merged: Settings = { ...defaults, ...existing };
    this.saveSettings(merged);
    return merged;
  }

  // ── git init ──────────────────────────────────────────────────────────────

  async initGit(): Promise<void> {
    if (this.destroyed || this.gitInitialized) return;
    // Serialize concurrent calls — only one init runs at a time
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitGit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  /**
   * Write a self-contained `.gitignore` into the state dir so the *project's*
   * git ignores everything under `.vscode/interactive-review/` (the nested git
   * repo, settings, baselines). A single `*` rule matches all contents — git
   * reads .gitignore files even inside untracked directories, so this needs no
   * changes to the user's root .gitignore. Written idempotently; skipped if the
   * file already exists so we never clobber a user edit.
   */
  private ensureGitignore(): void {
    const gitignorePath = path.join(this.stateDir, '.gitignore');
    try {
      if (fs.existsSync(gitignorePath)) return;
      fs.mkdirSync(this.stateDir, { recursive: true });
      // Ignore all contents of this directory from the enclosing project repo.
      fs.writeFileSync(gitignorePath, '# Managed by the Interactive Review extension.\n# Keeps review state out of your project\'s git.\n*\n', 'utf-8');
    } catch (err) {
      this.log(`ensureGitignore failed: ${err}`);
    }
  }

  private async doInitGit(): Promise<void> {
    // Keep review state out of the enclosing project's git (idempotent).
    this.ensureGitignore();
    // Check for a valid git repo: HEAD file must exist. If the directory
    // exists but HEAD is missing, the repo is corrupted (e.g. interrupted
    // init). Re-initialize from scratch in that case.
    const headPath = path.join(this.gitDir, 'HEAD');
    if (!fs.existsSync(this.gitDir) || !fs.existsSync(headPath)) {
      if (fs.existsSync(this.gitDir)) {
        this.log('initGit: corrupted git dir detected (HEAD missing), re-initializing');
        // Whatever baselines this repo held are gone. Flag it so `load()` reports a
        // lost session instead of reading the fresh repo's empty tracked list as
        // proof that every file in the workspace is newly created.
        this._baselineLost = true;
        try {
          fs.rmSync(this.gitDir, { recursive: true, force: true });
        } catch (err) {
          this.log(`initGit: failed to remove corrupted git dir: ${err}`);
          throw err;
        }
      }
      if (this.destroyed) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      await this.git(['init']);
      if (this.destroyed) return;
      await this.git(['config', 'user.email', 'interactive-review@localhost']);
      if (this.destroyed) return;
      await this.git(['config', 'user.name', 'interactive-review']);
    }
    if (this.destroyed) return;
    this.gitInitialized = true;
  }

  private async hasHead(): Promise<boolean> {
    try {
      await this.git(['rev-parse', 'HEAD']);
      return true;
    } catch {
      // Expected when repo has no commits yet
      return false;
    }
  }

  // ── snapshot / remove ─────────────────────────────────────────────────────

  /**
   * Write content into the git index for filePath (no commit).
   * Use commit() to persist.
   */
  async snapshot(filePath: string, content: string): Promise<void> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const hash = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'git',
          ['hash-object', '-w', '--stdin'],
          { env: this.env },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
        );
        // Writing to git's stdin can emit EPIPE if git exits early. Without this
        // listener Node rethrows it as an uncaught exception and crashes the host
        // (the try/catch below can't see an unhandled stream 'error' event).
        child.stdin!.on('error', reject);
        child.stdin!.end(content, 'utf-8');
      });
      await this.git(['update-index', '--add', '--cacheinfo', `100644,${hash},${rel}`]);
      await this.commit();
    } catch (err) {
      this.log(`snapshot failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Rename a file (or all files under a directory) in the git index and commit.
   * Reuses existing blob hashes — no content re-hashing needed.
   */
  async renameFile(oldFilePath: string, newFilePath: string): Promise<void> {
    await this.initGit();
    const oldRel = normalizePath(path.relative(this.workTree, oldFilePath));
    const newRel = normalizePath(path.relative(this.workTree, newFilePath));
    try {
      // ls-files returns all entries matching the path (a single file or all files under a directory)
      const lsOut = await this.git(['ls-files', '--stage', '--', oldRel]);
      const lines = lsOut.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        // No baseline to move, but the source still replaces the target: a baseline left
        // there would review the moved file as an edit of whatever the path held before.
        // A no-op when the target is untracked too. Guarded by `stateManagerGit.test.ts`
        // ("an untracked source still replaces the target's baseline").
        await this.removeFile(newFilePath);
        return;
      }

      // Parse all matching entries
      const entries: { mode: string; hash: string; entryRel: string }[] = [];
      for (const line of lines) {
        const m = line.match(/^(\d+) ([0-9a-f]+) \d+\t(.+)$/);
        if (!m) continue;
        entries.push({ mode: m[1], hash: m[2], entryRel: normalizePath(m[3]) });
      }
      if (entries.length === 0) return;

      // Remove all old entries
      const oldPaths = entries.map(e => e.entryRel);
      const CHUNK = 200;
      for (let i = 0; i < oldPaths.length; i += CHUNK) {
        await this.git(['update-index', '--force-remove', '--', ...oldPaths.slice(i, i + CHUNK)]);
      }

      // Add entries with new paths — replace oldRel prefix with newRel
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ mode, hash, entryRel }) => {
          const suffix = entryRel === oldRel ? '' : entryRel.slice(oldRel.length);
          const renamed = newRel + suffix;
          return ['--add', '--cacheinfo', `${mode},${hash},${renamed}`];
        });
        await this.git(['update-index', ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      this.log(`renameFile failed (${path.relative(this.workTree, oldFilePath)} → ${path.relative(this.workTree, newFilePath)}): ${err}`);
      throw err;
    }
  }

  /**
   * Remove a file's baseline from the git index and commit.
   */
  async removeFile(filePath: string): Promise<void> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const lsOut = await this.git(['ls-files', '--stage', '--', rel]);
      if (!lsOut.trim()) return; // not tracked — nothing to remove
      await this.git(['update-index', '--force-remove', '--', rel]);
      await this.commit();
    } catch (err) {
      this.log(`removeFile failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Snapshot multiple files at once — writes all blobs to index then commits once.
   * Much faster than calling snapshot() per file.
   */
  async snapshotBatch(files: { filePath: string; content: string }[]): Promise<void> {
    if (files.length === 0) return;
    await this.initGit();
    try {
      // Hash blobs concurrently but BOUNDED. This was a bare `Promise.all` over every
      // file, which spawns one `git hash-object` process per workspace file — a few
      // thousand at once in a real repo, which fails as a group on EMFILE/EAGAIN.
      //
      // The failure mode was what made it serious rather than slow: the catch below
      // swallowed it, so `Begin review` came up enabled with an *empty* baseline repo,
      // which looks exactly like "nothing to review". Every subsequent edit then surfaced
      // as a whole-file unbaselined hunk. `snapshotWorkspace` now reports the throw to the
      // user; this cap is what stops it happening in the first place.
      const entries = await mapWithLimit(files, HASH_CONCURRENCY, ({ filePath, content }) =>
        new Promise<{ rel: string; hash: string }>((resolve, reject) => {
          const rel = normalizePath(path.relative(this.workTree, filePath));
          const child = execFile(
            'git',
            ['hash-object', '-w', '--stdin'],
            { env: this.env },
            (err, stdout) => (err ? reject(err) : resolve({ rel, hash: stdout.trim() }))
          );
          // Guard against an uncaught EPIPE crashing the host if git exits early;
          // routes the stream error into the promise so the try/catch handles it.
          child.stdin!.on('error', reject);
          child.stdin!.end(content, 'utf-8');
        })
      );
      // Stage all entries, chunked to avoid OS argument length limits
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ rel, hash }) => ['--add', '--cacheinfo', `100644,${hash},${rel}`]);
        await this.git(['update-index', ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      // Logged *and* rethrown. Callers that route through `gitQueue` still swallow it into
      // the log exactly as before; `snapshotWorkspace` awaits it directly so it can tell
      // the user that this session has no baselines rather than showing an empty queue.
      this.log(`snapshotBatch failed (${files.length} files): ${err}`);
      throw err;
    }
  }

  /**
   * Remove multiple files from the git index in a single operation and commit once.
   * Much faster than calling removeFile() per file.
   */
  async removeFileBatch(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.initGit();
    try {
      const rels = filePaths.map(fp => normalizePath(path.relative(this.workTree, fp)));
      // Chunk to avoid exceeding OS argument length limits (~250KB on macOS)
      const CHUNK = 200;
      for (let i = 0; i < rels.length; i += CHUNK) {
        await this.git(['update-index', '--force-remove', '--', ...rels.slice(i, i + CHUNK)]);
      }
      await this.commit();
    } catch (err) {
      this.log(`removeFileBatch failed (${filePaths.length} files): ${err}`);
    }
  }

  /**
   * `--no-verify` is redundant with the empty `core.hooksPath` in `git()` and kept anyway:
   * it states the intent at the call site, and it does not depend on the empty-path
   * override behaving identically across git versions.
   */
  private async commit(): Promise<void> {
    if (await this.hasHead()) {
      await this.git(['commit', '--amend', '--no-edit', '--allow-empty', '--no-verify']);
    } else {
      await this.git(['commit', '-m', 'interactive-review baselines', '--no-verify']);
    }
  }

  /**
   * Return the baseline content for a file from the git index, or undefined if not tracked.
   * Reads from index (not HEAD) so newly staged files are immediately visible.
   */
  async getBaseline(filePath: string): Promise<string | undefined> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      // `cat-file blob`, NOT `show`. This method's whole contract is "undefined means not
      // tracked", and it relies on git FAILING for a path with no index entry. `git show`
      // does not reliably fail: when `:<path>` does not resolve as an object, show falls
      // back to reading the argument as a *pathspec*, and git accepts any argument
      // containing glob characters as a pathspec without it having to match anything.
      //
      // So for an untracked `x[1].txt`, `git show :x[1].txt` exited 0. Before
      // GIT_LITERAL_PATHSPECS it printed the HEAD commit — a commit header and diff
      // returned as if it were the file's baseline. With literal pathspecs it printed
      // nothing, which callers read as "tracked, and the file was empty". Both routed an
      // untracked file down the tracked-file path. Plain names were never affected, which
      // is why nothing caught it; the pathspec regression test exposed it.
      //
      // `cat-file` is plumbing that takes an object name and never falls back to a
      // pathspec, and `blob` asserts the type. It returns the raw bytes with no porcelain
      // processing in between.
      //
      // The explicit stage number is load-bearing. `:<path>` is itself ambiguous: git reads
      // `:<n>:<rest>` as "stage n of <rest>", so a root file named `1:notes.txt` was looked
      // up as stage 1 of `notes.txt` and reported untracked. `:0:<path>` pins stage 0 — the
      // only stage this repo ever writes — so the path is never reparsed. (An earlier
      // version of this comment claimed `cat-file` could never reinterpret its argument;
      // that was true of pathspecs and false of this. Pinned by
      // baselineGitHardening.test.ts.)
      return await this.git(['cat-file', 'blob', `:0:${rel}`]);
    } catch {
      return undefined;
    }
  }

  /**
   * Return absolute paths of all files currently tracked in HEAD.
   *
   * Throws `BaselineUnreadableError` if the repo has a HEAD commit that cannot be
   * walked. It must never answer "[]" for a repo it failed to read: callers treat
   * an untracked file as externally created, so a failure reported as emptiness
   * silently reclassifies the entire workspace as new files. Only a repo with no
   * commits at all — a genuinely empty baseline — returns [].
   *
   * `hasHead` is what separates the two, and it has to be checked *before* the walk
   * rather than inferred from the walk's failure: `rev-parse HEAD` resolves the ref
   * out of the ref store without touching the object database, so it still succeeds
   * when the objects behind it are damaged, while a repo with no commits fails it.
   */
  async listTrackedFiles(): Promise<string[]> {
    await this.initGit();
    if (!(await this.hasHead())) return [];
    try {
      const out = await this.git(['ls-tree', 'HEAD', '--name-only', '-r']);
      return out
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(rel => normalizePath(path.join(this.workTree, rel)));
    } catch (err) {
      this.log(`listTrackedFiles failed — baseline repo has a HEAD but is unreadable: ${err}`);
      throw new BaselineUnreadableError('listTrackedFiles', err);
    }
  }

  /**
   * Throw away the current repo and start a fresh, empty one, clearing the
   * `baselineLost` flag. The recovery path for an unreadable baseline: unlike
   * `destroyGit` this leaves the instance usable, so the caller can immediately
   * re-snapshot the workspace into a clean baseline.
   */
  async resetRepo(): Promise<void> {
    if (fs.existsSync(this.gitDir)) {
      fs.rmSync(this.gitDir, { recursive: true, force: true });
    }
    this.gitInitialized = false;
    await this.initGit();
    // Set after initGit: the re-init above sees no gitDir and so never raises the
    // flag itself, but an earlier raise must not survive a completed recovery.
    this._baselineLost = false;
  }

  // ── destroy ───────────────────────────────────────────────────────────────

  /** Remove only the git directory (called on disable). settings.json is preserved. */
  destroyGit(): void {
    this.gitInitialized = false;
    this.destroyed = true;
    if (fs.existsSync(this.gitDir)) {
      try {
        fs.rmSync(this.gitDir, { recursive: true, force: true });
      } catch (err) {
        this.log(`destroyGit failed: ${err}`);
      }
    }
  }
}
