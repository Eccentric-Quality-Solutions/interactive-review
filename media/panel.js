// @ts-check
/** @type {{ postMessage: (msg: unknown) => void, getState: () => unknown, setState: (state: unknown) => void }} */
const vscode = /** @type {any} */ (globalThis).acquireVsCodeApi();
const app = document.getElementById("app");

/**
 * The full panel state pushed from the extension host (see `PanelState` in
 * src/reviewPanel.ts — this must stay in sync with it).
 * @typedef {object} PanelState
 * @property {boolean} enabled
 * @property {string[]} ignorePatterns
 * @property {boolean} respectGitignore
 * @property {boolean} clearOnBranchSwitch
 * @property {number} quoteRotationInterval
 * @property {number} totalFiles
 * @property {number} totalAdded
 * @property {number} totalRemoved
 * @property {any[]} files
 * @property {boolean} reviewComplete
 */

/** @type {PanelState | null} */
let currentState = null;
/** @type {Set<string>} */
const expandedFiles = new Set();
/** @type {'main' | 'settings'} */
let view = "main";
/** Track whether we are currently in loading state, so the next update can fade in */
let isLoading = false;

// SVG icon: two offset blocks (red=removed, green=added) representing a hunk diff
const ICON_SVG = `<svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="6" width="26" height="8" rx="2" fill="#f85149" opacity="0.85"/>
  <rect x="4" y="17" width="18" height="8" rx="2" fill="#f85149" opacity="0.5"/>
  <rect x="22" y="28" width="26" height="8" rx="2" fill="#3fb950" opacity="0.85"/>
  <rect x="30" y="39" width="18" height="8" rx="2" fill="#3fb950" opacity="0.5"/>
</svg>`;

const SPLASH_QUOTES = [
  "Every change deserves a witness.",
  "Ship it. But know what you shipped.",
  "The diff is the truth.",
  "A hunk a day keeps the mystery away.",
  "Code doesn't lie. Commit messages do.",
  "Review small. Sleep well.",
  "Not all who wander are lost. Not all diffs are intentional.",
  "The only good surprise is no surprise.",
  "Blame is a feature, not a bug.",
  "Change is inevitable. Reviewing it is optional — but wise.",
  "If it compiles, it's done. If it diffs, it's under review.",
  "Even Linus reviews his own patches.",
  "In the beginning was the diff, and the diff was good.",
  "You can't unsee a hunk once you've seen it.",
  "Refactoring: the art of changing everything and nothing.",
  "The best code review is the one you do before asking for one.",
  "A bug is just a feature you haven't documented yet.",
  "git blame: because someone has to be responsible.",
  "Move fast, break things, then review the diff.",
  "Every deleted line is a victory.",
  "There are two hard problems: naming things, cache invalidation, and off-by-one errors.",
  "The code you wrote six months ago was written by a stranger.",
  "If it's not reviewed, it's not real.",
  "Complexity is easy to add, hard to remove.",
  "Works on my machine — have you tried diffing it?",
  "The first rule of hunk club: you always review hunk club.",
  "Ship less. Review more. Sleep better.",
  "Fear leads to unreviewed code. Unreviewed code leads to production incidents.",
  "A diff a day keeps the rollback away.",
  "Your future self will thank you. Or blame you. It depends on the diff.",
];

/** Interval handle for idle screen text cycling (outer timer) */
/** @type {ReturnType<typeof setTimeout> | null} */
let idleCycleTimer = null;
/** Inner fade-completion timer handle */
/** @type {ReturnType<typeof setTimeout> | null} */
let idleFadeTimer = null;
/** Last quote index, to avoid immediate repeat */
let lastQuoteIndex = -1;
/** Current displayed quote — persists across re-renders so refresh doesn't reset it */
let currentQuote = "";

/** Pick a new random quote (different from last) and store it */
function pickNewQuote() {
  let idx;
  do {
    idx = Math.floor(Math.random() * SPLASH_QUOTES.length);
  } while (idx === lastQuoteIndex);
  lastQuoteIndex = idx;
  currentQuote = SPLASH_QUOTES[idx];
  return currentQuote;
}

/** Return the current quote, picking one if none has been chosen yet */
/** @returns {string} */
function getOrPickQuote() {
  if (!currentQuote) pickNewQuote();
  return currentQuote;
}

