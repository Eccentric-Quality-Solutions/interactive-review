import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

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

export function gitGetBaseline(root: string, relPath: string): string | undefined {
  try {
    return execSync(`git show ":${relPath}"`, {
      cwd: root,
      env: baselineGitEnv(root),
      encoding: 'utf-8',
    });
  } catch {
    return undefined;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Floor for all condition waits. Many call sites pass tight per-op timeouts (5s/8s)
// inherited from hunkwise's macOS runs; on Linux, VS Code's file watcher fires late
// under load, so those events arrive after the tight deadline even though they DO
// arrive (a fully-green run proves they're late, not dropped). Enforcing a generous
// floor centrally de-flakes every call site without touching 70+ of them. Harmless
// for fast git-op waits — they resolve in <1s, well before the floor. Kept under the
// mocha per-test timeout (see .vscode-test.mjs) so a genuinely-stuck condition still fails.
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
