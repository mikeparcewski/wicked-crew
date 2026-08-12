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
    ],
  },
  ...tseslint.configs.recommended,
);
