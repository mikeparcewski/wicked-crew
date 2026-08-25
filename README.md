```
          _      _            _
__      _(_) ___| | _____  __| |       ___ _ __ _____      __
\ \ /\ / / |/ __| |/ / _ \/ _` |_____ / __| '__/ _ \ \ /\ / /
 \ V  V /| | (__|   <  __/ (_| |_____| (__| | |  __/\ V  V /
  \_/\_/ |_|\___|_|\_\___|\__,_|      \___|_|  \___| \_/\_/
```

# wicked-crew

**The control room for governed agent delivery — drive, gate, and audit the work; the human stays in
command.**

wicked-crew is the **Govern** arc of the wicked loop (intent → steer → equip → *harness* →
**verify · govern** → record, all under human authority). You cannot stabilize the harness — the
coding agents and their models change constantly — so crew is the durable system *around* it: it runs
the coding-agent CLIs you already use (Claude Code, Codex, and others) as governed workers through
**durable, multi-agent workflows**, and you drive the run, the gates decide, and every decision is
audited. State your intent, get verified work out. The engine underneath is **wicked-core**.

Bring your own CLI and your own subscription — crew drives the agents *you* already pay for, on *your*
auth and *your* plan. There's no billing, no accounts, no model reselling.

Under the hood it's a daemon (`wicked-crew serve`) plus CLI and a same-origin browser console — but
the daemon is the **mechanism, not the pitch.** What you actually get: an evaluator that is
structurally not the creator (it can't self-grade), a deny-dominates dual gate, "done" **re-derived
from evidence** instead of asserted, and **workflows-as-data** you can add without touching code. crew
owns the phase lifecycle, the gates, the evidence, and the crash-safe state; the agent does
the coding inside a phase.

> **Local-first today.** Loopback only, in-process engine, local workers and local bus — no cloud, no
> accounts, nothing leaves your machine. The execution seam is built for a remote runner, but
> remote/distributed execution is **not shipped**: crew runs on a single host. No cluster, no
> horizontal scale.

## The idea

Spec-driven development promised rigor and delivered ceremony. wicked-crew goes for the **outcome
without the theater** — call it *intent-driven*: you state intent, and the orchestrator drives a
governed workflow to a verified result, harnessing the coding agents (and subscriptions) you already
pay for instead of replacing them.

- **You own the workflow; the agent owns the work.** The orchestrator sequences phases and holds the
  gates; the agent does the coding inside a phase.
- **Workflows are data.** feature / bug / migration ship built-in; new ones are drop-in JSON files, not
  code. (The engine — `wicked-core` — validates and drives them.)
- **Gates are real, not self-graded.** Every phase transition is governed **deny-dominates**, on a
  deterministic structural floor, with an independent evaluator seat that reads cold evidence only.
- **Evidence, not assertion.** "Done" is re-derived from evidence at the gate, never claimed by the
  agent that did the work.
- **Drive it your way.** Headless over CLI + REST/WS, or through the browser console.

## The governed lifecycle

One run token moves through the workflow's phases with a gate between every one — e.g. for `feature`:

```
clarify → design → build → adversarial-review → test → review
   │gate     │gate    │gate         │gate          │gate    │gate
```

Each phase is executed by a **skill** (a fixed, versioned capability contract) invoked on the assigned
CLI — consistent control instead of an ad-hoc prompt every run. Phases, gates, roles, and the skill a
phase runs are all **data** on the workflow definition.

## Gates: generated, grounded, dual validators *(built — `wicked-core`, DES-EXEC-001 rev0.4)*

> **Built + live-verified** in the [`wicked-core`](../wicked-core) engine: a test-strategy skill authors
> a grounded deterministic check (`provision-validator`), a human/council approves it (`approve-validator`,
> distinct content-hash pin), and the gate re-verifies that pinned script against the worktree
> (deny-dominates, no LLM at gate time) alongside an independent agent judge that can reject but never
> lone-approve. The security controls (approval gate, fail-closed parse, denylist) survived a 14-finding
> adversarial review. **Caveat:** the shipped feature/bug/migration workflows ship *ungated*
> (`validator_pin: null`) — a phase engages the gate only once an operator authors, approves, and pins a
> validator into the def.

The deterministic gate check is not a generic precanned assertion. A **test-strategy agent authors a
grounded validation script** for that specific phase/task — stored as the phase's **evidence
evaluator**, versioned and approved; when the spec changes the script is regenerated and re-approved, so
validation always tracks the spec. The evaluator is a **complementary pair**:

- a **deterministic** validator (structural/factual: files, config keys, doc sections, code shape,
  patterns — auditable, cheap), and
- an **agent-based** validator (semantic judgment: does this meet the *intent*?).

*(As built, the agent validator now runs under a **genuinely distinct council seat** — identity-distinct
from both the deterministic-validator author and the work author, by resolved binary (no self-grading),
with a single-runner fallback when the roster is too small. An adversarial review caught an early
self-grade hole here — the judge excluded the wrong author — since fixed and dispatch-proven.)*

Combined so that **Approve requires the deterministic piece to PASS; the agent piece can REJECT but is
never the sole approver** — a model may fail a gate, never solely approve one.

**Trust model, named honestly:** diverse-seat agent consensus, on a deterministic structural floor, with
human escalation above a threshold. A green run means "diverse seats + the escalation policy agreed,"
not "proven."

## Event-driven, with sidecars *(built substrate — DES-EXEC-001 §2/§4.2)*

Components publish and subscribe; they don't call each other. Standard event types (`wicked.*`) mean you
can attach **sidecars** — audit, extra processing, skill provisioning/refresh — to any workflow without
touching it.

> **Built:** the `wicked-core` engine has a Rust↔`wicked-bus` bridge (`src/bus.rs`) — it emits/polls the
> real wicked-bus SQLite log and turns `wicked.crew.run.requested` into a launch (cross-language round-trip
> verified, at-least-once with retry). The reducer + skill-provisioner **sidecars** (poll-loops with
> idempotent, correlation-aware handlers) run on it (`wicked-bus/examples/crew-sidecars`, smoke-verified).
> Wiring the bridge into the studio's browser feed is a follow-up.

## Third-party CLI terms of service

Crew drives the coding-agent CLIs you install, under your own accounts and subscriptions.
**It is your responsibility to confirm that driving a given CLI programmatically is
permitted by its terms of service.** In particular, community reports suggest that
driving **Antigravity (`agy`)** headless/programmatically may conflict with its ToS —
review Google's current terms before enabling that seat, and remove it from your roster
if in doubt. The engine works identically with any subset of the roster.

## Crew is the control plane; the studio is its own product

Since the #98 carve, the studio SPA lives in its own repo —
[**wicked-studio**](https://github.com/mikeparcewski/wicked-studio), the coder-facing skin of the
experience plane. Crew keeps the control-plane function: the daemon, the `/api/v1` REST surface,
the `/ws` CoreEvent stream, and the wicked-core engine underneath. The two share exactly one
thing: the published wire contract (`packages/crew-api-types`, npm: `wicked-crew-api-types`),
which studio consumes as a normal dependency. No source coupling in either direction.

Crew still ships a default skin. `packages/crew` declares `wicked-studio` as a devDependency
whose package carries only its built `dist/`; the release build copies that artifact into the
daemon's serving tree, so `npx wicked-crew serve` keeps the one-command local UX.

## A project is a context: one code graph over all its repos *(0.7.0)*

Real work spans repos. A change in an engine lands in the daemon that embeds it and the console
that renders it, and an agent that can only see one of them answers "not found" about the other two
— confidently, because a per-repo graph has no way to know it was asked about something outside
itself.

Attach repos to a project as `crew.repo` members and build one **co-located** wicked-estate graph
over all of them:

```bash
curl -X POST localhost:7701/api/v1/projects/$PID/members \
     -H 'content-type: application/json' -d '{"kind":"crew.repo","ref":"wicked-studio"}'
curl -X POST localhost:7701/api/v1/projects/$PID/graph/refresh   # indexes each member, once
```

| route | answers |
|---|---|
| `GET /projects/:id/graph` | what the graph holds, and for anything missing: why, and the remedy |
| `GET /projects/:id/graph/search?name=` | symbol resolution across every member repo |
| `GET /projects/:id/graph/blast-radius?name=` | dependents across every member repo |
| `POST /projects/:id/graph/refresh` | (re)index members — never happens implicitly at launch |

Every hit is attributed to the repo it came from, and results span languages: one query for
`register` over studio + crew + core returns TypeScript and Rust hits together, counted per repo.

**Co-located is not linked.** Each repo is indexed under its own label and edges do **not** resolve
across repos — `studio → wicked-crew-api-types → crew` does not traverse. What you get is per-repo
results gathered into one answer with the repo named on every hit, which is genuinely useful
("who calls `record`, anywhere in this project") and is not a cross-repo dependency trace. Every
response says so in a `linkage: "co-located"` field and a `note`, so a consumer cannot mistake one
for the other.

**Runs bind to it, and say when they don't.** A run filed into a project is handed the project graph
instead of its own repo's, and the decision is recorded either way — "this run sees the project" and
"this run sees one repo, because X" are both facts about what the run could observe, and the second
is the one you need when a worker reports a sibling repo does not exist:

```
run 909db7fb: bound to the project graph as 'wicked-studio'.
run 0df7fb33: repo 'wicked-garden' is not a crew.repo member of project proj_1787…, so the project
              graph does not describe it; this run uses the repo's own code graph. Attach it with
              POST /api/v1/projects/proj_1787…/members and refresh the graph to widen future runs.
```

A refresh is `wicked-estate index` per member, bounded at ten minutes **each**, so it is never
implicit: a launch that silently indexed N repos would block the response for as long as the
slowest one takes. A missing or stale graph degrades the run to the per-repo graph and says so.

Requires `wicked-estate` ≥ 0.14.6 (the release that added `--repo` co-location) and `wicked-core-ts` ≥ 0.7.1.
Both are capability-probed before anything is indexed: an older estate accepts `--repo`, **ignores
it**, and exits 0, which would silently produce a database holding only the last repo indexed.

## Building from source: two build modes

| mode | command | what you get |
|---|---|---|
| **default (dev)** | `npm run -w packages/crew build` | plain `tsc` — the daemon only. Without a bundle at `dist/studio` it serves **headless API + WS** and logs that it is doing so. |
| **release-shaped** | `npm run -w packages/crew build:with-studio` (or `npm run build:with-studio` at the root) | `tsc` + `scripts/bundle-studio.mjs`, which copies the installed `wicked-studio` package's `dist/` → `packages/crew/dist/studio/` — the daemon then serves the SPA same-origin, exactly what the published npm tarball ships (`files: ["dist"]`). |

CI and the release workflow run `build:with-studio`, so **npm consumers still get the studio UI
inside `wicked-crew`** — the carve changes where the UI lives and the dependency direction
(control plane ships a dist artifact), not the shipped experience.

To work on the studio, clone [wicked-studio](https://github.com/mikeparcewski/wicked-studio) and
run its dev server against a local daemon (vite on :4200 → `VITE_API_HOST=127.0.0.1:7701`,
CORS-allowed for any loopback origin). Its `e2e/studio_standalone_test.py` is the scripted proof
of the standalone mode, driven against this repo's built daemon.

Shared types live in `packages/crew-api-types` — a types-only (zero-runtime) workspace package
defining every `/api/v1` + `/ws` wire shape, published to npm as `wicked-crew-api-types` and
versioned independently of the daemon. The daemon's route layer imports the workspace copy and
studio pins the published contract; `packages/crew/tests/wire-contract.test.ts` fails the
typecheck if the daemon's responses ever stop satisfying it.

## Where things are

- `.product/` — requirements, design, and evidence:
  - `REQ-001-application-overview.md`, `DES-001-technical-design.md`
  - `DES-CAMPAIGN-001-parallel-scheduler.md`, `DES-STUDIO-*`, `DES-TERMINAL-001`, `DES-RELEASE-001`
- **The execution engine is [`wicked-core`](../wicked-core)** — the single-writer runtime that owns the
  workflow-as-data model, data-driven planning, skills-driven invocation, and the gate ladder. See
  `wicked-core/.product/DES-EXEC-001-event-driven-workflow-execution.md` for the engine design (the two
  laws, the gate model, the skills seam).
- `site/` — the wicked-crew site (wc.wickedagile.com).

## Status

Active build. **Built + verified in `wicked-core`** (each layer adversarially reviewed): workflows-as-data
→ data-driven planning → per-phase gate + role/artifact-passing → skills-driven invocation → the
dual-validator gate (author→approve→pin→re-verify) → the validator vault → the Rust↔wicked-bus bridge →
a napi bridge (`../wicked-core-ts`). Remaining: wiring the napi addon into the studio UI, an OS sandbox
around validator execution, and (honestly) the shipped workflows gate only once an operator pins a
validator. See `wicked-core/README.md` for the per-layer status.
