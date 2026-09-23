// Minimal vscode stub for unit tests that import the 'vscode' module.
// Covers vscode.workspace.workspaceFolders and a settings store good enough for
// diffSettings. The three layers matter: `get()` returns the effective value
// (workspace ← global ← defaults) while `inspect().globalValue` sees only the layer
// an extension can write. Code that confuses the two breaks exactly when a workspace
// setting shadows the key, so the mock has to be able to express that.

declare const global: Record<string, unknown>;

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export interface TestConfigStore {
  global: Record<string, unknown>;
  defaults: Record<string, unknown>;
  /** Highest precedence, and not writable by us — like a real `.vscode/settings.json`. */
  workspace?: Record<string, unknown>;
  /**
   * Fault injection for settings writes (unparseable settings.json, read-only remote FS).
   * Lives on the store rather than a monkeypatched export because the module under test
   * loads its own copy of this mock — only the global store is shared between them.
   */
  shouldFailUpdate?: (key: string, callIndex: number) => boolean;
  updateCount?: number;
  /** Every target passed to `update`, so a write to the wrong layer can't pass silently. */
  updateTargets?: number[];
}

/** Reset and return the settings store backing `workspace.getConfiguration`. */
export function __setTestConfig(store: TestConfigStore): TestConfigStore {
  global.__reviewTestConfig = store;
  return store;
}

function store(): TestConfigStore {
  return (global.__reviewTestConfig as TestConfigStore | undefined)
    ?? __setTestConfig({ global: {}, defaults: {} });
}

/** The minimum of a `TextDocument` that `editorUtils` reads. */
export interface TestDocument {
  uri: { scheme: string; fsPath: string };
}

/** The minimum of a `TextEditor` that `editorUtils` reads. */
export interface TestEditor {
  document: TestDocument;
  viewColumn: number | undefined;
  selection?: unknown;
}

/**
 * Seed `workspace.textDocuments` and `window.visibleTextEditors`.
 *
 * On `global` for the same reason as the settings store: the module under test loads its
 * own copy of this mock, so only the global object is shared between them.
 */
export function __setTestEditors(docs: TestDocument[], editors: TestEditor[] = []): void {
  global.__reviewTestDocuments = docs;
  global.__reviewTestEditors = editors;
}

export const workspace = {
  /** Empty unless a test seeds it, so code under test falls back to reading from disk. */
  get textDocuments(): unknown[] {
    return (global.__reviewTestDocuments as unknown[] | undefined) ?? [];
  },
  get workspaceFolders() {
    const root = global.__reviewTestRoot as string | undefined;
    if (!root) return undefined;
    return [{ uri: { fsPath: root } }];
  },
  getConfiguration(section: string) {
    const k = (key: string) => `${section}.${key}`;
    return {
      // Effective value: workspace wins over global wins over defaults, as in the real API.
      get<T>(key: string): T | undefined {
        const s = store();
        for (const layer of [s.workspace ?? {}, s.global, s.defaults]) {
          if (k(key) in layer) return layer[k(key)] as T;
        }
        return undefined;
      },
      inspect<T>(key: string) {
        const s = store();
        return {
          globalValue: s.global[k(key)] as T | undefined,
          workspaceValue: (s.workspace ?? {})[k(key)] as T | undefined,
          defaultValue: s.defaults[k(key)] as T | undefined,
        };
      },
      async update(key: string, value: unknown, target?: number): Promise<void> {
        const s = store();
        s.updateCount = (s.updateCount ?? 0) + 1;
        (s.updateTargets ??= []).push(target ?? -1);
        if (s.shouldFailUpdate?.(key, s.updateCount)) throw new Error(`update ${k(key)} failed`);
        if (value === undefined) delete s.global[k(key)];
        else s.global[k(key)] = value;
      },
    };
  },
};

/**
 * Minimal `EventEmitter`. Present so unit tests can import modules that construct
 * one at field-initialization time (`StateManager.baselineChanged`) without also
 * pulling in the real extension host. Listener errors propagate rather than being
 * swallowed as the real API does — a test that breaks a listener should fail loudly.
 */
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void { this.listeners = []; }
}

/**
 * Notifications, recorded rather than shown. StateManager reports rollbacks and baseline
 * recovery through these; a unit test that reaches either path should be able to assert on
 * what the user would have been told, not crash on a missing API. Kept on `global` for the
 * same reason as the settings store: the module under test loads its own copy of this mock.
 */
export interface TestNotification { level: 'error' | 'warning' | 'info'; message: string }
export function __notifications(): TestNotification[] {
  return (global.__reviewTestNotifications ??= []) as TestNotification[];
}
export const window = {
  get visibleTextEditors(): unknown[] {
    return (global.__reviewTestEditors as unknown[] | undefined) ?? [];
  },
  async showErrorMessage(message: string) { __notifications().push({ level: 'error', message }); return undefined; },
  async showWarningMessage(message: string) { __notifications().push({ level: 'warning', message }); return undefined; },
  async showInformationMessage(message: string) { __notifications().push({ level: 'info', message }); return undefined; },
};

/**
 * Just enough of the editor geometry types for `revealHunkPosition`: it constructs a
 * `Position`, assigns a `Selection`, and reveals a `Range`. Recording the arguments is the
 * point — the contract under test is which line it lands on.
 */
export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}
export class Selection {
  constructor(public readonly anchor: Position, public readonly active: Position) {}
}
export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}
export const TextEditorRevealType = { InCenter: 2 };
