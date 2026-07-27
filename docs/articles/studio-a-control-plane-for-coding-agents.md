# A control plane for coding agents: what wicked-crew studio is and why it exists

*Status: experimental. Everything described below has been exercised end-to-end against
real CLI agents — but the project is young, local-first, and evolving. Treat it as a
working research vehicle, not a finished product.*

---

## The problem

If you use coding-agent CLIs seriously — Claude Code, Codex, opencode, Copilot, or
several at once — you have probably noticed four things:

1. **Outcomes are inconsistent.** The same task, phrased the same way, lands differently
   run to run and agent to agent. There is no structure forcing a *process* onto the work.
2. **Agents grade their own homework.** The agent that wrote the code tells you the code
   is fine. Nothing structurally prevents self-approval.
3. **The trail evaporates.** When a run finishes, what actually happened — who decided
   what, what was reviewed, what it cost — lives in a scrollback buffer, if anywhere.
4. **Token burn is opaque.** You find out what a workflow cost when the invoice arrives,
   not while it runs.

Studio (the browser console of [wicked-crew](../../README.md)) exists to solve those four
problems for the CLIs **you already have**. It doesn't ship a model, doesn't proxy your
API keys, and doesn't replace your agent subscriptions. It is closest in spirit to a
**forward-deployed engineer's control plane**: one operator, several capable workers,
consistent process, visible decisions, and a paper trail you can hand to someone else.

## The shape of the thing

Under the hood there are three pieces:

- **wicked-core** — a Rust engine: a single-writer actor that owns workflows-as-data,
  planning, routing, gates, and an event stream. Runs are durable (embedded SQLite);
  every decision is an event.
- **the daemon** (`wicked-crew serve`) — a thin TypeScript surface: REST + WebSocket over
  the engine, and the process that puts your agent adapters on PATH.
- **studio** — the browser console: launch runs, watch every agent live, answer gates,
  inspect the decision trail, export the evidence.

Everything below is a property of that stack, verified live.

## What it actually does

### 1. Workflows as data — the consistency mechanism

A workflow is a JSON document, not code: an ordered list of phases with kinds
(recon/build/review/test), roles (creator/evaluator), and gates. `feature` ships as
clarify → design → build → adversarial-review → test → review. Drop a JSON file in
`~/.config/wicked-core/workflows/` and the engine runs yours instead.

This is what makes outcomes consistent: the same task class always moves through the same
phases with the same gate policy, regardless of which agent executes each step or how you
phrased the prompt. A worked example: a four-phase `collab` workflow
(propose → critique → revise → verdict) turned two CLIs into a genuine design
discussion — the critic read the actual source to ground its numbered findings, the
proposer answered each finding explicitly, and the final verdict was an honest
"FAIL as written, but narrowly" with the residuals named. No engine changes — one JSON
file.

### 2. The council — routing without self-selection

When a run is planned, every unit is auctioned to the roster by an in-process council:
each CLI votes on **numbered capability profiles** — agent names are never shown to
voters, so no agent can vote for itself. Deliberation is real: every seat evaluates
through a distinct lens (capability fit, risk, efficiency, output quality), the council
is told it needs 75% agreement, and below-bar ballots trigger runoff rounds where every
seat sees the tally and the dissenters' arguments. If it still can't converge, plurality
stands — routing never wedges a run.

### 3. Evaluator ≠ creator — structural, not aspirational

