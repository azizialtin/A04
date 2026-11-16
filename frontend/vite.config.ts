import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
  // Preserve the browser targets used before the Vite tooling upgrade.
  build: { target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'] },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ is Playwright's; it needs a browser, not jsdom.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
  },
})
