import * as fs from 'fs';
import * as path from 'path';

/** Written next to the compiled extension by `scripts/build-stamp.js`. */
export interface BuildInfo {
  version: string;
  sha: string;
  dirty: boolean;
  builtAt: string;
}

/**
 * Read the build stamp from `dir` (the compiled `out/` directory in production).
 *
 * Never throws: a missing or malformed stamp is a build that skipped the stamp step — a
 * `tsc --watch` dev build, most often — and must not stop the extension activating.
 */
export function readBuildInfo(dir: string = __dirname): BuildInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'buildInfo.json'), 'utf-8'));
    if (typeof raw?.version !== 'string' || typeof raw?.sha !== 'string') return undefined;
    return { version: raw.version, sha: raw.sha, dirty: raw.dirty === true, builtAt: String(raw.builtAt ?? '') };
  } catch {
    return undefined;
  }
}

/**
 * The one-line build identity shown in the log and the panel, e.g. `0.0.1 · 1a2b3c4d5e6f`
 * or `0.0.1 · 1a2b3c4d5e6f-dirty`. The build date is appended because two dirty builds of
 * the same commit are otherwise indistinguishable, and "which of my builds is installed"
 * is exactly the question this answers.
 */
export function formatBuild(info: BuildInfo | undefined): string {
  if (!info) return 'unstamped build';
  const date = info.builtAt ? ` · built ${info.builtAt.slice(0, 16).replace('T', ' ')}Z` : '';
  return `${info.version} · ${info.sha}${info.dirty ? '-dirty' : ''}${date}`;
}
