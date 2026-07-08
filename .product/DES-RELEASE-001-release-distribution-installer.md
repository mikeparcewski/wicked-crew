---
name: DES-RELEASE-001-release-distribution-installer
title: Release / distribution + installer design for the wicked-* ecosystem
status: draft
version: 0.1
date: 2026-07-08
author: michael.parcewski@accenture.com
review-required: true
scope: design + execution PATH only — NO repos created, NO publish, NO code changes in this doc
depends-on:
  - wicked-estate 0.13.0 → crates.io (keystone; currently local-only, crates.io has 0.12)
  - wicked-core (Rust) → wicked-core-ts (napi cdylib) → @wicked/crew + @wicked/studio (npm)
relates-to:
  - DES-STUDIO-001 (crew daemon + React studio on core-ts)
  - REQ-002 §6 (package + distribution constraints)
  - archived wicked-memory:release-to-crates-io skill (tag-triggered crates.io pipeline)
  - wicked-ci reusable workflows (node-ci.yml, node-release.yml)
  - wicked-installer (existing npm installer, registry-driven)
---

# DES-RELEASE-001 — Release, distribution & installer

> **Every outward or irreversible action in this doc is tagged `[USER-GATED]`.** Repo
> creation, `cargo publish`, `npm publish`, secret creation, org claims, and any write
> to a user's CLI/MCP config are NOT performed here. Design + execution PATH only.

---

## 0. Executive summary

The crew slice (`@wicked/crew` daemon + `@wicked/studio` React app) sits at the **top
of a four-layer native dependency chain** that bottoms out in Rust crates that are not
yet on crates.io. The whole release problem reduces to **one keystone**: publish
`wicked-estate 0.13.0` to crates.io. Until that lands, `wicked-core` cannot resolve its
cross-repo deps from a clean checkout, `wicked-core-ts` cannot build in CI, and the two
npm packages that depend on the native addon have nothing to stand on.

Two facts change the shape of the "installer" ask versus a greenfield design:

1. **A registry-driven installer already ships** — `wicked-installer` is on npm at
   `0.1.4` (`wicked-installer/package.json:2`, unscoped, `bin` = `wicked` + `wicked-installer`),
   with a `registry.json` product/bundle model and CLI detection. The right move is to
   **extend it**, not invent a new `@wicked/install`.
2. **A `wicked-studio` GitHub repo already exists** (`mikeparcewski/wicked-studio`,
   public, **Rust/Tauri**, "Desktop agent IDE") — a *different artifact* from the new
   browser `packages/studio` React SPA. That name collision is a decision (§7, D5).

---

## 1. Recon findings (read-only; cited)

### 1.1 Publish targets & flags per product

| Artifact | File:line | Name / version | Publish flag | Target |
|---|---|---|---|---|
| estate workspace | `wicked-estate/Cargo.toml:21,23,25` | `0.13.0`, MIT, repo=`github.com/mikeparcewski/wicked-estate` | (no `publish=false`) | **crates.io** (15 member crates + 11 vendored tree-sitter grammars) |
| wicked-core | `wicked-core/Cargo.toml:2,3,5` | `wicked-core` `0.1.0`, MIT | (no `publish=false`) | **undecided** (D2) — recommend *not published* |
| wicked-core-ts | `wicked-core/crates/wicked-core-ts/Cargo.toml:7` | `wicked-core-ts` `0.1.0`, MIT | **`publish = false`** (crates.io) | **npm** as prebuilt-binary package |
| crew workspace root | `wicked-crew/package.json:2,4` | `wicked-crew-workspace` `0.1.0` | **`private: true`** | not published (workspace container) |
| crew daemon | `wicked-crew/packages/crew/package.json:2,7-8` | `@wicked/crew` `0.1.0`, `bin: wicked-crew` | (not private) | **npm** |
| studio | `wicked-crew/packages/studio/package.json:2` | `@wicked/studio` `0.1.0`, **no `bin`/`main`/`files`** | (not private) | **npm (optional) / bundled into crew** |

**Naming drift (D1):** the package.json files use **scoped** `@wicked/crew` /
`@wicked/studio`, but `REQ-002 §6` (`wicked-crew/.product/REQ-002-technology-constraints.md:86`)
mandates **unscoped** `wicked-crew` / `wicked-studio`, and every published sibling is
unscoped (`wicked-bus`, `wicked-brain`, `wicked-testing`, `wicked-installer`,
`wicked-loom`, `wicked-vault`). This doc recommends aligning to unscoped (§4, D1).

### 1.2 The napi prebuild pattern (template for core-ts distribution)

`archived/wicked-memory/crates/wicked-memory-ts/` is the exact template
`wicked-core-ts` already mirrors:

- `Cargo.toml`: `[lib] crate-type = ["cdylib"]`, `napi`/`napi-derive` deps,
  `napi-build` build-dep, excluded from any cargo workspace, `[profile.release] lto + strip`.
