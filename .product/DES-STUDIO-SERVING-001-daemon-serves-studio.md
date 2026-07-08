---
name: DES-STUDIO-SERVING-001-daemon-serves-studio
title: The wicked-crew daemon builds, bundles, and serves the studio SPA — Technical Design
status: draft
version: 0.1
date: 2026-07-08
author: mike.parcewski@gmail.com
review-required: true
target-release: wicked-crew v0.2.0
depends-on:
  - DES-STUDIO-001 (crew daemon + studio on core-ts) — §0 the one architectural fact
  - DES-RELEASE-001 (release / distribution) — §2.3D, §3
  - wicked-ci node-release.yml (build_cmd / publish_working_dir inputs)
relates-to:
  - packages/crew/src/api/server.ts (current Fastify server — CORS-only, serves no assets)
  - packages/studio (Vite React SPA)
supersedes-scope: DES-STUDIO-001 left "daemon serves the dist" as an asserted goal (§0, DES-RELEASE-001 §2.3D) without a mechanism; this design specifies it.
---

# DES-STUDIO-SERVING-001 — The daemon serves the studio SPA

> **Scope of this doc:** design + plan only. No implementation. It specifies how
> **wicked-crew v0.2.0** turns the currently-headless daemon (v0.1.1) into one that
> **builds, bundles, and serves** the `packages/studio` React SPA on its own port.

---

## 0. Status quo (what v0.1.1 ships)

- **Daemon** (`packages/crew`, published `wicked-crew@0.1.1`) is **headless**. Its
  Fastify server (`packages/crew/src/api/server.ts`) exposes exactly three surfaces:
  `/api/v1/*` (REST, `api/routes.ts`), `/ws` (CoreEvent fan-out, `events/bus.ts`), and
  `/ws/terminals/:id` (per-PTY channel, `events/terminals.ts`). **It serves no static
  assets.** The only concession to the browser UI is a CORS `onRequest` hook that
  reflects loopback origins (`LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/`)
  so a *separately hosted* studio (Vite dev server on `:4200`) can call the API
  cross-origin.
- **Studio** (`packages/studio`, `wicked-studio@0.1.0`, **not published**, `files`/`bin`/`main`
  all absent per DES-RELEASE-001 §1.1) is a Vite React SPA. It builds to a static
  `packages/studio/dist/` (`vite build`; verified output = `dist/index.html` +
  `dist/assets/index-*.js` + `dist/assets/index-*.css`). Today it is only run via
  `vite` on `:4200` in dev, or `vite preview`.
- **The API base is hardcoded.** `packages/studio/src/api/client.ts` pins
  `const HOST = '127.0.0.1:7701'` for both REST (`http://${HOST}/api/v1`) and the
  terminal WS (`ws://${HOST}/ws/terminals/:id`). So today the browser always talks to
  `127.0.0.1:7701` regardless of where the SPA itself is served from.
- **Release wiring** (`.github/workflows/release.yml`) calls wicked-ci
  `node-release.yml@v1` with `publish_working_dir: packages/crew`,
  `build_cmd: 'npm install && npm run -w packages/crew build'`, and crew's
  `files: ["dist"]`. So the published tarball contains **only** `packages/crew/dist`.
  Nothing builds or bundles the studio — the four "PREREQUISITES" comments at the top
  of `release.yml` explicitly flag "crew bundles the built studio dist" as **not yet done**.

**Gap:** DES-STUDIO-001 §0 and DES-RELEASE-001 §2.3D both *assert* "the daemon serves
the SPA" as the shipping model, but no build step produces the bundle, no `files` entry
carries it, and no route serves it. This design closes that gap.

---

## 1. Why the daemon must be the one to serve it (not a static host / CDN)

Straight from **DES-STUDIO-001 §0** — *the one architectural fact everything hangs off*:

> The browser **cannot** call the napi addon. `wicked-core-ts` is a native cdylib
> (`index.node`) `require()`d by a Node process. **The daemon is the only process that
> holds the `Core` handle.**

Consequences for serving:

