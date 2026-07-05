import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { ReviewPanel } from './reviewPanel';
import { registerCommands, acceptHunk, discardHunk } from './commands';
import { DiffCodeLensProvider } from './diffCodeLens';
import { initLog, log } from './log';

export async function activate(context: vscode.ExtensionContext): Promise<{ getReviewPanel: () => ReviewPanel | undefined; getStateManager: () => StateManager | undefined; getFileWatcher: () => FileWatcher | undefined }> {
  initLog();
  const ext = vscode.extensions.getExtension('eccentricqualitysolutions.vsc-interactive-review');
  log(`activate v${ext?.packageJSON?.version ?? '?'}`);
  const stateManager = new StateManager();
  stateManager.onRollback = () => onStateChanged();

  // Content provider for showing baselines in diff view
  const baselineChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    baselineChangeEmitter,
    vscode.workspace.registerTextDocumentContentProvider('interactive-review-baseline', {
      onDidChange: baselineChangeEmitter.event,
      provideTextDocumentContent(uri: vscode.Uri): string {
        const filePath = uri.fsPath;
        const fileState = stateManager.getFile(filePath);
        return fileState?.baseline ?? '';  // null baseline → '' for diff display
      },
    })
  );

  let reviewPanel: ReviewPanel | undefined;
  let diffCodeLensProvider: DiffCodeLensProvider | undefined;

  // Status bar: surfaces "N to review" while walking the queue and "Review complete"
  // as the terminal closure state (the review-flow model's whole point). Clicking it
  // focuses the review panel.
  const reviewStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  reviewStatusBar.command = 'interactiveReviewToolbar.focus';
  context.subscriptions.push(reviewStatusBar);

  function updateStatusBar(): void {
    if (!stateManager.enabled) { reviewStatusBar.hide(); return; }
    if (stateManager.reviewComplete) {
      reviewStatusBar.text = '$(check-all) Review complete';
      reviewStatusBar.tooltip = 'All changes reviewed';
      reviewStatusBar.show();
      return;
    }
    const n = stateManager.reviewingCount;
    if (n > 0) {
      reviewStatusBar.text = `$(git-compare) ${n} file${n === 1 ? '' : 's'} to review`;
      reviewStatusBar.tooltip = 'Interactive Review — pending changes';
      reviewStatusBar.show();
      return;
    }
    reviewStatusBar.hide();
  }

  // State-changed callback — the single funnel for UI refresh after any mutation.
  function onStateChanged(): void {
    stateManager.noteReviewActivity();
    reviewPanel?.refresh();
    diffCodeLensProvider?.fire();
    updateStatusBar();
  }

  /** Notify the diff editor that a specific file's baseline changed (only after accept). */
  function fireBaselineChange(filePath: string): void {
    baselineChangeEmitter.fire(vscode.Uri.file(filePath).with({ scheme: 'interactive-review-baseline' }));
  }

  /**
   * Close tabs for files that are no longer in reviewing state.
   * - Interactive Review diff tabs: always close; reopen normal editor if file still exists on disk
   * - Normal tabs for deleted files: close (new file was discarded)
   */
  async function closeStaleTabs(): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        // Interactive Review diff tab (normal file or deleted file)
        if (tab.input instanceof vscode.TabInputTextDiff
          && tab.input.original.scheme === 'interactive-review-baseline') {
          // For deleted files, modified is untitled:path.deleted; extract real path from original
          const filePath = tab.input.modified.scheme === 'file'
            ? tab.input.modified.fsPath
            : tab.input.original.fsPath;
          const fileState = stateManager.getFile(filePath);
          if (!fileState || fileState.status !== 'reviewing') {
            await vscode.window.tabGroups.close(tab);
            if (fs.existsSync(filePath)) {
              await vscode.window.showTextDocument(vscode.Uri.file(filePath));
            }
          }
          continue;
        }
        // Normal text tab for a deleted file that exited reviewing
        if (tab.input instanceof vscode.TabInputText) {
          const filePath = tab.input.uri.fsPath;
          if (tab.input.uri.scheme === 'file' && !fs.existsSync(filePath)) {
            const fileState = stateManager.getFile(filePath);
            if (!fileState || fileState.status !== 'reviewing') {
              await vscode.window.tabGroups.close(tab);
            }
          }
        }
      }
    }
  }

  /**
   * After a hunk is resolved via CodeLens, close the resolved file's stale diff tab,
   * then auto-advance to the next reviewing file (cross-file walk). Sequenced so the
   * resolved tab is gone before the next file opens.
   */
  function walkAfterResolve(filePath: string): void {
    void closeStaleTabs()
      .then(() => reviewPanel?.advanceToNextFile(filePath))
      .catch(err => log(`walkAfterResolve: ${err}`));
  }

  let syncIgnore: () => void;
  const fileWatcher = new FileWatcher(stateManager, onStateChanged, () => syncIgnore());
  syncIgnore = () => stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)).then(onStateChanged);
  // Register watcher early so gitignoreMatcher is initialized before load().
  // Suppress events during load to avoid race conditions where file changes
  // fire before state is fully restored from git.
  fileWatcher.register(context);
  fileWatcher.suppressAll();

  try {
    await stateManager.load((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
    log(`loaded state: enabled=${stateManager.enabled}, files=${stateManager.getAllFiles().size}`);
  } finally {
    fileWatcher.resumeAll();
  }

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      diffCodeLensProvider?.fire();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      diffCodeLensProvider?.fire();
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'file') return;
      reviewPanel?.refresh();
    }),
  );

  reviewPanel = new ReviewPanel(context, stateManager, fileWatcher, onStateChanged, fireBaselineChange, closeStaleTabs);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('interactiveReviewToolbar', reviewPanel)
  );

  registerCommands(context, stateManager, fileWatcher, reviewPanel, onStateChanged);

  // ── Diff CodeLens ─────────────────────────────────────────────────────────
  diffCodeLensProvider = new DiffCodeLensProvider(stateManager);
  context.subscriptions.push(
    diffCodeLensProvider,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, diffCodeLensProvider),
    vscode.commands.registerCommand('interactiveReview.codeLensAcceptHunk', (filePath: string, hId: string) => {
      acceptHunk(stateManager, filePath, hId, () => { onStateChanged(); fireBaselineChange(filePath); walkAfterResolve(filePath); }, 'codeLens');
    }),
    vscode.commands.registerCommand('interactiveReview.codeLensDiscardHunk', (filePath: string, hId: string) => {
      discardHunk(stateManager, fileWatcher, filePath, hId, () => { onStateChanged(); walkAfterResolve(filePath); }, 'codeLens');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('interactiveReview.openSettings', () => {
      reviewPanel?.openSettings();
    }),
    vscode.commands.registerCommand('interactiveReview.refresh', async () => {
      if (!stateManager.enabled) return;
      reviewPanel?.setLoading(true);
      try {
        await stateManager.rebuildState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir));
        onStateChanged();
      } catch (err) {
        log(`refresh: error — ${err}`);
      } finally {
        reviewPanel?.setLoading(false);
      }
    })
  );

  // Sync ignore state on startup in case .gitignore or ignorePatterns
  // changed while VSCode was closed. Show loading state during sync so
  // the panel doesn't flash stale data before the sync completes.
  if (stateManager.enabled) {
    reviewPanel.setLoading(true);
    log('startup sync: begin');
    Promise.all([
      new Promise(resolve => setTimeout(resolve, 750)),
      stateManager.syncIgnoreState((fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)),
    ]).then(() => {
      log('startup sync: complete');
      reviewPanel?.setLoading(false);
      onStateChanged();
    }).catch((err) => {
      log(`startup sync: error — ${err}`);
      reviewPanel?.setLoading(false);
      onStateChanged();
    });
  } else {
    onStateChanged();
  }

  // ── Watch .vscode/interactive-review/git/ for deletion ────────────────────────────────
  // Detects: git dir deleted → reset to disabled; settings.json changed → reload patterns.
  const stateDir = stateManager.dir;
  if (stateDir) {
    const gitDir = path.join(stateDir, 'git');
    const settingsPath = path.join(stateDir, 'settings.json');
    let settingsWatcher: fs.FSWatcher | undefined;
    // mtime of settings.json as last seen by the poll fallback. Seeded to the
    // current value so we only react to changes made after activation.
    let lastSettingsMtimeMs: number | undefined;
    try { lastSettingsMtimeMs = fs.statSync(settingsPath).mtimeMs; } catch { /* no settings yet */ }

    const onSettingsChanged = () => {
      stateManager.reloadIgnorePatterns();
      syncIgnore();
    };

    const startSettingsWatch = () => {
      if (!fs.existsSync(stateDir)) return;
      try {
        settingsWatcher = fs.watch(stateDir, { persistent: false }, (_eventType, filename) => {
          if (filename === 'settings.json') {
            try { lastSettingsMtimeMs = fs.statSync(settingsPath).mtimeMs; } catch { /* deleted */ }
            onSettingsChanged();
          }
        });
      } catch (err) { log(`settings watch failed: ${err}`); }
    };

    // Poll for git dir existence — detect external deletion.
    // Also poll settings.json mtime as a fallback: fs.watch does not reliably
    // fire for external writes on Linux, so the watcher above can miss changes.
    const pollInterval = setInterval(() => {
      const gitExists = fs.existsSync(gitDir);
      if (!gitExists && stateManager.enabled) {
        log('git dir deleted externally — resetting to disabled');
        settingsWatcher?.close();
        settingsWatcher = undefined;
        stateManager.resetToDisabled();
        onStateChanged();
        return;
      }
      if (gitExists && stateManager.enabled) {
        if (!settingsWatcher) startSettingsWatch();
        // Fallback: detect settings.json changes the fs.watch may have dropped.
        try {
          const mtime = fs.statSync(settingsPath).mtimeMs;
          if (lastSettingsMtimeMs !== undefined && mtime !== lastSettingsMtimeMs) {
            lastSettingsMtimeMs = mtime;
            onSettingsChanged();
          } else if (lastSettingsMtimeMs === undefined) {
            lastSettingsMtimeMs = mtime;
          }
        } catch { /* settings.json not present yet */ }
      }
    }, 1000);

    startSettingsWatch();

    context.subscriptions.push({
      dispose: () => {
        clearInterval(pollInterval);
        settingsWatcher?.close();
      },
    });
  }

  // ── Watch .git/HEAD for branch switches ─────────────────────────────────────
  // When clearOnBranchSwitch is enabled, suppress FileWatcher during the switch
  // so that file create/delete/change events caused by git checkout don't produce
  // false reviewing entries, then re-sync all baselines to the new branch content.
  //
  // On macOS, git checkout replaces .git/HEAD via atomic rename, which can
  // invalidate fs.watch. We recreate the watcher after every event.
  //
  // No extra delay is needed after clearHunksOnBranchSwitch completes: the
  // re-sync updates all baselines to match current disk content, so any late
  // FSEvents that arrive after resumeAll() will compare disk vs baseline,
  // find 0 hunks, and be harmless no-ops.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const gitHeadPath = path.join(workspaceRoot, '.git', 'HEAD');
    let lastHead: string | undefined;
    try { lastHead = fs.readFileSync(gitHeadPath, 'utf-8').trim(); } catch { /* no .git */ }

    if (lastHead !== undefined) {
      let headWatcher: fs.FSWatcher | undefined;
      const startHeadWatch = () => {
        headWatcher?.close();
        headWatcher = undefined;
        try {
          headWatcher = fs.watch(gitHeadPath, { persistent: false }, () => {
            // Recreate watcher immediately — on macOS, git checkout replaces
            // .git/HEAD via atomic rename, which can invalidate fs.watch.
            startHeadWatch();

            if (!stateManager.enabled || !stateManager.clearOnBranchSwitch) return;
            let currentHead: string | undefined;
            try { currentHead = fs.readFileSync(gitHeadPath, 'utf-8').trim(); } catch { return; }
            if (currentHead !== lastHead) {
              lastHead = currentHead;
              log(`branch switched → suppressing file watcher and clearing hunks`);
              fileWatcher.suppressAll();
              stateManager.clearHunksOnBranchSwitch(
                (fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)
              ).then(() => {
                fileWatcher.resumeAll();
                onStateChanged();
              }).catch((err) => {
                log(`clearHunksOnBranchSwitch error: ${err}`);
                fileWatcher.resumeAll();
                onStateChanged();
              });
            }
          });
        } catch (err) { log(`HEAD watch failed: ${err}`); }
      };
      startHeadWatch();
      context.subscriptions.push({ dispose: () => headWatcher?.close() });
    }
  }

  activeStateManager = stateManager;
  activeReviewPanel = reviewPanel;
  activeFileWatcher = fileWatcher;

  return { getReviewPanel, getStateManager, getFileWatcher };
}

let activeStateManager: StateManager | undefined;
let activeReviewPanel: ReviewPanel | undefined;
let activeFileWatcher: FileWatcher | undefined;

/** Exposed for integration tests */
export function getReviewPanel(): ReviewPanel | undefined {
  return activeReviewPanel;
}

/** Exposed for integration tests */
export function getStateManager(): StateManager | undefined {
  return activeStateManager;
}

/** Exposed for integration tests */
export function getFileWatcher(): FileWatcher | undefined {
  return activeFileWatcher;
}

export async function deactivate(): Promise<void> {
  log('deactivate');
  await activeStateManager?.flush();
}
