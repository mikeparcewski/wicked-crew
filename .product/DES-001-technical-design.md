---
name: DES-001-technical-design
title: wicked-crew — Technical Design
status: draft
version: 0.1
date: 2026-07-07
author: michael.parcewski@accenture.com
review-required: true
---

# DES-001 — Technical Design

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Terminal / wicked-crew CLI                                             │
│  wicked-crew start / status / resume / gate / workers                  │
└────────────────────┬────────────────────────────────────────────────────┘
                     │ IPC (REST calls to localhost:7701)
┌────────────────────▼────────────────────────────────────────────────────┐
│  wicked-crew daemon  (Node.js + Fastify, port 7701)                    │
│                                                                         │
│  ┌──────────────┐  ┌─────────────────┐  ┌──────────────────────────┐  │
│  │  Phase FSM   │  │ Governance      │  │  Worker Dispatcher       │  │
│  │  (XState v5) │  │ (json-rules-    │  │  (execa + output parser) │  │
│  │              │  │  engine)        │  │                          │  │
│  └──────┬───────┘  └────────┬────────┘  └──────────┬───────────────┘  │
│         │                   │                       │                   │
│  ┌──────▼───────────────────▼───────────────────────▼───────────────┐  │
│  │  Evidence Store + Session Store  (SQLite via better-sqlite3)     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Event Bridge  (wicked-bus cursor poll → WebSocket broadcast)    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │  REST API  (Fastify routes)  +  WebSocket  (/api/v1/events)    │    │
└──┴────────────────────────────────────────────────────────────────┴────┘
                     │ REST + WebSocket (localhost:7701)
┌────────────────────▼────────────────────────────────────────────────────┐
│  wicked-studio  (React app, port 4200)                                  │
│  Session list, PhaseGraph, GatePanel, EvidencePanel, EventFeed          │
└─────────────────────────────────────────────────────────────────────────┘

Workers (spawned as subprocesses by Worker Dispatcher):
  claude --print "<prompt>"
  codex run "<prompt>"
  npx wicked-testing run <plan>
  bash -c "<command>"
```

---

## 2. Repository Structure

Single git repo, npm workspaces:

```
wicked-crew-repo/
├── package.json              # workspace root ({"workspaces": ["packages/*"]})
├── packages/
│   ├── crew/                 # wicked-crew daemon + CLI
│   │   ├── package.json      # name: "wicked-crew", bin: {wicked-crew: dist/cli.js}
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── cli.ts        # CLI entrypoint (@inquirer/prompts)
│   │   │   ├── daemon.ts     # Fastify server + lifecycle
│   │   │   ├── fsm/
│   │   │   │   ├── phase-machine.ts     # XState v5 phase-level actor
│   │   │   │   ├── session-machine.ts   # XState v5 session-level actor
│   │   │   │   └── types.ts
│   │   │   ├── governance/
│   │   │   │   ├── engine.ts            # json-rules-engine wrapper
│   │   │   │   ├── facts.ts             # GateFacts builder from session/phase state
│   │   │   │   └── built-in-policies/   # default JSON policy files
│   │   │   ├── dispatch/
│   │   │   │   ├── dispatcher.ts        # execa subprocess management
│   │   │   │   ├── parser.ts            # stdout → parsed output
│   │   │   │   └── workers.ts           # workers.json loader + hot-reload
│   │   │   ├── store/
│   │   │   │   ├── db.ts                # better-sqlite3 setup, WAL, migrations
│   │   │   │   ├── sessions.ts          # session queries
│   │   │   │   ├── phases.ts            # phase queries
│   │   │   │   ├── dispatches.ts        # dispatch queries
│   │   │   │   ├── evidence.ts          # evidence queries
│   │   │   │   ├── gates.ts             # gate queries
│   │   │   │   ├── raid.ts              # RAID item queries
│   │   │   │   └── snapshots.ts         # XState snapshot persistence
│   │   │   ├── api/
│   │   │   │   ├── sessions.ts          # route handlers for /api/v1/sessions
│   │   │   │   ├── gates.ts             # route handlers for gate actions
│   │   │   │   ├── workers.ts           # route handlers for /api/v1/workers
│   │   │   │   └── events.ts            # WebSocket handler
│   │   │   ├── events/
│   │   │   │   ├── bus.ts               # wicked-bus cursor poll
│   │   │   │   └── bridge.ts            # bus events → WebSocket broadcast
│   │   │   └── config.ts               # ~/.wicked-crew/config.json loader
│   │   └── tests/
│   │       ├── unit/
│   │       └── integration/
│   └── studio/               # wicked-studio React app
│       ├── package.json      # name: "wicked-studio"
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── api/
│       │   │   ├── client.ts            # fetch wrapper (base URL from config)
│       │   │   └── types.ts             # shared API types (copied from crew)
│       │   ├── components/
│       │   │   ├── SessionList.tsx
│       │   │   ├── SessionDetail.tsx
│       │   │   ├── PhaseGraph.tsx
│       │   │   ├── GatePanel.tsx
│       │   │   ├── EvidencePanel.tsx
│       │   │   ├── EventFeed.tsx
│       │   │   ├── WorkerRegistry.tsx
│       │   │   └── ConnectionStatus.tsx
│       │   ├── hooks/
│       │   │   ├── useSessions.ts       # TanStack Query
│       │   │   ├── useSession.ts
│       │   │   ├── useEventStream.ts    # WebSocket hook
│       │   │   └── useGateActions.ts
│       │   └── store/
│       │       └── useUIStore.ts        # Zustand
│       └── tests/
├── config/                   # Shared config types (API contract)
│   └── api-contract.ts       # Single source of truth for REST + WS types
└── .github/workflows/
    └── release.yml
