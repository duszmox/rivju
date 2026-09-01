import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Electron launches are serial by nature; the app takes a single-instance lock.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
})