- `build.rs`: `napi_build::setup();` (one line).
- `.cargo/config.toml`: macOS `dynamic_lookup` rustflags so a **plain `cargo build`**
  links the addon without the `napi build` CLI.

`wicked-core-ts` reproduces all three (`.../wicked-core-ts/Cargo.toml`, `build.rs`,
`.cargo/config.toml`) and adds an `index.d.ts` (hand-kept; `index.d.ts:2` notes napi-rs
could emit it) + a `package.json` whose build is
`cargo build -p wicked-core-ts --release && cp target/release/libwicked_core_ts.dylib index.node`
(`.../wicked-core-ts/package.json:13`). **That `cp` hardcodes the macOS `.dylib`
extension** — the CI matrix must generalize it per-platform (`.dylib`/`.so`/`.dll`).
The built `index.node` (44 MB) and `*.node` are **gitignored**
(`.../wicked-core-ts/.gitignore`) — so the artifact is a *build output*, never committed;
distribution must ship it, per platform, via npm.

### 1.3 Existing release tooling (reuse)

- **crates.io pipeline** — `archived/wicked-memory/.agent/skills/release-to-crates-io/SKILL.md`:
  tag `v*` → `.github/workflows/publish.yml` → `scripts/publish.sh` (topological,
  resumable, 429-aware). **wicked-estate already has this wired**:
  `wicked-estate/scripts/publish.sh` (21-crate topological order, `--dry-run`,
  `--allow-dirty`) + `.github/workflows/publish.yml` (tag `v*`) +
  `release.yml` (workflow_dispatch: bump → tag → push).
- **npm pipeline** — `wicked-ci/.github/workflows/node-release.yml` (reusable):
  inputs `package_name`, `scope` (default `@mikeparcewski`, GH-Packages mirror,
  `:12`), `os_matrix` (default all 3 OSes), `version_dirs`, `pre_publish_install_dirs`,
  `enable_sync_pr`, `enable_github_packages` (`:50`). Callers: `wicked-vault.release.yml`,
  `wicked-brain.release.yml`, `wicked-loom.release.yml` (`wicked-ci/examples/`).
- **CI** — `wicked-ci/.github/workflows/node-ci.yml`; shared Renovate preset
  `wicked-ci/default.json` (consumers `extends: github>mikeparcewski/wicked-ci`).
- **GAP:** wicked-ci has **no Rust/crates.io reusable workflow and no napi build-matrix
  workflow** — estate carries its own bespoke `publish.yml`; core-ts needs a **new**
  napi matrix workflow (§2.3).

### 1.4 Existing repos (gh, account `mikeparcewski`) — conventions to match

| Repo | Visibility | License | Lang | Note |
|---|---|---|---|---|
| wicked-estate | public | MIT | Rust | crates.io publisher wired |
| wicked-core | **private** | **null** (repo has no LICENSE; `Cargo.toml:5` says MIT) | Rust | **no `.github/workflows`**; branches `main`, `lane/estate-0.13-migration` (current), `feat/orchestrator-engine-p0-p4a` |
| wicked-bus / -brain / -testing / -interactive / -signals | public | — | JS/TS | product siblings, all public |
| wicked-studio | **public** | null | **Rust** | OLD Tauri desktop app — name collides with new React studio (D5) |
| wicked-installer | public | MIT | TS | npm `0.1.4`; registry-driven; `npx wicked-installer` |
| wicked-loom | public | — | Py/npm | "resolves, version-checks, installs the wicked-* peer set" — overlaps installer (D7) |
| wicked-ci | public | — | — | reusable workflows + Renovate preset |
| **wicked-crew** | **does not exist** | — | — | local git only, branch `lane/crew-on-core-ts`, **main unborn**, **no remote** |

Convention to match for a new **wicked-crew** repo: `mikeparcewski/wicked-crew`,
**public**, **MIT** + `LICENSE` file, Renovate extending wicked-ci, unscoped npm packages.

### 1.5 The verified dependency & blocker facts

- **12** cross-repo estate path-deps live in the wicked-core repo (task estimated ~16):
  6 in the root manifest (`wicked-core/Cargo.toml:27-33`: estate-core, -rank, -retrieve,
  -memory, -memory-core, -knowledge) + 2 each in `crates/wicked-apps-core` (`:10-11`),
  `crates/wicked-governance` (`:11-12`), `crates/wicked-council` (`:11-12`) — all
  estate-core + estate-store. `crates/wicked-orchestration` has **zero** estate deps
  (path-deps `wicked-apps-core` only). **All 12 are bare `{ path = … }` — no `version =`
  — so wicked-core cannot `cargo publish` and cannot build from a lone checkout.**
- estate's internal deps are already **dual** `{ path, version = "0.13.0" }`
  (`wicked-estate/Cargo.toml` workspace.dependencies) → estate is publish-ready once
  tagged.