```

---

## 3. SQLite Schema

Database path: `~/.wicked-crew/wicked-crew.db`. WAL mode enabled on first open.

```sql
-- Migrations are numbered sequential SQL files: store/migrations/001_init.sql

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,                -- "feature" | "fix" | "migrate" | custom
  goal        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active', -- "active"|"paused"|"completed"|"failed"|"abandoned"
  current_phase TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'terminal', -- "terminal"|"studio"|"api"|"signals:<id>"
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE phases (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  phase_id      TEXT NOT NULL,             -- "clarify"|"design"|"test-strategy"|"build"|"test"|"ship"
  state         TEXT NOT NULL DEFAULT 'Open',
  gate_kind     TEXT NOT NULL DEFAULT 'auto', -- "auto"|"human"|"council"
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  blocking_raid_ids TEXT NOT NULL DEFAULT '[]'  -- JSON array of RAID item ids
);

CREATE TABLE dispatches (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  phase_id          TEXT NOT NULL,
  worker_id         TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  context_snapshot  TEXT NOT NULL DEFAULT '{}', -- JSON of prior phase artifacts
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  exit_code         INTEGER,
  output            TEXT,                  -- raw stdout
  parsed_output_json TEXT,                 -- result of output parsing
  status            TEXT NOT NULL DEFAULT 'pending' -- "pending"|"running"|"success"|"timeout"|"error"
);

CREATE TABLE evidence (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  phase_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- "worker-output"|"gate-decision"|"human-approval"|"test-verdict"|"raw-text"
  content_json  TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  actor         TEXT NOT NULL,             -- worker_id | "human" | "governance"
  attestation_json TEXT                    -- nullable; wicked-testing attestation chain
);

CREATE TABLE gates (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  phase_id              TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  evaluated_at          TEXT NOT NULL,
  result                TEXT NOT NULL,     -- "approved"|"rejected"|"approved-with-conditions"
  policies_evaluated_json TEXT NOT NULL DEFAULT '[]',
  blocking_policies_json  TEXT NOT NULL DEFAULT '[]',
  human_override_json   TEXT              -- nullable; HumanDecision JSON
);

CREATE TABLE raid_items (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  kind        TEXT NOT NULL,              -- "risk"|"assumption"|"issue"|"decision"
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open', -- "open"|"resolved"|"accepted"
  blocks_phase TEXT,                      -- nullable; phase_id this blocks
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE xstate_snapshots (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id),
  snapshot_json TEXT NOT NULL,            -- JSON.stringify(actor.getSnapshot())
  updated_at    TEXT NOT NULL
);

-- Indexes
CREATE INDEX idx_phases_session_id ON phases(session_id);
CREATE INDEX idx_dispatches_session_phase ON dispatches(session_id, phase_id);
CREATE INDEX idx_evidence_session_phase ON evidence(session_id, phase_id);
CREATE INDEX idx_gates_session_phase ON gates(session_id, phase_id);
CREATE INDEX idx_raid_session ON raid_items(session_id);
```

---

## 4. XState v5 Phase State Machine

Each session runs a session-level actor that manages the phase sequence. Each active phase runs a phase-level actor.

### 4.1 Phase-Level Machine

```typescript
// src/fsm/phase-machine.ts
import { createMachine, assign } from 'xstate';

