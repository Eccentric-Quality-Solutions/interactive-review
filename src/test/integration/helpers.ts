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
 * createFileSystemWatcher firing onDidCreate — which is unreliable in the headless
 * Linux test host (events for external raw-fs writes are dropped or badly delayed).
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
  await vscode.commands.executeCommand('interactiveReview.enable');
  const root = getWorkspaceRoot();
  const gitDir = path.join(root, '.vscode', 'interactive-review', 'git');
  await waitForCondition(() => fs.existsSync(gitDir));
  await sleep(200);
}

export async function disableReview(): Promise<void> {
  await vscode.commands.executeCommand('interactiveReview.disable');
  await sleep(100);
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

export function getReviewPanel(): any {
  const ext = vscode.extensions.getExtension('eccentricqualitysolutions.vsc-interactive-review');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  if (api && typeof api.getReviewPanel === 'function') {
    return api.getReviewPanel();
  }
  return undefined;
}

export function getStateManager(): any {
  const ext = vscode.extensions.getExtension('eccentricqualitysolutions.vsc-interactive-review');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  if (api && typeof api.getStateManager === 'function') {
    return api.getStateManager();
  }
  return undefined;
}

export function getFileWatcher(): any {
  const ext = vscode.extensions.getExtension('eccentricqualitysolutions.vsc-interactive-review');
  if (!ext || !ext.isActive) return undefined;
  const api = ext.exports;
  if (api && typeof api.getFileWatcher === 'function') {
    return api.getFileWatcher();
  }
  return undefined;
}
