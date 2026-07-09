# wicked-crew

**Own the workflow. Not the work.**

wicked-crew is a standalone **external orchestrator** — a daemon plus CLI (and a browser console it
serves same-origin on localhost) — for governed, multi-phase AI development. It runs **above** your
coding agents, never inside them: it treats AI CLIs (Claude Code, and others) as stateless worker
subprocesses while *it* owns the phase lifecycle, the gates, the evidence, and the crash-safe state.

Local-first. No cloud, no accounts.

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

## Gates: generated, grounded, dual validators *(design — DES-EXEC-001 rev0.4)*

> **Today** a gate is the deterministic, deny-dominates check (no model on the gate path). The model
> below is the designed evolution — generated grounded validators — not yet shipped.

The deterministic gate check is not a generic precanned assertion. A **test-strategy agent authors a
grounded validation script** for that specific phase/task — stored as the phase's **evidence
evaluator**, versioned and approved; when the spec changes the script is regenerated and re-approved, so
validation always tracks the spec. The evaluator is a **pair authored by two independent strategists**:

- a **deterministic** validator (structural/factual: files, config keys, doc sections, code shape,
  patterns — auditable, cheap), and
- an **agent-based** validator (semantic judgment: does this meet the *intent*?).

Combined so that **Approve requires the deterministic piece to PASS; the agent piece can REJECT but is
never the sole approver** — a model may fail a gate, never solely approve one.

**Trust model, named honestly:** diverse-seat agent consensus, on a deterministic structural floor, with
human escalation above a threshold. A green run means "diverse seats + the escalation policy agreed,"
not "proven."

## Event-driven, with sidecars

Components publish and subscribe; they don't call each other. Standard event types (`wicked.*`) mean you
can attach **sidecars** — audit, extra processing, skill provisioning/refresh — to any workflow without
touching it. Skills the engine needs are provisioned by event (`wicked.skill.needed` / `.refresh` →
`.ready`), never a synchronous fetch.

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

Active build. The engine spine (workflows-as-data → data-driven planning → skills-driven invocation) is
built and tested in `wicked-core`; the gate mechanism (generated dual validators), the event bus seam,
and the studio bridge are designed and in progress. See `wicked-core/README.md` for the engine's
per-layer status.