export const phaseMachine = createMachine({
  id: 'phase',
  initial: 'Open',
  context: {
    phaseId: '',
    sessionId: '',
    gateKind: 'auto' as 'auto' | 'human' | 'council',
    evidenceIds: [] as string[],
    blockingRaidCount: 0,
    dispatchAttempts: 0,
    humanDecision: null as HumanDecision | null,
    conditions: null as string | null,
    councilScore: null as number | null,  // set by AwaitingCouncil; read by evaluateGate
  },
  states: {
    Open: {
      on: { START: 'InProgress' }
    },
    InProgress: {
      on: { DISPATCH: 'AwaitingWorker' }
    },
    AwaitingWorker: {
      on: {
        WORKER_COMPLETE: {
          target: 'ReadyForGate',
          actions: assign({ evidenceIds: ({ context, event }) =>
            [...context.evidenceIds, event.evidenceId]
          })
        },
        WORKER_FAILED: {
          target: 'InProgress',
          actions: assign({ dispatchAttempts: ({ context }) => context.dispatchAttempts + 1 })
        }
      }
    },
    ReadyForGate: {
      always: [
        { guard: 'isHumanGate',   target: 'AwaitingHuman' },
        { guard: 'isCouncilGate', target: 'AwaitingCouncil' },
        { target: 'GateRunning' }
      ]
    },
    AwaitingHuman: {
      on: {
        HUMAN_APPROVE: { target: 'GateRunning', actions: assign({ humanDecision: ({ event }) => event.decision }) },
        HUMAN_REJECT:  { target: 'Rejected',    actions: assign({ humanDecision: ({ event }) => event.decision }) },
        HUMAN_APPROVE_WITH_CONDITIONS: {
          target: 'GateRunning',
          actions: assign({
            humanDecision: ({ event }) => event.decision,
            conditions:    ({ event }) => event.conditions,
          })
        }
      }
    },
    // AwaitingCouncil: dispatches N workers in parallel via dispatchCouncil(),
    // then stores the synthesisScore in context before transitioning to GateRunning.
    // council_score in GateFacts is populated from context.councilScore.
    AwaitingCouncil: {
      invoke: {
        src: 'runCouncil',       // calls dispatchCouncil(); returns CouncilResult
        onDone: {
          target: 'GateRunning',
          actions: assign({ councilScore: ({ event }) => event.output.synthesisScore })
        },
        onError: 'Rejected'
      }
    },
    GateRunning: {
      invoke: {
        src: 'evaluateGate',
        // council_score is sourced from context.councilScore (set by AwaitingCouncil)
        onDone: [
          { guard: ({ event }) => event.output.result === 'approved', target: 'Approved' },
          { guard: ({ event }) => event.output.result === 'approved-with-conditions', target: 'Approved' },
          { target: 'Rejected' }
        ],
        onError: 'Rejected'
      }
    },
    Approved: { type: 'final' },
    Rejected: {
      on: { RETRY: 'InProgress' }
    }
  }
}, {
  guards: {
    isHumanGate:   ({ context }) => context.gateKind === 'human',
    isCouncilGate: ({ context }) => context.gateKind === 'council',
  }
});
```

### 4.2 Session-Level Machine

The session machine carries `lastActivePhase` in its context so that RESUME
targets the correct phase, not phaseIds[0].

`runPhase` is implemented as a child state machine actor (not a Promise), so
XState v5 can serialize its in-progress state into the session snapshot and
fully restore it on resume — including a phase stuck in AwaitingWorker.

```typescript
// src/fsm/session-machine.ts

