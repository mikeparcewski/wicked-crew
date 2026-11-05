// Flat ESLint config for the wicked-crew workspace (crew daemon; the studio SPA
// carved out to its own repo — github.com/mikeparcewski/wicked-studio — carries
// this rule set with it, plus its React-specific block).
// typescript-eslint's `recommended` set — correctness-focused (unused vars, unsafe
// patterns, misused promises-lite), not opinionated style. Fast: no type-info project
// wiring, so it runs the same locally and in CI.
//
// This header used to say tests were "excluded — covered by typecheck". They were not:
// `tsconfig.json` listed `tests` under `exclude`, so no test file in this repo had ever been
// typechecked OR linted, and the sentence asserting otherwise was the only thing standing where a
// check should have been (FINDING-071). Tests are now linted here and typechecked through
// `tsconfig.test.json`. Build scripts under `packages/*/scripts/` remain ignored below, deliberately.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.{js,cjs,mjs,ts}',
      'packages/*/scripts/**',
      // A real MCP server's tsc output, installed and called by tests/mcp-installed-server.test.ts: not our source.
      'packages/crew/tests/fixtures/mcp/unit-convert/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // crew takes `z` from src/zod.js, which installs zod 3's English messages as zod 4's global error
    // map before anything parses (crew quotes zod's messages on the wire). A direct `zod` import would
    // still share that config, but only if src/zod.js had loaded first: route every import through it.
    files: ['packages/crew/src/**/*.{ts,js}', 'packages/crew/tests/**/*.{ts,js,mjs}'],
    ignores: ['packages/crew/src/zod.js', 'packages/crew/tests/fixtures/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        paths: [{ name: 'zod', message: "import { z } from src/zod.js (it installs zod 3's messages)", allowTypeImports: true }],
        patterns: [{ group: ['zod/*'], message: 'import { z } from src/zod.js', allowTypeImports: true }],
      }],
    },
  },
);
