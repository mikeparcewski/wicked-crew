# A control plane for coding agents: what wicked-crew studio is and why it exists

*Status: experimental. Everything below has been exercised end-to-end against real CLI
agents — but the project is young, local-first, and evolving. Treat it as a working
research vehicle, not a finished product.*

*Two kinds of verification appear in this article, and they are not the same thing.
Claims tagged *(observed)* are backed by incidents from real working runs. Claims tagged
*(fault-injected)* are backed by deliberately broken configurations built to test a
mechanism. Fault injection proves the mechanism fires; only observation proves it
matters.*

---

## The problem

If you use coding-agent CLIs seriously — Claude Code, Codex, opencode, Copilot, or
several at once — you have probably noticed four things:

1. **There is no process.** The same task, phrased the same way, moves through
   different steps run to run and agent to agent — sometimes reviewed, sometimes not,
   gated wherever the agent felt like pausing.
2. **Agents grade their own homework.** The agent that wrote the code tells you the
   code is fine. Nothing structurally prevents self-approval.
3. **The trail evaporates.** When a run finishes, what actually happened — who decided
   what, what was reviewed, what it cost — lives in a scrollback buffer, if anywhere.
4. **Token burn is opaque.** You find out what a workflow cost when the invoice
   arrives, not while it runs.