// sessionId is passed in so phase child actors can persist evidence with the correct id.
export function buildSessionMachine(workflowType: WorkflowType, sessionId: string) {
  const phaseIds = workflowType.phases.map(p => p.id);

  return createMachine({
    id: 'session',
    initial: phaseIds[0],
    context: {
      sessionId,                        // carried so child actors receive it via invoke input
      lastActivePhase: phaseIds[0],     // updated on every phase entry; used by RESUME
    },
    states: Object.fromEntries(
      phaseIds.map((phaseId, i) => [
        phaseId,
        {
          entry: assign({ lastActivePhase: phaseId }),
          // phaseMachine is a child state-machine actor.
          // XState v5 includes child actor snapshots in the parent snapshot,
          // so mid-phase state (AwaitingHuman, AwaitingCouncil, etc.) survives crash+resume.
          invoke: { src: 'phaseMachine', input: ({ context }) => ({ phaseId, sessionId: context.sessionId }) },
          on: {
            PHASE_APPROVED: phaseIds[i + 1]
              ? { target: phaseIds[i + 1] }
              : { target: 'completed' },
            PHASE_REJECTED: { target: 'failed' },
            PHASE_PAUSED:   { target: 'paused' }
          }
        }
      ]).concat([
        ['completed', { type: 'final' }],
        ['failed',    { type: 'final' }],
        // Dynamic target expression transitions to lastActivePhase from context.
        // self.send() would queue an event that paused ignores — dynamic target is correct.
        ['paused', { on: { RESUME: { target: ({ context }) => context.lastActivePhase } } }]
      ])
    )
  });
}
```

**Note on paused resume**: The `paused` state's `RESUME` transition uses a dynamic `target` expression `({ context }) => context.lastActivePhase`. This is XState v5's supported mechanism for data-driven transitions. On `restoreSnapshot` + `actor.start()` the actor is in `paused`; sending RESUME transitions directly to the stored phase state (e.g. `build`). The child `phaseMachine` snapshot is embedded in the parent snapshot, so mid-phase state (AwaitingHuman, AwaitingCouncil) also restores.

### 4.3 Checkpoint / Resume

```typescript
// src/store/snapshots.ts
export function saveSnapshot(db: Database, sessionId: string, actor: AnyActor): void {
  const snapshot = JSON.stringify(actor.getSnapshot());
  db.prepare(`
    INSERT INTO xstate_snapshots (session_id, snapshot_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
  `).run(sessionId, snapshot, new Date().toISOString());
}

export function restoreSnapshot(db: Database, sessionId: string, machine: AnyStateMachine): AnyActor | null {
  const row = db.prepare('SELECT snapshot_json FROM xstate_snapshots WHERE session_id = ?').get(sessionId);
  if (!row) return null;
  const snapshot = JSON.parse(row.snapshot_json);
  return createActor(machine, { snapshot });
}
```

Snapshots are written after every state transition. Resume calls `restoreSnapshot` → `actor.start()`.

---

## 5. Governance Engine

```typescript
// src/governance/engine.ts
import { Engine, Rule } from 'json-rules-engine';

export interface GateFacts {
  evidence_kinds: string[];     // all evidence.kind values for this phase
  blocking_raid_count: number;  // open RAID items where blocks_phase === current phase
  worker_exit_codes: number[];  // all dispatch exit_codes (non-null only) — for display
  worker_all_success: boolean;  // derived: worker_exit_codes.every(c => c === 0)
  gate_kind: 'auto' | 'human' | 'council';
  council_score: number | null;
  test_verdict: string | null;  // "PASS" | "CONDITIONAL" | "FAIL" | null
  human_override: boolean;
}

export async function evaluateGate(
  policies: Rule[],
  facts: GateFacts
): Promise<{ result: 'approved' | 'rejected'; blockingPolicies: string[] }> {
  const engine = new Engine(policies);
  const { failureResults } = await engine.run(facts);

  if (failureResults.length === 0) return { result: 'approved', blockingPolicies: [] };
  return {
    result: 'rejected',
    blockingPolicies: failureResults.map(r => r.name)
  };
}
```

### 5.1 Built-in Policy Files

```json
// governance/built-in-policies/evidence-required.json
{
  "name": "evidence-required",
  "conditions": {
    "all": [{ "fact": "evidence_kinds", "operator": "contains", "value": "worker-output" }]
  },
  "event": { "type": "evidence-required" }
}

// governance/built-in-policies/no-blocking-raid.json
{
  "name": "no-blocking-raid",
  "conditions": {
    "all": [{ "fact": "blocking_raid_count", "operator": "equal", "value": 0 }]
  },
  "event": { "type": "no-blocking-raid" }
}

// governance/built-in-policies/worker-exit-success.json
// Blocks if ANY dispatch in this phase exited non-zero (error OR timeout).
// Uses a computed fact `worker_all_success` (bool) derived in facts.ts:
//   worker_all_success = worker_exit_codes.every(c => c === 0)
{
  "name": "worker-exit-success",
  "conditions": {
    "all": [{ "fact": "worker_all_success", "operator": "equal", "value": true }]
  },
  "event": { "type": "worker-exit-success" }
}
// Note: worker_exit_codes array is still in GateFacts for human-readable display;
// worker_all_success is the derived boolean the policy evaluates against.

// governance/built-in-policies/test-verdict-pass.json
{
  "name": "test-verdict-pass",
  "conditions": {
    "any": [
      { "fact": "test_verdict", "operator": "equal", "value": "PASS" },
      { "fact": "test_verdict", "operator": "equal", "value": "CONDITIONAL" }
    ]
  },
  "event": { "type": "test-verdict-pass" }
}

