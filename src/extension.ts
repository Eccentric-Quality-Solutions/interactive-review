import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StateManager } from './stateManager';
import { FileWatcher } from './fileWatcher';
import { ReviewPanel } from './reviewPanel';
import {
  registerCommands, acceptHunk, discardHunk, rejectSelection, acceptSelection, acceptFileByPath, discardFileByPath,
  activeReviewTarget, hunkAtCursor, neighbourHunk, revealHunk,
} from './commands';
import { DiffCodeLensProvider } from './diffCodeLens';
import { restoreDiffSettings } from './diffSettings';
import { computeHunks, hunkId } from './diffEngine';
import { findFileDocument } from './editorUtils';
import { initLog, log } from './log';
import { formatBuild, readBuildInfo } from './buildInfo';

export async function activate(context: vscode.ExtensionContext): Promise<{ getReviewPanel: () => ReviewPanel | undefined; getStateManager: () => StateManager | undefined; getFileWatcher: () => FileWatcher | undefined }> {
  initLog();
  // The commit, not just the version: the version never changes between local builds, so
  // it cannot say whether the installed copy is the one the source describes. See
  // scripts/build-stamp.js.
  log(`activate ${formatBuild(readBuildInfo())}`);
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
    }),
    // Empty modified side for a deleted file's diff. Using a content-provider doc
    // (keyed to the real fsPath) rather than an untitled buffer means the file-level
    // Accept/Restore CodeLenses render on the *modified* side, where diff-editor
    // lenses are reliably shown, and the provider can resolve the path from the URI.
    vscode.workspace.registerTextDocumentContentProvider('interactive-review-deleted', {
      provideTextDocumentContent(): string { return ''; },
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
      // Bright accent so the item reads at a glance instead of the dull default
      // foreground. `charts.*` are vivid, theme-aware colors defined in every theme.
      reviewStatusBar.color = new vscode.ThemeColor('charts.green');
      reviewStatusBar.show();
      return;
    }
    const n = stateManager.reviewingCount;
    if (n > 0) {
      reviewStatusBar.text = `$(git-compare) ${n} file${n === 1 ? '' : 's'} to review`;
      reviewStatusBar.tooltip = 'Interactive Review — pending changes';
      reviewStatusBar.color = new vscode.ThemeColor('charts.blue');
      reviewStatusBar.show();
      return;
    }
    reviewStatusBar.hide();
  }

  // Gates the review keybindings: true when the active editor is a reviewing file,
  // so accept/reject/next/prev keys stay inert everywhere else.
  function updateInReviewContext(): void {
    const editor = vscode.window.activeTextEditor;
    const inReview = !!editor
      && editor.document.uri.scheme === 'file'
      && stateManager.getFile(editor.document.uri.fsPath)?.status === 'reviewing';
    void vscode.commands.executeCommand('setContext', 'interactiveReview.inReview', inReview);
  }

  // State-changed callback — the single funnel for UI refresh after any mutation.
  function onStateChanged(): void {
    stateManager.noteReviewActivity();
    reviewPanel?.refresh();
    diffCodeLensProvider?.fire();
    updateStatusBar();
    updateInReviewContext();
  }

  /**
   * Invalidate VS Code's cached copy of a file's baseline document, so the next
   * render of the diff editor's original side re-reads `stateManager`.
   *
   * Driven off `onDidChangeBaseline` rather than called from the accept/reject
   * commands: the baseline is state's to own, and hanging the notification off the
   * commands left every other writer (enter-reviewing, rollback, rename, clear) —
   * and reject entirely — silently stale. See the event's doc comment.
   *
   * Still exported to `ReviewPanel` as a belt-and-braces refresh immediately before
   * `vscode.diff`, which costs one no-op fire and makes the surface correct even if
   * a future writer escapes the event.
   */
  function fireBaselineChange(filePath: string): void {
    baselineChangeEmitter.fire(vscode.Uri.file(filePath).with({ scheme: 'interactive-review-baseline' }));
  }
  context.subscriptions.push(stateManager, stateManager.onDidChangeBaseline(filePath => {
    // Do NOT invalidate the cached baseline for a file that has just *left* review.
    //
    // This is the whole-file-turns-green flash on the last accept. `exitReviewing` drops
    // the state entry, `dropState` fires this event, and the content provider answers a
    // missing entry with `''` — so the diff's original side empties and the editor
    // repaints every line of the file as added, while the async `closeStaleTabs` is still
    // on its way to close the tab. It fires on the happy path of every completed file.
    //
    // Skipping the notification leaves VS Code holding the *previous* baseline instead of
    // an empty one. That is stale for the few hundred milliseconds before the tab closes,
    // and stale-but-plausible beats empty-and-alarming: at worst the tab still shows the
    // hunk that was just accepted, rather than claiming the entire file is new.
    //
    // It does not reintroduce the ADR-0011 defect, which was the *opposite* ordering
    // problem: re-entering review writes a fresh baseline through `writeState`, and that
    // still fires here (the entry is `reviewing` by then), so the cache is corrected
    // before the next diff opens. `ReviewPanel` also re-fires immediately before every
    // `vscode.diff` as a second guarantee.
    if (stateManager.getFile(filePath)?.status !== 'reviewing') return;
    fireBaselineChange(filePath);
  }));

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
          // For deleted files the modified side is interactive-review-deleted (not a
          // real file), so fall back to the baseline side for the real path.
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

  /**
   * Rejection handler for the review commands, every one of which is fire-and-forget:
   * `registerCommand` callbacks return void, so a rejected accept/reject promise has
   * nowhere to surface. These operations write to disk and apply workspace edits, so
   * they genuinely fail (read-only file, full volume, an edit VS Code declines) — and
   * unhandled, the failure is invisible: the lens or keybinding appears to have worked
   * while nothing changed. Log it and tell the user, who can then retry.
   */
  /**
   * Does this CodeLens click carry a hunk id that no longer resolves?
   *
   * Hunk ids are derived from position, so every accept or discard renumbers the ones that
   * follow it. `acceptHunk`/`discardHunk` handle a stale id by logging and returning, which
   * from the outside is indistinguishable from the button doing nothing at all — the user
   * clicks, the block stays, and there is no way to tell whether the tool ignored them or
   * acted somewhere they could not see.
   *
   * Only the two lens entry points are guarded, and only with a message. Re-resolving the
   * id by position would be a semantic change: it would silently act on whatever hunk now
   * occupies those coordinates, which is a different edit from the one that was clicked.
   */
  function lensTargetIsStale(filePath: string, hId: string, label: string): boolean {
    const fileState = stateManager.getFile(filePath);
    const doc = findFileDocument(filePath);
    // No open document means this is not the lens path we can check cheaply; let the
    // command run and apply its own guards.
    if (!fileState || !doc) return false;
    if (computeHunks(fileState.baseline, doc.getText()).some(h => hunkId(h) === hId)) return false;
    log(`${label} hunk(${path.basename(filePath)}): stale hunk id ${hId}, nothing to act on`);
    void vscode.window.showWarningMessage(
      `Interactive Review: that ${label.toLowerCase()} button was out of date — the changes had already moved. Nothing was applied; try again.`
    );
    return true;
  }

  function reportCommandFailure(label: string, filePath: string): (err: unknown) => void {
    return err => {
      const name = path.basename(filePath);
      log(`${label}(${name}): failed — ${err}`);
      void vscode.window.showErrorMessage(`Interactive Review: ${label} failed for ${name} — ${err}`);
    };
  }

  let syncIgnore: () => void;
  const fileWatcher = new FileWatcher(stateManager, onStateChanged, () => syncIgnore(),
    // Watcher-driven exits (undo back to baseline, external delete) leave a diff tab
    // whose baseline document is now correctly empty — so it would repaint the whole
    // file as added. The command paths already sweep via `walkAfterResolve`; this gives
    // the watcher paths the same. Fire-and-forget: nothing downstream awaits the sweep.
    () => { void closeStaleTabs().catch(err => log(`closeStaleTabs (watcher): ${err}`)); });
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

  // A ledger with no session behind it means a previous restore never completed — the
  // write failed, or the host died between the two. Retry it now rather than leaving
  // the user's diffEditor settings forced indefinitely. No-op in the normal case.
  //
  // KNOWN LIMITATION — multi-window. The gate is *this* window's session, but the
  // ledger and the settings it guards are global. Opening a second window on another
  // workspace therefore restores the settings out from under a first window that is
  // mid-review, whose next diff renders side-by-side with the hunk CodeLenses hidden.
  //
  // Left unfixed on purpose. A real fix means the ledger carries a cross-window session
  // refcount, with its own crash-recovery story for counts that never decrement — more
  // machinery, and more ways to strand the user's settings, than the fault deserves.
  // The fault self-heals: `applyInlineDiffSettings` runs before every diff open, so the
  // damage is one file rendered wrong, not a stuck state. Compare the `deactivate()`
  // note below, which is the same global-ledger/per-window-session seam seen from the
  // closing side.
  if (!stateManager.enabled) {
    await restoreDiffSettings(context.globalState);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      diffCodeLensProvider?.fire();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      diffCodeLensProvider?.fire();
      updateInReviewContext();
    }),
    // Both lens gates (isActiveReviewDiffTab / isActiveDeletedReviewTab) read
    // tabGroups.activeTab, so tab activation — not just editor focus — is what
    // actually changes their answer. Subscribe to the governing event rather than
    // relying on the editor events happening to fire alongside it.
    vscode.window.tabGroups.onDidChangeTabs(() => {
      diffCodeLensProvider?.fire();
    }),
  );

  // Panel refresh on typing, debounced.
  //
  // This was an undebounced `refresh()` on every keystroke in any file, and `refresh`
  // rebuilds the whole panel: Myers over every reviewing file, reading the unopened ones
  // from disk. With a sizeable queue that is felt as typing lag, and it is a plausible
  // cause of the "Accept/Discard showing up much more slowly" report that was attributed
  // to running on a VM. 150ms is long enough to coalesce a burst of typing and short
  // enough that the panel still tracks the buffer; the watcher's own document listener
  // debounces at 50ms for the heavier recompute.
  let panelRefreshTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'file') return;
      // Nothing to repaint when no session is open, and this fires for every edit in
      // every file regardless.
      if (!stateManager.enabled) return;
      if (panelRefreshTimer) clearTimeout(panelRefreshTimer);
      panelRefreshTimer = setTimeout(() => {
        panelRefreshTimer = undefined;
        reviewPanel?.refresh();
      }, 150);
    }),
    { dispose: () => { if (panelRefreshTimer) clearTimeout(panelRefreshTimer); } },
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
    // Deleted files render their file-level actions on the empty modified side
    // (the `interactive-review-deleted` doc), which has no file-scheme lenses.
    vscode.languages.registerCodeLensProvider({ scheme: 'interactive-review-deleted' }, diffCodeLensProvider),
    vscode.commands.registerCommand('interactiveReview.codeLensAcceptHunk', (filePath: string, hId: string) => {
      if (lensTargetIsStale(filePath, hId, 'Accept')) return;
      acceptHunk(stateManager, filePath, hId, () => { onStateChanged(); walkAfterResolve(filePath); }, 'codeLens');
    }),
    vscode.commands.registerCommand('interactiveReview.codeLensDiscardHunk', (filePath: string, hId: string) => {
      if (lensTargetIsStale(filePath, hId, 'Discard')) return;
      void discardHunk(stateManager, fileWatcher, filePath, hId, () => { onStateChanged(); walkAfterResolve(filePath); }, 'codeLens')
        .catch(reportCommandFailure('Discard hunk', filePath));
    }),
    // Deleted-file file-level actions (rendered on the baseline side of a deleted diff).
    // Accept = confirm the deletion (drop from tracking); Restore = write the baseline back.
    vscode.commands.registerCommand('interactiveReview.codeLensAcceptFile', (filePath: string) => {
      acceptFileByPath(stateManager, filePath, () => { onStateChanged(); walkAfterResolve(filePath); });
    }),
    vscode.commands.registerCommand('interactiveReview.codeLensRestoreFile', (filePath: string) => {
      void discardFileByPath(stateManager, fileWatcher, filePath, () => { onStateChanged(); walkAfterResolve(filePath); })
        .catch(reportCommandFailure('Restore file', filePath));
    }),
  );

  // ── Keyboard-driven review: cursor-resolved accept/reject + navigation ──────
  context.subscriptions.push(
    vscode.commands.registerCommand('interactiveReview.acceptHunk', () => {
      const t = activeReviewTarget(stateManager);
      if (!t) return;
      const hunk = hunkAtCursor(t.editor, t.fileState);
      if (!hunk) return;
      acceptHunk(stateManager, t.filePath, hunkId(hunk),
        () => { onStateChanged(); walkAfterResolve(t.filePath); }, 'keybinding');
    }),
    vscode.commands.registerCommand('interactiveReview.rejectHunk', () => {
      const t = activeReviewTarget(stateManager);
      if (!t) return;
      const hunk = hunkAtCursor(t.editor, t.fileState);
      if (!hunk) return;
      void discardHunk(stateManager, fileWatcher, t.filePath, hunkId(hunk),
        () => { onStateChanged(); walkAfterResolve(t.filePath); }, 'keybinding')
        .catch(reportCommandFailure('Reject hunk', t.filePath));
    }),
    vscode.commands.registerCommand('interactiveReview.rejectSelection', () => {
      const t = activeReviewTarget(stateManager);
      if (!t) return;
      const sel = t.editor.selection;
      void rejectSelection(stateManager, fileWatcher, t.filePath, sel.start.line, sel.end.line,
        () => { onStateChanged(); walkAfterResolve(t.filePath); }, 'keybinding')
        .catch(reportCommandFailure('Reject selection', t.filePath));
    }),
    vscode.commands.registerCommand('interactiveReview.acceptSelection', () => {
      const t = activeReviewTarget(stateManager);
      if (!t) return;
      const sel = t.editor.selection;
      void acceptSelection(stateManager, t.filePath, sel.start.line, sel.end.line,
        () => { onStateChanged(); walkAfterResolve(t.filePath); }, 'keybinding')
        .catch(reportCommandFailure('Accept selection', t.filePath));
    }),
    vscode.commands.registerCommand('interactiveReview.acceptFile', () => {
      const t = activeReviewTarget(stateManager);
      if (!t) return;
      acceptFileByPath(stateManager, t.filePath,
        () => { onStateChanged(); walkAfterResolve(t.filePath); });
    }),
    vscode.commands.registerCommand('interactiveReview.rejectFile', () => {
      const t = activeReviewTarget(stateManager);
      if (!t) return;
      void discardFileByPath(stateManager, fileWatcher, t.filePath,
        () => { onStateChanged(); walkAfterResolve(t.filePath); })
        .catch(reportCommandFailure('Reject file', t.filePath));
    }),
    vscode.commands.registerCommand('interactiveReview.nextHunk', () => {
      const t = activeReviewTarget(stateManager);
      if (!t) return;
      const next = neighbourHunk(t.editor, t.fileState, 1);
      if (next) { revealHunk(t.editor, next); return; }
      void reviewPanel?.openNextReviewingFile(t.filePath); // past the last hunk → next file (nav only)
    }),
    vscode.commands.registerCommand('interactiveReview.prevHunk', () => {
      const t = activeReviewTarget(stateManager);
      if (!t) return;
      const prev = neighbourHunk(t.editor, t.fileState, -1);
      if (prev) revealHunk(t.editor, prev);
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
        // Same session-ended contract as `endReview`: give the user's global
        // diffEditor settings back (ADR-0003).
        void restoreDiffSettings(context.globalState);
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
      // Serialize branch-switch handling. A rebase / rapid checkouts change HEAD
      // several times in quick succession; running clearHunksOnBranchSwitch calls
      // concurrently would race on state, and resuming after the FIRST finished
      // (while a later one is still rewriting baselines) would let git-checkout file
      // events surface as false "reviewing" entries. Chain the clears and only
      // resume once the last pending switch completes.
      let branchSwitchPending = 0;
      let branchSwitchChain: Promise<void> = Promise.resolve();
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
              branchSwitchPending++;
              branchSwitchChain = branchSwitchChain
                .then(() => stateManager.clearHunksOnBranchSwitch(
                  (fp, isDir) => fileWatcher.shouldIgnore(fp, isDir)
                ))
                .catch((err) => { log(`clearHunksOnBranchSwitch error: ${err}`); })
                .finally(() => {
                  // Only resume once every queued switch has drained, so late
                  // git-checkout events never arrive while suppression is off.
                  if (--branchSwitchPending === 0) {
                    fileWatcher.resumeAll();
                    onStateChanged();
                  }
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
  activeGlobalState = context.globalState;

  return { getReviewPanel, getStateManager, getFileWatcher };
}

let activeStateManager: StateManager | undefined;
let activeReviewPanel: ReviewPanel | undefined;
let activeFileWatcher: FileWatcher | undefined;
let activeGlobalState: vscode.Memento | undefined;

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
  // Only when this window has no session open. A review session outlives a window
  // reload, so restoring on every shutdown would churn settings.json twice per reload.
  // A session that has already ended has nothing left to justify holding the settings,
  // so this is where an uninstall-after-review gets them back.
  //
  // The guard is per-window while the ledger is per-extension, so closing an idle window
  // can still restore out from under a second window that is mid-review. That case
  // self-heals — the reviewing window re-nudges and re-records on its next diff — and
  // the same is true of `endReview`; a cross-window lock is not worth the machinery.
  if (activeGlobalState && !activeStateManager?.enabled) {
    await restoreDiffSettings(activeGlobalState);
  }
}
