/**
 * THE DELIVERABLE FLOOR (crew#311) — "done" is re-derived from the artifact, never asserted.
 *
 * ## The defect
 *
 * A governed unit that produced NOTHING still passed its execution gate on the strength of a
 * prose reply. The engine's only universal floor is the SUBSTANCE floor
 * (wicked-core `actor.rs`, "phase produced no reviewable substance"): a governed
 * Creator/Neutral unit is rejected only when its output carries BOTH under 200 trimmed chars
 * of prose AND no worktree change. So ~200 characters of narration — "I'll read the design
 * spec, let me check the API types…" — clears it, with no file anywhere. Prose length stood in
 * for evidence.
 *
 * The engine has two real evidence instruments, and neither reaches a run of this shape:
 *
 *  1. `validator_pin` → the built-in EVIDENCE floor (`builtin_floors::EVIDENCE_FLOOR_PIN`,
 *     criterion "the run left a change in its worktree (done is re-derived from the diff, never
 *     asserted)"). It re-verifies a git DIFF, and is fail-closed on a run with no worktree — so
 *     an UNBOUND run (`repoRef` omitted, `workdir: null`) can never satisfy it. Every crew
 *     interactive seam launches unbound on purpose (wicked-core#293/#294), and their deliverable
 *     is a FILE in a declared write root, invisible to a diff.
 *  2. `required_deliverables` → enforced by wicked-core as of FINDING-101, but only in the
 *     WRAPPED-CLI runner (`execute_wrapped.rs`), only against the unit's own cwd, and any
 *     absolute or `..`-escaping path is counted MISSING by construction. The ACP runner — the
 *     path a real seat takes — never consults it. So for a run whose deliverable is an absolute
 *     path under `extraWriteRoots`, declaring it there would fail every run on one runner and
 *     check nothing on the other. That gap is wicked-core's to close
 *     (wicked-core#297, items 1 and 3); once it is, this phase can retire in favour of the
 *     engine field. Crew must not paper over it meanwhile by declaring something unverifiable.
 *
 * ## What this module does
 *
 * It gives crew the instrument it can honestly own: a deterministic TOOL phase, appended to a
 * PER-RUN copy of the workflow def (the exact mechanism `core/deliver.ts` proved for
 * `deliver: "pr"` — the shared def is never mutated, nothing lands in the overlay dir, the
 * catalog never grows a per-run entry), which asserts that the artifacts the launcher declared
 * EXIST and are non-empty. A Tool phase's failure surface is its exit code: wicked-core's
 * `run_tool_cmd` maps a non-zero exit to `StepStatus::Failed`, which fails the unit and the run
 * through the unchanged completion path. No LLM, no worktree, no judgement about the content —
 * only "the phase promised this file; is it there".
 *
 * That is deliberately a FLOOR and not a review, in exactly the sense `builtin_floors` documents:
 * it proves an artifact exists. It says nothing about whether the artifact is correct, or even
 * related to the task. What it removes is the failure mode crew#311 recorded — a unit whose
 * `Write` was policy-denied, which therefore produced no file at all, reporting done.
 *
 * ## The report
 *
 * The script prints what was EXPECTED and what was FOUND before it exits, on both branches, so
 * the failure is legible from the unit output alone: which paths were declared, which exist
 * (with their size), and which are missing and why (absent / empty file / empty directory).
 * An operator reading a failed run must never have to guess what the phase was supposed to
 * produce.
 */

import type { PhaseDef, WorkflowDef } from './types.js';

/** The id of the appended floor phase — also the collision probe when a def already carries one. */
export const DELIVERABLE_FLOOR_PHASE_ID = 'verify-deliverables';

/** The marker line the failing branch prints. Asserted by tests and greppable in a unit output. */
export const DELIVERABLE_FLOOR_FAILURE_MARKER =
  '[wicked-crew] DELIVERABLE FLOOR FAILED';

/**
 * The floor program, run as `node -e <script> <path...>`.
 *
 * Node rather than a shell: this must work identically on macOS, Linux, and Windows, and the
 * daemon already IS node, so `process.execPath` is a guaranteed-present absolute interpreter
 * (see {@link deliverableFloorPhase}). `-e` runs CommonJS, so `require` is available; the
 * declared paths arrive as `process.argv.slice(1)`, passed as argv rather than interpolated
 * into a shell string so a path containing a space, a quote, or a `$` cannot be re-parsed.
 *
 * A path counts as PRODUCED when it exists AND carries bytes: a non-empty file, or a directory
 * with at least one entry (a phase may declare a directory of outputs). A zero-byte file is
 * NOT evidence — it is the same "nothing was produced" this exists to catch, and the draft/chat
 * seams already treated an empty deliverable as a failure at their own post-hoc check.
 */
