import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    // Allow top-level await in test files
    pool: 'forks',
  },
})
