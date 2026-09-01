import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests only. The Playwright-Electron suite in e2e/ is run by
    // `npm run test:e2e`; vitest would otherwise glob its *.spec.ts and fail
    // on Playwright's own test() binding.
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'out/**', 'release/**'],
  },
})
