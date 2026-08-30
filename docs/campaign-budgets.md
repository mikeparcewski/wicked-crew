# Campaign budgets and runtime governance

How crew keeps a **qe campaign** (garden ADR 0006) from becoming an unbounded spend
commitment: a wall-clock budget, a per-node timeout, an explicit kill/abandon policy,
a nightly node cap, and per-node cost recorded in evidence. Implemented by
`packages/crew/src/campaign/supervision.ts` (TH-20 / recon test-R22).

## Knob placement — the P-9 interim decision (recorded)

The open question P-9 (2026-08 recon TASK-PLAN §parked) asks where the budget knobs
live: as `CampaignDef` fields in wicked-core, or as crew-side supervision. **Interim
decision: CREW-SIDE SUPERVISION**, effective with this document.

- **Why**: crew supervision ships without a core release, rides the cancel path that
  already exists (`CancelRun` through the adapter), and can be revised without touching
  the engine's durable schema. Core's `CampaignDef` carries exactly one resource knob
  today — `max_concurrency` (DES-CAMPAIGN-001 §2) — and growing it is a core-maintainer
  call.
- **Accepted limitation (stated, not hidden)**: supervision state lives in the crew
  daemon. A campaign resumed **engine-only** (without the crew daemon, e.g. straight
  through `wicked-core-ts`) runs with **no budget enforcement**. `CampaignDef` fields
  would survive such a resume; this layer does not. Until the core-maintainer call
  lands, the rule is: **governed campaigns launch and resume through crew** — the same
  posture the acceptance gate already imposes.
- **Migration path**: `CampaignBudgetPolicy` is defined so its fields can move onto
  `CampaignDef` without changing semantics. When core takes the knobs, this layer
  degrades to cost accounting + reporting.

## The knobs

All resolution is **fail-closed**: a malformed value throws at launch — a typo'd
ceiling must never mean "unbounded". Resolved by `resolveBudgetPolicy(env)`.

| Env var | Meaning | Default |
|---|---|---|
| `WICKED_CAMPAIGN_BUDGET_SECS` | Campaign wall-clock budget (includes human-gate wait — a nightly run is unattended, so a gate nobody answers burns budget and then aborts, on purpose) | `14400` (4 h) |
| `WICKED_CAMPAIGN_NODE_TIMEOUT_SECS` | Per-node timeout, counted against **running** time only (`awaiting_human` never counts — a gate is quiet by design and burns no worker spend) | `1800` (30 min) |
| `WICKED_UNIT_TIMEOUT_SECS` | The **engine's** per-unit wall-clock cap. An ambient value is **honored as the pin**; unset, the campaign pins the proven `900`. Unpinned nodes are refused — the engine's own default is **7200 s (2 h) per unit**, which is exactly the unbounded-spend hazard | pin `900` |
| `WICKED_CAMPAIGN_MAX_NODES` | Nightly cap: hard ceiling on nodes per campaign, asserted **before launch** (`assertWithinNightlyCap`, fail-closed) | `25` |
| `WICKED_CAMPAIGN_MAX_COST_USD` | Optional campaign USD ceiling, fed by `recordNodeCost` | unset (wall-clock stays the hard ceiling) |
| `WICKED_CAMPAIGN_KILL_POLICY` | What happens to **in-flight** nodes at budget exhaustion: `kill-running` (cancel now) or `abandon-running` (let them finish; launch nothing new) | `kill-running` |

Defaults are sized from the 2026-08 studio E2E campaign: 21 scenarios, one observed
governed feature run at 7 m 41 s (a single data point, directional), the campaign
environment pinned `WICKED_UNIT_TIMEOUT_SECS=900`.

### TH-8-style environment pins

Until the full TH-8 environment manifest lands, `nodeEnvPins(policy)` is the budget
block of that manifest: every campaign node **must** launch with the exact
`WICKED_UNIT_TIMEOUT_SECS` the policy resolved. `assertNodeEnvPinned(nodeEnv, policy)`
is the fail-closed preflight — missing pin refuses (unpinned = engine 2-hour default),
mismatched pin refuses (the manifest must not lie about the environment).

## What exhaustion looks like — never silent

When the wall-clock (or opt-in cost) budget trips, `CampaignSupervisor`:

