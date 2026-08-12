---
id: DES-PROJECT-001
title: The Project model — keystone of the experience plane (ADR)
status: draft
phase: design
version: 0.1
date: 2026-08-11
author: michael.parcewski@accenture.com
review-required: true
decides:
  - what a Project IS (identity, membership, lifecycle) and which plane owns it
  - where project state lives and how interactive's doc dirs attach
  - the foundation record (estate scope grammar + what lands there)
  - the bus event vocabulary for project lifecycle
  - the studio↔interactive interchangeability contract + minimum /api/v1 additions
  - durable interaction prompts (subsumes the ephemeral-GateCache/elicitation-cache fix)
  - migration of existing runs/docs (implicit default project, lazy adoption)
  - the Phase 7 functional-test definition (one project, two skins, one state)
grounded-in:
  - packages/crew/src/core/types.ts (SessionView:98 — "the read a UI builds its project list from"; RepoEntry:104)
  - packages/crew/src/api/routes.ts (the 52-route /api/v1 surface; gate/elicitation/chats/governance routes)
  - packages/crew/src/api/gate-cache.ts + elicitation-cache.ts (FINDING-051 rebuild; lifecycle deferred)
  - wicked-core/.product/DES-EXEC-001 (workflows-as-data, single-writer actor, bus edge table)
  - wicked-interactive src/service/events.js (wicked.interactive.* vocabulary) + ~/wicked-interactive/docs/<doc>/ layout (versions.json parent-pointer manifest, write-once _v{n}.html)
  - wicked-estate crates/wicked-estate-memory-core/src/scope.rs (kind:id slash-path scopes, parse_strict) + .product/REQ-003 (memory.erase/coverage scope_prefix subtree ops)
  - the four-planes recon (task #85): experience / control / capability / foundation; control owns project STATE, foundation owns the RECORD
---

# DES-PROJECT-001 — The Project model (ADR)

> **Decision in one line:** a *Project* is a named, control-plane-owned container whose members
> are work units from any plane — crew runs, chats, repos, interactive docs — stored as new
> tables in wicked-core's store (`~/.wicked-crew/core.db`), exposed through crew's
> `/api/v1/projects`, mirrored to the bus as `wicked.crew.project.*`, and recorded in the
> foundation under the estate scope `project:<id>`. Binding is **additive**: interactive keeps
> working fully offline and ungoverned; a doc that never meets a daemon is simply in no project.

## 0. Why this is the keystone

The target architecture is four planes — **experience** (studio coder-skin, interactive
creator-skin, interchangeable on the SAME projects), **control** (crew + the wicked-core
engine), **capability** (garden), **foundation** (estate). Today nothing above `repo → runs`
exists: studio's "project list" is literally the run list
(`packages/crew/src/core/types.ts:98`), interactive's unit of work is a self-contained local
doc dir with no crew binding at runtime, and the one crew→interactive bridge is a read-only
batch CLI (`create --from-crew`). Every experience-plane feature that matters —
two skins on one body of work, a project activity feed, durable human prompts a late-joining
skin can render — needs one shared noun first. This document decides that noun.

Boundary rule, applied throughout: **control owns project STATE** (what is in this project
*now*; mutable; authoritative), **foundation owns the RECORD** (what this project *learned and
produced*; durable; survives archive and even control-store loss).

---

## 1. Decision — what a Project IS

### 1.1 Identity

- `id`: `proj_<ulid>` — lowercase, time-sortable, minted by control at create. Never derived
  from the name; renames never move anything.
- `name`: human label, 1–120 chars. Uniqueness among *active* projects is enforced at the API
  (409 on collision) as a UX rule, not a storage invariant — archived projects free their name.
- Reserved id **`default`** — the implicit "Unfiled" project (§7). It cannot be created,
  renamed, archived, or attached-to explicitly; it is synthesized, never stored.

### 1.2 Membership

A membership is a typed, opaque reference:

```
(project_id, member_kind, member_ref, attached_at, attached_by)
UNIQUE (project_id, member_kind, member_ref)
```

`member_kind` is an open `<product>.<noun>` grammar — data, not a closed enum (DES-EXEC-001's
stability law: new member kinds MUST NOT edit core). Kinds this ADR blesses:

| kind | ref | semantics |
|---|---|---|
| `crew.run` | run/session id | owned work; the common case; auto-attached at launch |
| `crew.chat` | chat id | owned work |
| `crew.repo` | repo id (`RepoEntry.id`) | **association**, not ownership — a repo may belong to many projects |
| `crew.workflow` | workflow def id | association — "this project uses this workflow"; informational |
| `interactive.doc` | doc name (dir basename under the interactive root) | owned creative work; attached by registration (§2.3) |
| `studio.session` | — | **reserved**, not implemented; named now so the grammar doesn't fork later |

The engine treats `member_ref` as an opaque string; it never resolves non-crew kinds. Referential
integrity for `crew.*` kinds is checked at the API layer at attach time (404 on unknown run/repo),
not by foreign keys — members may legitimately outlive or predate what they point to
(a doc deleted on disk, a run pruned).

**Foundation references are NOT members.** Evidence trees
(`<product>/.wicked-testing/evidence/<run-id>/verdict.json`) are reachable transitively through
`crew.run` members; knowledge and memory are reachable through the project scope (§3). Making
them members would duplicate the record into state — exactly the boundary the plane rule forbids.

### 1.3 Lifecycle

```
active ──archive──▶ archived ──restore──▶ active
```

- **No hard delete in v1.** Archive hides the project from default lists and blocks new
  attachments; members, evidence, knowledge, and memory are all retained. The record outlives
  the state on purpose. (Erasure — `memory.erase scope_prefix=project:<id>` — is irreversible
  and stays a deliberate, separate, human-invoked estate operation; it is never a side effect
  of any project API call.)
- Detaching a member never deletes the member's own data (the run, the doc dir). It removes a
  row, nothing else.

### 1.4 Alternatives considered

1. **Project = repo group** (promote `RepoEntry` to the container). Rejected: interactive docs
   and repo-less runs (both real today — `LaunchRunInput.repoRef` is optional) would have no
   home; repos are context, not the work itself.
2. **Project = workflow instance / campaign.** Rejected: campaigns are an execution shape
   (DAG of runs), not a grouping of heterogeneous work; a project outlives any one campaign.
3. **Project = estate scope only** (no control tables; membership inferred from scope tags).
   Rejected: violates the boundary rule in the other direction — the foundation would own
   *state*; membership mutations would become memory writes; offline interactive docs could
   never be listed at all; and "what is in this project" would require a search, not a read.
4. **Tags instead of containers** (runs/docs carry free-form labels). Rejected: no lifecycle,
   no single place to hang the activity feed and prompt inbox, no answer to "create it in
   studio, continue it in interactive."

---

## 2. Decision — where project state lives

### 2.1 New tables in wicked-core's store, written by the engine's single-writer actor

Projects and memberships are **two new tables in `~/.wicked-crew/core.db`**, owned and written
exclusively by the wicked-core actor, like every other durable control fact (runs, units,
events, governance, chats):

```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,          -- proj_<ulid>
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','archived')),
  scope       TEXT NOT NULL,             -- estate scope path, e.g. 'project:proj_01j...' (§3)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE project_members (
  id          TEXT PRIMARY KEY,          -- pm_<ulid>
  project_id  TEXT NOT NULL REFERENCES projects(id),
  member_kind TEXT NOT NULL,             -- '<product>.<noun>', open grammar
  member_ref  TEXT NOT NULL,             -- opaque
  meta        TEXT,                      -- JSON: skin hints (doc root, display title…)
  attached_at INTEGER NOT NULL,
  attached_by TEXT NOT NULL,             -- 'studio' | 'interactive' | 'cli' | 'api'
  UNIQUE (project_id, member_kind, member_ref)
);
```

Engine surface additions (napi via `wicked-core-ts`, names indicative):
`projectCreate / projectList / projectGet / projectUpdate / projectMemberAttach /
projectMemberDetach`, plus `LaunchOptions.projectId` (below). The daemon's `CoreAdapter` maps
them 1:1, exactly as chats do today.

**Why the engine store and not a daemon-owned `crew.db`:** (a) core.db is already the
single-writer domain for every other durable control fact — a second daemon-owned database
reintroduces the two-writer, two-backup, split-restore problem the actor exists to prevent
("single-writer catches"); (b) every `crew.*` member kind lives in core.db, so the activity
feed and prompt inbox join locally instead of cross-database; (c) the execution seam is built
for a future remote runner — daemon-local state would strand projects on the wrong side of that
seam. The cost — Rust engine work for a "mere" grouping — is accepted and bounded: two tables,
opaque refs, zero workflow-engine coupling.

**Alternative rejected:** daemon-owned SQLite beside `~/.wicked-crew/`. Cheaper to build
(no napi work), but it makes the daemon a second writer of durable control state, splits
backup/restore, and puts the project boundary in the wrong process for the remote-runner
future. Rejected on the boundary rule, not on effort.

### 2.2 Launch integration

`POST /api/v1/runs` and `POST /api/v1/chats` accept an optional `projectId`. The engine
attaches the `crew.run` / `crew.chat` membership **atomically with the launch record** (same
actor transaction), so a crash between "run exists" and "run is in the project" cannot happen.
An invalid or archived `projectId` fails the launch with 4xx — never a silent unfiled run the
caller believed was filed.

`CoreEvent` frames are **not** changed in v1: the daemon knows run→project from the membership
table and enriches its own outbound surfaces (activity feed, bus events). Whether `project_id`
should ride natively on CoreEvent is an open question (§9), not a blocker.

### 2.3 How interactive's doc dirs attach — additive, never required

Interactive's contract today is sacred: a doc is a self-contained local directory
(`<root>/docs/<doc>/` with write-once `_v{n}.html`, a `versions.json` parent-pointer manifest,
`conversation.jsonl`, sources, theme) that works with **no daemon, no bus, no crew**. Project
binding adds three mechanisms on top and changes none of that:

1. **Registration is the authority.** A doc joins a project via
   `POST /api/v1/projects/:id/members {kind:"interactive.doc", ref:"<doc>", meta:{…}}` —
   called by interactive's service when a doc is created with a project
   (`wicked-interactive create … --project <id>`, or a project picker in `serve`), or by
   studio attaching an existing doc. The membership row in core.db is the single source of
   truth for "this doc is in this project."
2. **A doc-side breadcrumb, advisory only.** On successful registration, interactive writes
   `project.json` (`{project_id, project_name, crew_api, attached_at}`) **beside**
   `versions.json` — never inside it; the write-once version manifest is untouched. The
   breadcrumb lets the doc display its binding offline and lets a rebuilt control store
   re-adopt docs (§7), but it is never consulted as authority: breadcrumb and table disagree ⇒
   the table wins.
3. **Event enrichment.** Once bound, interactive's service includes `project_id` as an
   additive optional field in its `wicked.interactive.*` payloads (`doc.created`,
   `version.created`, `feedback.submitted`, `export.generated`, …). Consumers that don't know
   the field ignore it; the activity feed (§5) correlates on it.

Offline/ungoverned solo creators: no daemon reachable ⇒ no `--project` accepted (loud error,
not a queued intent), no breadcrumb, no enrichment — the full local loop works exactly as
today. **Binding is a capability the doc gains, never a dependency the doc acquires.**

---

## 3. Decision — the foundation record

### 3.1 Scope grammar

Estate scopes are ordered slash-paths of `kind:id` segments with subtree semantics
(`scope.rs`; `memory.erase` / `memory.coverage` / recall filters take a `scope_prefix`).
This ADR fixes the project grammar:

```
project:<project_id>                      — the project root scope
project:<project_id>/run:<run_id>         — memory/knowledge captured during a project run
project:<project_id>/doc:<doc_name>       — captured around an interactive doc
project:<project_id>/repo:<repo_id>       — repo-flavoured project knowledge (optional segment)
```

- The scope path is **stored** on the project row (`projects.scope`), not derived on read, so a
  future tenancy prefix (`org:<o>/project:<id>` — the team/org runtime in the consolidation
  plan) can be introduced for new projects without renaming the grammar or breaking old rows.
  Today it is always `project:<id>`.
- All caller-supplied scopes go through `Scope::parse_strict` (the lenient parser once silently
  re-rooted 205 memories to root — that scar is why).
- `memory.erase scope_prefix=project:<id>` therefore erases exactly one project's memory
  subtree, and `memory.coverage scope_prefix=project:<id>` is the cheap "does this project have
  a record?" probe the e2e test uses (§8).

### 3.2 What of a project lands in estate

On `project.created`, control writes the **project charter** into the knowledge store under
`project:<id>`: name, description, created-at, creator surface. Thereafter:

| record | where | written by |
|---|---|---|
| project charter (name, description, lifecycle notes) | knowledge store, scope `project:<id>` | crew daemon on create/update/archive |
| memory captured during project-bound runs/chats | memory store, scope `project:<id>/run:<run_id>` | the engine's existing memory path, scope-prefixed when the run has a project |
| evidence **pointers** (run id → `.wicked-testing/evidence/<run-id>/verdict.json` path + verdict) | knowledge store, scope `project:<id>/run:<run_id>` | crew daemon when a run with evidence completes |
| doc lineage pointer (doc name, head version, export paths) | knowledge store, scope `project:<id>/doc:<doc>` | interactive service on `export.generated` *when bound and daemon-reachable*; best-effort |

Evidence files themselves stay where they are (in-repo, per QE convention) — the foundation
holds durable *pointers plus verdicts*, not copies. This is the concrete meaning of "control
owns the state, foundation owns the record": delete `core.db` and the project's name, members,
learned memory, and evidence trail are still recoverable from estate + breadcrumbs; delete the
estate record and the project still *operates* but has amnesia.

---

## 4. Decision — bus event vocabulary

Four-segment grammar `wicked.<domain>.<noun>.<verb>` (SPEC.md is canonical), domain `crew`,
emitted by the crew daemon after the engine commit (never before — no phantom events):

| event | when | payload core |
|---|---|---|
| `wicked.crew.project.created` | create | `project_id, name, scope, actor` |
| `wicked.crew.project.updated` | rename / description / restore | `project_id, changed: {…}, actor` |
| `wicked.crew.project.archived` | archive | `project_id, actor` |
| `wicked.crew.membership.attached` | member added (incl. auto-attach at launch) | `project_id, member: {kind, ref}, actor` |
| `wicked.crew.membership.detached` | member removed | `project_id, member: {kind, ref}, actor` |

Notes: `membership` is its own noun because the grammar is strictly four segments — no
`project.member.attached` five-segment form. `actor` is the attaching surface
(`studio | interactive | cli | api`). Idempotency keys include the event type
(DES-EXEC-001 rev0.2 correction #4a — the collide-on-UNIQUE data-loss scar). Interactive's
side of the conversation stays in its own domain (`wicked.interactive.*` + the additive
`project_id` field, §2.3); crew does not speak for interactive on the bus.

---

## 5. Decision — the interchangeability contract

### 5.1 The contract is the API, not the UI

Both skins are pure clients of crew's `/api/v1` (+ bus/WS for liveness). Studio is the coder
skin (runs, gates, governance, repos); interactive is the creator skin (docs). **Neither
re-implements the other's editor** — studio links/embeds interactive's doc UI; interactive
shows a project context panel — but both render the same four shared reads and can perform the
same shared writes:

| shared surface | studio | interactive |
|---|---|---|
| project list / create / rename / archive | ✓ (project nav replaces the run-list-as-project-list) | ✓ (project picker at doc create; project panel) |
| membership read / attach / detach | ✓ | ✓ (attach own docs) |
| activity feed (`/activity`) | ✓ (timeline pane) | ✓ (project panel) |
| open prompts (`/prompts`) + answering gates | ✓ (existing gate UI) | ✓ (prompt card → `POST /runs/:id/gate`) |

### 5.2 Minimum API additions (the complete v1 list)

```
POST   /api/v1/projects                      create {name, description?}
GET    /api/v1/projects                      list (includes synthesized 'default'; ?status=)
GET    /api/v1/projects/:id                  detail + members
PATCH  /api/v1/projects/:id                  rename / describe / archive / restore
GET    /api/v1/projects/:id/members          list members
POST   /api/v1/projects/:id/members          attach {kind, ref, meta?}
DELETE /api/v1/projects/:id/members/:mid     detach
GET    /api/v1/projects/:id/activity         merged feed, cursor-paginated (?cursor=&limit=)
GET    /api/v1/projects/:id/prompts          open interaction requests across member runs
```

Plus `projectId?` on the existing `POST /runs` and `POST /chats`. Nothing else on the 52-route
surface changes; `SessionView` is untouched.

**The activity feed** is a read-side merge, not a new store: core events of member runs/chats
(the durable event log crew already replays) ∪ bus `wicked.interactive.*` events carrying this
`project_id` — normalized to `{ts, source: 'crew'|'interactive', kind, ref, summary, raw}`,
newest-first, cursor on `(ts, id)`. Live updates ride the existing `/ws` stream (daemon tags
frames with `project_id` from the membership table) — no new socket.

### 5.3 Durable interaction prompts — subsuming the GateCache fix

Today the gate prompt lives on a transient event; `GateCache` rebuilds a single run's gate by
replaying its log (FINDING-051) and `lifecycle` is hard-coded `'open'`; elicitations have a
parallel cache; there is no cross-run query and no WS late-join replay. Multi-skin makes this
untenable: a prompt must be *addressable state*, because the skin that renders it may not be
the skin that was connected when it fired.

**Decision:** the engine persists interaction requests as a first-class table in core.db,
written by the actor in the same transaction that emits `awaitingHuman` / elicitation-request,
and resolved in the same transaction as the gate/elicitation decision:

```sql
CREATE TABLE interaction_requests (
  id          TEXT PRIMARY KEY,          -- ir_<ulid>
  session_id  TEXT NOT NULL,             -- the run
  kind        TEXT NOT NULL CHECK (kind IN ('gate','elicitation')),
  ord         INTEGER,                   -- unit ord for gates
  prompt      TEXT NOT NULL,             -- full prompt payload (JSON)
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','answered','expired','cancelled')),
  answer      TEXT,                      -- decision payload (JSON)
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
```

`GET /projects/:id/prompts` = join members(kind `crew.run`) × interaction_requests(status
`open`). `GateCache`/`ElicitationCache` demote to what their own comments already claim they
are — in-memory latency caches over durable truth — and gain the lifecycle states
(`answered/expired/cancelled`) DES-STUDIO-001 §3.3 deferred. Answering stays the existing
`POST /runs/:id/gate` / `POST /runs/:id/elicitation` routes (their `status === 'awaiting_human'`
guard already makes stale answers safe), so interactive gains gate-answering **without a single
new write route**. Interactive's own human questions (`wicked.interactive.question.*`) stay
skin-local in v1 — they appear in the activity feed but not the prompt inbox (§9, open).

---

## 6. Decision — capability and control planes stay decoupled

Garden (capability plane) is unaffected by this ADR: it neither stores nor resolves projects.
Where garden work runs inside a project-bound crew run, its outputs inherit the run's scope
prefix through the engine's existing paths. Any future garden awareness of projects is a
consumer of `/api/v1/projects` and the bus vocabulary, nothing more.

---

## 7. Decision — migration: lazy adoption, implicit default, zero backfill

- **No backfill migration runs, ever.** Existing rows are not touched.
- **The implicit `default` project** ("Unfiled") is *synthesized* by the API layer: its members
  are all runs/chats known to the engine that have no explicit membership row. It appears in
  `GET /projects`, supports `/activity` and `/prompts`, and rejects PATCH/archive/attach.
  Studio's current run list therefore becomes, on day one, exactly "the default project's
  view" — pixel-for-pixel continuity, no data migration.
- **Adoption is one insert.** Moving a run into a real project = `POST …/members`; nothing is
  deleted (default membership is computed, not stored).
- **Interactive docs**: control lists only what it has been told about. Unbound docs do NOT
  appear in the default project — the daemon cannot and should not enumerate a directory it
  was never granted; that boundary is honest, not a gap. Re-adoption after control-store loss:
  interactive's service offers `wicked-interactive adopt` (scan doc dirs for `project.json`
  breadcrumbs → re-register memberships), which also covers "new machine, synced docs."
- The batch ingress (`create --from-crew <session_id>` reading
  `~/.wicked-crew/sessions/<id>/session.json`) keeps working unchanged; when the source run has
  a project, it may stamp the breadcrumb and register the new doc into the same project.

---

## 8. Decision — the Phase 7 functional test (the gate this ADR must pass)

One project created in studio, continued in interactive, both reflecting the same state.
Concrete steps the e2e will run (each numbered step is an assertion boundary):

1. **Boot** — fresh `core.db`; start crew daemon + studio; start interactive `serve`
   (bus-connected); `gh`/network not required.
2. **Create in studio** — via studio UI: create project `e2e-keystone` → assert `201`, a
   `wicked.crew.project.created` event on the bus, and the project in `GET /api/v1/projects`.
3. **Launch governed work** — from studio, launch a run with `projectId` and a human-confirm
   gate (`humanConfirm: before:1` or a gated workflow) → assert `wicked.crew.membership.attached`
   with `member.kind == 'crew.run'`.
4. **Gate becomes durable state** — when the run reaches `awaiting_human`: assert
   `GET /api/v1/projects/:id/prompts` returns one open `gate` with the prompt text.
5. **Restart survival** — restart the crew daemon → repeat the §4 read; the same open prompt
   returns (this assertion is the ephemeral-GateCache fix, proven, not promised).
6. **Continue in interactive** — `wicked-interactive create … --project <proj_id>` (or the
   serve UI picker) → assert the `interactive.doc` membership in `GET …/members` and the
   `project.json` breadcrumb on disk beside `versions.json`.
7. **Creator-side progress is visible to the coder skin** — iterate the doc once (feedback →
   new version) → assert `wicked.interactive.version.created` carries `project_id`, and
   `GET …/activity` interleaves the run's gate entry and the doc's version entry in timestamp
   order; studio's open project view shows the doc event over `/ws` without reload.
8. **Answer the gate from the creator skin** — from interactive's project panel, answer the
   open prompt (`POST /api/v1/runs/:id/gate` approve) → assert the run resumes; studio reflects
   `resumed` live; `GET …/prompts` is empty.
9. **Foundation record exists** — assert `memory.coverage scope_prefix=project:<id> > 0` and
   the project charter is retrievable from the knowledge store under `project:<id>`.
10. **Offline regression (the solo creator is unharmed)** — stop the daemon; create and iterate
    a plain doc with no `--project` → full local loop succeeds; no breadcrumb, no errors, no
    queued side effects.

Pass = all ten. Steps 4+5+8 are the multi-skin heart: the prompt fired before either skin was
looking, survived a restart, and was answered by the skin that didn't launch the run.

---

## 9. Open questions (flagged, not blocking the shape)

1. **Tenancy prefix.** Where `org:<o>` lands relative to `project:<id>` when the team/org
   runtime arrives, and the re-scoping policy for pre-org projects (the stored-`scope` column
   is the designed seam; the policy is not decided).
2. **Interactive questions in the prompt inbox.** Should `wicked.interactive.question.*` /
   review-requests join `interaction_requests` (making the inbox truly cross-plane), or stay
   skin-local? v1 says skin-local; the table's `kind` column is deliberately extensible.
3. **`project_id` on CoreEvent.** Daemon-side enrichment suffices for v1; native engine
   stamping would help the remote-runner seam but widens every event frame. Deferred.
4. **Repo exclusivity.** `crew.repo` membership is many-to-many by design; whether any workflow
   needs "this repo is *primary* for this project" (ordering, default pick at launch) is unknown.
5. **Archive semantics for in-flight work.** Archiving a project with a running member: v1
   blocks new attachments but does not cancel runs. Whether archive should require quiescence
   is a product call.
6. **Erasure ceremony.** `memory.erase scope_prefix=project:<id>` is irreversible; who may
   invoke it and with what confirmation is an estate-side governance question this ADR only
   points at.
7. **Studio nav cutover.** When studio's top-level nav switches from run-list to project-list
   (day-one continuity via the default project makes this a pure UX sequencing question).
8. **Cross-machine identity.** Project ids are locally minted ULIDs; the bus is single-host
   today. Identity federation across a future remote runner / multi-host bus is explicitly out
   of scope here and must be designed with that transport.

## 10. Consequences

- **New engine work (Rust + napi):** two tables + CRUD, `interaction_requests` + actor-side
  writes, `LaunchOptions.projectId` — bounded, no workflow-engine coupling. This is the price
  of single-writer coherence and was chosen knowingly (§2.1).
- **Crew daemon:** 9 new routes, activity-feed merge, prompt-inbox join, bus emission, charter/
  evidence-pointer writes to the knowledge store. `GateCache`/`ElicitationCache` demote to
  caches (their code comments finally become true).
- **Interactive:** `--project` flag + picker, breadcrumb write, additive `project_id` event
  field, `adopt` command. Zero change to the doc format, the version manifest, or offline life.
- **Studio:** project nav + attach UI + activity/prompt panels — consumes only the new routes.
- **Estate:** no schema change; the `project:` scope kind is pure convention over the existing
  kind:id grammar (that's the point of custom kinds).
- **What this deliberately does not do:** no cross-plane transactionality (the record is
  eventually consistent with the state, best-effort writes with retry via the bus), no doc
  content in control, no project-level ACLs (single-operator assumption holds until the org
  runtime), no hard delete.
