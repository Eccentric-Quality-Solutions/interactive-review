import * as vscode from 'vscode';
import { log } from './log';

/**
 * Custody of the two **global** `diffEditor.*` settings the review surface has to
 * force ([ADR-0003](../docs/adr/0003-inline-diff-editor-sole-surface.md)): `vscode.diff`
 * exposes no per-call override, so the only lever is the user's own settings.json.
 *
 * Writing a user's settings is only defensible if we put them back. This module keeps
 * a ledger in `globalState` of what it overwrote and restores it when the review
 * session ends. Restore is tied to the *session*, not the process: a session survives
 * window reloads, so `deactivate()` only restores when no session is open, and
 * `activate()` retries a ledger left behind by a failed one (see `extension.ts`).
 *
 * The one gap it cannot close: VS Code gives an extension no uninstall hook, so
 * uninstalling — or never running `endReview` — with a session still open leaves the
 * settings forced, and uninstall then deletes the ledger with them.
 *
 * A nudge can also land just *after* the restore that ended its session — `endReview`
 * racing the unawaited `openDiffEditor` in `walkAfterResolve` — leaving the settings
 * forced with a fresh ledger and no session behind it. That is what the `activate()` and
 * `deactivate()` restores, both guarded on "no session open", are there to sweep up.
 *
 * Two rules make the ledger trustworthy, and both are load-bearing:
 *
 * - **Every decision reads `inspect().globalValue`, never the effective `get()`.** The
 *   global layer is the only one we write, and the two diverge as soon as a workspace
 *   setting shadows the key. A `get()`-based guard is unsatisfiable under a workspace
 *   override, so each nudge would re-record — recording *our own* write as the value to
 *   "restore", which is precisely the permanent mutation this module exists to prevent.
 * - **Record whatever we are about to clobber, every time.** This is self-limiting
 *   given the rule above: after our write `globalValue === want`, so the next nudge
 *   skips and cannot record our own value. Recording only *once* would be wrong,
 *   because the ledger outlives a session — a restore that failed leaves an entry that
 *   would still be treated as authoritative in a later session, destroying whatever the
 *   user set in between.
 */

const SECTION = 'diffEditor';

/** The values the inline review surface requires. */
const DESIRED: Readonly<Record<string, boolean>> = {
  renderSideBySide: false,
  codeLens: true,
};

/** globalState key holding the ledger of overwritten values. */
const LEDGER_KEY = 'interactiveReview.priorDiffEditorSettings';

/**
 * What the user's *global* setting was immediately before we overwrote it.
 * `null` means "no global value" — restoring it removes the key from settings.json
 * rather than pinning the default, which is what the user actually had.
 */
type Ledger = Record<string, boolean | null>;

/**
 * Nudge and restore are serialized against each other. Both are read-modify-write over
 * one ledger and are fired from independent triggers — every diff open, `endReview`,
 * and an unawaited call on the git-dir-deleted poll — so without this a restore in
 * flight can interleave with the nudge of a freshly re-enabled session and hand the
 * prior values back *over* the forced ones.
 *
 * Do not call either function from an `onDidChangeConfiguration` handler: the `cfg.update`
 * inside an op would re-enter the queue behind itself and deadlock it. There are no
 * configuration listeners in the extension today, which is why this is a note and not a
 * guard.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);   // run regardless of how the previous op settled
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Force inline/unified rendering with CodeLenses, recording what it overwrites.
 *
 * Never throws: a settings write can fail (unparseable settings.json, read-only remote
 * FS) and `openDiffEditor` awaits this — a rejection would mean the review diff
 * silently never opens.
 */
