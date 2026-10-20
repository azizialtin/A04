import { defineConfig, devices } from '@playwright/test'

// Real browser/layout checks with synthetic API and tracker data; no study database.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'feedback-*.spec.ts',
  outputDir: './test-results/feedback',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:5185',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5185 --strictPort',
    url: 'http://127.0.0.1:5185',
    reuseExistingServer: false,
    env: {
      ...process.env,
      VITE_API_BASE_URL: 'http://a04.invalid',
      VITE_TOBII_WS_URL: 'ws://127.0.0.1:8766',
    },
  },
})
