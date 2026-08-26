import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000
  }
})