export function applyInlineDiffSettings(memento: vscode.Memento): Promise<void> {
  return serialized(async () => {
    try {
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const ledger: Ledger = { ...(memento.get<Ledger>(LEDGER_KEY) ?? {}) };
      for (const [key, want] of Object.entries(DESIRED)) {
        const inspected = cfg.inspect<boolean>(key);
        const prior = inspected?.globalValue;
        // Already equals what we want, so there is nothing to write and nothing to
        // borrow. Note what this branch deliberately does *not* do: clear a pre-existing
        // ledger entry for the key.
        //
        // It cannot, because it cannot tell the two ways of arriving here apart. This
        // function runs before *every* diff open, so on the second nudge of a session
        // `prior === want` because *we* wrote it one diff ago — and the ledger entry is
        // the live record of what to hand back. Dropping it there would strand the
        // user's settings permanently, which is the ADR-0003 defect itself.
        //
        // The genuinely stale case — a restore that never completed, after which the
        // user sets the key to our value themselves — is indistinguishable from that at
        // this point: same config state, same ledger. Only a session boundary separates
        // them, so that is where it is handled: `activate` retries the restore whenever
        // a ledger outlives its session (see extension.ts). Reaching a stale entry here
        // means that retry did not run or did not succeed.
        if (prior === want) continue;
        // Persisted *before* the write: a crash between the two must leave a ledger
        // entry with no write (restore no-ops) rather than a write with no ledger
        // entry (permanent mutation).
        ledger[key] = prior ?? null;
        await memento.update(LEDGER_KEY, ledger);
        await cfg.update(key, want, vscode.ConfigurationTarget.Global);
        log(`diffSettings: borrowed ${key} (prior global: ${JSON.stringify(prior ?? null)})`);
        if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
          // A workspace/folder setting outranks the global layer we just wrote, and
          // there is no API to override it. Worth a log line when someone asks why
          // their review diff is still side-by-side.
          log(`diffSettings: diffEditor.${key} is overridden by a workspace setting — review diffs may not render inline`);
        }
      }
    } catch (err) {
      log(`diffSettings: nudge failed: ${err}`);
    }
  });
}

/**
 * Put back whatever `applyInlineDiffSettings` borrowed and clear the ledger. A no-op
 * when nothing was borrowed (the common case for a user who already reviews inline).
 *
 * A key whose global value is no longer the one we forced was changed by the user after
 * our last nudge, so it is left alone. The converse is not detectable: settings carry no
 * provenance, so a user who sets a key to the *same* value we forced has it removed on
 * restore.
 *
 * Never throws: this runs on teardown paths — including `deactivate()`, where the host
 * may be shutting the config service down underneath us — and a failed restore must not
 * take the rest of teardown with it.
 */
export function restoreDiffSettings(memento: vscode.Memento): Promise<void> {
  return serialized(async () => {
    const restored: Ledger = {};
    try {
      // Inside the try with everything else: the poll path calls this unawaited, so a
      // throw from any line here — not just the writes — becomes an unhandled rejection.
      const ledger = memento.get<Ledger>(LEDGER_KEY);
      if (!ledger || Object.keys(ledger).length === 0) return;
      const cfg = vscode.workspace.getConfiguration(SECTION);
      for (const [key, prior] of Object.entries(ledger)) {
        // A ledger written by an older version may name a key this one no longer
        // forces. `DESIRED[key]` would be `undefined` and match an unset global, so
        // without this the loop would *write* that key — and `update()` throws on a
        // setting the extension does not register, stranding the whole restore.
        if (!(key in DESIRED)) continue;
        if (cfg.inspect<boolean>(key)?.globalValue !== DESIRED[key]) continue;
        // `undefined` removes our global write, restoring the user's default/workspace value.
        await cfg.update(key, prior ?? undefined, vscode.ConfigurationTarget.Global);
        restored[key] = prior;
      }
      // Safe to retry after a partial failure: a recorded prior is by construction never
      // equal to the value we force, so an already-restored key fails the guard above.
      await memento.update(LEDGER_KEY, undefined);
      log(`diffSettings: restored ${JSON.stringify(restored)}`);
    } catch (err) {
      // Ledger deliberately kept on failure so a later teardown can retry.
      log(`diffSettings: restore failed after ${JSON.stringify(restored)}: ${err}`);
    }
  });
}
