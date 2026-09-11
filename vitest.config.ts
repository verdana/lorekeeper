import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    environment: 'node',
    // `.tsx` files are renderer tests: they opt into jsdom per file with a
    // `@vitest-environment jsdom` docblock, so the server tests keep the faster
    // node environment.
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
