import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: join(dir, 'tests'),
  workers: 8,
  fullyParallel: true,
  timeout: 10000,
  expect: { timeout: 3000 },
  use: {
    baseURL: 'http://localhost:8002',
    actionTimeout: 3000,
  },
  webServer: [
    {
      command: `npx http-server ${join(dir, 'tests/dist')} -p 8002 -c-1 --silent`,
      url: 'http://localhost:8002',
      reuseExistingServer: true,
      timeout: 10000,
    },
    {
      // Peer server for cross-origin federation tests. Same dist/, different
      // port, with CORS enabled.
      command: `npx http-server ${join(dir, 'tests/dist')} -p 8003 -c-1 --silent --cors`,
      url: 'http://localhost:8003',
      reuseExistingServer: true,
      timeout: 10000,
    },
  ],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
