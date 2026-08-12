# ADR-STUDIO-DEP-001 — crew declares wicked-studio as a devDependency

**Status**: Accepted  
**Date**: 2026-08-12  
**Deciders**: wicked-crew team  
**Supersedes**: n/a  
**Related**: DES-STUDIO-SERVING-001, P9 DoD adversarial review (conditional #2)

---

## Context

`wicked-crew/packages/crew/package.json` declares `wicked-studio` as a
`devDependency` at `^0.1.0`. The P9 DoD review flagged this as a potential
circular-dependency risk as both products evolve, and asked it to be
documented as intentional architecture rather than an accidental coupling.

---

## Decision

`wicked-crew` declares `wicked-studio` as a **devDependency** to bundle
studio's compiled distribution artifact into crew's release build via the
`build:with-studio` npm script.

This is intentional, load-bearing design — not an accidental coupling.

---

## Rationale

### The one-command UX requirement

`npx wicked-crew serve` must deliver a complete, usable experience without
any additional installation step. That means the studio SPA must be available
same-origin the moment the daemon starts. Shipping studio's compiled `dist/`
inside the crew package is the only approach that meets this requirement
without requiring a separate `npm install wicked-studio` or a runtime fetch.

### Why devDependency, not dependency

Studio is consumed as a **build artifact** (its `dist/` directory), not as a
runtime module. Nothing in crew's runtime JavaScript imports studio source or
types. The dependency is resolved at build time (`build:with-studio` copies
`dist/` into crew's release bundle), not at `require()` time. A `devDependency`
is the correct npm semantic for a build-time-only input.

### Dependency direction

```
wicked-studio ──(wire contract)──▶ wicked-crew-api-types
wicked-crew   ──(build artifact)──▶ wicked-studio dist/
```

- **Studio** depends on crew's **wire contract** (`wicked-crew-api-types`) —
  the published, versioned package that defines the HTTP/WS boundary. Studio
  NEVER imports crew source or crew internals.
- **Crew** depends on studio's **build artifact** (`dist/`) — the compiled,
  static SPA output. Crew NEVER imports studio source or studio types.

This is **control-plane-ships-the-skin**: the control plane (crew) bundles the
experience-plane skin (studio) for distribution convenience. It is not source
coupling.

---

## Risk and guard

**Risk**: If studio ever introduces a compile-time dependency on crew source
(not `wicked-crew-api-types` but crew's internal packages), this becomes a
true circular dependency. That would prevent studio from being built without
crew and prevent crew from being built without a working studio.

**Guard**: studio's `package.json` **must never** list `wicked-crew` as a
runtime or devDependency. The only permitted crew-namespace entry is
`wicked-crew-api-types` (the wire-contract package). This invariant should be
checked in CI.

**Recommended CI check** (add to the studio CI job):

```bash
# Fail if studio's package.json lists wicked-crew (not wicked-crew-api-types)
node -e "
  const pkg = require('./packages/studio/package.json');
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  if ('wicked-crew' in all) { console.error('studio must not depend on wicked-crew source'); process.exit(1); }
"
```

---

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Ship studio as a separate install (`npm i -g wicked-studio`) | Breaks the one-command UX; two installs to keep in sync |
| Fetch studio at daemon startup | Requires network access in air-gapped or offline deployments |
| Collapse studio source into the crew monorepo | Violates the product boundary; studio is an independently-releasable product with its own repo and CI |
| Dependency injection via `WICKED_STUDIO_PATH` env var | A valid escape hatch (already supported) but not a substitute for the default bundled experience |

---

## Consequences

- **Positive**: `npx wicked-crew serve` delivers a working UI with no extra
  steps. Crew and studio can be released on independent cadences; crew pins a
  specific studio version and upgrades deliberately.
- **Positive**: The wire contract (`wicked-crew-api-types`) is the only shared
  type surface, enforcing a clean boundary at compile time.
- **Negative**: Crew's release bundle grows by studio's dist size (~2–5 MB
  gzipped). Acceptable for a local-first developer tool.
- **Negative**: Crew must explicitly bump the studio devDependency to pick up
  studio improvements. This is intentional — it makes the coupling visible and
  auditable rather than implicit.