- estate 0.13 is **local-only**; crates.io currently has 0.12. `wicked-core-ts` and
  `wicked-installer`/`wicked-core-ts` are **not on npm** (verified 404); `wicked-installer`
  **is** on npm at `0.1.4`.
- `@wicked/crew` is a 404 on npm; whether the **`@wicked` org** is claimable is unknown → USER-GATED (D6).

---

## 2. Repo topology & per-product publish target

### 2.1 Topology decision — polyrepo (matches the ecosystem)

Keep polyrepo. The chain crosses three existing repos plus one new one:

```
mikeparcewski/wicked-estate   (Rust, public, MIT)   → crates.io
mikeparcewski/wicked-core     (Rust, private)       → NOT published (recommended, D2)
  └─ crates/wicked-core-ts    (napi cdylib, same repo, publish=false) → npm: wicked-core-ts (prebuilt .node)
mikeparcewski/wicked-crew     (NEW; npm workspace)  → npm: wicked-crew (daemon) [+ wicked-studio bundled]
mikeparcewski/wicked-installer(exists)              → npm: wicked-installer (thin composer)
```

`wicked-core-ts` stays **inside the wicked-core repo** (it path-deps `../..` = wicked-core
and `../wicked-council`; it is deliberately not a workspace member — see its Cargo.toml
comment). It ships to **npm**, never crates.io (`publish = false`). The new
**wicked-crew** repo carries the `packages/crew` + `packages/studio` npm workspace exactly
as it is laid out locally today.

### 2.2 The chain diagram (build-time coupling)

```
   ┌────────────────────────── crates.io ──────────────────────────┐
   │  wicked-estate 0.13.0  (15 crates + 11 tree-sitter grammars)   │  [USER-GATED publish — KEYSTONE]
   └───────────────▲────────────────────────────────────────────────┘
                   │ version deps (after the path→version flip, §3)
   ┌───────────────┴───────────── wicked-core repo (git) ───────────┐
   │  wicked-core (Rust)  ── path ──▶ crates/{apps-core,governance,  │  NOT published (D2)
   │                                  council,orchestration}         │
   │        ▲ path (../..)                                           │
   │  crates/wicked-core-ts  (napi cdylib, publish=false)  ──────────┼─▶ npm: wicked-core-ts
   └────────────────────────────────────────────────────────────────┘   (prebuilt per-platform .node)  [USER-GATED]
                   │ npm dep  "wicked-core-ts": "^0.1"
   ┌───────────────┴───────────── wicked-crew repo (NEW) ───────────┐
   │  packages/crew   (@wicked/crew → wicked-crew)  bin: wicked-crew │─▶ npm: wicked-crew           [USER-GATED]
   │        └─ serves ─▶ packages/studio dist (React SPA, bundled)   │   [+ wicked-studio optional]
   └────────────────────────────────────────────────────────────────┘
                   │ registry entry + composed bundle
   ┌───────────────┴───────────── wicked-installer (exists) ────────┐
   │  npx wicked-installer  → estate-MCP + wicked-crew + config wire │─▶ npm: wicked-installer bump [USER-GATED]
   └────────────────────────────────────────────────────────────────┘
```

The coupling is **static and build-time**: the `.node` addon is compiled against exact
`wicked-core` + `wicked-estate` crate versions. There is **no runtime version
negotiation** — the Rust is sealed inside `index.node` at build. This is the single most
important fact for the versioning contract (§4).

### 2.3 Per-product publish target + CI job shape

**A. wicked-estate → crates.io (reuse; already wired).**
`scripts/publish.sh` + `publish.yml` on tag `v0.13.0`. CI job = the existing bespoke
Rust publish job (checkout → rust-toolchain → rust-cache → `bash scripts/publish.sh`
with `CARGO_REGISTRY_TOKEN`). No change needed beyond the tag. Reuse the
`release-to-crates-io` skill's procedure verbatim.

**B. wicked-core → NOT published (recommended, D2).** Consumed only via core-ts's static
bundle. CI job = **build+test only** (`cargo test`), gated on estate 0.13 being resolvable
(post-flip, §3). No publish job. *(Tradeoff & the "publish anyway" alternative in D2.)*

**C. wicked-core-ts → npm, prebuilt per-platform `.node` (NEW napi matrix workflow).**
This is the one genuinely new pipeline. Shape:

