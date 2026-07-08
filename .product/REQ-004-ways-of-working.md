---
name: REQ-004-ways-of-working
title: wicked-crew — Ways of Working
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
---

# REQ-004 — Ways of Working

## 1. Development Philosophy

The same philosophy this product enforces in its users applies to how we build it:

- **Define → Design → Test Strategy → Build → Test**. Each phase gate must produce evidence and pass adversarial review before the next phase starts.
- **Research before building.** Any component where an existing OSS solution exists gets a research finding document before design begins. We do not build what already exists.
- **DoD is a working app.** Passing tests is necessary but not sufficient. The DoD gate requires end-to-end behavior verification.
- **Adversarial reviews at every phase gate.** A review is not complete until a reviewer specifically looking for failures has run and found no critical issues.

---

## 2. Phase Gate Process

Each of these phases must pass before the next begins:

### Define (this set of documents)
- **Produces**: REQ-001..005, RAID.md
- **Gate type**: adversarial review (independent reviewer)
- **Gate criteria**: No unresolved CRIT or SIG findings. All success criteria are measurable. Domain model is internally consistent.

### Design
- **Produces**: DES-001 (technical design), API spec, SQLite schema, phase FSM diagram, worker protocol spec
- **Gate type**: adversarial review
- **Gate criteria**: No CRIT/SIG findings. Design covers all REQ-001 success criteria. Architecture is implementable without research blockers.

### Test Strategy
- **Produces**: TEST-001 (test strategy document) with scenarios per success criterion
- **Gate type**: adversarial review + testability review
- **Gate criteria**: Every SC-001..SC-008 has at least one executable scenario. No scenario is unmeasurable.

### Build
- **Produces**: Working code with evidence (build logs, test runs, lint)
- **Gate type**: adversarial diff review + continuous quality review
- **Gate criteria**: All unit + integration tests pass. No lint warnings. wicked-testing acceptance pipeline PASS.

### Test (DoD)
- **Produces**: End-to-end evidence (working app demo evidence, wicked-testing verdict)
- **Gate type**: working app verification (not just test suite)
- **Gate criteria**: All SC-001..SC-008 verified against running software with recorded evidence.

---

## 3. Adversarial Review Protocol

Each adversarial review follows this protocol:

1. **Reviewer receives**: the phase artifact(s) only. No implementation context, no conversation history.
2. **Reviewer role**: explicitly looking for failures, gaps, inconsistencies, and missing coverage. Not looking for approval.
3. **Findings format**: `[CRIT | SIG | MIN] finding description`. CRIT = blocks gate. SIG = must address before gate. MIN = should address, non-blocking.
4. **Resolution**: Each CRIT and SIG must be resolved with a written response before re-review.
5. **Minimum rounds**: 1 round. More rounds if CRITs or SIGs found.
6. **Evidence**: Review findings + resolutions recorded in `.product/evidence/`.

---

## 4. Build Phase Conventions

When build begins:

- **Per-component commits**: Each logical component (daemon HTTP server, FSM, governance engine, worker dispatch, studio UI, etc.) gets its own commit.
- **No big-bang commits**: Do not commit 500 lines at once. Build in layers with runnable checkpoints.
- **Test as you go**: Each component has passing tests before moving to the next.
- **Quality gate active from day 1**: Lint and type-check run on every commit.
- **Worker integration test pattern**: Use a fixture worker (`echo '{"status":"done"}'`) as the default worker in tests. Never mock the subprocess layer — spawn real subprocesses.

---

## 5. What "Working App" Means

DoD for wicked-crew + wicked-studio is a **working app** — not a test suite with green checkmarks.

Working app means:
1. A developer can run `wicked-crew start --type feature --goal "add CSV export"` and the session starts.
2. The daemon dispatches to a real worker CLI (claude or a mock worker in test mode) and records output.
3. The gate auto-evaluates and advances the phase.
4. wicked-studio connects, shows the live session, and the HITL gate surface works.
5. Crash the daemon mid-session, restart, `wicked-crew resume` returns to the exact phase.
6. `wicked-crew status` shows accurate phase state at all times.

These six behaviors are the evidence requirements for the DoD gate. Each must be captured as a recorded test run or demonstration with observable output.

---

## 6. Research Protocol

When a component might be replaceable by OSS:

1. Write a **research brief** (1 page): what do we need, what did we survey, what was rejected and why, what recommendation.
2. Record the brief in `.product/research/`.
3. If recommendation is "use OSS component X": add it as a dependency and document the integration contract.
4. If recommendation is "build custom": the brief becomes the justification record for the design decision.

Research briefs are written before design documents for the relevant component.

---

## 7. Parallel Products

wicked-crew and wicked-studio are developed in the same phase cadence — they are co-released. The interface contract (REST API + WebSocket event schema) is defined in the design phase and frozen before build begins. Neither side can break the contract during build without a joint review.

wicked-garden scope reduction (removing orchestration layer) is a separate product workstream. It proceeds in parallel but is independent — no blocking dependency on wicked-crew reaching any phase.

---

## 8. Tooling

| Activity | Tool |
|---|---|
| Requirements + design | Markdown in `.product/` |
| Dependency management | npm workspaces (single repo for crew + studio) |
| Build | TypeScript + tsc; Vite for studio |
| Test runner | Vitest (unit + integration) |
| Acceptance pipeline | wicked-testing |
| Linting | ESLint + TypeScript strict mode |
| CI | GitHub Actions (wicked-ci reusable workflows) |
| npm publish | OIDC trusted publishing (no stored secrets) |
| Evidence | `.product/evidence/` (timestamped run artifacts) |

---

## 9. Conventions

- **No comments explaining what code does.** Code names explain what. Comments only for non-obvious WHY.
- **No backwards-compat hacks.** If an API changes, change the callers.
- **No mocks for SQLite.** Integration tests use real SQLite temp files.
- **Error messages are actionable.** If the governance engine rejects a gate, the rejection message tells the user exactly which policy failed and what evidence is missing.
- **TypeScript strict mode.** No `any`. No `ts-ignore`. Type every boundary.
