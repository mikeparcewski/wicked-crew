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
> real wicked-bus SQLite log and turns `wicked.run.requested` into a launch (cross-language round-trip
> verified, at-least-once with retry). The reducer + skill-provisioner **sidecars** (poll-loops with
> idempotent, correlation-aware handlers) run on it (`wicked-bus/examples/crew-sidecars`, smoke-verified).
> Wiring the bridge into the studio's browser feed is a follow-up.

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
