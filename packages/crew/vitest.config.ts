import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 30000,
    hookTimeout: 15000,
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/**'],
      exclude: ['src/cli/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
});