function clearIdleTimers() {
  if (idleCycleTimer !== null) {
    clearTimeout(idleCycleTimer);
    idleCycleTimer = null;
  }
  if (idleFadeTimer !== null) {
    clearTimeout(idleFadeTimer);
    idleFadeTimer = null;
  }
}

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param {string} label
 * @param {string} cls
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function btn(label, cls, onClick) {
  const b = /** @type {HTMLButtonElement} */ (document.createElement("button"));
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * A settings checkbox row: a labelled `<label>` with a checkbox + description that
 * posts `{ command, value }` on toggle. Factors out the two near-identical rows in
 * the settings render path so a new toggle is one call, not a 26-line copy.
 * @param {string} label
 * @param {string} desc
 * @param {boolean} checked
 * @param {string} command
 * @returns {HTMLLabelElement}
 */
function checkboxRow(label, desc, checked, command) {
  const row = /** @type {HTMLLabelElement} */ (el("label", "settings-check-row"));
  row.appendChild(el("span", "settings-check-label", label));
  const descRow = el("div", "settings-check-desc-row");
  const checkbox = /** @type {HTMLInputElement} */ (document.createElement("input"));
  checkbox.type = "checkbox";
  checkbox.className = "settings-checkbox";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => {
    vscode.postMessage({ command, value: checkbox.checked });
  });
  descRow.appendChild(checkbox);
  descRow.appendChild(el("span", "settings-check-desc", desc));
  row.appendChild(descRow);
  return row;
}

/**
 * The ✓ Accept / ↺ Discard `btn-action` cluster used at the file and hunk level.
 * Returns a `containerClass` div holding both buttons; `onAccept`/`onDiscard` are
 * the click handlers (each site posts a different payload).
 * @param {string} containerClass
 * @param {() => void} onAccept
 * @param {() => void} onDiscard
 * @param {string} acceptTitle
 * @param {string} discardTitle
 * @returns {HTMLElement}
 */
function actionButtons(containerClass, onAccept, onDiscard, acceptTitle, discardTitle) {
  const container = el("div", containerClass);
  const keep = btn("✓", "btn-action btn-action-keep", onAccept);
  keep.title = acceptTitle;
  const undo = btn("↺", "btn-action btn-action-discard", onDiscard);
  undo.title = discardTitle;
  container.appendChild(keep);
  container.appendChild(undo);
  return container;
}

/** @param {HTMLElement} parent */
function appendIcon(parent) {
  const wrap = el("div", "splash-icon");
  wrap.innerHTML = ICON_SVG;
  parent.appendChild(wrap);
}

/**
 * @param {PanelState} state
 */
function render(state) {
  if (!app) return;
  clearIdleTimers();
  app.innerHTML = "";

  if (!state.enabled) {
    renderSetupScreen();
    return;
  }

  if (view === "settings") {
    renderSettingsScreen(state);
    return;
  }

  if (state.totalFiles === 0) {
    // Terminal closure state: the session had pending changes and drained them all.
    // Distinct from the idle splash (enabled but nothing was ever pending).
    if (state.reviewComplete) {
      renderCompleteScreen();
    } else {
      renderIdleScreen(state.quoteRotationInterval);
    }
    return;
  }

  renderReviewScreen(state);
}

function renderCompleteScreen() {
  if (!app) return;
  const screen = el("div", "splash-screen");
  const badge = el("div", "complete-badge");
  badge.textContent = "✓";
  screen.appendChild(badge);
  screen.appendChild(el("p", "splash-tagline", "Review complete"));
  screen.appendChild(el("p", "complete-subtitle", "All changes reviewed."));
  app.appendChild(screen);
}

function renderSetupScreen() {
  if (!app) return;
  const screen = el("div", "splash-screen");
  appendIcon(screen);
  screen.appendChild(el("p", "splash-tagline", getOrPickQuote()));
  screen.appendChild(
    btn("Begin review", "btn-primary", () => {
      vscode.postMessage({ command: "beginReview" });
    }),
  );
  app.appendChild(screen);
}

const IDLE_CYCLE_FADE = 600; // ms fade transition

/**
 * @param {number} quoteRotationInterval minutes; 0 = no rotation
 */
function renderIdleScreen(quoteRotationInterval) {
  if (!app) return;
  const screen = el("div", "splash-screen");
  appendIcon(screen);

  const textBox = el("div", "splash-textbox");
  const cycleEl = el("p", "splash-tagline splash-cycle");
  cycleEl.textContent = getOrPickQuote();
  textBox.appendChild(cycleEl);
  screen.appendChild(textBox);

  app.appendChild(screen);

  // Clear any previous cycle timers (outer + inner)
  clearIdleTimers();

  if (quoteRotationInterval > 0) {
    const intervalMs = quoteRotationInterval * 60 * 1000;
    function scheduleNext() {
      idleCycleTimer = setTimeout(() => {
        cycleEl.classList.add("splash-cycle-fade");
        idleFadeTimer = setTimeout(() => {
          cycleEl.textContent = pickNewQuote();
          cycleEl.classList.remove("splash-cycle-fade");
          idleFadeTimer = null;
          scheduleNext();
        }, IDLE_CYCLE_FADE);
      }, intervalMs);
    }
    scheduleNext();
  }
}

