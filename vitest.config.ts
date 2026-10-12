// crew#986: a vitest run from the repo root loaded NO config, so crew's `tests/setup/*` (the
// hermetic temp state home, worker home, emit outbox, bus dir) never ran and the tests wrote into
// the operator's live `~/.wicked-crew`. From the root, every package runs under its own config.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/crew', 'packages/agent-acp-bridges'],
  },
});
