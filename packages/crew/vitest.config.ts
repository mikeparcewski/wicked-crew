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
    // crew#649: 15 s was the in-suite deadline the `test_targeted` floor kept blowing on a loaded
    // host — the same run's failures never reproduced when re-run on their own, and the verdict
    // tracked ambient load rather than the diff. A setup hook that takes 20 s at load 130 and 0.4 s
    // at load 10 is not evidence about a change, so the hook deadline matches `testTimeout` instead
    // of sitting at half of it. Tolerance only: nothing here changes what runs or in what order.
    hookTimeout: 30000,
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
