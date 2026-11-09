import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  outputDir: 'test-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5190',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx vite --config web/vite.config.ts --host localhost --port 5190 --strictPort web',
    url: 'http://localhost:5190',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