/**
 * @param {{ ignorePatterns: string[], respectGitignore: boolean, clearOnBranchSwitch: boolean, quoteRotationInterval: number }} state
 */
function renderSettingsScreen(state) {
  if (!app) return;

  // Header with back button
  const header = el("div", "settings-header");
  const backBtn = btn("← Back", "btn-back", () => {
    view = "main";
    if (currentState) render(currentState);
  });
  header.appendChild(backBtn);
  header.appendChild(el("span", "settings-header-title", "Settings"));
  app.appendChild(header);

  const body = el("div", "settings-body");

  // ── Respect .gitignore ──
  const gitignoreSection = el("div", "settings-section");
  gitignoreSection.appendChild(
    el("div", "settings-section-title", "Git Integration"),
  );

  gitignoreSection.appendChild(
    checkboxRow(
      "Respect .gitignore",
      "Skip files already ignored by your project's .gitignore",
      state.respectGitignore,
      "setRespectGitignore",
    ),
  );

  gitignoreSection.appendChild(
    checkboxRow(
      "Clear hunks on branch switch",
      "Automatically clear pending hunks when you switch branches",
      state.clearOnBranchSwitch,
      "setClearOnBranchSwitch",
    ),
  );

  // ── Appearance ──
  const appearanceSection = el("div", "settings-section");
  appearanceSection.appendChild(
    el("div", "settings-section-title", "Appearance"),
  );

  const rotationRow = el("div", "settings-input-row");
  const rotationLabel = el("div", "settings-check-text");
  rotationLabel.appendChild(
    el("span", "settings-check-label", "Quote rotation interval (minutes)"),
  );
  rotationLabel.appendChild(
    el(
      "span",
      "settings-check-desc",
      "Rotate idle screen quotes at this interval. Set to 0 to disable.",
    ),
  );
  rotationRow.appendChild(rotationLabel);
  const rotationInput = /** @type {HTMLInputElement} */ (
    document.createElement("input")
  );
  rotationInput.type = "number";
  rotationInput.className = "settings-number-input";
  rotationInput.min = "0";
  rotationInput.value = String(state.quoteRotationInterval);
  rotationInput.addEventListener("change", () => {
    const val = parseInt(rotationInput.value, 10);
    if (!isNaN(val) && val >= 0) {
      vscode.postMessage({ command: "setQuoteRotationInterval", value: val });
    }
  });
  rotationRow.appendChild(rotationInput);

  appearanceSection.appendChild(rotationRow);

  // ── Exclude Patterns ──
  const patternSection = el("div", "settings-section");
  patternSection.appendChild(
    el("div", "settings-section-title", "Exclude Patterns"),
  );
  patternSection.appendChild(
    el(
      "p",
      "settings-section-desc",
      "gitignore-style patterns to exclude from change tracking (relative to workspace root).",
    ),
  );

  const patternList = el("div", "pattern-list");

  // Protected system rule — always enforced, cannot be removed
  const protectedRow = el("div", "pattern-row-inner pattern-row-protected");
  protectedRow.appendChild(
    el("span", "pattern-text", ".vscode/interactive-review"),
  );
  protectedRow.appendChild(el("span", "pattern-lock", "🔒"));
  patternList.appendChild(protectedRow);

  for (const folder of state.ignorePatterns) {
    const inner = el("div", "pattern-row-inner");
    const folderEl = el("span", "pattern-text", folder);
    const delBtn = el("button", "pattern-del", "");
    delBtn.title = "Remove";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const newFolders = state.ignorePatterns.filter((f) => f !== folder);
      vscode.postMessage({ command: "setIgnorePatterns", folders: newFolders });
    });
    inner.appendChild(folderEl);
    inner.appendChild(delBtn);
    patternList.appendChild(inner);
  }

  const addRow = el("div", "pattern-add-row");
  const addInput = /** @type {HTMLInputElement} */ (
    document.createElement("input")
  );
  addInput.type = "text";
  addInput.className = "pattern-input";
  addInput.placeholder = "e.g. node_modules";
  const addBtn = el("button", "pattern-add-btn", "Add");
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const val = addInput.value.trim();
    if (val && !state.ignorePatterns.includes(val)) {
      vscode.postMessage({
        command: "setIgnorePatterns",
        folders: [...state.ignorePatterns, val],
      });
    }
    addInput.value = "";
  });
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBtn.click();
  });
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  patternList.appendChild(addRow);
  patternSection.appendChild(patternList);
  body.appendChild(appearanceSection);
  body.appendChild(patternSection);
  body.appendChild(gitignoreSection);

  // ── End review ──
  const disableSection = el("div", "settings-section settings-section-danger");
  disableSection.appendChild(
    el("div", "settings-section-title", "Danger Zone"),
  );
  disableSection.appendChild(
    el(
      "p",
      "settings-section-desc",
      "Ends the review session and discards the baseline snapshot. Pending hunks stop being tracked; your files are left exactly as they are on disk.",
    ),
  );
  disableSection.appendChild(
    btn("End review", "btn-disable", () => {
      vscode.postMessage({ command: "endReview" });
    }),
  );
  body.appendChild(disableSection);

  app.appendChild(body);
}

