#!/usr/bin/env node
/**
 * Stamp the build with the commit it came from: writes out/buildInfo.json, which the
 * extension logs on activation and shows in the review panel (see src/buildInfo.ts).
 *
 * It exists because no test can detect the failure it targets. On 2026-09-20 the owner was
 * running an installed build five weeks older than the source while reporting bugs, two of
 * which the working tree had already fixed. A visible commit makes that obvious at a glance.
 *
 *   node scripts/build-stamp.js                write the stamp (run by `npm run compile`)
 *   node scripts/build-stamp.js --require-clean
 *                                              refuse a dirty tree (run before packaging)
 *
 * `--require-clean` is what stops a .vsix being built from uncommitted source, because a
 * dirty build's SHA names a commit that does not describe it. Set IR_ALLOW_DIRTY=1 to
 * package one anyway — for installing a fix to test before committing it. The stamp still
 * says "-dirty", so the panel does not pretend otherwise.
 *
 * "Dirty" is scoped to the inputs of the package, not the whole tree: an untracked note in
 * docs/ changes nothing that ships and should not block a build. Keep this list in step
 * with .vscodeignore.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD_INPUTS = [
  'src', 'media', 'package.json', 'package-lock.json', 'tsconfig.json',
  '.vscodeignore', 'README.md', 'CHANGELOG.md', 'LICENSE',
];

function git(args) {
  // trimEnd, not trim: porcelain status lines start with a significant space.
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
}

function describe() {
  try {
    const sha = git(['rev-parse', '--short=12', 'HEAD']);
    // `src/test` is compiled into neither out/ nor the package, so test-only edits stay clean.
    const status = git(['status', '--porcelain', '--', ...BUILD_INPUTS, ':(exclude)src/test']);
    return { sha, dirty: status.length > 0, changes: status };
  } catch {
    // Not a git checkout (a source tarball) or no git on PATH. Say so rather than guess.
    return { sha: 'unknown', dirty: false, changes: '' };
  }
}

const info = describe();

if (process.argv.includes('--require-clean') && info.dirty) {
  if (process.env.IR_ALLOW_DIRTY === '1') {
    console.warn(`build-stamp: packaging a dirty tree at ${info.sha} (IR_ALLOW_DIRTY=1); it will be stamped -dirty`);
  } else {
    console.error(
      'build-stamp: refusing to package uncommitted changes to build inputs:\n' +
      info.changes.split('\n').map(l => `  ${l}`).join('\n') + '\n' +
      'Commit them, or set IR_ALLOW_DIRTY=1 to build a -dirty package on purpose.'
    );
    process.exit(1);
  }
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
const stamp = { version, sha: info.sha, dirty: info.dirty, builtAt: new Date().toISOString() };
fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out', 'buildInfo.json'), JSON.stringify(stamp, null, 2) + '\n');
console.log(`build-stamp: ${version} ${info.sha}${info.dirty ? '-dirty' : ''}`);
