// crew#311 — the deliverable floor: "done" is re-derived from the artifact, never asserted.
//
// The script assertions RUN the script (spawn the real node with the real argv) rather than
// pattern-matching its source: the whole point of this phase is its exit code, and a test that
// only greps the program text would pass on a program that never exits non-zero. The phase and
// composition assertions pin the contract the adapter and wicked-core depend on.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DELIVERABLE_FLOOR_FAILURE_MARKER,
  DELIVERABLE_FLOOR_PHASE_ID,
  composeDeliverableFloor,
  deliverableFloorPhase,
  deliverableFloorScript,
} from '../src/core/deliverable-floor.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { PhaseDef, WorkflowDef } from '../src/core/types.js';

/**
 * Run the floor exactly as wicked-core's `run_tool_cmd` will: argv[0] then the phase's argv.
 *
 * `launchedAtMs` defaults to an hour in the PAST so every pre-existing assertion below keeps
 * testing what it was written to test (existence + bytes) rather than accidentally testing
 * freshness — the fixtures are written moments before the call, so they are trivially newer.
 */
function runFloor(
  paths: string[],
  launchedAtMs: number = Date.now() - 3_600_000,
): { code: number; out: string } {
  const phase = deliverableFloorPhase(paths, launchedAtMs);
  const cmd = (phase.executor as { type: 'tool'; cmd: string[] }).cmd;
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** Backdate a path so it looks like a PRIOR run's leftover. */
function backdate(p: string, msAgo: number): void {
  const t = (Date.now() - msAgo) / 1000;
  utimesSync(p, t, t);
}

describe('the floor script (executed, not grepped)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deliverable-floor-'));
  // Fixtures are real files on disk because the script stats them; remove them when the suite
  // ends so repeated runs do not litter tmpdir (Copilot, #319).
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('PASSES when every declared artifact exists with bytes, and says what it found', () => {
    const a = join(dir, 'a.html');
    writeFileSync(a, '<html>real content</html>');
    const outDir = join(dir, 'fragments');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'fragment-1.html'), '<p>x</p>');

    const { code, out } = runFloor([a, outDir]);
    expect(code).toBe(0);
    expect(out).toContain('EXPECTED:');
    expect(out).toContain(a);
    expect(out).toContain(outDir);
    expect(out).toContain('bytes');
    expect(out).toContain('1 entries');
    expect(out).not.toContain(DELIVERABLE_FLOOR_FAILURE_MARKER);
  });

  // THE REPRODUCER (crew#311, verified live on 2026-08-24): a unit whose Write was policy-denied
  // produced no file at all and still passed its execution gate on ~200 chars of narration. The
  // floor is the check that turns that into a failure, and the failure must NAME the path.
  it('FAILS a denied-write run: no file at all ⇒ non-zero exit naming what was expected', () => {
    const never = join(dir, 'never-written.html');
    const { code, out } = runFloor([never]);
    expect(code).toBe(1);
    expect(out).toContain(DELIVERABLE_FLOOR_FAILURE_MARKER);
    expect(out).toContain(never);
    expect(out).toContain('does not exist');
    expect(out).toContain('FOUND:    (nothing)');
  });

  it('FAILS a zero-byte artifact — an empty file is not evidence', () => {
    const empty = join(dir, 'empty.html');
    writeFileSync(empty, '');
    const { code, out } = runFloor([empty]);
    expect(code).toBe(1);
    expect(out).toContain('file is empty, 0 bytes');
  });

  it('FAILS an empty directory — a created-but-unfilled output dir is not evidence', () => {
    const emptyDir = join(dir, 'empty-dir');
    mkdirSync(emptyDir, { recursive: true });
    const { code, out } = runFloor([emptyDir]);
    expect(code).toBe(1);
    expect(out).toContain('directory is empty');
  });

  // THE crew#320 REPRODUCER: the interactive seams copy the deliverable to `outPath` and never
  // remove it, and demo/draft/edit run dirs are keyed by DOCUMENT ID — so a second run over the
  // same key finds the PREVIOUS run's file sitting there. Existence alone therefore proves
  // nothing about THIS run: the artifact is there, but this run did not produce it. That is the
  // "done asserted rather than derived" shape the floor exists to eliminate, one level in.
  it('FAILS a STALE artifact — a PRIOR run\'s file is not this run\'s evidence (crew#320)', () => {
    const stale = join(dir, 'stale-from-a-previous-run.html');
    writeFileSync(stale, '<html>produced by the run before this one</html>');
    backdate(stale, 3_600_000); // one hour before this run launched
    const launchedAt = Date.now();

    const { code, out } = runFloor([stale], launchedAt);
    expect(code).toBe(1);
    expect(out).toContain(DELIVERABLE_FLOOR_FAILURE_MARKER);
    expect(out).toContain(stale);
    expect(out).toContain('STALE');
    // The report must name BOTH clocks, or an operator cannot tell a stale artifact from a
    // mis-set launch timestamp.
    expect(out).toContain(new Date(launchedAt).toISOString());
    expect(out).toContain('FOUND:    (nothing)');
  });

  it('PASSES the same path once THIS run rewrites it — freshness, not a blanket ban', () => {
    const p = join(dir, 'rewritten.html');
    writeFileSync(p, 'v1');
    backdate(p, 3_600_000);
    const launchedAt = Date.now();
    expect(runFloor([p], launchedAt).code).toBe(1);
    // The run does its job: same path, new bytes, mtime now after the launch.
    writeFileSync(p, '<html>v2, produced by this run</html>');
    expect(runFloor([p], launchedAt).code).toBe(0);
  });

  it('FAILS a directory whose only entries predate the launch, and PASSES once one is fresh', () => {
    const d = join(dir, 'stale-fragments');
    mkdirSync(d, { recursive: true });
    const old = join(d, 'fragment-from-last-run.html');
    writeFileSync(old, '<p>old</p>');
    backdate(old, 3_600_000);
    backdate(d, 3_600_000);
    const launchedAt = Date.now();

    const stale = runFloor([d], launchedAt);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('NONE written by this run');

    writeFileSync(join(d, 'fragment-from-this-run.html'), '<p>new</p>');
    expect(runFloor([d], launchedAt).code).toBe(0);
  });

  it('FAILS CLOSED when armed without a launch timestamp — unknowable freshness is not freshness', () => {
    const p = join(dir, 'fresh-but-unjudgeable.html');
    writeFileSync(p, 'content');
    const r = spawnSync(process.execPath, ['-e', deliverableFloorScript(), 'not-a-timestamp', p], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain(DELIVERABLE_FLOOR_FAILURE_MARKER);
  });

  it('FAILS on a PARTIAL delivery and names both halves — three declared, one written', () => {
    const wrote = join(dir, 'wrote.html');
    writeFileSync(wrote, 'x'.repeat(40));
    const missA = join(dir, 'miss-a.html');
    const missB = join(dir, 'miss-b.html');

    const { code, out } = runFloor([wrote, missA, missB]);
    expect(code).toBe(1);
    // Found and missing are both reported: an operator must see what DID land, not only the gap.
    expect(out).toContain(`${wrote} (40 bytes)`);
    expect(out).toContain(missA);
    expect(out).toContain(missB);
  });

  it('PROSE IS NOT A DELIVERABLE: the floor never reads the worker output, only the disk', () => {
    // The engine's substance floor passes any reply over 200 trimmed chars. Prove that the same
    // reply buys nothing here: the floor's inputs are paths, and its verdict is the filesystem.
    const narration = 'I will now write the spec file. '.repeat(20); // >> 200 chars
    expect(narration.length).toBeGreaterThan(200);
    const script = deliverableFloorScript();
    expect(script).not.toContain('stdin');
    const missing = join(dir, 'still-not-there.html');
    const r = spawnSync(process.execPath, ['-e', script, String(Date.now() - 3_600_000), missing], {
      encoding: 'utf8',
      input: narration,
    });
    expect(r.status).toBe(1);
    // Not the fail-closed branch: the timestamp above is valid, so this is the file verdict.
    expect(`${r.stdout}${r.stderr}`).toContain('does not exist');
  });

  it('handles paths carrying spaces, quotes and shell metacharacters (argv, never a shell string)', () => {
    const nasty = join(dir, `a b '$q` + '`.html');
    writeFileSync(nasty, 'ok');
    expect(runFloor([nasty]).code).toBe(0);
    // The same path, unwritten, still fails — the pass above was not an accident of quoting.
    const nastyMissing = join(dir, `c d '$q` + '`.html');
    expect(runFloor([nastyMissing]).code).toBe(1);
  });
});

