import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Run before every test file, before anything it imports:
    //   hermetic-home           arms the engine/daemon env seams (emit outbox, worker home,
    //                           system settings, audit log, project graphs) away from the
    //                           operator's real home — crew#396. Guarded by
    //                           tests/harness-hygiene.test.ts; do not remove.
    //   isolate-workflow-overlay redirects the workflow overlay dir away from the real ~/.config.
    setupFiles: ['./tests/setup/hermetic-home.ts', './tests/setup/isolate-workflow-overlay.ts'],
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
