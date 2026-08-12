# wicked-crew-api-types

The **wire contract** of the wicked-crew daemon: one definition of every shape that crosses the
`/api/v1` REST surface and the `/ws` CoreEvent stream. Both sides compile against it —

- the daemon's route layer, via `packages/crew/src/core/types.ts` (a re-export), and
- the studio SPA, via `packages/studio/src/api/types.ts` (likewise a re-export)

— replacing the hand-copied mirror the studio used to carry (task #84).

## Rules

- **Wire shapes only.** Engine-internal types (`LaunchRunInput`, `RepoOnboardRef`, runtime
  constants) stay in the daemon.
- **Zero runtime.** This is a `.d.ts`-only package: no JavaScript, nothing to build, nothing to
  publish (`private: true`; both consumers declare it as a devDependency, so the published
  `wicked-crew` tarball never depends on it). Import it with `import type` only — the `exports`
  map offers just a `types` condition, so a value import fails loudly.
- **Forward-additive.** Optional/index-signature fields keep the shapes additive: a newer daemon
  that adds fields still parses in an older studio (DES-STUDIO-001 §5.1).

## Drift guard

`packages/crew/tests/wire-contract.test.ts` holds compile-time assertions, run by
`npm run -w packages/crew typecheck` (and CI): every response type the daemon produces must satisfy
this contract, and every request body the contract allows must be accepted by the daemon's zod
schemas. Change the wire shape in one place and the typecheck fails everywhere it matters.