describe('the floor PhaseDef', () => {
  const LAUNCHED_AT = 1_756_000_000_000;
  const phase = deliverableFloorPhase(['/tmp/x.html'], LAUNCHED_AT, ['draft']);

  it('is an EXECUTION-gated phase that runs a deterministic tool, not an agent', () => {
    expect(phase.id).toBe(DELIVERABLE_FLOOR_PHASE_ID);
    expect(phase.gate_type).toBe('execution');
    expect(phase.gate).toBe('auto');
    expect(phase.executor).toEqual({
      type: 'tool',
      cmd: [
        process.execPath,
        '-e',
        deliverableFloorScript(),
        String(LAUNCHED_AT),
        '/tmp/x.html',
      ],
    });
    expect(phase.depends_on).toEqual(['draft']);
  });

  // crew#320: position, not parsing, separates the timestamp from the paths — a declared path is
  // arbitrary text and may itself be all digits.
  it('carries the launch timestamp as its OWN argv slot, ahead of the paths', () => {
    const numericPath = deliverableFloorPhase(['/inbox/12345'], LAUNCHED_AT);
    const cmd = (numericPath.executor as { cmd: string[] }).cmd;
    expect(cmd.slice(3)).toEqual([String(LAUNCHED_AT), '/inbox/12345']);
  });

  it('names an ABSOLUTE, existing interpreter — wicked-core preflights tool binaries at launch', () => {
    // `preflight_tool_phases` REFUSES to start a run whose tool binary does not resolve. A bare
    // `node` resolves only if the engine's PATH happens to carry one; process.execPath always does.
    const bin = (phase.executor as { cmd: string[] }).cmd[0]!;
    expect(bin).toBe(process.execPath);
    expect(bin.startsWith('/') || /^[A-Za-z]:[\\/]/.test(bin)).toBe(true);
  });

  it('declares NEITHER verified_evidence NOR required_deliverables — both would misfire here', () => {
    // verified_evidence ⇒ wicked-core arms the worktree-DIFF floor (FINDING-055), which is
    // fail-closed on the repo-less runs this phase exists to serve.
    expect(phase.verified_evidence).toBe(false);
    // required_deliverables is checked against the unit's cwd and counts every ABSOLUTE path as
    // missing by construction (execute_wrapped.rs) — it would deny the run for the wrong reason.
    expect(phase.required_deliverables).toEqual([]);
    expect(phase.validator_pin).toBeNull();
  });
});