1. The SPA is **useless without a co-located daemon** — every screen is a thin view over
   a `/api/v1` call or a `/ws` frame, all of which terminate at the `Core` handle the
   daemon alone owns. There is no "static-host the studio on Netlify" option: a CDN copy
   would have nothing to talk to.
2. The **simplest correct topology is same-origin**: the daemon that owns `Core` also
   serves the bytes of the UI that drives `Core`. One process, one port, one origin —
   no CORS, no second server to start, no port coordination for the operator.
3. **Dev stays split** (unchanged): `packages/studio` runs `vite` on `:4200` for HMR and
   fast iteration, and the daemon's existing loopback-CORS hook keeps letting it call
   `:7701` cross-origin. **Prod = daemon-served** same-origin on `:7701`. This is the
   split DES-RELEASE-001 §2.6/§4 already describes (`wicked-crew serve` auto-serves the
   studio at the daemon port; `--ui` opens a browser).

**Non-goal:** shipping `wicked-studio` as an independently *runnable* package. Per
DES-RELEASE-001 §1.1 / §2.3D it may still be published as an assets-only convenience
package, but it is not runnable standalone (no daemon = no `Core`). The bundle inside the
crew tarball is the canonical artifact.

---

## 2. Build wiring — getting the studio `dist` into the crew package

### 2.1 The constraint that picks the option

`node-release.yml` runs `build_cmd` **at repo root with full dev deps** (fresh
`npm install`), then runs `npm publish` **from `publish_working_dir: packages/crew`**.
`npm publish` only tars what `packages/crew`'s `files` glob resolves to. Therefore the
studio bytes must physically live **under `packages/crew/`** at publish time, and the
`files` list must name them. Everything below is downstream of that fact.

### 2.2 Options considered

**Option (a) — crew build also builds studio, then copies `dist` into the crew package.**
`packages/crew`'s build script (or a small `prebuild`/`postbuild` step) runs
`npm run -w packages/studio build` and copies `packages/studio/dist` →
`packages/crew/dist/studio/`. `packages/crew` `files` adds `dist` already covers it
(the copied `studio/` is under `dist/`), so no `files` change is even required if we
nest under `dist/`. Release `build_cmd` needs the studio build added.

- **Pros:** one published package (`wicked-crew`), one version, zero new npm coordinates,
  no dependency resolution at install time for the UI, matches DES-RELEASE-001's stated
  "bundled into the crew tarball" model (§2.3D, §1.5 diagram line 180). The daemon reads
  assets from a path relative to its own `dist/` — trivial and offline.