/**
 * File extension → background color for the badge
 * @param {string} fileName
 * @returns {string}
 */
function extColor(fileName) {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  /** @type {Record<string,string>} */
  const m = {
    ts: "#3178c6",
    tsx: "#3178c6",
    js: "#d4a017",
    jsx: "#d4a017",
    mjs: "#d4a017",
    json: "#d4a017",
    py: "#3572A5",
    go: "#00add8",
    rs: "#dea584",
    java: "#b07219",
    kt: "#a97bff",
    rb: "#cc342d",
    php: "#4f5d95",
    cs: "#178600",
    cpp: "#f34b7d",
    c: "#a8a8a8",
    h: "#a8a8a8",
    html: "#e34c26",
    htm: "#e34c26",
    css: "#563d7c",
    scss: "#c6538c",
    less: "#1d365d",
    md: "#4a90d9",
    mdx: "#4a90d9",
    yaml: "#cb171e",
    yml: "#cb171e",
    toml: "#9c4221",
    sh: "#89e051",
    bash: "#89e051",
    swift: "#F05138",
    vue: "#41b883",
    svelte: "#ff3e00",
    dart: "#00B4AB",
  };
  return m[ext] ?? "#6e7681";
}

/**
 * Create a small colored badge showing the file extension abbreviation
 * @param {string} fileName
 * @returns {HTMLElement}
 */
function fileIconBadge(fileName) {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const abbr =
    ext.length <= 3 ? ext.toUpperCase() : ext.slice(0, 3).toUpperCase();
  const badge = el("span", "file-badge", abbr);
  badge.style.background = extColor(fileName);
  return badge;
}

/**
 * @param {{ enabled: boolean, ignorePatterns: string[], totalFiles: number, totalAdded: number, totalRemoved: number, files: any[] }} state
 */
function renderReviewScreen(state) {
  if (!app) return;

  // Summary header
  const header = el("div", "review-header");
  const summary = el("div", "review-summary");
  summary.appendChild(
    document.createTextNode(
      `${state.totalFiles} file${state.totalFiles > 1 ? "s" : ""} `,
    ),
  );
  summary.appendChild(el("span", "stat-added", `+${state.totalAdded}`));
  summary.appendChild(document.createTextNode(" "));
  summary.appendChild(el("span", "stat-removed", `-${state.totalRemoved}`));
  const actions = el("div", "review-actions");
  actions.appendChild(
    btn("✓ Accept", "btn-review-accept", () =>
      vscode.postMessage({ command: "acceptAll" }),
    ),
  );
  actions.appendChild(
    btn("↺ Discard", "btn-review-discard", () =>
      vscode.postMessage({ command: "discardAll" }),
    ),
  );
  header.appendChild(summary);
  header.appendChild(actions);
  app.appendChild(header);

  for (const file of state.files) {
    app.appendChild(renderFileGroup(file));
  }
}

/**
 * @param {{ filePath: string, fileName: string, dirName: string, addedLines: number, removedLines: number, pendingCount: number, isNew: boolean, isDeleted: boolean, hunks: any[] }} file
 */