// governance/built-in-policies/human-approval-required.json
{
  "name": "human-approval-required",
  "conditions": {
    "all": [{ "fact": "human_override", "operator": "equal", "value": true }]
  },
  "event": { "type": "human-approval-required" }
}
```

---

## 6. Worker Dispatcher

```typescript
// src/dispatch/dispatcher.ts
import { execa } from 'execa';

export interface Worker {
  id: string;
  command: string[];            // argv[0] is the binary
  output_format: 'json' | 'text' | 'structured-text';
  timeout_seconds: number;
  env?: Record<string, string>;
  capabilities?: string[];
}

export interface DispatchResult {
  exit_code: number;
  raw_output: string;
  parsed_output: unknown;
  status: 'success' | 'timeout' | 'error';
}

export async function dispatch(
  worker: Worker,
  prompt: string,
  contextSnapshot: Record<string, unknown>
): Promise<DispatchResult> {
  const fullPrompt = buildPrompt(prompt, contextSnapshot);
  const args = buildArgs(worker, fullPrompt);

  try {
    const result = await execa(worker.command[0], [...worker.command.slice(1), ...args], {
      timeout: worker.timeout_seconds * 1000,
      forceKillAfterDelay: 5000,    // cross-platform: execa handles SIGTERM/SIGKILL/Windows
      reject: false,                 // never throw — inspect exit code ourselves
      env: { ...process.env, ...worker.env },
    });

    const parsedOutput = parseOutput(result.stdout, worker.output_format);
    return {
      exit_code: result.exitCode ?? 0,
      raw_output: result.stdout,
      parsed_output: parsedOutput,
      status: result.exitCode === 0 ? 'success' : 'error'
    };
  } catch (err: unknown) {
    // execa only throws for non-process errors (e.g. binary not found)
    if (isExecaError(err) && err.timedOut) {
      return { exit_code: -1, raw_output: err.stdout ?? '', parsed_output: null, status: 'timeout' };
    }
    return { exit_code: -2, raw_output: String(err), parsed_output: null, status: 'error' };
  }
}

function buildPrompt(prompt: string, contextSnapshot: Record<string, unknown>): string {
  const contextText = JSON.stringify(contextSnapshot, null, 2);
  return [
    'You are being orchestrated by wicked-crew worker protocol v1.',
    `Session context: ${contextText}`,
    '',
    prompt,
    '',
    'Output: emit a JSON object as the LAST LINE of your response. Schema: { status, artifact, reasoning?, warnings?, votes? }',
  ].join('\n');
}

function buildArgs(worker: Worker, prompt: string): string[] {
  // Maps worker input_mode (from agentic_cli_registry conventions) to argv
  // For "prompt-arg" mode: the prompt is the last argument
  // For "stdin" mode: we use execa's input option instead (handled in caller)
  // Default for claude --print, codex run: prompt-arg
  return [prompt];
}
```

### 6.1 Output Parser

```typescript
// src/dispatch/parser.ts
export function parseOutput(stdout: string, format: 'json' | 'text' | 'structured-text'): unknown {
  if (!stdout || stdout.trim() === '') return null;

  const lines = stdout.trim().split('\n');

  // Try last line as JSON
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        return JSON.parse(line);
      } catch { /* continue scanning */ }
    }
  }

  // Try the full stdout as JSON (some workers emit pretty-printed)
  try { return JSON.parse(stdout.trim()); } catch { /* not JSON */ }

  // Unstructured fallback
  return { _raw: stdout, _format: 'raw-text' };
}
```

### 6.2 Council Dispatch (parallel)

```typescript
// src/dispatch/dispatcher.ts (additions)
export interface CouncilResult {
  workerResults: Array<{ workerId: string; result: DispatchResult }>;
  synthesisScore: number;   // mean dimension-agreement fraction across all workers
  recommendation: string;   // plurality recommendation across workers
}

export async function dispatchCouncil(
  workerIds: string[],
  prompt: string,
  contextSnapshot: Record<string, unknown>
): Promise<CouncilResult> {
  // All workers dispatched in parallel — Promise.all, not sequential
  const results = await Promise.all(
    workerIds.map(async (workerId) => {
      const worker = getWorker(workerId);
      if (!worker) throw new Error(`Worker not found: ${workerId}`);
      const result = await dispatch(worker, prompt, contextSnapshot);
      return { workerId, result };
    })
  );

  return synthesizeCouncil(results);
}

