import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';

export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error('No workspace folder');
  return folders[0].uri.fsPath;
}

export function baselineGitEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: path.join(root, '.vscode', 'interactive-review', 'git'),
    GIT_WORK_TREE: root,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function gitListTracked(root: string): string[] {
  try {
    const out = execSync('git -c core.quotepath=false ls-tree HEAD --name-only -r', {
      cwd: root,
      env: baselineGitEnv(root),
      encoding: 'utf-8',
    });
    return out.split('\n').map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `cat-file blob`, matching `BaselineGit.getBaseline` and for the same reason: `git show
 * :<path>` exits 0 for an untracked path whose name contains glob characters, so a test
 * asserting "not tracked" through this helper could pass while the file was in fact
 * mishandled. `execFileSync` with an argument array also removes the shell-quoting that
 * the old interpolated command depended on. The explicit `:0:` stage stops a name like
 * `1:notes.txt` being read as stage 1 of `notes.txt`.
 */
export function gitGetBaseline(root: string, relPath: string): string | undefined {
  try {
    return execFileSync('git', ['cat-file', 'blob', `:0:${relPath}`], {
      cwd: root,
      env: baselineGitEnv(root),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Floor for all condition waits: a generous ceiling a healthy run never reaches, not a
// delay. Waits resolve as soon as their condition holds — in practice <1s — so the floor
// costs wall-clock only when a test is already failing. It exists because many call sites
// pass tight per-op timeouts (5s/8s) inherited from hunkwise's macOS runs, and raising
// them centrally beats editing 70+ of them.
//
// It is NOT compensation for a slow platform watcher. That premise was retracted
// 2026-08-10 (design.md §4c.1): a headless Linux host at stock inotify limits delivered
// 30/30 onDidCreate at ~130ms, and the original failures were inotify starvation on a
// saturated workstation. Lowering this number therefore buys no time on a green run and
// only narrows the margin on a loaded box. Kept under the mocha per-test timeout
// (see .vscode-test.mjs) so a genuinely-stuck condition still fails.
//
// Scope that 30/30 carefully before citing it: the probe created files at the workspace
// ROOT. Creates into a brand-new directory were delivered 0/N — a real bug, found
// 2026-09-22 and fixed in `fileWatcher.handleDiskCreateTree`. "The watcher is reliable"
// is true of the cases that have actually been measured, and that is not all of them.
const WAIT_FLOOR_MS = 15000;

export async function waitForCondition(fn: () => boolean, timeoutMs = 10000, intervalMs = 100): Promise<void> {
  const effectiveTimeout = Math.max(timeoutMs, WAIT_FLOOR_MS);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (fn()) return;
    await sleep(intervalMs);
  }
  throw new Error('Condition not met within timeout');
}

/**
 * Wait until `filePath` is in reviewing state, nudging a synchronous rescan each poll.
 *
 * Detection of a brand-new externally-created file relies on VS Code's
 * createFileSystemWatcher firing onDidCreate — which was believed unreliable in the
 * headless Linux test host (events for external raw-fs writes dropped or badly delayed).
 *
 * CAUTION (2026-08-10): that premise was RETRACTED — see design.md §4c.1. A direct probe
 * on a headless Linux host at stock inotify limits delivered 30/30 onDidCreate events at
 * ~130ms. The original failures were inotify *starvation* on a saturated workstation, not
 * a platform limit. This nudge therefore compensates for a cause that no longer
 * reproduces, and it has a real cost: because it drives interactiveReview.refresh, every
 * test using it asserts the synchronous rescan path works — such a test CANNOT FAIL if
 * the watcher breaks. Kept for now as margin; if you are adding a test that is genuinely
 * about watcher delivery, use a plain waitForCondition instead.
 * The synchronous rebuildState path (interactiveReview.refresh) detects the same file
 * deterministically via collectUntrackedFiles, so we drive it as a fallback. This tests
 * the end-state (file enters reviewing with the right baseline) without depending on the
 * flaky async watcher. In production the cross-process watcher is reliable; this nudge
 * only compensates for the degraded in-process test watcher.
 */
export async function waitForConditionNudged(fn: () => boolean, timeoutMs = 15000): Promise<void> {
  // Floor as in waitForCondition: call sites inherit tight 5s timeouts, but under
  // full-suite load the queued refreshes need longer to converge.
  const effectiveTimeout = Math.max(timeoutMs, WAIT_FLOOR_MS);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (fn()) return;
    await vscode.commands.executeCommand('interactiveReview.refresh');
    await sleep(250);
  }
  throw new Error('Condition not met within timeout (nudged)');
}

/** Wait until `filePath` is in reviewing state (rescan-nudged). */
export async function waitForReviewing(filePath: string, timeoutMs = 15000): Promise<void> {
  await waitForConditionNudged(() => getStateManager()?.getFile(filePath)?.status === 'reviewing', timeoutMs);
}

/**
 * Wait for a condition that only the file watcher can make true — no Refresh, no rescan.
 *
 * For tests whose subject is watcher *delivery*. `waitForConditionNudged` cannot serve them:
 * it drives `interactiveReview.refresh` every poll, and the rescan reaches the same end
 * state without the watcher, so such a test stays green with the watcher disconnected.
 * A plain wait is the whole difference; the separate name is so a later reader does not
 * "fix" a flake by swapping the nudge back in. If one of these flakes, check inotify
 * starvation first (docs/test-strategy.md), then treat it as a watcher bug.
 */
export async function waitForWatcher(fn: () => boolean, timeoutMs = 15000): Promise<void> {
  await waitForCondition(fn, timeoutMs);
}

/**
 * Read an fs.inotify sysctl, for failure diagnostics. It is there to let a reader rule the
 * environment in *or out*: an exhausted instance limit means the failure is reporting the
 * box (docs/test-strategy.md), and a healthy one means it is not — which is how the
 * new-directory watcher bug was identified on 2026-09-22. Either way the number belongs in
 * the failure message rather than in someone's memory of how the box was configured.
 */
export function readSysctl(name: string): string {
  try {
    return fs.readFileSync(`/proc/sys/fs/inotify/${name}`, 'utf-8').trim();
  } catch {
    return 'unknown';
  }
}

let canaries = 0;

/**
 * Wait for the extension to finish what it has been given, before a negative assertion
 * ("not queued", "not tracked"). A fixed sleep there passes whenever the event is late, so
 * it can pass on broken code; see docs/test-strategy.md.
 *
 * `FileWatcher.whenIdle` only knows about events that have *arrived*. When the assertion is
 * about a disk event, pass `canary: true`: it writes a file the watcher must queue and waits
 * for that, so the events written before it have been delivered (the watcher reports them
 * in order), then removes it again. Needs an active review session.
 */
export async function settle(opts: { canary?: boolean } = {}): Promise<void> {
  if (opts.canary) {
    const canary = path.join(getWorkspaceRoot(), `settle-canary-${++canaries}.txt`);
    writeFileExternally(canary, 'canary\n');
    await waitForWatcher(() => getStateManager()?.getFile(canary) !== undefined);
    fs.unlinkSync(canary);
    await waitForWatcher(() => getStateManager()?.getFile(canary) === undefined);
  }
  await getFileWatcher().whenIdle();
}

export async function enableReview(): Promise<void> {
  await vscode.commands.executeCommand('interactiveReview.beginReview');
  const root = getWorkspaceRoot();
  const gitDir = path.join(root, '.vscode', 'interactive-review', 'git');
  await waitForCondition(() => fs.existsSync(gitDir));
  await sleep(200);
}

export async function disableReview(): Promise<void> {
  await vscode.commands.executeCommand('interactiveReview.endReview');
  await sleep(100);
}

/**
 * Create `name` at `baseline`, begin review, wait until that exact content is
 * recorded as the git baseline, then write `modified` so the file enters reviewing.
 *
 * Waiting for `=== baseline` rather than merely "a baseline exists" is load-bearing:
 * if the snapshot has not landed before the edit, the file is adopted as brand-new
 * (null baseline) and every assertion downstream measures the wrong thing.
 */
export async function setupReviewingFile(name: string, baseline: string, modified: string): Promise<string> {
  const root = getWorkspaceRoot();
  const filePath = path.join(root, name);
  writeFileExternally(filePath, baseline);
  await enableReview();
  await waitForCondition(() => gitGetBaseline(root, path.relative(root, filePath)) === baseline);
  writeFileExternally(filePath, modified);
  await waitForReviewing(filePath);
  return filePath;
}

/**
 * Open a file and set a 0-based line selection, returning the editor. Omitting `endLine0`
 * selects that one line in full — NOT a collapsed cursor. The hunk commands only read
 * `selection.active.line`, so this serves cursor-based tests too; but a test of
 * `acceptSelection`/`rejectSelection` written this way exercises the partial-selection
 * path, not the whole-hunk fallback a bare cursor would take.
 */
export async function openWithSelection(
  filePath: string,
  startLine0: number,
  endLine0: number = startLine0,
): Promise<vscode.TextEditor> {
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(filePath));
  const doc = editor.document;
  const endCol = doc.lineAt(Math.min(endLine0, doc.lineCount - 1)).text.length;
  editor.selection = new vscode.Selection(
    new vscode.Position(startLine0, 0),
    new vscode.Position(endLine0, endCol),
  );
  return editor;
}

/** Open a file in a real editor tab and return the editor (buffer is clean). */
export async function openDocInEditor(filePath: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  await sleep(100);
  return editor;
}

/** The open file-scheme TextDocument for a path, if any. */
export function findOpenDoc(filePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    d => d.uri.scheme === 'file' && d.uri.fsPath === filePath
  );
}

export function writeFileExternally(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export async function writeFileViaVSCode(filePath: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const uri = vscode.Uri.file(filePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

export async function renameFileViaVSCode(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(oldUri, newUri);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) throw new Error(`Failed to rename ${oldUri.fsPath} → ${newUri.fsPath}`);
}

export async function deleteFileViaVSCode(uri: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(uri);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) throw new Error(`Failed to delete ${uri.fsPath}`);
}

export function cleanWorkspace(): void {
  const root = getWorkspaceRoot();
  for (const entry of fs.readdirSync(root)) {
    if (entry === '.vscode' || entry === '.gitkeep') continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
  const stateDir = path.join(root, '.vscode', 'interactive-review');
  if (fs.existsSync(stateDir)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

/**
 * Call an accessor on the activated extension's exported test API, or return
 * undefined if the extension is absent, not yet active, or predates the accessor.
 */
function fromExtensionApi(accessor: 'getReviewPanel' | 'getStateManager' | 'getFileWatcher'): any {
  const ext = vscode.extensions.getExtension('eccentricqualitysolutions.vsc-interactive-review');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  return typeof api?.[accessor] === 'function' ? api[accessor]() : undefined;
}

export function getReviewPanel(): any {
  return fromExtensionApi('getReviewPanel');
}

export function getStateManager(): any {
  return fromExtensionApi('getStateManager');
}

export function getFileWatcher(): any {
  return fromExtensionApi('getFileWatcher');
}