function renderFileGroup(file) {
  const isSpecial = file.isNew || file.isDeleted;
  const isExpanded = !isSpecial && expandedFiles.has(file.filePath);
  const group = el("div", "file-group");

  const fileRow = el("div", "file-row");
  fileRow.addEventListener("click", () => {
    if (isSpecial) {
      if (file.isDeleted) {
        vscode.postMessage({
          command: "openDeletedDiff",
          filePath: file.filePath,
        });
      } else {
        vscode.postMessage({ command: "openFile", filePath: file.filePath });
      }
      return;
    }
    if (isExpanded) {
      expandedFiles.delete(file.filePath);
    } else {
      expandedFiles.add(file.filePath);
      if (file.hunks.length > 0) {
        vscode.postMessage({
          command: "jumpToHunk",
          filePath: file.filePath,
          hunkId: file.hunks[0].id,
        });
      }
    }
    if (currentState) render(currentState);
  });

  const chevron = isSpecial
    ? el("span", "file-chevron", "")
    : el("span", "file-chevron", isExpanded ? "▼" : "▶");
  const fileIcon = fileIconBadge(file.fileName);
  const name = el("span", "file-name", file.fileName);
  if (!isSpecial) {
    name.classList.add("file-name-link");
    name.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ command: "openFile", filePath: file.filePath });
    });
  }
  const badge = file.isNew
    ? el("span", "file-status-badge file-status-new", "new")
    : file.isDeleted
      ? el("span", "file-status-badge file-status-deleted", "deleted")
      : null;
  const dir = file.dirName ? el("span", "file-dir", file.dirName) : null;

  const right = el("div", "file-right");
  const stats = el("div", "file-stats");
  if (file.addedLines > 0)
    stats.appendChild(el("span", "stat-added", `+${file.addedLines}`));
  if (file.addedLines > 0 && file.removedLines > 0)
    stats.appendChild(document.createTextNode(" "));
  if (file.removedLines > 0)
    stats.appendChild(el("span", "stat-removed", `-${file.removedLines}`));

  const fileActions = actionButtons(
    "file-actions",
    () => vscode.postMessage({ command: "acceptFile", filePath: file.filePath }),
    () => vscode.postMessage({ command: "discardFile", filePath: file.filePath }),
    "Accept all changes",
    "Discard all changes",
  );

  right.appendChild(stats);
  right.appendChild(fileActions);

  fileRow.appendChild(chevron);
  fileRow.appendChild(fileIcon);
  fileRow.appendChild(name);
  if (badge) fileRow.appendChild(badge);
  if (dir) fileRow.appendChild(dir);
  fileRow.appendChild(right);
  group.appendChild(fileRow);

  if (isExpanded) {
    const hunkList = el("div", "hunk-list");
    for (const hunk of file.hunks) {
      const hunkRow = el("div", "hunk-row");
      hunkRow.addEventListener("click", () => {
        vscode.postMessage({
          command: "jumpToHunk",
          filePath: hunk.filePath,
          hunkId: hunk.id,
        });
      });
      const label = el("span", "hunk-label", `@line ${hunk.newStart}`);
      const hunkStats = el("div", "hunk-stats");
      hunkStats.appendChild(el("span", "stat-added", `+${hunk.newLines}`));
      hunkStats.appendChild(document.createTextNode(" "));
      hunkStats.appendChild(el("span", "stat-removed", `-${hunk.oldLines}`));
      const hunkActions = actionButtons(
        "hunk-actions",
        () => vscode.postMessage({ command: "acceptHunk", filePath: hunk.filePath, hunkId: hunk.id }),
        () => vscode.postMessage({ command: "discardHunk", filePath: hunk.filePath, hunkId: hunk.id }),
        "Accept hunk",
        "Discard hunk",
      );
      hunkRow.appendChild(label);
      hunkRow.appendChild(hunkStats);
      hunkRow.appendChild(hunkActions);
      hunkList.appendChild(hunkRow);
    }
    group.appendChild(hunkList);
  }

  return group;
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "loading") {
    if (!app) return;
    if (msg.loading) {
      isLoading = true;
      app.innerHTML = "";
      const screen = el("div", "splash-screen");
      screen.appendChild(el("p", "splash-tagline", "Initializing…"));
      app.appendChild(screen);
    }
  } else if (msg.type === "update") {
    currentState = msg.state;
    if (!msg.state.enabled) view = "main";
    if (isLoading && app) {
      isLoading = false;
      // Render hidden first, then fade in
      app.classList.add("fade-hidden");
      render(msg.state);
      // Force a reflow so the transition fires
      void app.offsetWidth;
      app.classList.remove("fade-hidden");
    } else {
      render(msg.state);
    }
  } else if (msg.type === "openSettings") {
    view = "settings";
    if (currentState) render(currentState);
  }
});

vscode.postMessage({ command: "ready" });