describe('composeDeliverableFloor (per-run, never mutating the shared def)', () => {
  const base = BUILTIN_WORKFLOWS.find((w) => w.id === 'feature')!;

  it('appends the floor last under a run-scoped id and leaves the base untouched', () => {
    const before = JSON.stringify(base);
    const composed = composeDeliverableFloor(base, 'run-abc', ['/tmp/out.html']);
    expect(composed.id).toBe('feature-verified-run-abc');
    expect(composed.phases.map((p: PhaseDef) => p.id)).toEqual([
      ...base.phases.map((p) => p.id),
      DELIVERABLE_FLOOR_PHASE_ID,
    ]);
    expect(composed.phases[composed.phases.length - 1]!.depends_on).toEqual(['review']);
    expect(JSON.stringify(base)).toBe(before);
    // Engine input, not catalog data — same contract as composeDeliverWorkflow.
    expect((composed as WorkflowDef & { is_system?: boolean }).is_system).toBeUndefined();
  });

  it('REFUSES an empty declaration — a floor over nothing passes vacuously, which is the defect', () => {
    expect(() => composeDeliverableFloor(base, 'run-abc', [])).toThrow(/vacuously/);
    expect(() => composeDeliverableFloor(base, 'run-abc', ['  '])).toThrow(/must not be blank/);
  });

  it('REFUSES a def that already carries the floor phase (ambiguous double-append)', () => {
    const once = composeDeliverableFloor(base, 'run-abc', ['/tmp/out.html']);
    expect(() => composeDeliverableFloor(once, 'run-abc', ['/tmp/out.html'])).toThrow(
      /already has a 'verify-deliverables' phase/,
    );
  });

  // crew#320: the floor phase is only as good as the instant it compares against, so the
  // timestamp has to reach the argv, and a nonsense one has to be caught at compose time rather
  // than discovered by the tool phase minutes into the run.
  it('threads the launch timestamp through to the floor phase argv', () => {
    const composed = composeDeliverableFloor(base, 'run-abc', ['/tmp/out.html'], 1_756_000_000_000);
    const floor = composed.phases[composed.phases.length - 1]!;
    expect((floor.executor as { cmd: string[] }).cmd.slice(3)).toEqual([
      '1756000000000',
      '/tmp/out.html',
    ]);
  });

  it('defaults the launch timestamp to composition time — the last instant before launch', () => {
    const before = Date.now();
    const composed = composeDeliverableFloor(base, 'run-abc', ['/tmp/out.html']);
    const after = Date.now();
    const floor = composed.phases[composed.phases.length - 1]!;
    const stamp = Number((floor.executor as { cmd: string[] }).cmd[3]);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it('REFUSES a non-timestamp — an unjudgeable freshness check is not a freshness check', () => {
    expect(() =>
      composeDeliverableFloor(base, 'run-abc', ['/tmp/out.html'], Number.NaN),
    ).toThrow(/positive epoch-millisecond timestamp/);
    expect(() => composeDeliverableFloor(base, 'run-abc', ['/tmp/out.html'], 0)).toThrow(
      /positive epoch-millisecond timestamp/,
    );
  });

  it('keeps the composed id inside registerWorkflow\'s charset and length limits', () => {
    const composed = composeDeliverableFloor(base, 'a/b c:d'.repeat(40), ['/tmp/out.html']);
    expect(composed.id.length).toBeLessThanOrEqual(128);
    expect(composed.id).toMatch(/^[a-zA-Z0-9._-]+$/);
  });
});

// Copilot (#319): an enforcement option that is silently ignored leaves the caller worse off
// than one that was never offered — it watches the run complete believing the artifacts were
// re-derived. `requireDeliverables` without a workflow must refuse the launch, the same way
// deliver: "pr" already does.
describe('requireDeliverables without a workflow', () => {
  it('refuses the launch instead of dropping the option', async () => {
    const { CoreAdapter } = await import('../src/core/adapter.js');
    const adapter = Object.create(CoreAdapter.prototype) as {
      launchRun: (i: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(
      adapter.launchRun({
        problem: 'free-text run',
        sessionId: 'r-nofloor',
        clisJson: '[]',
        requireDeliverables: ['/tmp/never-checked.html'],
      }),
    ).rejects.toThrow(/requireDeliverables requires a workflow/);
  });
});
