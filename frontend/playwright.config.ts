import { defineConfig, devices } from '@playwright/test'

// The e2e run needs a backend and the built frontend. Playwright starts both;
// Postgres and the admin account are the caller's job (see e2e/README.md).
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8031'
const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:4175'

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'feedback-*.spec.ts',
  fullyParallel: false, // one participant at a time, as in the lab
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',

  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: `cd ../backend && .venv/bin/uvicorn main:app --port ${new URL(API_URL).port}`,
      url: `${API_URL}/health/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // webServer.env replaces the environment rather than adding to it, so
      // spread process.env or DATABASE_URL is lost and the backend quietly
      // falls back to the dev database.
      env: { ...process.env, FRONTEND_URL: APP_URL },
    },
    {
      // Built here rather than served from whatever dist/ happens to hold:
      // Vite bakes VITE_API_BASE_URL at build time, so setting it only for
      // `preview` silently leaves the bundle pointing at the wrong backend.
      command: `npm run build && npm run preview -- --port ${new URL(APP_URL).port} --strictPort`,
      url: APP_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...process.env, VITE_API_BASE_URL: API_URL },
    },
  ],
})
