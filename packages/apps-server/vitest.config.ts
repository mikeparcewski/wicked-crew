import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // dist/server/shim/host.test.js is the host's TEST build (a framed-token seam), not a test file.
    include: ['tests/**/*.test.ts'],
    // crew's hermetic setup: the tests build apps with crew's own store and registry (tests/support), which
    // must never touch the operator's real state home (crew#396).
    setupFiles: ['../crew/tests/setup/hermetic-home.ts', '../crew/tests/setup/isolate-workflow-overlay.ts', '../crew/tests/setup/bus-double.ts'],
    globals: false,
    // The server's tests start real HTTPS issuers, Postgres connections and the built server: generous on a
    // loaded host, like crew's (crew#649).
    testTimeout: 60000,
    hookTimeout: 60000,
    reporters: ['verbose'],
  },
});
