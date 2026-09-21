#!/usr/bin/env python3
"""
Mutation check for the regression tests: prove each one can catch the bug it guards.

For every entry below this script re-introduces a defect that actually shipped, compiles,
runs the test file meant to guard it, and restores the source. The mutation must be
KILLED — the guarding test must FAIL. A mutation that SURVIVES means a regression test that
cannot detect its own regression, which is worse than no test: it manufactures confidence.

Run from the repo root after `npm test` has built out-test/ once:

    python3 scripts/mutation-check.py

Exit status is non-zero if any mutation survives. The source is always restored, including
on Ctrl-C, from an in-memory copy — never from git, so uncommitted work is safe.

Adding a regression test? Add its mutation here too. That is the check that the test works.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (description, source file, [(old, new), ...], guarding test file under out-test/test/)
MUTATIONS = [
    ("filenames read as git glob patterns",
     "src/baselineGit.ts",
     [("      GIT_LITERAL_PATHSPECS: '1',\n", "")],
     "baselineGitHardening.test.js"),

    ("getBaseline via `git show` (untracked glob name reads as tracked)",
     "src/baselineGit.ts",
     [("this.git(['cat-file', 'blob', `:0:${rel}`])", "this.git(['show', `:0:${rel}`])")],
     "baselineGitHardening.test.js"),

    ("getBaseline without an explicit stage (`1:x` read as stage 1 of `x`)",
     "src/baselineGit.ts",
     [("this.git(['cat-file', 'blob', `:0:${rel}`])", "this.git(['cat-file', 'blob', `:${rel}`])")],
     "baselineGitHardening.test.js"),

    ("commits inherit the user's commit.gpgsign",
     "src/baselineGit.ts",
     [("      '-c', 'commit.gpgsign=false',\n", "")],
     "baselineGitHardening.test.js"),

    ("commits run the user's core.hooksPath hooks",
     "src/baselineGit.ts",
     [("      '-c', 'core.hooksPath=',\n", ""),
      ("'--allow-empty', '--no-verify']", "'--allow-empty']"),
      ("'interactive-review baselines', '--no-verify']", "'interactive-review baselines']")],
     "baselineGitHardening.test.js"),

    ("unbounded git hash-object fan-out",
     "src/baselineGit.ts",
     [("const HASH_CONCURRENCY = 32;", "const HASH_CONCURRENCY = 1_000_000;")],
     "baselineGitHardening.test.js"),

    ("snapshotWorkspace swallows a failed snapshot",
     "src/stateManager.ts",
     [("    if (failure !== undefined) throw failure;", "    if (failure !== undefined) { /* swallowed */ }")],
     "stateManagerGit.test.js"),

    ("directory delete removes only the exact path (git no-op for a dir)",
     "src/stateManager.ts",
     [("const toRemove = tracked.filter(under);", "const toRemove = tracked.filter(fp => fp === dirPath);")],
     "stateManagerGit.test.js"),

    ("CodeLens anchored on the line after its hunk",
     "src/diffEngine.ts",
     [("return Math.min(Math.max(0, hunk.newStart - 1), Math.max(0, lineCount - 1));",
       "return Math.min(hunk.newStart - 1 + hunk.newLines, lineCount - 1);")],
     "diffEngine.test.js"),

    ("discard at EOF adds a newline the file never had",
     "src/hunkApply.ts",
     [("originalLines, baseline.terminated);", "originalLines, true);")],
     "hunkApply.test.js"),

    ("accept splices split('\\n') arrays (phantom trailing element)",
     "src/hunkApply.ts",
     [("  return spliceLines(baseline, hunk.oldStart - 1, hunk.oldLines, acceptedLines, current.terminated);",
       "  const bl = baselineText.split('\\n'); const cl = currentText.split('\\n');\n"
       "  return [...bl.slice(0, hunk.oldStart - 1), ...cl.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines),"
       " ...bl.slice(hunk.oldStart - 1 + hunk.oldLines)].join('\\n');")],
     "hunkApply.test.js"),

    ("partial accept takes the document's final newline",
     "src/hunkApply.ts",
     [("const acceptedTerminator = acceptEndLine < current.lines.length - 1 || current.terminated;",
       "const acceptedTerminator = current.terminated;")],
     "hunkApply.test.js"),

    ("partial reject takes the document's final newline",
     "src/hunkApply.ts",
     [("  const tailTerminator = newTailIsContext\n    ? hunk.oldLines > 0 || baseline.terminated\n    : current.terminated;",
       "  const tailTerminator = current.terminated;")],
     "hunkApply.test.js"),
]


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def main() -> int:
    survived = []
    for desc, rel, edits, test in MUTATIONS:
        path = ROOT / rel
        original = path.read_text()
        try:
            mutated = original
            for old, new in edits:
                count = mutated.count(old)
                if count != 1:
                    print(f"  ERROR   {desc}\n          anchor found {count}x in {rel} — update this script")
                    return 2
                mutated = mutated.replace(old, new)
            path.write_text(mutated)

            build = run(["npx", "tsc", "-p", "tsconfig.test.json"])
            if build.returncode != 0:
                print(f"  ERROR   {desc}\n          mutation does not compile:\n{build.stdout[-800:]}")
                return 2
            result = run(["node", "--test", f"out-test/test/{test}"])
            if result.returncode != 0:
                print(f"  killed  {desc}")
            else:
                print(f"  SURVIVED {desc}  ({test} still passes)")
                survived.append(desc)
        finally:
            path.write_text(original)

    # Leave out-test/ built from the real source.
    run(["npx", "tsc", "-p", "tsconfig.test.json"])
    print(f"\n{len(MUTATIONS) - len(survived)}/{len(MUTATIONS)} mutations killed")
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