Studio (the browser console of
[wicked-crew](https://github.com/mikeparcewski/wicked-crew)) exists to address those
four problems for the CLIs you already have. It doesn't ship a model, doesn't proxy
your API keys, and doesn't replace your agent subscriptions. It is closest in spirit to
a forward-deployed engineer's control plane: one operator, several capable workers, a
defined process, visible decisions, and a paper trail you can hand to someone else.

## The proof point first

The clearest single demonstration of the system is a feature it now ships *(observed)*.

Studio's evidence-export endpoint — one call producing a JSON bundle of a run's units,
transcripts, decision trail, and assumptions — was itself built through a governed crew
run. One CLI took the clarify, design, and build phases. Because it had created the
work, the engine forced the adversarial-review and test units onto a different CLI,
which found a real defect the creator had already signed off on: the two exported
artifact copies were not byte-identical. A human answered two gates along the way. When
the run finished, the new feature was used to export the evidence of its own
construction.

Every mechanism described below — routing, role separation, gates, the event stream —
is visible in that one bundle. The rest of this article is those mechanisms in detail.

That run is also the right place to narrow the promise. What the system enforces — and
what the run demonstrates — is **process consistency**: the same task class always
moves through the same phases, with the same gate policy, whichever agent takes each
step. Whether consistent process produces consistent *outcomes* is the hypothesis the
whole project exists to test, and it has not been measured yet. This article claims the
former and argues for the latter.

## The shape of the thing

Under the hood there are three pieces:

- **wicked-core** — a Rust engine: a single-writer actor that owns workflows-as-data,
  planning, routing, gates, and an event stream. Runs are durable (embedded SQLite);
  every decision is an event.
- **the daemon** (`wicked-crew serve`) — a thin TypeScript surface: REST + WebSocket
  over the engine, and the process that puts your agent adapters on PATH.
- **studio** — the browser console: launch runs, watch every agent live, answer gates,
  inspect the decision trail, export the evidence.

Agents run as workers over the
[Agent Client Protocol](https://agentclientprotocol.com): persistent sessions, streamed
token-level output, structured usage reporting. The adapters come from the ecosystem
where they exist (the official `@agentclientprotocol/claude-agent-acp` and `codex-acp`,
community `pi-acp`, native `copilot --acp` and `opencode acp`). The adapter packages
are npm dependencies — installing the repo installs them; the CLIs themselves (and the
natively-speaking `copilot`/`opencode`) you install and authenticate separately.
Cross-agent context is injected automatically: when unit 4 runs on a
different CLI than unit 3, it receives unit 3's output as labeled context.

> **Terms-of-service note:** crew drives CLIs you install under your own accounts.
> Confirm that programmatic use is permitted by each CLI's terms — community reports
> suggest driving Antigravity (`agy`) this way may conflict with its ToS.

It is fair to ask what this adds to orchestration tools that already exist. Temporal
will run a workflow durably and retry it forever; LangGraph and CrewAI will wire agents
into graphs and pass state between them. The honest distinction is not that they lack
the primitives — Temporal has signals and human-in-the-loop patterns, LangGraph has
interrupts and checkpoints. It is where authority lives. Those tools leave who may
judge a piece of work, what rejection means, and which recovery actions are forbidden
to your application code, where they degrade back into convention. Here they are engine
invariants: an ineligible evaluator cannot be assigned, a rejection cannot be
reinterpreted, a deny-listed flag cannot be auto-applied. Orchestration decides what
runs next; this project is about who gets to decide, enforced below the level where a
prompt can undo it.

## Consistency

A workflow is a JSON document, not code: an ordered list of phases with kinds
(recon/build/review/test), roles (creator/evaluator), and gates. `feature` ships as
clarify → design → build → adversarial-review → test → review. Drop a JSON file in
`~/.config/wicked-core/workflows/` (or point `WICKED_WORKFLOWS_DIR` elsewhere) and the
engine runs yours instead.

A worked example *(observed)*: a four-phase `collab` workflow
(propose → critique → revise → verdict) turned two CLIs into a genuine design
discussion — the critic read the actual source to ground its numbered findings, the
proposer answered each finding explicitly, and the final verdict was an honest "FAIL as
written, but narrowly" with the residuals named. No engine changes — one JSON file,
now a built-in.

## Independence

**Routing.** When a run is planned, every unit is auctioned to the roster: each seat
votes on numbered capability profiles rather than agent names, evaluates through a
distinct lens (capability fit, risk, efficiency, output quality), and the council needs
75% agreement, with runoff rounds where every seat sees the tally and the dissenters'
arguments.

Hiding names makes self-selection harder, not impossible — a model can often recognize
a description of its own capabilities. The mechanism removes the name, not the mirror.

The deliberation apparatus also produced the project's clearest negative result
*(observed)*. On a full six-seat roster, generic one-line tasks never converged: every
seat held its own lens through all three ballots — 17% each — and plurality decided,
which with votes that flat is barely a decision at all. Reading the ballots pointed at
the runoff design, not the seats: on a task with no differentiating signal, the
anti-groupthink instruction ("never converge against your lens") does exactly what it
was told, and the runoff prompt hands dissenters only the objections to answer — never
the leading option's affirmative case. So the runoff is what changes: later ballots
will carry the leader's rationale, not just the tally and the risks. And the threshold
needs stating plainly at the scale most people will run: on a two-CLI roster, 75% means
unanimity or nothing. What survives at every scale is that the disagreement is recorded
and inspectable rather than silently averaged away — but the convergence math is under
revision because implementation showed it wasn't doing the work the design assumed.

**Role separation.** After routing, any review/test unit assigned to a CLI that built
or scoped the work is reassigned to a different seat — enforced in the engine, not
requested in a prompt. This is the mechanism behind the defect catch in the export run
above.

## Control

Between phases, runs pause at gates you answer in studio: **approve**, **approve with
steering**, **reject**, or reassign the unit first. Rejection stops the run — deny
dominates; it is not a signal to be weighed. Steering is not advisory either: in one
verification run *(observed)*, the gate amendment "mention durability" surfaced in the
next phase's output as *"durable across restart"*. Gate policy is per-run: everything
gated, one gate before a chosen phase, or fully autonomous.

Mid-run, the inject bar sends an operator message to all agents or a specific one. On
live terminal sessions it lands immediately; on protocol sessions it queues and rides
the next unit's prompt as an explicit operator context block, with queued/delivered
receipts in the thread. Verified with sentinel tokens echoed back verbatim by the
receiving agents *(observed)*.

## Recovery

When a worker fails, the engine climbs a ladder instead of killing the run:

1. **Known environment refusals self-heal.** A CLI refusing an untrusted directory gets
   the documented trust flag injected and retries. Verified by fault injection: a
   deliberately broken seat refused, the engine re-invoked it with the flag, and the
   run completed *(fault-injected)*.
2. **Unknown failures get a triage judge** — a *different* CLI reads the raw error and
   answers under a strict contract: retry with a single flag, plain retry, escalate, or
   fail. Proposed flags pass a deny-list (nothing privilege-bypassing is ever
   auto-applied) and malformed verdicts escalate rather than execute. In testing
   *(fault-injected)*, the judge derived the correct flag from a fabricated environment
   refusal using the error text alone, and refused to retry a fabricated internal
   fault, failing the run with its reasoning attached.
3. **Escalations reach you pre-diagnosed** — the gate prompt carries both the judge's
   analysis and the CLI's own words.
4. **Autonomous runs skip the detour.** No human in the loop → the classic fail-fast
   contract holds.

The ladder's origin was observed, not injected: a real run stalled on a CLI waiting at
an interactive trust prompt no stream parser could answer.

## The escape

The most valuable thing the whole campaign produced was a failure.

During testing, one worker CLI wrote a duplicate implementation directly into the main
checkout — outside the isolated worktree every run is supposed to be confined to
*(observed)*. The root cause was not an engine bug. The CLI's own configuration marked
an ancestor directory as trusted, and it silently resolved its workspace by walking
*up* out of the run's worktree to that ancestor. A worker's own trust settings turned
out to be a containment threat no design diagram had anticipated.

The fix scopes each worker's workspace explicitly, verified with a live
write-confinement test; the residual risk — trusted ancestors may still win for some
operations — is documented rather than declared solved. It is the cleanest evidence for
the claim this project is built on: the failure was invisible in prose and unmissable
in practice.

## Accountability

**Decisions, not just logs.** Every run page carries a rail of live panels fed by the
event stream: who won each unit's council vote and at what agreement; the gate
decisions; recorded governance claims; files touched; every operator intervention in
order; and per-CLI token, cost, and rework figures as each unit completes. The Burn
panel's dollar figures deserve a footnote: for CLIs running on subscription accounts,
"cost" is an imputed API-equivalent price, not money spent — useful for comparing runs,
not for accounting.

One number this article does not give is the one a skeptical engineer should ask for:
governance overhead. Council ballots per unit, an occasional triage judge, and a second
CLI's review are real token cost layered on top of the work. The Burn panel breaks all
of it out per run; no aggregate figure has been published yet because too few
comparable runs exist to make one honest. Whether adversarial review justifies its cost
is the first question this instrumentation was built to answer, and it is still open.

**Assumptions.** A subtle failure mode of agent-built systems: the work depends on a
third-party library or service that transforms a payload — an address service returning
a corrected address, a tax service enriching line items — and the transformation
semantics live nowhere in your codebase. Crew's convention makes agents record each one
as a structured assumption with an honest confidence: `known` (logic captured) or
`needs-research` (a placeholder badged for human review). In the live verification run
*(observed)*, an agent designing against an address pipeline captured the normalization
library's behavior as known, flagged the tax provider's address-rewriting as
needs-research — including the catch that the provider's rewrite could conflict with
the normalizer — and one malformed marker degraded to a review placeholder instead of
disappearing.

**Evidence.** The export described at the top derives everything from durable run
state — assignments, transcripts, gate outcomes, assumptions, usage, files. Nothing in
it is invented after the fact, because it is not a report about execution; it is a
product of it.

## What it is not

- **Not a hosted service.** Local-first, single host, your machine, your keys.
- **Not a model or an agent.** Bring your own CLIs; crew is the process around them.
- **Not finished.** Interfaces move, and some surfaces (campaigns, remote execution)
  are scaffolding. It has survived weeks of adversarial end-to-end testing, and the
  failures found along the way became engine fixes.

## When to reach for it

- You want the **same process** every time a task class runs, regardless of which agent
  does the work.
- You need **review that isn't self-review**, mechanically guaranteed.
- You want to **watch and steer** long agent workflows instead of discovering the
  outcome at the end.
- You need to show someone **what happened and what it cost** — per run, per agent,
  per token.

## Trying it

```sh
git clone https://github.com/mikeparcewski/wicked-crew
cd wicked-crew && npm install && npm run build
node packages/crew/dist/cli/index.js serve
# open http://127.0.0.1:7701
```

Install and authenticate whichever agent CLIs you want on the roster; crew degrades
gracefully to whatever subset it finds.
