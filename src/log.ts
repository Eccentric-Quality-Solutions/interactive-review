import * as vscode from 'vscode';
import * as fs from 'fs';

let channel: vscode.OutputChannel | undefined;

// Integration tests run in a separate extension host, where the output channel is
// unreadable. When INTERACTIVE_REVIEW_LOG_FILE is set, mirror every line to that
// file so a failing test can be diagnosed from the log it actually produced.
const logFile = process.env.INTERACTIVE_REVIEW_LOG_FILE;

export function initLog(): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Interactive Review');
  }
}

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  channel?.appendLine(line);
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n'); } catch { /* diagnostics only */ }
  }
}
