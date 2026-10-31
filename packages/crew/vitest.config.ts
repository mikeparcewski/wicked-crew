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
    //   bus-double              answers the engine bus calls (src/core/bus.ts) for a bus file no
    //                           engine is attached to — a fake-adapter seam test's temp bus.
    setupFiles: ['./tests/setup/hermetic-home.ts', './tests/setup/isolate-workflow-overlay.ts', './tests/setup/bus-double.ts'],
    testTimeout: 30000,
    // crew#649: 15 s was the in-suite deadline the `test_targeted` floor kept blowing on a loaded
    // host — the same run's failures never reproduced when re-run on their own, and the verdict
    // tracked ambient load rather than the diff. A setup hook that takes 20 s at load 130 and 0.4 s
    // at load 10 is not evidence about a change, so the hook deadline matches `testTimeout` instead
    // of sitting at half of it. Tolerance only: nothing here changes what runs or in what order.
    hookTimeout: 30000,
    reporters: ['verbose'],
    // crew#1173: a test that reads the sibling wicked-core checkout (tests/support/core-checkout.ts)
    // carries this tag, one per test (never on a suite: scripts/test-related.mjs counts tagged
    // tests off the source). The repo-checks floor's checkout has no sibling, so test-related.mjs
    // runs `--tags-filter=!cross-repo` there and prints what it left out; CI and `npm test` run
    // them, and without a checkout they still fail loudly. Strict tags (vitest's default) make a
    // misspelt tag an error rather than a test the filter cannot see.
    tags: [
      {
        name: 'cross-repo',
        description: 'reads the sibling wicked-core checkout; runs in CI, left out of the floor when there is none',
      },
      // DES-FLOOR-CONTAINER: a test that needs the network (an `npm ci` from the registry). The container
      // checks floor has none and sets WICKED_CHECKS_FLOOR=container; scripts/test-related.mjs then runs
      // `--tags-filter=!network` and prints what it left out. CI and `npm test` run them.
      {
        name: 'network',
        description: 'needs the network; runs in CI, left out of the container checks floor (no network)',
      },
    ],
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
