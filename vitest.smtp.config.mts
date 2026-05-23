import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/smtp-core/**/*.test.ts'],
    pool: 'threads',
  },
})
