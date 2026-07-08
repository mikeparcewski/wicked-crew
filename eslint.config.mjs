// Flat ESLint config for the wicked-crew workspace (crew daemon + studio SPA).
// typescript-eslint's `recommended` set — correctness-focused (unused vars, unsafe
// patterns, misused promises-lite), not opinionated style. Fast: no type-info project
// wiring, so it runs the same locally and in CI. Scoped to each package's `src/`
// (tests + build scripts are excluded — they're covered by typecheck + their own runs).
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
