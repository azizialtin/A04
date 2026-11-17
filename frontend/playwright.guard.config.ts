import { defineConfig, devices } from '@playwright/test'

// Another local server may already hold the default port.
const PORT = process.env.A04_GUARD_PORT ?? '5194'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'feedback-display-guard.spec.ts',
  // The blocking dialog is opt-in now; this suite keeps it honest. The observing
  // default is exercised by playwright.display-check.config.ts.
  grepInvert: /@observe/,
  outputDir: './test-results/display-guard',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        screen: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        launchOptions: { args: ['--window-position=0,0', '--window-size=1920,1080'] },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    env: {
      ...process.env,
      VITE_API_BASE_URL: 'http://a04.invalid',
      VITE_TOBII_WS_URL: 'ws://127.0.0.1:8766',
      VITE_LAB_DISPLAY_GUARD: 'true',
      VITE_LAB_DISPLAY_GUARD_BLOCKING: 'true',
    },
  },
})
