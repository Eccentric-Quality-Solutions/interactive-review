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
    timeout: 30000,
  },
});
