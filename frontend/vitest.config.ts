import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const r = (p: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), p)

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': r('./src'),
    },
  },
})