export function deliverableFloorScript(): string {
  return [
    'const fs=require("node:fs");',
    'const want=process.argv.slice(1);',
    'const found=[],missing=[];',
    'for(const p of want){',
    'let s=null;',
    'try{s=fs.statSync(p)}catch(e){s=null}',
    'if(s===null){missing.push(p+" (does not exist)");continue}',
    'if(s.isDirectory()){',
    'let n=0;try{n=fs.readdirSync(p).length}catch(e){n=0}',
    'if(n===0){missing.push(p+" (directory is empty)")}else{found.push(p+" (directory, "+n+" entries)")}',
    'continue}',
    'if(s.size===0){missing.push(p+" (file is empty, 0 bytes)");continue}',
    'found.push(p+" ("+s.size+" bytes)");',
    '}',
    'console.log("[wicked-crew] deliverable floor: this phase declared "+want.length+" artifact(s).");',
    'console.log("[wicked-crew] EXPECTED: "+(want.length?want.join(", "):"(none)"));',
    'console.log("[wicked-crew] FOUND:    "+(found.length?found.join(", "):"(nothing)"));',
    'if(missing.length===0){',
    'console.log("[wicked-crew] every declared deliverable exists and carries bytes — done is re-derived from the artifact, not asserted.");',
    'process.exit(0)}',
    'console.log("[wicked-crew] MISSING:  "+missing.join(", "));',
    `console.log(${JSON.stringify(DELIVERABLE_FLOOR_FAILURE_MARKER)}+" — the run reported done without producing the artifact(s) it was launched to produce. A prose reply is not a deliverable (crew#311).");`,
    'process.exit(1);',
  ].join('');
}

/**
 * The floor PhaseDef for `paths`.
 *
 * `cmd[0]` is `process.execPath` — the ABSOLUTE path of the node binary already running the
 * daemon — not the bare name `node`. wicked-core preflights every Tool phase at launch
 * (`workflow::preflight_tool_phases`) and REFUSES to start a run whose tool binary does not
 * resolve; a bare `node` resolves only if the engine's PATH happens to carry one, which is
 * exactly the kind of environment-dependent gate that fails in production and passes in tests.
 * The composed def is per-run and hot-registered only, so baking a machine-local path into it
 * costs nothing: it never reaches the catalog or the overlay dir.
 *
 * `role: 'neutral'` + `executes_code: false` + `governed`-free Tool dispatch: this phase is
 * deterministic tooling, so the substance floor, the agent judge, and the input-governance fold
 * do not apply to it — its verdict IS its exit code.
 */
export function deliverableFloorPhase(
  paths: readonly string[],
  dependsOn: string[] = [],
): PhaseDef {
  return {
    id: DELIVERABLE_FLOOR_PHASE_ID,
    kind: 'test',
    executor: {
      type: 'tool',
      cmd: [process.execPath, '-e', deliverableFloorScript(), ...paths],
    },
    gate_type: 'execution',
    gate: 'auto',
    executes_code: false,
    // NOT `verified_evidence: true`: wicked-core arms any `verified_evidence` phase that names no
    // pin of its own with the worktree-DIFF floor (FINDING-055), which is fail-closed on the
    // repo-less runs this phase exists to serve — it would deny every one of them for the wrong
    // reason. This phase carries its own re-verification in its exit code.
    verified_evidence: false,
    // NOT the declared paths either: core checks `required_deliverables` relative to the unit's
    // cwd and counts every absolute path as missing (see the module doc; wicked-core#297).
    // Declaring them here would fail the run on the wrapped-CLI path for the wrong reason.
    required_deliverables: [],
    depends_on: dependsOn,
    role: 'neutral',
    skill_ref: null,
    allowed_skills: [],
    validator_pin: null,
  };
}

/**
 * Compose a PER-RUN def: `base`'s phases (untouched — the shared def is never mutated) plus the
 * deliverable floor appended last, under a run-scoped id. Mirrors `composeDeliverWorkflow`'s
 * contract exactly, including the id charset/length rules `registerWorkflow` enforces and the
 * deliberate absence of `is_system` (core's register schema rejects unknown fields on this path,
 * and a composed def is engine input, not catalog data).
 *
 * Throws on an empty `paths` list — a floor over nothing would pass vacuously, which is the
 * defect, not the fix. Throws on a def that already carries the floor phase, for the same
 * ambiguity reason `composeDeliverWorkflow` does.
 */
export function composeDeliverableFloor(
  base: WorkflowDef,
  runId: string,
  paths: readonly string[],
): WorkflowDef {
  if (paths.length === 0) {
    throw new Error(
      'requireDeliverables: at least one path must be declared — a floor over nothing passes vacuously',
    );
  }
  for (const p of paths) {
    if (p.trim().length === 0) {
      throw new Error('requireDeliverables: a declared deliverable path must not be blank');
    }
  }
  if (base.phases.some((p) => p.id === DELIVERABLE_FLOOR_PHASE_ID)) {
    throw new Error(
      `workflow '${base.id}' already has a '${DELIVERABLE_FLOOR_PHASE_ID}' phase — launch it without requireDeliverables`,
    );
  }
  const last = base.phases[base.phases.length - 1];
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const composedId = `${base.id}-verified-${safeRunId}`.slice(0, 128);
  return {
    id: composedId,
    phases: [...base.phases, deliverableFloorPhase(paths, last !== undefined ? [last.id] : [])],
  };
}
