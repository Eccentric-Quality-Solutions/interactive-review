import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const IGNORE_ENTRY = '.vscode/interactive-review/';
const MARKER_COMMENT = '# interactive-review';

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function upsertGitignore(): void {
  const root = getWorkspaceRoot();
  if (!root) return;
  const gitignorePath = path.join(root, '.gitignore');

  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  }

  if (content.includes(IGNORE_ENTRY)) return;
  const entry = content.endsWith('\n') || content.length === 0
    ? `${MARKER_COMMENT}\n${IGNORE_ENTRY}\n`
    : `\n${MARKER_COMMENT}\n${IGNORE_ENTRY}\n`;

  fs.writeFileSync(gitignorePath, content + entry, 'utf-8');
}

export function removeGitignore(): void {
  const root = getWorkspaceRoot();
  if (!root) return;
  const gitignorePath = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return;

  const content = fs.readFileSync(gitignorePath, 'utf-8');
  const filtered = content
    .split('\n')
    .filter(l => l.trim() !== MARKER_COMMENT && l.trim() !== IGNORE_ENTRY.trimEnd())
    .join('\n');
  fs.writeFileSync(gitignorePath, filtered, 'utf-8');
}
