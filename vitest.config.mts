import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/cloudflare-worker/wrangler.toml' },
      main: './test/cloudflare-worker/worker.ts',
    }),
  ],
  test: {
    include: ['test/unit/**/*.test.ts'],
    exclude: ['test/deno/**', 'test/smtp-core/**'],
  },
})