function synthesizeCouncil(
  results: Array<{ workerId: string; result: DispatchResult }>
): CouncilResult {
  // Extract votes from parsed outputs (only workers that returned valid JSON with votes)
  const votes = results
    .map(r => {
      const parsed = r.result.parsed_output as Record<string, unknown> | null;
      return parsed?.votes as Record<string, unknown> | undefined;
    })
    .filter((v): v is Record<string, unknown> => v != null);

  if (votes.length === 0) return {
    workerResults: results, synthesisScore: 0, recommendation: 'insufficient-data'
  };

  // Per dimension: count the plurality answer, compute fraction
  const allDimensions = new Set(votes.flatMap(v =>
    Object.keys(v.dimensions as Record<string, string> ?? {})
  ));

  const dimensionAgreements: number[] = [];
  for (const dim of allDimensions) {
    const answers = votes.map(v => (v.dimensions as Record<string, string>)?.[dim]).filter(Boolean);
    if (answers.length === 0) continue;
    const counts = Object.fromEntries([...new Set(answers)].map(a =>
      [a, answers.filter(x => x === a).length]
    ));
    const maxCount = Math.max(...Object.values(counts));
    dimensionAgreements.push(maxCount / votes.length);
  }

  const synthesisScore = dimensionAgreements.length > 0
    ? dimensionAgreements.reduce((a, b) => a + b, 0) / dimensionAgreements.length
    : 0;

  const recommendations = votes.map(v => v.recommendation as string).filter(Boolean);
  const recCounts = Object.fromEntries([...new Set(recommendations)].map(r =>
    [r, recommendations.filter(x => x === r).length]
  ));
  const recommendation = Object.entries(recCounts).sort(([,a], [,b]) => b - a)[0]?.[0] ?? 'neutral';

  return { workerResults: results, synthesisScore, recommendation };
}
```

### 6.3 Workers.json Hot-Reload

```typescript
// src/dispatch/workers.ts
import { watch } from 'node:fs';

let workers: Record<string, Worker> = {};
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startWorkerHotReload(configPath: string, pollIntervalSeconds = 30): void {
  workers = loadWorkers(configPath);

  // Primary: fs.watch() for immediate notification on systems where it works
  try {
    watch(configPath, { persistent: false }, () => {
      try { workers = loadWorkers(configPath); } catch { /* ignore parse errors mid-write */ }
    });
  } catch { /* fs.watch() unavailable — fall through to poll-only */ }

  // Fallback: poll-based reload covers editor atomic writes (vim/VS Code
  // unlink+rename pattern breaks inotify file watches on Linux) and NFS mounts.
  // SC-008 requires detection within 30 seconds — poll interval satisfies this.
  pollTimer = setInterval(() => {
    try { workers = loadWorkers(configPath); } catch { /* ignore */ }
  }, pollIntervalSeconds * 1000);
}

export function getWorker(id: string): Worker | undefined {
  return workers[id];
}
```

---

## 7. REST API Specification

Base URL: `http://127.0.0.1:7701/api/v1`

All responses: `Content-Type: application/json`. All errors: `{ "error": "message" }`.

### Sessions

```
POST /sessions
Body:  { type: string, goal: string, source?: string, config?: object }
201:   { id, type, goal, status, current_phase, created_at, phases: Phase[] }
       // phases[] included so wicked-studio can render PhaseGraph without a second GET

GET /sessions
Query: ?status=active&limit=20&offset=0
200:   { sessions: SessionCard[], total: number }

GET /sessions/:id
200:   { session: Session, phases: Phase[], evidence_summary: EvidenceSummary }

PATCH /sessions/:id
Body:  { status: "paused" | "abandoned" }
200:   { session: Session }
```

### Gates

```
POST /sessions/:id/gates/:phase/approve
Body:  {}
200:   { gate: Gate, phase: Phase }

POST /sessions/:id/gates/:phase/approve-with-conditions
Body:  { conditions: string }
200:   { gate: Gate, phase: Phase, raid_item: RaidItem }

POST /sessions/:id/gates/:phase/reject
Body:  { reason?: string }
200:   { gate: Gate, phase: Phase }
```

### Evidence

```
GET /sessions/:id/evidence
Query: ?phase=clarify&kind=worker-output&limit=50
200:   { evidence: Evidence[] }

GET /sessions/:id/evidence/:evidenceId
200:   { evidence: Evidence }
```

### Workers

```
GET /workers
200:   { workers: WorkerStatus[] }
       WorkerStatus: { id, command, capabilities, detected: boolean, version?: string }
```

### Config

```
GET /config
200:   { port: number, log_level: string, default_worker: string, daemon_version: string }
```

### Events (WebSocket)

```
WS /api/v1/events
```

