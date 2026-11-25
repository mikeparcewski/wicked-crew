# wicked-crew-api-types

The **wire contract** of the wicked-crew daemon: one definition of every shape that crosses the
`/api/v1` REST surface and the `/ws` CoreEvent stream. Both sides compile against it —

- the daemon's route layer, via `packages/crew/src/core/types.ts` (a re-export), and
- the [wicked-studio](https://github.com/mikeparcewski/wicked-studio) SPA, via its
  `src/api/types.ts` (likewise a re-export)

— replacing the hand-copied mirror the studio used to carry (task #84). Published to npm as
[`wicked-crew-api-types`](https://www.npmjs.com/package/wicked-crew-api-types) so out-of-repo
clients (studio first among them) can pin the contract as a normal dependency; crew's in-repo
consumers keep the workspace reference.

## Rules

- **Wire shapes only.** Engine-internal types (`LaunchRunInput`) and runtime
  constants stay in the daemon.
- **Zero runtime.** This is a `.d.ts`-only package: no JavaScript, nothing to build. Consumers
  declare it as a devDependency (the published `wicked-crew` tarball never depends on it at
  runtime). Import it with `import type` only — the `exports` map offers just a `types`
  condition, so a value import fails loudly.
- **Forward-additive.** Optional/index-signature fields keep the shapes additive: a newer daemon
  that adds fields still parses in an older studio (DES-STUDIO-001 §5.1).

## Drift guard

`packages/crew/tests/wire-contract.test.ts` holds compile-time assertions, run by
`npm run -w packages/crew typecheck` (and CI): every response type the daemon produces must satisfy
this contract, and every request body the contract allows must be accepted by the daemon's zod
schemas. Change the wire shape in one place and the typecheck fails everywhere it matters.

## Versioning: stamped once per train

A pull request that changes this contract does not pick a version:

- It tags each field or type it adds or changes `(api-types next)`, in the doc comment here and in crew's source, in
  place of a number. Example: `/** (api-types next, crew#1234) Why the run stopped. */`. A tag is the two words
  `api-types next` on one line, outside backticks; a parenthesis may wrap across comment lines.
- It leaves this package's `version`, crew's `wicked-crew-api-types` caret and `package-lock.json` alone.

The release train's crew version PR stamps the contract once, from the repo root:

```sh
npm run stamp:api-types -- 0.232.0
```

The stamp (`scripts/stamp-api-types.mjs`) sets the version and every workspace's caret on it. It edits the same
fields of the workspaces' lockfile entries in place, with no install and nothing fetched. It turns every
`api-types next` tag in `index.d.ts`, in the workspaces' `src` and in the CHANGELOG into `api-types 0.232.0`, new
files included. Last, it regenerates crew's endpoint manifest and API sample test. Run it whenever the contract
changed since its last `api-types-v*` tag, doc changes included.

`npm run stamp:api-types -- --check` is the guard. It runs in three places:

- CI, on a PR that moves crew's version (the train's version PR), so that PR goes red before anything is tagged;
- the api-types release, before it publishes;
- crew's release, as a job of its own that publish does not wait on.

It fails if:

- a `next` tag is left;
- a version is not X.Y.Z;
- a caret, a lockfile entry or crew's endpoint manifest names another version;
- this directory, as it stands on disk, differs from the `api-types-v<version>` tag of the version it claims, when
  that tag exists.

With `--remote origin` the remote says whether that tag exists, and a remote that cannot be asked fails the check.
Without it, the local tags answer, so fetch the tags first.

Between trains, main's version names the last stamp while some fields already say `next`. Nothing reads the version
at runtime.
