import { defineConfig } from '@vscode/test-cli';
import path from 'path';

export default defineConfig({
  files: 'out-integration/test/integration/**/*.test.js',
  workspaceFolder: path.resolve('src/test/integration/workspace'),
  launchArgs: [
    '--disable-extensions',
    '--disable-gpu',
  ],
  mocha: {
    // Headroom above the waitForCondition floor (15s) so a test that chains a couple
    // of watcher-dependent waits under Linux load doesn't brush the per-test cap.
    timeout: 60000,
  },
});
