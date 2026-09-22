// FIX-IT-ALL L8-0b — the crew-side EXPECTATION for L4 PR-② (DES-L4 §5 ②, register line R8 /
// BC-23), recorded BEFORE ② merges (des-adjudicated §1 row 0.3 "must precede L4 ②").
//
// The coming terminal semantics: `mkdir` becomes a WRITE TARGET in the engine's Bash command table
// (`gate_hook.rs::bash_write_targets`), so a Full-posture CREATOR running `mkdir -p <outside the
// boundary>` is refused by the filesystem-boundary arm exactly as a redirect outside is today —
// unit-FATAL — and the run parks at the escalation gate:
//   gateEscalated{condition: 'boundary_deny', denialSource: 'input_governance', ord: <creator>}
//   → awaitingHuman{gateKind: 'escalation'}; 0 sessionFailed; `mkdir src/new` INSIDE the tree stays
//   allowed. Under ReadOnly / pre-build postures the same target is advisory (workerToolCallDenied).
//
// What this file pins TODAY (passes on every engine): the frame SHAPE the daemon will relay — the
// DES-SHAPED 11-key frame of that class in `fixtures/engine-frames-0.38.0.json` (the key set and the
// `false` / `[]` / `null` conventions are the engine's `to_json`; the class pair is DES-L4 R8; the
// `verdictSummary` prose is the design's, NOT a recording — nothing here pins that text) satisfies
// api-types 0.38.0 and carries the (condition, denialSource) pair the studio copy table keys on — and the
// crew-side inventory fact that makes ② safe to merge: no crew test asks a worker to `mkdir` outside
// its boundary (the one `mkdir -p e2e tests` in the qe-author e2e is inside the worktree), so ②
// cannot break crew CI and no existing expectation has to flip.
//
// What it does NOT pin yet — NOT_FIXED_YET, `it.todo` below: the EXECUTABLE launch test. The
// stub engine (`CoreAdapter({ stub: true })`, every crew integration rig) never runs a governance
// hook — its Tool phases spawn real subprocesses but bypass the PreToolUse gate-hook, and its agent
// units are the StubStepRunner. Driving the real refusal needs the REAL engine plus a scripted ACP
// agent that raises `session/request_permission` for `execute` `mkdir -p <outside>` (the
// `acp-bridge-kill` rig's STUB_AGENT shape) INSIDE a registered repo (the boundary is the run
// worktree — a free-text launch has none). That harness is the follow-up named in the lane log;
// L4's own core test (`gate_hook.rs` ② unit tests + the S-L4a smoke step) covers the refusal itself.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GateEscalatedEvent } from 'wicked-crew-api-types';

const FIXTURE = fileURLToPath(new URL('./fixtures/engine-frames-0.38.0.json', import.meta.url));

describe('L4 ② expectation — a creator `mkdir -p <outside the boundary>` parks the run at a boundary_deny gate', () => {
  const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  const frame = recorded['gateEscalatedCreatorMkdirOutside'] as GateEscalatedEvent;

  it('the DES-shaped frame the daemon will relay: gateEscalated{boundary_deny × input_governance} on the creator, engine-authored, nothing to restore', () => {
    expect(frame.type).toBe('gateEscalated');
    expect(frame.condition).toBe('boundary_deny');
    expect(frame.denialSource).toBe('input_governance');
    expect(frame.defGate).toBe(false);
    // A refused tool call captures no worker output and touches no tree: the guard's restore
    // fields are the class's `false` / `[]` / `null`, present not absent.
    expect(frame.outputCaptured).toBe(false);
    expect(frame.restored).toBe(false);
    expect(frame.discarded).toEqual([]);
    expect(frame.suggestionRef).toBeNull();
    // No assertion on `verdictSummary`: the fixture's sentence is the design's wording, and pinning
    // it here could only ever agree with itself — the engine's text lands with L4 ②.
  });

  it('the (condition, denialSource) pair is one the studio copy table must key on — distinct from the hook-veto arm whose source is ""', () => {
    const veto = recorded['gateEscalatedHookVeto'] as GateEscalatedEvent;
    expect(veto.condition).toBe('boundary_deny');
    expect(veto.denialSource).toBe('');
    expect(frame.denialSource).not.toBe(veto.denialSource);
  });

  it.todo(
    'NOT_FIXED_YET (L4 ②, core-ts 0.7.26): REAL engine + scripted ACP creator in a registered repo — `mkdir -p <outside>` → gateEscalated{boundary_deny, input_governance} → awaitingHuman{escalation}; `mkdir src/new` → allowed; 0 sessionFailed (harness: see the header)',
  );
});
