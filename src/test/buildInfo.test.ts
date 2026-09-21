import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { formatBuild, readBuildInfo } from '../buildInfo';

/**
 * The build stamp is read at activation, so the reader's one hard requirement is that it
 * never throws: a dev build without a stamp must still activate.
 */

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-build-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readBuildInfo', () => {
  it('reads a stamp written by scripts/build-stamp.js', () => {
    fs.writeFileSync(path.join(dir, 'buildInfo.json'), JSON.stringify({
      version: '1.2.3', sha: 'abcdef123456', dirty: true, builtAt: '2026-09-21T13:00:00.000Z',
    }));
    assert.deepEqual(readBuildInfo(dir), {
      version: '1.2.3', sha: 'abcdef123456', dirty: true, builtAt: '2026-09-21T13:00:00.000Z',
    });
  });

  it('returns undefined, not a throw, for a missing or malformed stamp', () => {
    assert.equal(readBuildInfo(dir), undefined);
    fs.writeFileSync(path.join(dir, 'buildInfo.json'), '{ not json');
    assert.equal(readBuildInfo(dir), undefined);
    fs.writeFileSync(path.join(dir, 'buildInfo.json'), JSON.stringify({ version: 1 }));
    assert.equal(readBuildInfo(dir), undefined);
  });
});

describe('formatBuild', () => {
  it('shows the commit, marks a dirty build, and dates it', () => {
    const info = { version: '0.0.1', sha: 'abcdef123456', dirty: false, builtAt: '2026-09-21T13:05:59.000Z' };
    assert.equal(formatBuild(info), '0.0.1 · abcdef123456 · built 2026-09-21 13:05Z');
    assert.equal(formatBuild({ ...info, dirty: true }), '0.0.1 · abcdef123456-dirty · built 2026-09-21 13:05Z');
  });

  it('says so when there is no stamp rather than showing a bare version', () => {
    assert.equal(formatBuild(undefined), 'unstamped build');
  });
});
