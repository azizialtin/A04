import { defineConfig, devices } from '@playwright/test'

const PORT = process.env.A04_FEEDBACK_PORT ?? '5185'

// Real browser/layout checks with synthetic API and tracker data; no study database.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'feedback-*.spec.ts',
  testIgnore: 'feedback-display-guard.spec.ts',
  outputDir: './test-results/feedback',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.A04_ALL_BROWSERS === '1'
      ? [
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        ]
      : []),
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    env: {
      ...process.env,
      VITE_API_BASE_URL: 'http://a04.invalid',
      VITE_TOBII_WS_URL: 'ws://127.0.0.1:8766',
    },
  },
})