- **Cons:** a cross-workspace copy step in the build (needs to be cross-platform —
  Node `fs.cp`, **not** a `cp -r` shell line, per the repo's cross-platform rule).
  Studio version is implicit (folded into crew's version).

**Option (b) — publish `wicked-studio` as a separate package the daemon depends on.**
`packages/studio` gets `files`/`main` pointing at its `dist`; `wicked-crew` adds
`"wicked-studio": "^0.2"` as a **runtime dependency**; the daemon resolves the asset
dir via `require.resolve('wicked-studio/dist/index.html')`.

- **Pros:** independent studio versioning; the assets are reusable by any future consumer;
  cleaner separation.
- **Cons:** two packages to publish and keep version-locked on every release; a runtime
  `dependencies` entry that ships in the tarball (today crew's runtime deps are only
  fastify/ws/core-ts/zod); install-time resolution risk; contradicts DES-RELEASE-001 §2.3D
  ("Publishing `wicked-studio` standalone is optional… not independently runnable"). More
  moving parts for zero operator-visible benefit at v0.2.0.

### 2.3 Recommendation — **Option (a)**, copy studio `dist` into `packages/crew/dist/studio/`

Rationale: it is the minimal change that satisfies the same-origin serving model, keeps a
single published artifact, and aligns with what DES-RELEASE-001 already promises. Revisit
Option (b) only if/when a second consumer of the built studio appears.

**Concrete build shape (for the implementer, v0.2.0):**

1. Add a **copy helper** to the crew build. Preferred: a tiny Node script
   `packages/crew/scripts/bundle-studio.mjs` invoked from crew's `build` script, e.g.
   `"build": "tsc -p tsconfig.json && node scripts/bundle-studio.mjs"`. The script:
   - resolves `packages/studio/dist` (repo-root-relative), asserting it exists
     (fail loudly if the studio wasn't built first — see wiring below);
   - `fs.rmSync(dest, { recursive: true, force: true })` then
     `fs.cpSync(studioDist, 'packages/crew/dist/studio', { recursive: true })`.
   - Cross-platform: pure Node `fs`, no shell `cp`/`rm` (repo rule).
2. **Local/dev build ordering.** `packages/crew build` must run *after* `packages/studio
   build`. Two acceptable wirings:
   - root `build` script already does `npm run build --workspaces`; workspace order runs
     studio before crew if listed first in `workspaces` (it is: `packages/crew` is first —
     so **reorder** to `["packages/studio","packages/crew"]`, or)
   - make crew's bundle step *itself* build studio: `bundle-studio.mjs` runs
     `npm run -w packages/studio build` before copying (robust regardless of order).
     **Recommended** — self-contained, order-independent.
3. **Release wiring** (`.github/workflows/release.yml`): extend `build_cmd` from
   `'npm install && npm run -w packages/crew build'` to **also build studio first**:
   `'npm install && npm run -w packages/studio build && npm run -w packages/crew build'`
   (or rely on the self-contained bundle step from (2) and leave build_cmd as the single
   crew build). Because `build_cmd` runs at repo root with full dev deps, `vite` is
   available — the studio build works in CI exactly as locally.
4. **`packages/crew` `files`**: nesting the assets under `dist/studio` means the existing
   `"files": ["dist"]` **already includes them** — no change needed. (If the implementer
   instead chooses a top-level `static/` dir, `files` must add `"static"`.) Nesting under
   `dist/` is preferred precisely to avoid touching `files` and to keep one tree.
5. **`.gitignore`**: `packages/crew/dist/` is (and stays) gitignored/build-output — the
   studio bundle is a build artifact, never committed. `npm pack --dry-run` from
   `packages/crew` is the acceptance check that the tarball contains `dist/studio/index.html`.

---

## 3. Serving — Fastify static + SPA fallback alongside the existing API

### 3.1 Mechanism

Add **`@fastify/static`** (new runtime dependency of `packages/crew`, Fastify v5-compatible
major) registered in `createServer()` (`packages/crew/src/api/server.ts`), rooted at the
bundled asset dir. Resolve the root relative to the compiled server module, e.g.
`fileURLToPath(new URL('../studio', import.meta.url))` from `dist/api/server.js` →
`dist/studio` (matches the copy target in §2.3). Guard with an existence check so a
dev/headless run without a bundle degrades gracefully (log a warning, skip registration)
rather than crashing.

### 3.2 Route precedence (critical — must not shadow the API)

Registration order and matching rules must guarantee **`/api/v1/*`, `/ws`, and
`/ws/terminals/:id` keep winning**:

1. Register the **API routes, `/ws`, and terminal WS first** (as today).
2. Register `@fastify/static` with `wildcard: false` so it does **not** greedily claim
   every path; it serves files that exist under root (`/`, `/assets/*`, `/favicon`, etc.).
3. Add an explicit **SPA fallback** via `setNotFoundHandler`: for a **GET** whose path is
   **not** under `/api/` and **not** under `/ws`, reply with `dist/studio/index.html`
   (200, `text/html`) so client-side routes (deep links) resolve. For anything else
   (unknown `/api/**`, non-GET), preserve the normal 404/JSON behavior.

   ```
   if (req.method === 'GET'
       && !req.url.startsWith('/api/')
       && !req.url.startsWith('/ws')) {
     return reply.type('text/html').sendFile('studio/index.html'); // SPA shell
   }
   return reply.code(404).send({ error: 'not found' });             // API/other
   ```

4. The existing CORS `onRequest` hook is **untouched** and becomes a **no-op for
   same-origin** requests (no `Origin` header on same-origin navigations; the reflected
   headers simply aren't needed). It still serves the dev `:4200` split. No conflict.

### 3.3 Interaction with `/ws` and terminal WS

`@fastify/static` only handles HTTP GET for files; the WebSocket upgrade routes
(`/ws`, `/ws/terminals/:id`) are registered by `@fastify/websocket` and match on the
upgrade handshake, which static serving never intercepts. The `!startsWith('/ws')` guard
in the not-found handler is belt-and-suspenders for any non-upgrade GET to those paths.

### 3.4 Same-origin implication for the hardcoded API base

Because the SPA is now served from the **same origin** it calls (`127.0.0.1:7701`),
`client.ts`'s hardcoded `HOST = '127.0.0.1:7701'` **happens to be correct in prod** — but
it is brittle (breaks the moment the daemon binds a different port via `--port`/`CREW_PORT`,
which the CLI already supports, `cli/index.ts parseBootstrap`). See §4.2 for the resolution.

---

## 4. Config / versioning

### 4.1 Studio `base` path

Serve at the **origin root `/`**. Set Vite `base: '/'` (the current implicit default; the
built `dist/index.html` already emits absolute `/assets/...` URLs — verified). Since the
daemon serves the SPA at the daemon root and the API lives under the `/api/v1` **path**
(not a subpath-mounted SPA), `base: '/'` is correct and needs no change. **Do not** move
the SPA under a `/studio/` subpath — it would force a `base` change and complicate the
fallback for no benefit.

### 4.2 API base URL resolution (same-origin vs the dev :4200 split)

Replace the hardcoded `HOST` in `client.ts` with an **origin-aware resolver** so the same
build works both daemon-served (same-origin) and in the dev split:

- **Prod / daemon-served:** derive from `window.location` → REST base
  `` `${location.origin}/api/v1` ``; WS base `` `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` ``.
  This makes `--port` / `CREW_PORT` "just work" and removes the brittle `7701` literal.
- **Dev (:4200 split):** an env override, `import.meta.env.VITE_API_HOST` (Vite env), lets
  the `:4200` dev server point REST/WS at `127.0.0.1:7701`. A `.env.development` in
  `packages/studio` sets `VITE_API_HOST=127.0.0.1:7701`; when unset (prod build) the
  resolver falls back to `window.location`.
- This is the **only studio source change** the serving work strictly requires; it is small
  and testable in isolation (see §6). It also lets the existing loopback-CORS hook keep
  covering exactly the dev case and nothing more.

### 4.3 Cache headers

- **Hashed assets** (`/assets/index-<hash>.js|css`) are content-addressed → serve with
  `Cache-Control: public, max-age=31536000, immutable`. `@fastify/static` can set this via
  a `setHeaders`/`maxAge` for the `assets/` prefix.
- **`index.html` (and the SPA fallback)** must be **non-cached** (`Cache-Control: no-cache`)
  so a redeploy's new asset hashes are picked up immediately. This is the standard
  hashed-assets-immutable + no-cache-HTML pattern.

### 4.4 Version semantics — **v0.2.0** (minor)

- Additive, backward-compatible feature (headless daemon → daemon-that-also-serves-UI);
  no API break; existing `/api/v1` + `/ws` contracts unchanged. → **minor** bump: `0.1.1 → 0.2.0`.
- Bump all three `version_dirs` in lockstep (root, `packages/crew`, `packages/studio`) as
  the release workflow already does. Studio version tracks crew (Option (a): studio isn't
  independently published/runnable).
- New runtime dep `@fastify/static` and (removal-eligible) tightening of the CORS hook are
  minor-appropriate. Update the four PREREQUISITES comments at the top of `release.yml`
  (prereq #4 "crew bundles the built studio dist" is satisfied by this work).

---

## 5. Acceptance criteria (SMART)

Given a clean checkout of the v0.2.0 candidate:

- **AC-1 (build produces the bundle).** Running `npm run -w packages/crew build` from repo
  root (after `npm install`) results in `packages/crew/dist/studio/index.html` and
  `packages/crew/dist/studio/assets/*.js` + `*.css` existing on disk. *Measure:* those
  paths are present; the build exits 0.
- **AC-2 (tarball carries the bundle).** `npm pack --dry-run` in `packages/crew` lists
  `dist/studio/index.html` and at least one `dist/studio/assets/*` file. *Measure:* grep
  the pack file list.
- **AC-3 (root serves the SPA shell).** With the daemon running (`wicked-crew serve
  --stub`), `GET http://127.0.0.1:7701/` returns HTTP 200, `Content-Type: text/html`, and
  a body containing `<div id="root">` and the hashed `/assets/index-*.js` script tag.
- **AC-4 (deep-link fallback).** `GET http://127.0.0.1:7701/runs/does-not-exist` (an
  arbitrary non-API, non-ws client route) returns HTTP 200 with the **same** `index.html`
  shell (SPA fallback), **not** a 404.
- **AC-5 (API untouched).** `GET http://127.0.0.1:7701/api/v1/health` still returns the
  JSON health payload (`{status, version, ping}`); an unknown API route
  (`GET /api/v1/nope`) still returns a **404 JSON** (not the HTML shell).
- **AC-6 (assets cached, HTML not).** A response for `/assets/index-*.js` carries
  `Cache-Control: …immutable`; the response for `/` and for the fallback carries
  `Cache-Control: no-cache`.
- **AC-7 (same-origin API base).** A production studio build served by the daemon issues
  its REST/WS calls to the **serving origin** (no hardcoded `7701` literal in the shipped
  bundle) — verified by starting the daemon on a non-default port (`--port 7788`) and
  confirming the loaded SPA calls `/api/v1/*` on `:7788`.
- **AC-8 (dev split still works).** `npm run -w packages/studio dev` on `:4200` with
  `VITE_API_HOST=127.0.0.1:7701` still reaches the daemon (loopback CORS hook path),
  proving the split-dev workflow is intact.
- **AC-9 (existing suites green).** `npm run -w packages/crew test` (currently 16) and
  `npm run -w packages/studio test` (currently 50) still pass, plus the new serving tests
  below.

## 6. Test plan (short)

1. **Static-serving integration (crew, vitest + fastify.inject / undici).** New test file
   `packages/crew/tests/integration/studio-serving.test.ts`:
   - fixture: point the static root at a tiny temp `studio/` dir (index.html + one asset)
     so the test doesn't depend on a real vite build;
   - `GET /` → 200 text/html, body contains the shell marker → **AC-3**;
   - `GET /some/deep/route` → 200, identical shell → **AC-4**;
   - `GET /api/v1/health` → 200 JSON; `GET /api/v1/nope` → 404 JSON → **AC-5**;
   - assert `Cache-Control` on an `/assets/*` GET vs `/` GET → **AC-6**.
2. **API-base resolver unit test (studio, vitest + jsdom).** Test the `client.ts`
   resolver: with `window.location` on `:7788` and no `VITE_API_HOST` → base is
   `http://127.0.0.1:7788/api/v1`; with `VITE_API_HOST` set → dev override wins → **AC-7/8**.
3. **Build/pack smoke (CI or local script).** `npm run -w packages/crew build` then
   `npm pack --dry-run` asserts `dist/studio/index.html` in the file list → **AC-1/2**.
4. **Manual `serve` walk-through** (documented in the PR): `wicked-crew serve`, open
   `http://127.0.0.1:7701/`, confirm the app loads and drives a stub run end-to-end.

---

## 7. Risks / open questions

- **R1 — `@fastify/static` + `@fastify/websocket` route interplay.** Low risk (static is
  HTTP-only, ws is upgrade-only), but the not-found handler must be registered after both;
  covered by AC-4/AC-5 tests. Pin `@fastify/static` to its Fastify-v5 major.
- **R2 — build order fragility.** Mitigated by the self-contained bundle step (§2.3 step 2)
  that builds studio itself; the CI `build_cmd` change is belt-and-suspenders.
- **R3 — stale `HOST` literal left in a shipped bundle.** AC-7 (non-default-port run) is the
  guard; the resolver change (§4.2) is mandatory, not optional.
- **Q1 — publish `wicked-studio` assets package too?** Deferred; not required for v0.2.0
  (Option (b) rejected). Revisit if a second consumer appears.
- **Q2 — HTTPS/remote serving?** Out of scope — daemon binds loopback only (DES-STUDIO-001
  §0, server.ts). The `wss` branch in §4.2 is future-proofing, not a v0.2.0 requirement.
