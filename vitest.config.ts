import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup/silence-logs.ts', 'test/setup/loopback-listen.ts'],
  },
})
