// The ledger reader (Phase 6a) against a REAL ledger — read-only, run-scoped (F-E2E-013).
//
// `tests/fixtures/qe-ledger-pass/` is a copy of the ledger garden's 6b functional run left behind:
// one project, one scenario, one run (status `passed`, started 2026-08-12T02:17:34.799Z), one PASS
// verdict, and a 1.1.0 manifest with 9 artifacts. Only the canonical JSON is committed — the SQLite
// index is DERIVED state, and the reader no longer touches it at all: it reads the canonical files
// the way the ledger's own JSON-only mode does, and creates nothing under the root. The pre-fix
// reader opened a `DomainStore` (which creates `wicked-qe.db` + WAL/SHM inside the checkout and
// runs a stale-run sweep) and then `rebuildIndex()`ed it — a GET that wrote into the customer's
// clone and, on wicked-core's committed legacy ledger, failed two SQLite inserts on the way.
//
// Every read is FOR a subject: an explicit QE run (`?qeRun`), or the crew run whose evidence is
// wanted — a verdict is served only when it is stamped with that run's id or its QE run started
// inside that run's lifetime. The fixture predates any run a test launches, so "a fresh run gets
// the repo's old PASS" is exactly the mis-attribution these cases refuse.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreateInput } from 'wicked-ledger';
import {
  CREW_RUN_ID_FIELD,
  DEFAULT_QE_LEDGER_DIRNAME,
  LEGACY_QE_LEDGER_DIRNAME,
  describeAttribution,
  qeLedgerDirName,
  qeLedgerRoot,
  readAcceptanceState,
  summarizeManifest,
  type ReadSubject,
} from '../src/qe/ledger.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/qe-ledger-pass', import.meta.url));

/** The 6b run the fixture records. */
const QE_RUN_ID = '7ec47687-fb15-4592-bf69-5121359f8bab';
const QE_VERDICT_ID = '7ae4f27c-57f4-4e36-bfea-3e3d6c4deb48';
const QE_RUN_STARTED = Date.parse('2026-08-12T02:17:34.799Z');

/** A crew run that started a minute before the fixture's QE run and is still live: the QE run falls inside it. */
function runBefore(runId = 'crew-run-before'): ReadSubject {
  return { run: { runId, startedAt: QE_RUN_STARTED - 60_000, finishedAt: null } };
}
/** A crew run started NOW — everything the fixture holds predates it. */
function runNow(runId = 'crew-run-now'): ReadSubject {
  return { run: { runId, startedAt: Date.now(), finishedAt: null } };
}

let dir: string;
/** Prior value of the ledger-dir override, restored after each test (never clobber the harness env). */
let priorLedgerDirEnv: string | undefined;

/**
 * A fresh workspace holding a copy of the fixture ledger (never mutate the
 * committed fixture). The FIXTURE keeps the legacy `.wicked-testing` dirname —
 * it is the 6b run the retired package's era wrote — so copying it under the
 * default (new) dirname is a rename, and copying it as-is exercises dual-read.
 */
function workspaceWithLedger(dirname: string = DEFAULT_QE_LEDGER_DIRNAME): string {
  const ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  cpSync(join(FIXTURE, LEGACY_QE_LEDGER_DIRNAME), join(ws, dirname), {
    recursive: true,
  });
  return ws;
}

/** Every file under `root` (relative path → sha256), the byte-identity witness for "read-only". */
function treeDigest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    const abs = join(root, rel);
    if (!statSync(abs).isFile()) continue;
    out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'));
  }
  return out;
}

beforeEach(() => {
  priorLedgerDirEnv = process.env['WICKED_QE_LEDGER_DIR'];
  dir = mkdtempSync(join(tmpdir(), 'qe-ledger-'));
});