```yaml
# .github/workflows/napi-release.yml  (author in wicked-ci as reusable, OR bespoke in wicked-core)
# Trigger: tag  core-ts-v*   (independent of estate's v* tags — same repo, two tag namespaces)
strategy:
  matrix:
    include:
      - { runner: macos-latest,   target: x86_64-apple-darwin,        ext: dylib }
      - { runner: macos-latest,   target: aarch64-apple-darwin,       ext: dylib }
      - { runner: ubuntu-latest,  target: x86_64-unknown-linux-gnu,   ext: so }
      - { runner: ubuntu-latest,  target: aarch64-unknown-linux-gnu,  ext: so }   # cross
      - { runner: windows-latest, target: x86_64-pc-windows-msvc,     ext: dll }
steps:
  - checkout (wicked-core repo only — self-contained after §3 flip)
  - rust-toolchain + target add
  - cargo build -p wicked-core-ts --release --target ${{ matrix.target }}
  - rename target/<t>/release/libwicked_core_ts.<ext>  →  wicked-core-ts.<target>.node
  - upload per-target artifact
publish:                       # after matrix
  - assemble platform packages (@napi-rs/cli style: wicked-core-ts-<os>-<arch>) OR
    a single package + postinstall that fetches the matching .node from the GH release
  - npm publish   [USER-GATED]
```

**Recommendation:** adopt the **`@napi-rs/cli` platform-package model** — a thin main
package `wicked-core-ts` whose `optionalDependencies` are per-platform binary packages
(`wicked-core-ts-darwin-arm64`, `-linux-x64-gnu`, `-win32-x64-msvc`, …). npm installs only
the matching one; no postinstall download, works offline/air-gapped, and is the ecosystem
standard for napi. This supersedes the current hand-`cp` build script for release (keep
the `cp` script for local dev).

**D. wicked-crew (daemon) + wicked-studio → npm (reuse node-release.yml).**
Caller shape (mirrors `wicked-ci/examples/wicked-vault.release.yml`), from the
new wicked-crew repo:

```yaml
# wicked-crew/.github/workflows/release.yml
on: { push: { tags: ['v*'] } }
jobs:
  release:
    uses: mikeparcewski/wicked-ci/.github/workflows/node-release.yml@v1
    with:
      package_name: wicked-crew          # unscoped (D1); scope input only mirrors GH Packages
      version_dirs: |
        .
        packages/crew
        packages/studio
      pre_publish_install_dirs: |
        packages/crew
      test_cmd: 'npm run -w packages/crew test && npm run -w packages/studio test'
      os_matrix: '["ubuntu-latest","macos-latest","windows-latest"]'
      enable_sync_pr: true
    secrets: inherit
```

`packages/studio` builds to static `dist/` and is **bundled into the crew tarball**
(daemon serves it — DES-STUDIO-001 §0: the browser cannot call the napi addon; the daemon
is the only process holding the `Core` handle). Publishing `wicked-studio` standalone is
optional (D1/D5) — it is not independently runnable in the new browser model.

**E. wicked-installer → npm (reuse node-release.yml; it already publishes at 0.1.4).**
Add wicked-crew to `registry.json`; version bump on tag.

CI (non-release) for the JS repos = `node-ci.yml` caller + Renovate `default.json`
extension, matching every sibling.

---

## 3. The path-dep → version fix (concrete, sequenced)

**Why it's required even though we don't publish wicked-core:** `wicked-core-ts`'s CI
checks out **only the wicked-core repo**. The 12 bare estate path-deps
(`../wicked-estate/...`, `../../../wicked-estate/...`) resolve **only when an estate
checkout sits next to wicked-core** — true locally, false in CI. To make core-ts build in
a clean single-repo CI checkout, estate must come from **crates.io**, which means the
deps must carry a `version`.

**Per the `release-to-crates-io` skill rule:** flip *cross-repo* deps to dual
`{ path, version }` (path builds locally, version resolves in CI); leave *intra-repo*
path-deps (`crates/wicked-apps-core`, etc. within the wicked-core repo, and
`wicked-core-ts → ../..`) untouched — they travel with the checkout.

**The flip (13 edits across 4 manifests — AUTONOMOUS to author as a patch; local commit only):**

```toml
# wicked-core/Cargo.toml:27-33  (6 deps)  — add version, keep path:
wicked-estate-core     = { path = "../wicked-estate/crates/wicked-estate-core",     version = "0.13" }
wicked-estate-rank     = { path = "../wicked-estate/crates/wicked-estate-rank",     version = "0.13" }
wicked-estate-retrieve = { path = "../wicked-estate/crates/wicked-estate-retrieve", version = "0.13", features = ["model2vec"] }
wicked-estate-memory       = { path = "../wicked-estate/crates/wicked-estate-memory",       version = "0.13" }
wicked-estate-memory-core  = { path = "../wicked-estate/crates/wicked-estate-memory-core",  version = "0.13" }
wicked-estate-knowledge    = { path = "../wicked-estate/crates/wicked-estate-knowledge",    version = "0.13" }
# crates/wicked-apps-core/Cargo.toml:10-11   → estate-core, estate-store  + version="0.13"
# crates/wicked-governance/Cargo.toml:11-12  → estate-core, estate-store  + version="0.13"
# crates/wicked-council/Cargo.toml:11-12     → estate-core, estate-store  + version="0.13"
```