Client connects. Server streams all wicked-bus events matching `wicked.crew.*` as JSON messages:

```typescript
interface WSEvent {
  type: string;         // e.g. "wicked.crew.phase.gate.approved"
  domain: string;       // "wicked-crew"
  subdomain: string;
  payload: Record<string, unknown>;  // always includes session_id, phase, timestamp
  bus_id: string;
  timestamp: string;
}
```

Server also sends a heartbeat every 30 seconds: `{ type: "heartbeat", timestamp: "..." }`.

Client disconnect: server removes client from broadcast list (no error logged).

---

## 8. Event Bridge (wicked-bus → WebSocket)

```typescript
// src/events/bridge.ts
import { createCursor } from 'wicked-bus';

let clients: Set<WebSocket> = new Set();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
  ws.addEventListener('close', () => clients.delete(ws));
}

export function startEventBridge(busDbPath: string): void {
  const cursor = createCursor({ dbPath: busDbPath, filter: 'wicked.crew.' });

  setInterval(() => {
    const events = cursor.poll();
    for (const event of events) {
      const msg = JSON.stringify(event);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg, (err) => {
            if (err) {
              log.warn({ err }, 'WebSocket send failed — removing client');
              clients.delete(client);
              client.terminate();
            }
          });
        }
      }
    }
  }, 200);  // 200ms poll interval
}
```

The bridge polls wicked-bus every 200ms and broadcasts new events to all connected WebSocket clients. No event is delivered more than once per client (cursor tracks position).

---

## 9. CLI Commands

```
wicked-crew serve [--port 7701] [--ui]
  Start the daemon. --ui opens wicked-studio in the default browser.

wicked-crew start --type <type> --goal "<text>" [--worker <id>] [--ui]
  Create and start a session. Calls POST /sessions internally.

wicked-crew status [--session <id>]
  With no session: list all active sessions.
  With session: show phase graph, current state, blockers.

wicked-crew resume --session <id>
  Resume a paused or crashed session. Restores XState snapshot from SQLite.

wicked-crew gate --session <id> --phase <phase> --action approve|reject|conditions
  [--conditions "<text>"]
  HITL gate action from terminal. Calls the appropriate gate endpoint.

wicked-crew workers [--add|--remove]
  List registered workers and their detection status.
  --add opens workers.json in $EDITOR.

wicked-crew --version
  Print daemon version.
```

---

## 10. Daemon Startup Sequence

```
1. Load config from ~/.wicked-crew/config.json (or defaults)
2. Open SQLite at ~/.wicked-crew/wicked-crew.db (WAL mode, run migrations)
3. Load workers from ~/.wicked-crew/workers.json + start hot-reload watcher
4. Start wicked-bus cursor poll + WebSocket bridge
5. Start Fastify server on 127.0.0.1:7701
6. Restore any sessions in status="active" (load XState snapshots, resume actors)
7. Log: "wicked-crew daemon v{version} ready on port 7701"

On SIGTERM / SIGINT:
1. Save all active session XState snapshots to SQLite
2. Close SQLite gracefully
3. Shutdown Fastify
4. Exit 0
```

---

## 11. Default workers.json

Shipped with the npm package at `defaults/workers.json`. Copied to `~/.wicked-crew/workers.json` on first run if absent.

```json
{
  "claude": {
    "id": "claude",
    "command": ["claude", "--print"],
    "output_format": "structured-text",
    "timeout_seconds": 120,
    "capabilities": ["clarify", "design", "test-strategy", "build", "review"]
  },
  "codex": {
    "id": "codex",
    "command": ["codex", "run"],
    "output_format": "structured-text",
    "timeout_seconds": 180,
    "capabilities": ["build", "test"]
  },
  "wicked-testing": {
    "id": "wicked-testing",
    "command": ["npx", "wicked-testing", "run"],
    "output_format": "json",
    "timeout_seconds": 300,
    "capabilities": ["test"]
  },
  "shell": {
    "id": "shell",
    "command": ["bash", "-c"],
    "output_format": "text",
    "timeout_seconds": 60,
    "capabilities": []
  }
}
```

---

## 12. wicked-studio Component Hierarchy