afterEach(() => {
  if (priorLedgerDirEnv === undefined) delete process.env['WICKED_QE_LEDGER_DIR'];
  else process.env['WICKED_QE_LEDGER_DIR'] = priorLedgerDirEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('qeLedgerDirName / qeLedgerRoot', () => {
  it('defaults to the .wicked-qe dirname (Phase 6c rename)', () => {
    expect(qeLedgerDirName()).toBe('.wicked-qe');
    // No ledger dir on disk at all → the new name, never the legacy one.
    expect(qeLedgerRoot(dir)).toBe(join(dir, '.wicked-qe'));
  });

  it('honours the WICKED_QE_LEDGER_DIR override exactly (no fallback probing)', () => {
    process.env['WICKED_QE_LEDGER_DIR'] = '.custom-ledger';
    expect(qeLedgerDirName()).toBe('.custom-ledger');
    const ws = workspaceWithLedger(LEGACY_QE_LEDGER_DIRNAME);
    expect(qeLedgerRoot(ws)).toBe(join(ws, '.custom-ledger'));
  });

  // Regression (recon TH-2 / campaign S11): an ABSOLUTE override is the root
  // itself — it must never be joined onto repoRoot. Before the fix,
  // `/elsewhere/ledger` resolved to `<repo>/elsewhere/ledger`, breaking every
  // isolated-profile run that pins the ledger outside the repo.
  it('honours an absolute WICKED_QE_LEDGER_DIR as-is (never joined onto repoRoot)', () => {
    const pinned = join(dir, 'pinned-ledger-root');
    process.env['WICKED_QE_LEDGER_DIR'] = pinned;
    const ws = workspaceWithLedger(LEGACY_QE_LEDGER_DIRNAME);
    expect(qeLedgerRoot(ws)).toBe(pinned);
    expect(qeLedgerRoot(ws)).not.toBe(join(ws, pinned));
  });

  it('still joins a relative WICKED_QE_LEDGER_DIR under repoRoot', () => {
    process.env['WICKED_QE_LEDGER_DIR'] = 'nested/qe-ledger';
    const ws = workspaceWithLedger(LEGACY_QE_LEDGER_DIRNAME);
    expect(qeLedgerRoot(ws)).toBe(join(ws, 'nested', 'qe-ledger'));
  });

  it('treats a blank override as unset', () => {
    process.env['WICKED_QE_LEDGER_DIR'] = '  ';
    expect(qeLedgerDirName()).toBe(DEFAULT_QE_LEDGER_DIRNAME);
  });

  // Dual-read (Phase 6c): a repo written under the retired package's dirname
  // keeps resolving — reads AND writes stay in that root.
  it('resolves an existing legacy .wicked-testing root when no .wicked-qe exists', () => {
    const ws = workspaceWithLedger(LEGACY_QE_LEDGER_DIRNAME);
    expect(qeLedgerRoot(ws)).toBe(join(ws, LEGACY_QE_LEDGER_DIRNAME));
  });

  it('prefers .wicked-qe when both dirnames exist', () => {
    const ws = workspaceWithLedger(LEGACY_QE_LEDGER_DIRNAME);
    mkdirSync(join(ws, DEFAULT_QE_LEDGER_DIRNAME), { recursive: true });
    expect(qeLedgerRoot(ws)).toBe(join(ws, DEFAULT_QE_LEDGER_DIRNAME));
  });
});

describe('readAcceptanceState', () => {
  it('reports a repo with no ledger as not found — and does NOT create one', async () => {
    const ws = join(dir, 'bare');
    mkdirSync(ws);
    const state = await readAcceptanceState(ws, runNow());
    expect(state.found).toBe(false);
    expect(state.verdict).toBeNull();
    expect(state.ledgerVerdicts).toBe(0);
    // The probe must not install an empty ledger into a repo that never had one.
    const again = await readAcceptanceState(ws, runNow());
    expect(again.found).toBe(false);
    expect(existsSync(join(ws, DEFAULT_QE_LEDGER_DIRNAME))).toBe(false);
    expect(existsSync(join(ws, LEGACY_QE_LEDGER_DIRNAME))).toBe(false);
  });

  it('serves the fixture verdict, its run and the public manifest to a run whose lifetime contains the QE run', async () => {
    const ws = workspaceWithLedger();
    const state = await readAcceptanceState(ws, runBefore());

    expect(state.found).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.ledgerVerdicts).toBe(1);
    expect(state.attributedVerdicts).toBe(1);
    expect(state.attribution).toEqual({
      kind: 'run-window',
      qeRunId: QE_RUN_ID,
      qeRunStartedAt: '2026-08-12T02:17:34.799Z',
    });
    expect(state.verdict).toMatchObject({
      id: QE_VERDICT_ID,
      run_id: QE_RUN_ID,
      verdict: 'PASS',
      reviewer: 'wicked-garden-qe-acceptance-test-reviewer',
    });
    expect(state.run).toMatchObject({ id: QE_RUN_ID, status: 'passed' });
    expect(state.manifest).not.toBeNull();
    expect(state.manifest?.manifest_version).toBe('1.1.0');
    expect(state.manifest?.artifacts).toHaveLength(9);

    const summary = summarizeManifest(state.manifest!);
    expect(summary).toMatchObject({
      manifestVersion: '1.1.0',
      runId: QE_RUN_ID,
      scenarioName: 'csv-stats-basic',
      status: 'passed',
      artifactCount: 9,
      verdict: { value: 'PASS', reviewer: 'wicked-garden-qe-acceptance-test-reviewer' },
    });
  });

  it("does NOT attribute the repo's older PASS to a run that started after it (F-E2E-013)", async () => {
    const ws = workspaceWithLedger();
    const state = await readAcceptanceState(ws, runNow('4f67808a'));
    expect(state.found).toBe(true);
    expect(state.error).toBeUndefined();
    // The ledger's contents are reported — as what it holds, not as this run's evidence.
    expect(state.ledgerVerdicts).toBe(1);
    expect(state.attributedVerdicts).toBe(0);
    expect(state.verdict).toBeNull();
    expect(state.run).toBeNull();
    expect(state.manifest).toBeNull();
    expect(state.attribution.kind).toBe('none');
    const reason = (state.attribution as { reason: string }).reason;
    expect(reason).toContain(`newest PASS (${QE_VERDICT_ID})`);
    expect(reason).toContain('before this run started');
    expect(reason).toContain('none is stamped with run 4f67808a');
  });

  it('links nothing for a run whose start is unknown — and says that is why', async () => {
    const ws = workspaceWithLedger();
    const state = await readAcceptanceState(ws, {
      run: { runId: 'no-history', startedAt: null, finishedAt: null },
    });
    expect(state.verdict).toBeNull();
    expect(state.attribution.kind).toBe('none');
    expect((state.attribution as { reason: string }).reason).toMatch(/start is not recorded/);
  });

  it('does not attribute a QE run that started after the crew run FINISHED (closed window)', async () => {
    const ws = workspaceWithLedger();
    const state = await readAcceptanceState(ws, {
      run: { runId: 'closed', startedAt: QE_RUN_STARTED - 120_000, finishedAt: QE_RUN_STARTED - 60_000 },
    });
    expect(state.verdict).toBeNull();
    expect((state.attribution as { reason: string }).reason).toMatch(/outside this run's lifetime/);
  });

  it('attributes a run the writer STAMPED with the crew run id, whatever the timing', async () => {
    const ws = workspaceWithLedger();
    // A QE writer inside a governed run knows `WICKED_RUN_ID`; recording it on the ledger run is the
    // explicit linkage. Written through the ledger's own API (the writer side is allowed to write).
    const { createDomainStore } = await import('wicked-ledger');
    const store = createDomainStore({ root: qeLedgerRoot(ws) });
    // The WRITER owns the derived index: the fixture ships JSON-only, so the writer builds it
    // before writing (the reader no longer does this on its behalf — see the module header).
    store.rebuildIndex();
    const base = store.get('runs', QE_RUN_ID)!;
    const stampedRun = store.create('runs', {
      project_id: base.project_id,
      scenario_id: base.scenario_id,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      status: 'passed',
      [CREW_RUN_ID_FIELD]: 'crew-late',
    } as unknown as CreateInput<'runs'>);
    store.create('verdicts', {
      run_id: stampedRun.id,
      verdict: 'PASS',
      reviewer: 'qe-ledger-test',
      reason: 'stamped with the crew run id',
    });

    // Even with NO window at all, the stamp attributes it …
    const state = await readAcceptanceState(ws, {
      run: { runId: 'crew-late', startedAt: null, finishedAt: null },
    });
    expect(state.attribution).toEqual({ kind: 'stamped', qeRunId: stampedRun.id });
    expect(state.verdict?.reviewer).toBe('qe-ledger-test');
    // … and to no other run.
    const other = await readAcceptanceState(ws, runNow('some-other-run'));
    expect(other.verdict).toBeNull();
    expect(other.ledgerVerdicts).toBe(2);
  });

  it('lets a newer attributed FAIL govern (newest first), and ?qeRun pins the older run', async () => {
    const ws = workspaceWithLedger();
    // Write the FAIL through the ledger's own API — the same path garden's qe gate uses.
    const { createDomainStore } = await import('wicked-ledger');
    const store = createDomainStore({ root: qeLedgerRoot(ws) });
    store.rebuildIndex(); // the writer's index, built by the writer
    const pass = await readAcceptanceState(ws, runBefore());
    expect(pass.verdict?.verdict).toBe('PASS');
    const failRun = store.create('runs', {
      project_id: pass.run!.project_id,
      scenario_id: pass.run!.scenario_id,
      started_at: new Date().toISOString(),
      status: 'running',
    });
    store.update('runs', failRun.id, { status: 'failed', finished_at: new Date().toISOString() });
    store.create('verdicts', {
      run_id: failRun.id,
      verdict: 'FAIL',
      reviewer: 'qe-ledger-test',
      reason: 'induced failure',
    });

    // The crew run is still live, so a QE run started now is inside its window too.
    const latest = await readAcceptanceState(ws, runBefore());
    expect(latest.verdict?.verdict).toBe('FAIL');
    expect(latest.run?.id).toBe(failRun.id);
    expect(latest.ledgerVerdicts).toBe(2);
    // No manifest was built for the induced run — absent is a real answer, not an error.
    expect(latest.manifest).toBeNull();

    const pinned = await readAcceptanceState(ws, { qeRunId: QE_RUN_ID });
    expect(pinned.verdict?.verdict).toBe('PASS');
    expect(pinned.run?.id).toBe(QE_RUN_ID);
    expect(pinned.attribution).toEqual({ kind: 'pinned', qeRunId: QE_RUN_ID });

    // A pin on a QE run with no verdict is its own honest answer.
    const empty = await readAcceptanceState(ws, { qeRunId: 'no-such-qe-run' });
    expect(empty.verdict).toBeNull();
    expect((empty.attribution as { reason: string }).reason).toContain('no-such-qe-run');
  });

  it('reads a legacy-dirname ledger end to end (dual-read)', async () => {
    const ws = workspaceWithLedger(LEGACY_QE_LEDGER_DIRNAME);
    const state = await readAcceptanceState(ws, runBefore());
    expect(state.root).toBe(join(ws, LEGACY_QE_LEDGER_DIRNAME));
    expect(state.found).toBe(true);
    expect(state.verdict?.verdict).toBe('PASS');
    expect(state.manifest).not.toBeNull();
  });

  it('is READ-ONLY: a read of a JSON-only legacy ledger leaves it byte-identical and creates no index (F-E2E-013)', async () => {
    // The fixture ships JSON-only. The pre-fix reader "healed" that by opening a DomainStore (which
    // creates wicked-qe.db + WAL/SHM under the root) and rebuilding the index into it — inside the
    // customer's checkout, on a GET.
    const ws = workspaceWithLedger(LEGACY_QE_LEDGER_DIRNAME);
    const root = join(ws, LEGACY_QE_LEDGER_DIRNAME);
    const before = treeDigest(root);

    const attributed = await readAcceptanceState(ws, runBefore());
    expect(attributed.verdict?.verdict).toBe('PASS');
    const fresh = await readAcceptanceState(ws, runNow());
    expect(fresh.verdict).toBeNull();
    const pinned = await readAcceptanceState(ws, { qeRunId: QE_RUN_ID });
    expect(pinned.verdict?.verdict).toBe('PASS');

    expect(treeDigest(root)).toEqual(before);
    for (const stray of ['wicked-qe.db', 'wicked-qe.db-wal', 'wicked-qe.db-shm', 'wicked-testing.db']) {
      expect(existsSync(join(root, stray)), `${stray} must not be created by a read`).toBe(false);
    }
  });

  it('surfaces an unparseable record as a read failure — never a cleaner answer', async () => {
    const ws = workspaceWithLedger();
    writeFileSync(join(ws, DEFAULT_QE_LEDGER_DIRNAME, 'verdicts', 'broken.json'), '{ not json');
    const state = await readAcceptanceState(ws, runBefore());
    expect(state.found).toBe(true);
    expect(state.error).toMatch(/verdicts\/broken\.json: not valid JSON/);
    // Deny-dominates: the readable PASS is NOT served around the broken row.
    expect(state.verdict).toBeNull();
    expect(state.manifest).toBeNull();
    expect((state.attribution as { reason: string }).reason).toMatch(/could not be read/);
  });

  it("skips in-flight `.tmp.*` files and soft-deleted rows exactly as the ledger's own JSON reader does", async () => {
    const ws = workspaceWithLedger();
    const verdicts = join(ws, DEFAULT_QE_LEDGER_DIRNAME, 'verdicts');
    // An atomicWriteJson in flight from another process — not a record, not an error.
    writeFileSync(join(verdicts, `in-flight.json.tmp.${Date.now()}`), '{ half-writ');
    // A soft-deleted, NEWER FAIL — reads only return live rows.
    writeFileSync(
      join(verdicts, 'deleted.json'),
      JSON.stringify({
        id: 'deleted-verdict',
        run_id: QE_RUN_ID,
        verdict: 'FAIL',
        reviewer: 'nobody',
        created_at: '2026-08-13T00:00:00.000Z',
        updated_at: '2026-08-13T00:00:00.000Z',
        deleted: 1,
        deleted_at: '2026-08-13T00:00:01.000Z',
      }),
    );
    const state = await readAcceptanceState(ws, runBefore());
    expect(state.error).toBeUndefined();
    expect(state.ledgerVerdicts).toBe(1);
    expect(state.verdict?.id).toBe(QE_VERDICT_ID);
  });
});

describe('readAcceptanceState — review of #539 (F1-adjacent windows, F2, F3, F5, F6)', () => {
  const T = (iso: string): number => Date.parse(iso);
  /** A canonical verdict row as the ledger writes it. */
  const verdictRow = (id: string, run_id: string, verdict: string, created_at: string) => ({
    id,
    run_id,
    verdict,
    reviewer: 'qe-ledger-test',
    reason: `${verdict} by test`,
    created_at,
    updated_at: created_at,
    deleted: 0,
    deleted_at: null,
  });
  /** A canonical run row as the ledger writes it. */
  const runRow = (id: string, started_at: string, status: string) => ({
    id,
    project_id: 'da838fff-9bd7-45df-a452-853516bdd7ae',
    scenario_id: 'other-scenario',
    started_at,
    finished_at: started_at,
    status,
    created_at: started_at,
    updated_at: started_at,
    deleted: 0,
    deleted_at: null,
  });
  const writeRow = (ws: string, table: string, row: { id: string } & Record<string, unknown>): void => {
    writeFileSync(join(ws, DEFAULT_QE_LEDGER_DIRNAME, table, `${row.id}.json`), JSON.stringify(row, null, 2));
  };

  it('a window closed BEFORE the QE run started links nothing — the cancelled-run shape (F1)', async () => {
    // The route derives this window from the engine's `runCancelled` frame; here the reader is
    // handed the resulting closed window directly: cancelled 01:05, fixture QE run started 02:17.
    const ws = workspaceWithLedger();
    const state = await readAcceptanceState(ws, {
      run: { runId: 'cancelled', startedAt: T('2026-08-12T01:00:00Z'), finishedAt: T('2026-08-12T01:05:00Z') },
    });
    expect(state.verdict).toBeNull();
    expect(state.attributedVerdicts).toBe(0);
    expect((state.attribution as { reason: string }).reason).toMatch(/outside this run's lifetime/);
    expect((state.attribution as { reason: string }).reason).toContain('finished 2026-08-12T01:05:00.000Z');
  });

  it('deny-dominates ACROSS attributed QE runs: a later PASS on run A does not mask an earlier FAIL on run B (F2)', async () => {
    const ws = workspaceWithLedger();
    // QE run B (another scenario) started 02:20 inside the same crew run and FAILED at 02:25; the
    // fixture's run A PASSED at 02:31 — newer, but a different QE run.
    writeRow(ws, 'runs', runRow('qe-run-b', '2026-08-12T02:20:00.000Z', 'failed'));
    writeRow(ws, 'verdicts', verdictRow('fail-run-b', 'qe-run-b', 'FAIL', '2026-08-12T02:25:00.000Z'));

    const state = await readAcceptanceState(ws, runBefore());
    expect(state.ledgerVerdicts).toBe(2);
    expect(state.attributedVerdicts).toBe(2);
    expect(state.verdict?.id).toBe('fail-run-b');
    expect(state.run?.id).toBe('qe-run-b');
    expect(state.attribution).toEqual({
      kind: 'run-window',
      qeRunId: 'qe-run-b',
      qeRunStartedAt: '2026-08-12T02:20:00.000Z',
    });

    // Supersession stays PER QE RUN: once run B is re-reviewed PASS, every attributed run passes
    // and the newest PASS governs.
    writeRow(ws, 'verdicts', verdictRow('rereview-run-b', 'qe-run-b', 'PASS', '2026-08-12T02:45:00.000Z'));
    const healed = await readAcceptanceState(ws, runBefore());
    expect(healed.attributedVerdicts).toBe(2);
    expect(healed.verdict?.id).toBe('rereview-run-b');

    // And a crew run whose window closed before run B started never sees run B at all.
    const closedEarly = await readAcceptanceState(ws, {
      run: { runId: 'early', startedAt: T('2026-08-12T02:00:00Z'), finishedAt: T('2026-08-12T02:19:00Z') },
    });
    expect(closedEarly.attributedVerdicts).toBe(1);
    expect(closedEarly.verdict?.id).toBe(QE_VERDICT_ID);
  });

  it('never places a QE run by inference without a DATED run row — a verdict alone cannot say when its run ran (F3)', async () => {
    const ws = workspaceWithLedger();
    // A verdict whose `runs/<id>.json` is absent, RECORDED inside a live crew run that started
    // after the fixture's QE run. The pre-fix reader fell back to the verdict's created_at and
    // attributed it (the "ghost" probe).
    writeRow(ws, 'verdicts', verdictRow('ghost-verdict', 'ghost-run', 'PASS', '2026-08-12T02:35:00.000Z'));
    const live = await readAcceptanceState(ws, {
      run: { runId: 'late-live', startedAt: T('2026-08-12T02:30:00Z'), finishedAt: null },
    });
    expect(live.verdict).toBeNull();
    expect(live.attributedVerdicts).toBe(0);
    expect(live.ledgerVerdicts).toBe(2);
    const reason = (live.attribution as { reason: string }).reason;
    expect(reason).toContain('across 2 QE runs');
    expect(reason).toContain('1 QE run has no dated run row and cannot be placed by inference');

    // The dated fixture run still attributes to a run that contains it; the ghost never does.
    const contained = await readAcceptanceState(ws, runBefore());
    expect(contained.attributedVerdicts).toBe(1);
    expect(contained.verdict?.id).toBe(QE_VERDICT_ID);

    // …but a STAMP places it, dated row or not.
    writeRow(ws, 'verdicts', {
      ...verdictRow('ghost-stamped', 'ghost-run-2', 'PASS', '2026-08-12T02:36:00.000Z'),
      [CREW_RUN_ID_FIELD]: 'late-live',
    });
    const stamped = await readAcceptanceState(ws, {
      run: { runId: 'late-live', startedAt: T('2026-08-12T02:30:00Z'), finishedAt: null },
    });
    expect(stamped.attribution).toEqual({ kind: 'stamped', qeRunId: 'ghost-run-2' });
    expect(stamped.run).toBeNull(); // the row is still missing; the stamp is on the verdict
  });

  it("names an UNREADABLE event log as the reason nothing can be placed — not 'no sessionStarted' (F5)", async () => {
    const ws = workspaceWithLedger();
    const state = await readAcceptanceState(ws, {
      run: { runId: 'x', startedAt: null, finishedAt: null, logUnreadable: 'event-log read binding missing (older addon)' },
    });
    expect(state.verdict).toBeNull();
    const reason = (state.attribution as { reason: string }).reason;
    expect(reason).toContain("the run's event log could not be read (event-log read binding missing (older addon))");
    expect(reason).not.toContain('no sessionStarted');
  });

  it('describeAttribution labels the inferred kind as INFERRED and names stamp and pin (F6)', () => {
    expect(describeAttribution({ kind: 'run-window', qeRunId: 'q', qeRunStartedAt: '2026-08-12T02:17:34.799Z' })).toBe(
      "INFERRED from this run's lifetime — QE run q started 2026-08-12T02:17:34.799Z inside it; not stamped by the writer",
    );
    expect(describeAttribution({ kind: 'stamped', qeRunId: 'q' })).toContain(`stamped ${CREW_RUN_ID_FIELD}`);
    expect(describeAttribution({ kind: 'pinned', qeRunId: 'q' })).toContain('caller-asserted');
    expect(describeAttribution({ kind: 'none', reason: 'why' })).toBe('why');
  });
});
