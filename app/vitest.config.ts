// Android port: upstream apps/desktop/vitest.config.ts minus the `electron`
// project (Electron main-process tests have nothing to run against here).
import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

export default defineConfig(env =>
  mergeConfig(viteConfig(env), {
    test: {
      name: 'ui',
      environment: 'jsdom',
      // Keep padding regressions observable instead of mocking the stylesheet away.
      css: { include: [/status-stack\.css$/] },
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      exclude: (process.env.VITEST_EXCLUDE ?? '').split(',').filter(Boolean),
      globals: true,
      testTimeout: 15_000,
      hookTimeout: 30_000
    }
  })
)