After routing, any review/test unit assigned to a CLI that built or scoped the work is
reassigned to a different seat. The agent that wrote the code *cannot* be the agent that
approves it — it's enforced in the engine, not requested in a prompt. In practice: when
claude took clarify/design/build on a feature run, the adversarial-review, test, and
review units were forced onto a different CLI, which then found a real defect
(two artifact copies that weren't byte-identical).

### 4. Gates — the human stays deny-dominant

Between phases, runs pause at gates you answer in studio: **approve**, **approve with
steering** (your amendment rides the next phase's prompt — in one verification run the
steering text "mention durability" showed up verbatim as *"durable across restart"* in
the output), **reject** (deny dominates — the run stops), or reassign the unit first.
Gate policy is per-run: everything gated, one gate before a chosen phase, or fully
autonomous.

### 5. Multi-CLI over ACP — one protocol, your roster

Agents run as workers over the [Agent Client Protocol](https://agentclientprotocol.com):
persistent sessions, streamed token-level output, structured usage reporting. The
adapters come from the ecosystem where they exist (the official
`@agentclientprotocol/claude-agent-acp` and `codex-acp`, community `pi-acp`, native
`copilot --acp` and `opencode acp`) — installing the repo installs them; the daemon puts
them on PATH itself. Cross-agent context is injected automatically: when unit 4 runs on
a different CLI than unit 3, it receives unit 3's output as labeled context. That is the
mechanism that makes the collab workflow an actual conversation.

> **Terms-of-service note:** crew drives CLIs you install under your own accounts.
> Confirm that programmatic use is permitted by each CLI's terms — community reports
> suggest driving Antigravity (`agy`) this way may conflict with its ToS.

### 6. Failure recovery — a ladder, not a die-roll

When a worker fails, the engine climbs a ladder instead of killing the run:

1. **Known environment refusals self-heal.** A CLI refusing an untrusted directory gets
   the documented trust flag injected and retries — verified live: a deliberately broken
   seat refused, the engine re-invoked it with the flag, and the run completed.
2. **Unknown failures get an agent triage judge.** A *different* CLI reads the raw error
   and answers under a strict contract: retry with a single flag, plain retry, escalate,
   or fail. Proposed flags pass a deny-list (nothing privilege-bypassing is ever
   auto-applied), malformed verdicts escalate rather than execute, and in live testing
   the judge correctly distinguished a fabricated environment refusal (it derived the
   right flag from the error text alone) from a fabricated internal fault (it refused to
   retry and failed the run with its reasoning attached).
3. **Escalations reach you pre-diagnosed** — the gate prompt carries both the judge's
   analysis and the CLI's own words.
4. **Autonomous runs skip the detour.** No human in the loop → the classic fail-fast
   contract holds, which is what campaign-style scheduling depends on.

### 7. Observability — the insight rail

Every run page carries a rail of live panels, each fed by the event stream:

| Panel | What it answers |
|---|---|
| Decisions | who won each unit's council vote, at what agreement, and what the gate decided |
| Governance | recorded governance claims for the run |
| **Burn** | tokens in/out, dollar cost, rework percentage, per-CLI breakdown |
| Data | files the agents actually touched |
| Steering | every operator intervention, in order |
| Assumptions | routing provenance + **external-transform assumptions** (below) |
| Files | the run's changed files |
| Term / Cov | a governed operator shell; the coverage-gate report |

Burn deserves emphasis because it answers the token-utilization question *during* the
run: after any unit completes you can see exactly what each CLI consumed and what it
cost, and rework (re-dispatched attempts) is broken out separately.

### 8. Captured assumptions — external transformations

A subtle failure mode of agent-built systems: the work depends on a third-party library
or service that *transforms a payload* — an address service returning a corrected
address, a tax service enriching line items — and the transformation semantics live
nowhere in your codebase. Crew's convention makes agents record each one as a structured
assumption, with an honest confidence: `known` (logic captured) or `needs-research`
(a placeholder — "uses X for Y; exact semantics unverified" — badged in the Assumptions
panel for human review). Malformed records degrade to needs-review rather than
disappearing.

### 9. Evidence export — the paper trail

One click (or `GET /api/v1/runs/:id/evidence`) produces a single JSON bundle: the run,
every unit with its full transcript, the derived decision trail (routing provenance and
gate outcomes), and the captured assumptions. Nothing in it is invented — every field
traces to durable run state. Fittingly, this feature was itself **built by the agent
team through a governed crew run** — claude planned and built it, a second CLI
adversarially reviewed and tested it, a human answered two gates — and then it was used
to export the evidence of its own construction.

### 10. Mid-run steering — talk to the workers

The inject bar sends an operator message to all agents or a specific one. On live
terminal sessions it lands immediately; on protocol sessions it queues and rides the
next unit's prompt as an explicit operator context block — with queued/delivered
receipts in the thread. Verified with sentinel tokens echoed back verbatim by the
receiving agents.

## What it is not

- **Not a hosted service.** Local-first, single host, your machine, your keys.
- **Not a model or an agent.** Bring your own CLIs; crew is the process around them.
- **Not finished.** Experimental: interfaces move, and some surfaces (campaigns,
  remote execution) are scaffolding. It has, however, survived weeks of adversarial
  end-to-end testing — every capability above was verified against live agents, and the
  test failures along the way became engine fixes.

## When to reach for it

- You want the **same process** every time a task class runs, regardless of which agent
  does the work.
- You need **review that isn't self-review**, mechanically guaranteed.
- You want to **watch and steer** long agent workflows instead of discovering the
  outcome at the end.
- You need to show someone **what happened and what it cost** — per run, per agent,
  per token.

## Getting started

```sh
git clone https://github.com/mikeparcewski/wicked-crew
cd wicked-crew && npm install && npm run build
node packages/crew/dist/cli/index.js serve
# open http://127.0.0.1:7701
```

Install and authenticate whichever agent CLIs you want on the roster; crew degrades
gracefully to whatever subset it finds.
