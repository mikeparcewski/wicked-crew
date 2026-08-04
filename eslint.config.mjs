// Flat ESLint config for the wicked-crew workspace (crew daemon + studio SPA).
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
import reactHooks from 'eslint-plugin-react-hooks';

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
  {
    // Studio is React — enforce the Rules of Hooks (a real bug class) and keep
    // exhaustive-deps advisory (warn) so intentional per-line disables stay valid.
    files: ['packages/studio/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