```
App
├── ConnectionStatus          // ● connected / ○ disconnected badge
├── Layout
│   ├── Sidebar
│   │   ├── SessionList       // uses useSessions() + TanStack Query
│   │   │   ├── SessionCard[] // goal, type, phase badge, status dot
│   │   │   └── StatusFilter  // all / active / paused / completed
│   │   ├── GateNotifications // ShadCN Badge + toast on gate.awaiting_human events
│   │   ├── EventFeed         // last 500 WebSocket events, filterable
│   │   └── NavLinks          // Workers, Settings
│   └── MainContent (route-based)
│       ├── /sessions/:id → SessionDetail
│       │   ├── SessionHeader  // goal, type, status, source
│       │   ├── PhaseGraph     // Recharts / custom SVG FSM visualization
│       │   │   └── PhaseNode[] // per phase: name, state badge, gate kind icon
│       │   ├── GatePanel      // shown when gate.awaiting_human for this session
│       │   │   ├── ArtifactViewer  // phase artifact text (monospace, scrollable)
│       │   │   ├── GovernanceFindings // policies passed/failed list
│       │   │   └── ActionButtons  // [Approve] [Reject] [Modify with conditions]
│       │   │       └── ConditionsDialog // ShadCN Dialog with textarea
│       │   └── EvidencePanel   // evidence list for selected phase
│       │       └── EvidenceRecord[] // expandable, kind badge, actor, timestamp
│       ├── /workers → WorkerRegistry
│       │   └── WorkerCard[] // id, command, capabilities, detected status
│       └── /settings → SettingsPanel
│           └── DaemonConfig   // port, log level (read-only in v1)
```

### 12.1 Key Hooks

```typescript
// hooks/useEventStream.ts
export function useEventStream(): WSEvent[] {
  const [events, setEvents] = useState<WSEvent[]>([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    const ws = new WebSocket('ws://127.0.0.1:7701/api/v1/events');
    ws.onmessage = (e) => {
      const event: WSEvent = JSON.parse(e.data);
      setEvents(prev => [...prev.slice(-499), event]); // keep last 500

      // Invalidate React Query caches on relevant events
      if (event.type.startsWith('wicked.crew.session.')) {
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
      }
      if (event.type.startsWith('wicked.crew.phase.') || event.type.startsWith('wicked.crew.gate.')) {
        queryClient.invalidateQueries({ queryKey: ['session', event.payload.session_id] });
      }
    };
    ws.onclose = () => { /* show disconnected state */ };
    return () => ws.close();
  }, [queryClient]);

  return events;
}
```

---

## 13. Port Allocation

| Service | Default port | Configurable |
|---|---|---|
| wicked-crew daemon | 7701 | Yes — `~/.wicked-crew/config.json` `port` field |
| wicked-studio | 4200 | Yes — Vite config / env var |
| wicked-garden daemon | 7700 | Existing (not changed) |

---

## 14. Config File Schema

`~/.wicked-crew/config.json`:
```json
{
  "port": 7701,
  "log_level": "info",
  "default_worker": "claude",
  "bus_db_path": "~/.something-wicked/wicked-bus.db",
  "workers_json_path": "~/.wicked-crew/workers.json",
  "workers_poll_interval_seconds": 30,
  "studio_port": 4200
}
```

Fields not present use the defaults shown above.

---

## 15. Build + Publish

Both packages published on npm via OIDC trusted publishing:

```yaml
# .github/workflows/release.yml
permissions:
  id-token: write
steps:
  - uses: actions/setup-node@v6
    with: { node-version: 20, registry-url: 'https://registry.npmjs.org' }
  - run: npm ci && npm run build --workspaces
  - run: npm publish --provenance --access public
    working-directory: packages/crew
  - run: npm publish --provenance --access public
    working-directory: packages/studio
```

Install paths:
- `npm install -g wicked-crew` → `wicked-crew` binary available
- `npm install -g wicked-studio` → `wicked-studio` binary (serves static build)
- `npx wicked-crew start` → no global install required

---

## 16. Open Items for Build Phase

| Item | Detail |
|---|---|
| Context window truncation | REQ-001 §5 says truncate context >8K tokens. Use 32K chars as conservative proxy (1 token ≈ 4 chars). Truncation strategy: drop the oldest complete phase artifact objects from the context snapshot first (not string-slice, which produces malformed JSON). Phases are sorted oldest-first; remove until under limit. The goal text and current-phase artifact are never truncated. |
| wicked-testing worker integration | `npx wicked-testing run <plan>` output format: confirm verdict.json location and schema. |
| FSM replay vs snapshot | Use snapshot (XState `actor.getSnapshot()`) — not event replay. Simpler and faster for resume. |
| workers.json poll vs inotify | Use `node:fs` `watch()` (inotify on Linux, FSEvents on macOS, polling on Windows). Already handles cross-platform. |
| Studio build artifacts | Vite output goes to `packages/studio/dist/`. `wicked-studio` binary serves this with `@fastify/static`. |