1. Marks the campaign `exhausted` in supervision state (`kind`, timestamp, spent vs
   budget, policy applied) — **the budget abort is visible in campaign state**; TH-9's
   `GET /api/v1/campaigns/:id` merges this state, and until those routes land it is
   readable via `CampaignSupervisor.state()`.
2. Gives every remaining node an **excluded-with-reason** record:
   - never-launched nodes → `applied: "excluded"`, blocked at the scheduler so they can
     never dispatch;
   - in-flight nodes → `applied: "cancelled"` under `kill-running` (through the
     existing cancel path) or `applied: "abandoned"` under `abandon-running` (they may
     finish, but they are on record as budget-breached and nothing new launches).
   Reasons are human-readable and name the ceiling that tripped
   (`wall-clock budget 14400s exceeded (elapsed 14495s); node never launched`).
3. Broadcasts synthetic `/ws` frames — one `campaignBudgetExceeded` naming every
   touched node, plus one `campaignNodeExcluded` per node — and logs each at warn.
   (Local frame types today, like `workerStalled`; NOTE for the next
   `wicked-crew-api-types` release: fold both into the published contract.)
4. Per-node timeouts use the same machinery outside exhaustion: a node whose
   **running** time exceeds the timeout is cancelled with a `node-timeout` exclusion.

Exhaustion is enforced **exactly once**, and a campaign whose nodes are all terminal is
auto-released — a finished campaign can never spuriously trip its budget on a later
sweep.

## Cost per node in evidence

The supervisor stamps wall-clock per node itself (running intervals only — always
available), and accepts token/USD figures via `recordNodeCost(campaignId, nodeId,
{usd, inputTokens, outputTokens})` whenever the worker CLI reports them.
`buildSupervisionReport(state)` + `writeSupervisionReport(evidenceDir, report)` emit
**`campaign-supervision.json`** into the campaign's evidence directory
(`.wicked-qe/evidence/<run-id>/`): policy (including the unit-timeout pin the nodes ran
under), budget outcome, campaign totals, and a per-node row
`{node_id, phase, cost: {wall_ms, usd?, input_tokens?, output_tokens?}, excluded?}`.

That artifact is what the TH-14 studio scoreboard's **cost column** reads and what
campaign-over-campaign diffs compare — **a cost regression is visible exactly like a
verdict regression**. Deliberately an evidence *artifact*, not new fields on
wicked-ledger's manifest 2.1: that schema is the ledger's contract and moves through
its owner's release train (ADR 0006 consequence 4), never ad hoc.

## Nightly recipe requirements (TH-23 must obey)

The nightly governed campaign (GH Actions recipe, TH-23) runs **capped or not at
all**:

- `assertWithinNightlyCap` runs before launch; a campaign over
  `WICKED_CAMPAIGN_MAX_NODES` (default 25) is refused, not trimmed silently.
- The workflow env **must** set `WICKED_CAMPAIGN_BUDGET_SECS` and
  `WICKED_UNIT_TIMEOUT_SECS` explicitly (defaults exist, but the nightly manifest
  states its ceilings — an unpinned artifact caps claims at machinery-verified, per
  the TH-8 doctrine).
- Quarantined/flaky scenarios follow TH-21's excluded-with-reason representation at
  the gate; budget exclusions use the same visibility rule — nothing is ever silently
  dropped from a nightly's acceptance payload.
- Recommended nightly baseline: `BUDGET_SECS=14400`, `NODE_TIMEOUT_SECS=1800`,
  `UNIT_TIMEOUT_SECS=900`, `MAX_NODES=25`, `KILL_POLICY=kill-running`.

## Seam for TH-9 (campaign endpoints)

`CampaignSupervisor` is deps-injected against the `SupervisedScheduler` port
(`listNodes` / `cancelNode` / `excludeNode`). TH-9's campaign adapter implements the
port over core's campaign state + `CancelRun`; the daemon arms one supervisor the way
it arms the stall watchdog (`start()` on boot, `supervise(campaignId, policy)` at
`POST /campaigns`, state merged into `GET /campaigns/:id`). Until TH-9 lands, campaigns
run as ordinary governed workflows (ADR 0006 consequence 4) and the interim mitigations
apply: pin `WICKED_UNIT_TIMEOUT_SECS` in the environment manifest, cap the nightly
explicitly.
