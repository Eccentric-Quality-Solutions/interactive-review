#!/usr/bin/env node
/*
 * Mutation check for the regression tests: prove each one can catch the bug it guards.
 *
 * For every entry below this script re-introduces a defect that actually shipped, compiles,
 * runs the test file meant to guard it, and restores the source. The mutation must be
 * KILLED — the guarding test must FAIL. A mutation that SURVIVES means a regression test that
 * cannot detect its own regression, which is worse than no test: it manufactures confidence.
 *
 * Run from the repo root after `npm test` has built out-test/ once:
 *
 *     node scripts/mutation-check.mjs
 *
 * Exit status is non-zero if any mutation survives. The source is always restored, including
 * on Ctrl-C, from an in-memory copy — never from git, so uncommitted work is safe.
 *
 * Adding a regression test? Add its mutation here too. That is the check that the test works.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

// desc, source file, [[old, new], ...], guarding test file under out-test/test/
const MUTATIONS = [
  {
    desc: "filenames read as git glob patterns",
    file: "src/baselineGit.ts",
    edits: [
      ["      GIT_LITERAL_PATHSPECS: '1',\n",
       ""],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "getBaseline via `git show` (untracked glob name reads as tracked)",
    file: "src/baselineGit.ts",
    edits: [
      ["this.git(['cat-file', 'blob', `:0:${rel}`])",
       "this.git(['show', `:0:${rel}`])"],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "getBaseline without an explicit stage (`1:x` read as stage 1 of `x`)",
    file: "src/baselineGit.ts",
    edits: [
      ["this.git(['cat-file', 'blob', `:0:${rel}`])",
       "this.git(['cat-file', 'blob', `:${rel}`])"],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "commits inherit the user's commit.gpgsign",
    file: "src/baselineGit.ts",
    edits: [
      ["      '-c', 'commit.gpgsign=false',\n",
       ""],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "commits run the user's core.hooksPath hooks",
    file: "src/baselineGit.ts",
    edits: [
      ["      '-c', 'core.hooksPath=',\n",
       ""],
      ["'--allow-empty', '--no-verify']",
       "'--allow-empty']"],
      ["'interactive-review baselines', '--no-verify']",
       "'interactive-review baselines']"],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "cursor accept/reject wraps to the first hunk when the cursor is past every hunk",
    file: "src/commands.ts",
    edits: [
      ["  return hunkAtLine(hunks, line);",
       "  return hunkAtLine(hunks, line) ?? hunks[0];"],
    ],
    test: "hunkAtCursor.test.js",
  },
  {
    desc: "renameFile parses ls-files without -z (C-quoted name re-staged at a nonsense path)",
    file: "src/baselineGit.ts",
    edits: [
      ["      const lsOut = await this.git(['ls-files', '--stage', '-z', '--', oldRel]);\n      const lines = lsOut.split('\\0').filter(Boolean);",
       "      const lsOut = await this.git(['ls-files', '--stage', '--', oldRel]);\n      const lines = lsOut.trim().split('\\n').filter(Boolean);"],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "listTrackedFiles parses ls-tree without -z (C-quoted names missed everywhere)",
    file: "src/baselineGit.ts",
    edits: [
      ["      const out = await this.git(['ls-tree', 'HEAD', '--name-only', '-r', '-z']);\n      return out\n        .split('\\0')\n        .filter(Boolean)",
       "      const out = await this.git(['ls-tree', 'HEAD', '--name-only', '-r']);\n      return out\n        .split('\\n')\n        .map(l => l.trim())\n        .filter(Boolean)"],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "removeFile parses ls-files without -z (C-quoted names silently not removed)",
    file: "src/baselineGit.ts",
    edits: [
      ["      const lsOut = await this.git(['ls-files', '--stage', '-z', '--', rel]);\n      const tracked = lsOut.split('\\0').filter(Boolean)\n        .map(entry => entry.match(/^\\d+ [0-9a-f]+ \\d+\\t([\\s\\S]+)$/)?.[1])",
       "      const lsOut = await this.git(['ls-files', '--stage', '--', rel]);\n      const tracked = lsOut.trim().split('\\n').filter(Boolean)\n        .map(entry => entry.match(/^\\d+ [0-9a-f]+ \\d+\\t(.+)$/)?.[1])"],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "removeFile force-removes the pathspec, so a directory silently loses nothing",
    file: "src/baselineGit.ts",
    edits: [
      ["      if (tracked.length === 0) return; // not tracked — nothing to remove",
       "      if (tracked.length === 0) return; tracked.length = 0; tracked.push(rel);"],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "panel badges any null baseline as a new file, ignoring nullReason",
    file: "src/reviewPanel.ts",
    edits: [
      ["      const isNew = unbaselined && fileState.nullReason === 'created';",
       "      const isNew = unbaselined;"],
    ],
    test: "panelBadge.test.js",
  },
  {
    desc: "unbounded git hash-object fan-out",
    file: "src/baselineGit.ts",
    edits: [
      ["const HASH_CONCURRENCY = 32;",
       "const HASH_CONCURRENCY = 1_000_000;"],
    ],
    test: "baselineGitHardening.test.js",
  },
  {
    desc: "snapshotWorkspace swallows a failed snapshot",
    file: "src/stateManager.ts",
    edits: [
      ["    if (failure !== undefined) throw failure;",
       "    if (failure !== undefined) { /* swallowed */ }"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "directory delete removes only the exact path (git no-op for a dir)",
    file: "src/stateManager.ts",
    edits: [
      ["const toRemove = tracked.filter(under);",
       "const toRemove = tracked.filter(fp => fp === dirPath);"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "CodeLens anchored on the line after its hunk",
    file: "src/diffEngine.ts",
    edits: [
      ["return Math.min(Math.max(0, hunk.newStart - 1), Math.max(0, lineCount - 1));",
       "return Math.min(hunk.newStart - 1 + hunk.newLines, lineCount - 1);"],
    ],
    test: "diffEngine.test.js",
  },
  {
    desc: "discard at EOF adds a newline the file never had",
    file: "src/hunkApply.ts",
    edits: [
      ["originalLines, baseline.terminated);",
       "originalLines, true);"],
    ],
    test: "hunkApply.test.js",
  },
  {
    desc: "accept splices split('\\n') arrays (phantom trailing element)",
    file: "src/hunkApply.ts",
    edits: [
      ["  return spliceLines(baseline, hunk.oldStart - 1, hunk.oldLines, acceptedLines, current.terminated);",
       "  const bl = baselineText.split('\\n'); const cl = currentText.split('\\n');\n  return [...bl.slice(0, hunk.oldStart - 1), ...cl.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines), ...bl.slice(hunk.oldStart - 1 + hunk.oldLines)].join('\\n');"],
    ],
    test: "hunkApply.test.js",
  },
  {
    desc: "partial accept takes the document's final newline",
    file: "src/hunkApply.ts",
    edits: [
      ["const acceptedTerminator = acceptEndLine < current.lines.length - 1 || current.terminated;",
       "const acceptedTerminator = current.terminated;"],
    ],
    test: "hunkApply.test.js",
  },
  {
    desc: "readBaseline answers before queued writes land (stale baseline after accept / folder delete)",
    file: "src/stateManager.ts",
    edits: [
      ["    await this.gitQueue;\n    return this._git?.getBaseline(normalizePath(filePath));",
       "    return this._git?.getBaseline(normalizePath(filePath));"],
    ],
    test: "reloadEqualsMemory.test.js",
  },
  {
    desc: "FileWatcher reads a baseline straight from git, bypassing the queue",
    file: "src/fileWatcher.ts",
    edits: [
      ["const gitBaseline = await this.stateManager.readBaseline(filePath);\n    if (!this.stillLive(session)) { log(`onDiskCreate(",
       "const gitBaseline = await git.getBaseline(filePath);\n    if (!this.stillLive(session)) { log(`onDiskCreate("],
    ],
    test: "reloadEqualsMemory.test.js",
  },
  {
    desc: "End review destroys the repo with writes still queued",
    file: "src/stateManager.ts",
    edits: [
      ["        await drained;\n",
       ""],
    ],
    test: "reloadEqualsMemory.test.js",
  },
  {
    desc: "Begin review does not wait for End review's teardown",
    file: "src/stateManager.ts",
    edits: [
      ["      await this.teardown;\n      // An End review that arrived",
       "      // An End review that arrived"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "Begin review carries on after an End review overtook it",
    file: "src/stateManager.ts",
    edits: [
      ["      if (this._session !== session) return;\n      const g = this.ensureGit();",
       "      const g = this.ensureGit();"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "End review leaves its git instance attached while draining",
    file: "src/stateManager.ts",
    edits: [
      ["      const g = this._git;\n      this._git = undefined;\n      const drained",
       "      const g = this._git;\n      const drained"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "session unchanged by Begin/End review",
    file: "src/stateManager.ts",
    edits: [
      ["    const session = ++this._session;",
       "    const session = this._session;"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "disk-event handler writes after a baseline read across a session change",
    file: "src/fileWatcher.ts",
    edits: [
      ["    if (!this.stillLive(session)) { log(`onDiskChange(${basename}): session changed or watcher suppressed while reading, skip`); return; }\n\n    // With no baseline",
       "\n    // With no baseline"],
    ],
    test: "reloadEqualsMemory.test.js",
  },
  {
    desc: "PathSerializer runs a key's tasks concurrently",
    file: "src/pathSerializer.ts",
    edits: [
      ["const result = prior.then(task);",
       "const result = task();"],
    ],
    test: "pathSerializer.test.js",
  },
  {
    desc: "a change with no baseline is classified 'created' (Discard would delete the user's file)",
    file: "src/diskEvent.ts",
    edits: [
      ["return { action: 'review', baseline: null, nullReason: 'unbaselined' };",
       "return { action: 'review', baseline: null, nullReason: 'created' };"],
    ],
    test: "diskEvent.test.js",
  },
  {
    desc: "delete events bypass the per-path serializer",
    file: "src/fileWatcher.ts",
    edits: [
      ["return this.perPath.run(normalizePath(uri.fsPath), () => this.onDiskDelete(uri, session));",
       "return this.onDiskDelete(uri, session);"],
    ],
    test: "reloadEqualsMemory.test.js",
  },
  {
    desc: "partial reject takes the document's final newline",
    file: "src/hunkApply.ts",
    edits: [
      ["  const tailTerminator = newTailIsContext\n    ? hunk.oldLines > 0 || baseline.terminated\n    : current.terminated;",
       "  const tailTerminator = current.terminated;"],
    ],
    test: "hunkApply.test.js",
  },
  {
    desc: "Refresh re-adopts an unbaselined file as 'created' (deletable)",
    file: "src/stateManager.ts",
    edits: [
      ["return this.sessionCreated.has(filePath) && !this.sessionUnbaselined.has(filePath)\n      ? 'created'\n      : 'unbaselined';",
       "return 'created';"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "an unbaselined classification is not recorded, so a Refresh forgets it",
    file: "src/stateManager.ts",
    edits: [
      ["      this.sessionUnbaselined.add(filePath);\n",
       ""],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "an old witnessed create outranks a later unbaselined classification",
    file: "src/stateManager.ts",
    edits: [
      ["return this.sessionCreated.has(filePath) && !this.sessionUnbaselined.has(filePath)\n      ? 'created'\n      : 'unbaselined';",
       "return this.sessionCreated.has(filePath) ? 'created' : 'unbaselined';"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a later witnessed create does not clear an earlier unbaselined classification",
    file: "src/stateManager.ts",
    edits: [
      ["      if (this.sessionUnbaselined.delete(filePath)) this.saveUnbaselined();\n",
       ""],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a rescan adopts a file with no record as 'created' (the pre-2026-09-22 default)",
    file: "src/stateManager.ts",
    edits: [
      ["return this.sessionCreated.has(filePath) && !this.sessionUnbaselined.has(filePath)\n      ? 'created'\n      : 'unbaselined';",
       "return this.sessionUnbaselined.has(filePath) ? 'unbaselined' : 'created';"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a window reload does not restore the witnessed creates",
    file: "src/stateManager.ts",
    edits: [
      ["    for (const fp of g.loadCreated()) this.sessionCreated.add(normalizePath(fp));\n",
       ""],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a witnessed create is not saved",
    file: "src/stateManager.ts",
    edits: [
      ["        this.sessionCreated.add(filePath);\n        this.saveCreated();\n",
       "        this.sessionCreated.add(filePath);\n"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "flush leaves the deferred witness record unwritten",
    file: "src/stateManager.ts",
    edits: [
      ["    await this.gitQueue;\n    this.writeCreatedRecord();\n",
       "    await this.gitQueue;\n"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a directory rename leaves a child's witness at its old path",
    file: "src/stateManager.ts",
    edits: [
      ["        if (this.sessionCreated.delete(fp)) {\n          this.sessionCreated.add(newFp);\n          this.saveCreated();\n        }\n",
       ""],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a branch switch leaves the saved witness record behind",
    file: "src/stateManager.ts",
    edits: [
      ["    this.saveCreated();\n    this.saveUnbaselined();\n",
       "    this.saveUnbaselined();\n"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a failed Begin review leaves the session open, so a retry resolves without baselines",
    file: "src/commands.ts",
    edits: [
      ["    await stateManager.setEnabled(false).catch(e => log(`enable: teardown after failure failed — ${e}`));\n",
       ""],
    ],
    test: "beginReview.test.js",
  },
  {
    desc: "hunk ids from position only (a rewritten line keeps its id)",
    file: "src/diffEngine.ts",
    edits: [
      ["  return `${hunk.newStart}:${hunk.newLines}:${hunk.oldStart}:${hunk.oldLines}:${content}`;",
       "  return `${hunk.newStart}:${hunk.newLines}:${hunk.oldStart}:${hunk.oldLines}:${content.slice(0, 0)}`;"],
    ],
    test: "diffEngine.test.js",
  },
  {
    desc: "a window reload does not restore the unbaselined record",
    file: "src/stateManager.ts",
    edits: [
      ["    for (const fp of g.loadUnbaselined()) this.sessionUnbaselined.add(normalizePath(fp));\n",
       ""],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "an unbaselined classification is not saved",
    file: "src/stateManager.ts",
    edits: [
      ["      this.sessionUnbaselined.add(filePath);\n      this.saveUnbaselined();\n",
       "      this.sessionUnbaselined.add(filePath);\n"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a later witnessed create leaves the saved record in place",
    file: "src/stateManager.ts",
    edits: [
      ["      if (this.sessionUnbaselined.delete(filePath)) this.saveUnbaselined();",
       "      this.sessionUnbaselined.delete(filePath);"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a damaged record fails the load",
    file: "src/baselineGit.ts",
    edits: [
      ["    } catch { /* fall through */ }\n",
       "    } finally { /* propagate */ }\n"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "a rename leaves the target's pending deletion in memory",
    file: "src/stateManager.ts",
    edits: [
      ["    if (!fileState && this.state.has(newFilePath)) this.dropState(newFilePath);\n",
       ""],
    ],
    test: "reloadEqualsMemory.test.js",
  },
  {
    desc: "renaming a new file leaves the target's old baseline in git",
    file: "src/stateManager.ts",
    edits: [
      ["      this.enqueue('renameFile: clearing target', g => g.removeFile(newFilePath));",
       "      this.enqueue('renameFile: clearing target', async () => undefined);"],
    ],
    test: "reloadEqualsMemory.test.js",
  },
  {
    desc: "a branch switch leaves the saved unbaselined record behind",
    file: "src/stateManager.ts",
    edits: [
      ["    this.saveCreated();\n    this.saveUnbaselined();\n",
       "    this.saveCreated();\n"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "renaming an untracked source leaves the target's old baseline",
    file: "src/baselineGit.ts",
    edits: [
      ["        await this.removeFile(newFilePath);\n        return;\n",
       "        return;\n"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "an untracked source moved over a baselined file is adopted as deletable",
    file: "src/stateManager.ts",
    edits: [
      ["    if (!fileState && !this.sessionUnbaselined.has(newFilePath)) {\n",
       "    if (false) {\n"],
    ],
    test: "stateManagerGit.test.js",
  },
  {
    desc: "Discard All runs without waiting for the user's answer",
    file: "src/commands.ts",
    edits: [
      ["  if (choice !== 'Discard All') {\n",
       "  if (false) {\n"],
    ],
    test: "discardAllConfirm.test.js",
  },
  {
    desc: "Discard All re-reads the queue after the dialog (discards files it never counted)",
    file: "src/commands.ts",
    edits: [
      ["await discardAllFiles(stateManager, fileWatcher, onStateChanged, entries.map(([fp]) => fp));",
       "await discardAllFiles(stateManager, fileWatcher, onStateChanged);"],
    ],
    test: "discardAllConfirm.test.js",
  },
  {
    desc: "the panel refreshes without updating its tab badge",
    file: "src/reviewPanel.ts",
    edits: [
      ["    this.view.badge = panelBadge(state);\n",
       ""],
    ],
    test: "panelBadge.test.js",
  },
  {
    desc: "subtree listing without -z (C-quoted names missed on a directory delete)",
    file: "src/baselineGit.ts",
    edits: [
      ["'-r', '-z', '--name-only'",
       "'-r', '--name-only'"],
      // Anchored on the `filter` that follows, because `removeFile` and `listTrackedFiles`
      // now have their own `return out` / `split('\\0')` pairs. Every path reader in this
      // file went `-z` in turn, so bare anchors here match several sites.
      ["        .split('\\0')\n        .filter(entry => entry.startsWith(prefix))",
       "        .split('\\n')\n        .filter(entry => entry.startsWith(prefix))"],
    ],
    test: "baselineGit.test.js",
  },
  {
    desc: "subtree listing treats a `..cache` folder as outside the workspace",
    file: "src/baselineGit.ts",
    edits: [
      ["rel.startsWith('..' + path.sep)",
       "rel.startsWith('..')"],
    ],
    test: "baselineGit.test.js",
  },
  {
    desc: "property generator seeded unscrambled (never an empty baseline)",
    file: "src/test/generators.ts",
    edits: [
      ["  let s = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) >>> 0;\n  s = (s ^ (s >>> 16)) >>> 0;\n",
       "  let s = seed >>> 0;\n"],
    ],
    test: "hunkApply.test.js",
  },
];

// The file currently holding a mutation, so a signal or crash can put it back.
let pending;
function restore() {
  if (pending) {
    writeFileSync(pending.path, pending.original);
    pending = undefined;
  }
}
process.on('exit', restore);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

// Async on purpose: a signal handler only runs when the event loop gets a turn.
function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.resume();
    child.on('close', code => resolve({ code, stdout }));
  });
}

async function main() {
  const survived = [];
  for (const { desc, file, edits, test } of MUTATIONS) {
    const path = join(ROOT, file);
    const original = readFileSync(path, 'utf8');
    try {
      let mutated = original;
      for (const [old, replacement] of edits) {
        const count = mutated.split(old).length - 1;
        if (count !== 1) {
          console.log(`  ERROR   ${desc}\n          anchor found ${count}x in ${file} — update this script`);
          return 2;
        }
        mutated = mutated.replace(old, () => replacement);
      }
      pending = { path, original };
      writeFileSync(path, mutated);

      const build = await run([TSC, '-p', 'tsconfig.test.json']);
      if (build.code !== 0) {
        console.log(`  ERROR   ${desc}\n          mutation does not compile:\n${build.stdout.slice(-800)}`);
        return 2;
      }
      const result = await run(['--test', `out-test/test/${test}`]);
      if (result.code !== 0) {
        console.log(`  killed  ${desc}`);
      } else {
        console.log(`  SURVIVED ${desc}  (${test} still passes)`);
        survived.push(desc);
      }
    } finally {
      restore();
    }
  }

  // Leave out-test/ built from the real source.
  await run([TSC, '-p', 'tsconfig.test.json']);
  console.log(`\n${MUTATIONS.length - survived.length}/${MUTATIONS.length} mutations killed`);
  return survived.length ? 1 : 0;
}

process.exitCode = await main();