**Sequence (strict):**
1. `[USER-GATED]` estate 0.13.0 → crates.io (§5 Phase 2). **Keystone.**
2. `[AUTONOMOUS]` Apply the flip patch in wicked-core.
3. `[AUTONOMOUS]` **Prove decoupling:** temporarily move/rename the co-located
   `../wicked-estate` checkout, run `cargo build` in wicked-core — it must pull estate
   0.13 from crates.io and succeed. Restore the checkout for local dev (path still wins
   locally because path takes precedence when present).
4. `[AUTONOMOUS]` Commit the flip locally; core-ts CI can now go matrix-green (§5 Phase 5).

**Caveat:** estate exports 0.13 crates *and* 11 vendored tree-sitter grammar crates. The
flip only touches the six estate crate names wicked-core actually references; grammars are
transitive and resolve automatically once estate is on crates.io.

---

## 4. Versioning semantics & the compatibility contract

**Independent semver per product** (matches the ecosystem — estate at 0.13, core at 0.1,
each sibling versions on its own). No lockstep monorepo version.

**The compatibility contract (documented, enforced by pins):**

1. **`wicked-crew` pins a `wicked-core-ts` major** — `"wicked-core-ts": "^0.1"` in
   `packages/crew` (today it is `file:../../../wicked-core/crates/wicked-core-ts`
   — `packages/crew/package.json:22`; flip to a version range at publish, §5 Phase 6).
2. **`wicked-core-ts`'s version is the single source of truth for the Rust inside it.**
   Because the addon statically bundles exact `wicked-core` + `wicked-estate` crate
   versions (napi build-time coupling, §2.2), core-ts must **bump its npm version whenever
   the bundled core or estate changes the addon's behavior/ABI**. Publish a
   machine-readable manifest of what's inside — e.g. `wicked-core-ts` package.json gains:
   ```json
   "wickedBundles": { "wicked-core": "0.1.0", "wicked-estate": "0.13.0" }
   ```
   generated at build from `Cargo.lock`. This makes "which estate am I actually running"
   answerable without reading Rust.
3. **napi engine floor** — `wicked-core-ts` targets N-API v8 (`Cargo.toml`
   `features=["napi8"]`); declare `engines.node >= 20` (matches
   `wicked-crew/package.json` and REQ-002 §1). Node ABI is stable across major versions via
   N-API, so a single prebuilt per (os,arch) covers all Node ≥ 20 — no per-Node-version
   matrix (the win over node-gyp).
4. **estate-MCP is version-independent of the estate bundled in core-ts.** A user may
   `cargo install wicked-estate` (standalone MCP) at one version while the crew daemon runs
   a different estate inside `index.node`. They are separate processes. **Hazard:** if both
   open the *same* SQLite DB file they race — wicked-core exists precisely to be the
   single writer. **Installer rule (§5):** give the crew daemon its own DB path
   (`~/.wicked-crew/`), distinct from any standalone estate-MCP DB. Document, don't share.

**Tag / release trigger per repo:**

| Repo | Tag pattern | Fires | Publishes |
|---|---|---|---|
| wicked-estate | `v*` | `publish.yml` → `publish.sh` | crates.io (15+11 crates) |
| wicked-core | `core-ts-v*` (separate namespace, same repo) | new `napi-release.yml` | npm `wicked-core-ts` (prebuilt matrix) |
| wicked-crew | `v*` | `node-release.yml` caller | npm `wicked-crew` (+ studio bundled) |
| wicked-installer | `v*` | `node-release.yml` caller | npm `wicked-installer` |

Using `core-ts-v*` in the wicked-core repo keeps the napi npm release independent of any
future `v*` crates.io release of wicked-core (D2), so the two tag namespaces never collide.

---

## 5. The installer

### 5.1 Strategy — extend `wicked-installer` (do NOT create `@wicked/install`)

`wicked-installer` already is the "brings it all together AND each independently
installable" tool: registry-driven (`wicked-installer/registry.json`), dependency-aware
(`src/resolver.ts`), CLI-detecting (`src/detector.ts`), with bundles
(`quick-start`/`garden`/`knowledge`/`creative`/`full`) and `npx wicked-installer`
(`package.json:2`, `bin` = `wicked` + `wicked-installer`). The task's `@wicked/install` is
a placeholder for exactly this. **Extend it.** (`wicked-loom` — "installs the wicked-* peer
set" — overlaps; converge on wicked-installer as the user-facing thin composer, D7.)

### 5.2 What the composer installs, in order

New registry product `wicked-crew` + a composed bundle (e.g. `crew` / `operator`):

```
Bundle "operator":  wicked-estate (MCP) + wicked-crew (daemon; bundles studio + core-ts)
```

Install order (the composer orchestrates; each step is also a standalone path, §5.3):

1. **Preflight** *(read-only)* — Node ≥ 20 check; detect platform (os,arch) so the correct
   `wicked-core-ts` prebuilt resolves; run existing `detector.ts` for AI CLIs; locate the
   target CLI's MCP config.
2. **estate-MCP** — install the standalone binary: `cargo install wicked-estate` (crates.io,
   post-keystone) **or** the GitHub release binary (registry `type: github-binary`, as today).
3. **crew daemon** — `npm i -g wicked-crew`. npm resolves `wicked-core-ts@^0.1`, which pulls
   the matching prebuilt platform package (the `.node`); the studio `dist/` ships inside the
   crew tarball. One install brings core-ts + studio transitively.
4. **Wire config** *(`[USER-GATED]` — writes to user's machine; prompt/confirm):*
   - Register estate as an MCP server in the detected CLI config
     (registry `mcpInstructions`).
   - Write `~/.wicked-crew/config.json` — daemon port (default + free-port probe), log
     level, and a **crew-owned DB path distinct from estate-MCP's** (§4.4 hazard).
   - Optionally register crew lifecycle events with wicked-bus (durable audit tap;
     DES-STUDIO-001 §1.3 notes the bus tap is optional/orthogonal).
5. **Verify** *(read-only)* — `wicked-estate --version`; `wicked-crew --version`;
   start `wicked-crew serve` and probe `GET /health` (DES-STUDIO-001 §2 — backed by
   `core.ping()`, also proves the event pump); confirm the MCP handshake.

### 5.3 Independent install paths (each product stands alone)

| Product | Standalone install | Runs without crew? |
|---|---|---|
| wicked-estate | `cargo install wicked-estate` **or** GitHub-release binary; register MCP manually | Yes — MCP server on its own |
| wicked-core-ts | `npm i wicked-core-ts` | Yes — native addon to embed the runtime in any Node app |
| wicked-crew | `npm i -g wicked-crew` → `wicked-crew serve` (auto-serves studio at daemon port; `wicked-crew start --ui` opens browser) | Yes — pulls core-ts + studio transitively |
| wicked-studio | (bundled in crew) — optional `npm i wicked-studio` for the built assets only | No — browser SPA needs the daemon to reach the addon (DES-STUDIO-001 §0) |

The composer is **additive sugar**, not a hard front door: nothing above requires the
installer; the installer just sequences + wires them.

---

## 6. Phased execution path

Legend: `[A]` = AUTONOMOUS (design / author CI files / dry-run / local build & commit);
`[G]` = USER-GATED (outward / irreversible).

| Phase | Step | Tag | Gate |
|---|---|---|---|
| **0. Freeze** | Ratify this doc; operator resolves the decision list (§7). | — | `[A]` doc / `[G]` decisions |
| **1. Author CI + patches (no push)** | (a) new `napi-release.yml` (reusable in wicked-ci or bespoke in wicked-core) — §2.3C. (b) wicked-crew `node-ci`/`node-release` callers + Renovate. (c) the §3 path→version flip as a staged patch. (d) `wicked-installer` registry entry + composed bundle. (e) migrate core-ts to `@napi-rs/cli` platform-package layout. | — | `[A]` |
| **1′. Dry-run everything** | `bash wicked-estate/scripts/publish.sh --dry-run`; `cargo build -p wicked-core-ts` locally; `npm pack` for crew/studio/core-ts/installer; render installer registry. | — | `[A]` |
| **2. KEYSTONE: estate → crates.io** | Precheck `CARGO_REGISTRY_TOKEN` secret in estate repo; version already `0.13.0`; tag `v0.13.0` → `publish.yml`. **Verify on crates.io.** IRREVERSIBLE. | `v0.13.0` | `[G]` |
| **3. Flip core deps** | Apply §3 patch; prove build against crates.io estate (move the local checkout aside); commit locally in wicked-core. | — | `[A]` |
| **4. Create wicked-crew repo** | `mikeparcewski/wicked-crew` (public, MIT + LICENSE — D3); push `lane/crew-on-core-ts`, set default branch; add npm publish auth + Renovate; decide old `wicked-studio` repo fate (D5). | — | `[G]` |
| **5. First native slice: core-ts → npm** | core-ts matrix CI builds per-platform `.node`; publish `wicked-core-ts` + platform packages. Depends on 2→3. IRREVERSIBLE. | `core-ts-v0.1.0` | `[G]` |
| **6. crew (+ studio) → npm** | Flip `packages/crew` core-ts dep `file:…` → `"^0.1"`; build+bundle studio dist into crew; publish `wicked-crew` (+ optional `wicked-studio`). Depends on 5. IRREVERSIBLE. | `v0.1.0` | `[G]` |
| **7. Installer composition** | Merge registry additions; bump + publish `wicked-installer`. Depends on 5,6. IRREVERSIBLE. | `v0.2.0` | `[G]` |

**First buildable slice / blocker order:** `2 → 3 → 5`. estate on crates.io (keystone)
unblocks the core flip, which unblocks a clean-checkout core-ts build, which produces the
first prebuilt `.node` on npm. Every JS artifact (crew, studio, installer) stacks on that.
Nothing above Phase 2 can be proven in CI until the keystone lands.

---

## 7. Decisions & actions requiring the operator

### 7.1 Decisions (resolve before/at Phase 0)

- **D1 — npm naming.** Recommend **unscoped** `wicked-crew` / `wicked-studio` (matches
  every sibling, `REQ-002 §6`, the installer registry, and node-release.yml). Requires
  editing `packages/crew/package.json:2` and `packages/studio/package.json:2` off
  `@wicked/*`. *Alt:* keep `@wicked/*` → then D6 (claim the org) is mandatory.
- **D2 — publish wicked-core to crates.io?** Recommend **NO** (consumed only via core-ts's
  static bundle; publishing means committing to a stable public Rust API, flipping the 12
  deps to bare-version, and gating on estate). *Alt (publish):* enables third-party Rust
  embedding of the runtime, but adds a release surface and API-stability burden with no
  current consumer.
- **D3 — wicked-crew repo config.** Recommend `mikeparcewski/wicked-crew`, **public**,
  **MIT** with a committed `LICENSE`. (Note: the wicked-core repo has **no LICENSE file**
  though `Cargo.toml:5` says MIT — fix that too if core-ts ships MIT to public npm.)
- **D4 — core repo privacy vs public npm artifact.** wicked-core is a **private** repo, but
  `wicked-core-ts` (public npm) ships its compiled bytes inside `index.node`. Confirm this
  is intended (binary distributed, source private) and that the npm package is MIT-licensed.
- **D5 — studio name collision.** Old `mikeparcewski/wicked-studio` (public, Rust/Tauri) vs
  new browser `packages/studio`. Recommend the new studio lives **inside wicked-crew**
  (bundled, not a separate repo) and the old Tauri repo is **archived/retired**; also update
  the stale `registry.json` `wicked-studio` entry (currently `desktop-binary` → the old repo).
- **D6 — claim the `@wicked` npm org** — only if D1 → scoped. Availability unknown.
- **D7 — installer convergence.** Recommend extend **wicked-installer**; clarify
  **wicked-loom**'s role (retire its install overlap, or scope it to compose/orchestration
  only).

### 7.2 Actions (all `[USER-GATED]`, irreversible/outward)

1. Create secrets: `CARGO_REGISTRY_TOKEN` (estate — precheck), npm automation token +
   GH-Packages auth (wicked-core for core-ts, wicked-crew, wicked-installer).
2. `cargo publish` estate 0.13.0 (tag `v0.13.0`) — **keystone, irreversible.**
3. Create GitHub repo `mikeparcewski/wicked-crew`; push + set default branch.
4. Archive/retire old `wicked-studio` repo (if D5).
5. `npm publish` `wicked-core-ts` + platform packages (tag `core-ts-v*`).
6. `npm publish` `wicked-crew` (+ optional `wicked-studio`) (tag `v*`).
7. `npm publish` `wicked-installer` bump.
8. Claim `@wicked` npm org (only if D1 → scoped).
9. (Installer runtime, per end-user machine) write MCP config + `~/.wicked-crew/config.json`
   — prompt/confirm before writing.

---

## 8. Open risks

- **napi cross-compile for `aarch64-unknown-linux-gnu`** needs a cross toolchain or
  `cargo-zigbuild` in CI — validate in Phase 1′ dry-run before relying on it in Phase 5.
- **estate 0.13 first-publish rate-limit / new-crate limits** — `publish.sh` is resumable
  and 429-aware, but any *new* crate names in 0.13 (vs 0.12) hit the ~1/10-min new-crate
  limit; budget time (per the release skill's gotchas).
- **Windows `.node` linking** — the `.cargo/config.toml` `dynamic_lookup` flag is
  macOS-only; confirm the Windows MSVC target links the addon in CI (napi-rs handles this,
  but the current hand-`cp` script does not).
- **Brand-new-repo tag race** (release skill gotcha) — on wicked-crew's first push, a tag
  pushed immediately after the branch can beat workflow registration; re-fire the tag.

---

## 9. Execution progress (live ledger)

> Supersedes stale recon in §1.4 / §7 as items are executed. `[A]` done autonomously;
> `[G]` still requires the operator's trigger.

### 9.1 Landed
- **F1 crash-resume blocker** fixed (`wicked-core@374accc`) + independently **re-reviewed PASS**
  (F1a/F1b closed via a shared `reconcile_terminal`; live path unchanged; 8/8 campaign IT).
- **wicked-core merged & public** `[A+G]`: `lane/estate-0.13-migration` fast-forwarded into
  `main` (`0771a40`, 10 commits: Campaign + terminal + core-ts + vendored crates), **MIT
  `LICENSE` added** (was missing — §1.4/D3/D4), pushed, and repo flipped **PRIVATE→PUBLIC**.
  → **D3 + D4 RESOLVED** (public repo, MIT, binary-distributed source-public).
- **D1 RESOLVED → unscoped.** On-disk package names are already `wicked-crew` (daemon,
  `bin: wicked-crew`), `wicked-studio`, root `wicked-crew-workspace` (`private:true`). The
  `@wicked/*` in §1.1 was pre-alignment. → **D6 (claim @wicked org) is now MOOT.**
- **wicked-crew repo EXISTS** — `mikeparcewski/wicked-crew`, **public**, default `main`,
  remote set (supersedes §1.4 "does not exist"). Still lacks `.github/workflows` + Renovate.
- **node-release.yml workspace-publish gap FOUND + FIXED** `[A]`: the reusable
  `publish-npm`/`publish-github-packages` jobs ran `npm publish` at the **repo root** — fine
  for every current (root-package) caller, broken for wicked-crew (private root, package at
  `packages/crew`). Added a backward-compatible **`publish_working_dir`** input (default `.`)
  on wicked-ci branch `feat/publish-working-dir` (`b429356`). §2.3D caller must set
  `publish_working_dir: packages/crew`. **Pending:** review → merge → **re-tag `v1`** so
  callers pinned `@v1` pick it up `[G]`.

### 9.2 In flight (background)
- **estate keystone CI unblock** `[A]` — fix `publish.sh` to skip `publish=false` crates
  (`wicked-estate-memory-api`) + diagnose/fix the red v0.13.0 CI gate. Precondition for
  Phase 2's `[G]` tag.
- **core-ts → `@napi-rs/cli` platform-package migration + bespoke `napi-release.yml`** `[A]`
  — §2.3C, on `wicked-core` branch `feat/napi-release-matrix`; host-target build + smokes
  validated in-sandbox, 4 cross-targets deferred to CI.

### 9.3 Sequenced operator triggers still owed (`[G]`, "I prep + trigger via CI")
1. **estate `v0.13.0`** → crates.io (KEYSTONE) — once 9.2 estate CI is green.
2. **`core-ts-v0.1.0`** → npm (after §3 path→version flip, which is gated on trigger 1).
3. **wicked-crew `v0.1.0`** → npm (after crew's `file:` core-ts dep → `^0.1`; needs the
   `v1` re-tag from 9.1).
4. **wicked-installer** bump → npm (registry entry for wicked-crew).

### 9.4 CRITICAL FINDING — publish=false blocker → Option B (supersedes §3 + reframes §0)

**Ground truth (verified via `cargo metadata`):** 7 estate crates are `publish = false`
(bench, knowledge, mcp, memory, memory-api, memory-core, overlay). **wicked-core depends on
3 of them** — `wicked-estate-memory`, `wicked-estate-memory-core`, `wicked-estate-knowledge`
— which estate never intends to publish (not even in `publish.sh`'s array). The §1.5 claim
"estate is publish-ready once tagged" holds only for its 8 *publishable* crates; the 3 above
can never come from crates.io. **The prior "estate 14/15 published" belief was wrong:** 19
publishable = 11 grammars + 8 estate crates; publish.sh (post-PR #38) skips memory-api + mcp.

**→ §3's path→version flip is IMPOSSIBLE and is CANCELLED.** You cannot add `version="0.13"`
to a dep that isn't on crates.io.

**→ Fix = Option B (two-repo checkout).** `napi-release.yml` checks out **wicked-core AND
wicked-estate side-by-side** (estate pinned to a ref, e.g. `v0.13.0`) and builds
`wicked-core-ts` via the existing relative path deps. The `.node` statically bundles the
compiled bytes → **no crates.io dependency at build or runtime** for the addon. Cost: a
2-repo checkout + a pinned estate ref (an honest, minor coupling; record the ref in the
`wickedBundles` manifest, §4.2). Applies to the §2.3C workflow.

**→ Reframes §0: the crew slice is DECOUPLED from the estate crates.io keystone.**
`wicked-core-ts → wicked-crew → wicked-installer` all build/ship from co-located source (the
installer uses the GitHub-release binary for estate-MCP, §5.2). **The estate crates.io
publish is a separate track** (estate-as-library, `cargo install`), no longer the blocker for
shipping crew. Revised crew-slice critical path: napi CI (Option B) → `core-ts-v*` npm →
crew `file:`→`^0.1` + `v1` re-tag → crew `v*` npm → installer.

**→ Open decision for the estate owner (does NOT block crew):** `wicked-estate-mcp` (flagship
MCP server) is `publish = false` and absent from crates.io. Intended (GitHub-release /
`cargo install --git`) or oversight? If it should be installable via `cargo install
wicked-estate-mcp`, remove `publish = false` from its manifest — publish.sh (PR #38) then
publishes it in order automatically.
