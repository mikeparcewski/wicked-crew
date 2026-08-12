// The ledger reader (Phase 6a) against a REAL ledger.
//
// `tests/fixtures/qe-ledger-pass/` is a copy of the ledger garden's 6b functional run left behind:
// one project, one scenario, one run (status `passed`), one PASS verdict, and a 1.1.0 manifest with
// 9 artifacts. Only the canonical JSON is committed — the SQLite index is DERIVED state the store
// can rebuild, and committing a binary db would freeze one machine's build of it into git. That
// also makes the fixture double as the drift case: a store whose index answers "no verdicts" while
// canonical verdict files exist is exactly what a JSON-only-degraded writer leaves behind, and the
// reader must heal it rather than report a ledger full of evidence as empty.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_QE_LEDGER_DIRNAME,
  qeLedgerDirName,
  qeLedgerRoot,
  readAcceptanceState,
  summarizeManifest,
} from '../src/qe/ledger.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/qe-ledger-pass', import.meta.url));

/** The 6b run the fixture records. */
const QE_RUN_ID = '7ec47687-fb15-4592-bf69-5121359f8bab';
const QE_VERDICT_ID = '7ae4f27c-57f4-4e36-bfea-3e3d6c4deb48';

let dir: string;
/** Prior value of the ledger-dir override, restored after each test (never clobber the harness env). */
let priorLedgerDirEnv: string | undefined;

/** A fresh workspace holding a copy of the fixture ledger (never mutate the committed fixture). */
function workspaceWithLedger(): string {
  const ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  cpSync(join(FIXTURE, DEFAULT_QE_LEDGER_DIRNAME), join(ws, DEFAULT_QE_LEDGER_DIRNAME), {
    recursive: true,
  });
  return ws;
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

describe('qeLedgerDirName', () => {
  it('defaults to the .wicked-testing wire contract', () => {
    expect(qeLedgerDirName()).toBe('.wicked-testing');
    expect(qeLedgerRoot('/repo')).toBe(join('/repo', '.wicked-testing'));
  });

  // The 6c rename lands as a config flip, not a grep — this pins that the seam exists.
  it('honours the WICKED_QE_LEDGER_DIR override', () => {
    process.env['WICKED_QE_LEDGER_DIR'] = '.wicked-qe';
    expect(qeLedgerDirName()).toBe('.wicked-qe');
    expect(qeLedgerRoot('/repo')).toBe(join('/repo', '.wicked-qe'));
  });

  it('treats a blank override as unset', () => {
    process.env['WICKED_QE_LEDGER_DIR'] = '  ';
    expect(qeLedgerDirName()).toBe(DEFAULT_QE_LEDGER_DIRNAME);
  });
});

describe('readAcceptanceState', () => {
  it('reports a repo with no ledger as not found — and does NOT create one', async () => {
    const ws = join(dir, 'bare');
    mkdirSync(ws);
    const state = await readAcceptanceState(ws);
    expect(state.found).toBe(false);
    expect(state.verdict).toBeNull();
    // The probe must not install an empty ledger into a repo that never had one:
    // createDomainStore creates its root on open, so the guard is the existsSync probe.
    const again = await readAcceptanceState(ws);
    expect(again.found).toBe(false);
  });

  it('reads the fixture ledger: newest verdict, its run, and the public manifest', async () => {
    const ws = workspaceWithLedger();
    const state = await readAcceptanceState(ws);

    expect(state.found).toBe(true);
    expect(state.error).toBeUndefined();
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

  it('lets a newer FAIL verdict govern (newest first), and ?qeRun pins the older run', async () => {
    const ws = workspaceWithLedger();
    // Write the FAIL through the ledger's own API — the same path garden's qe gate uses.
    const { createDomainStore } = await import('wicked-ledger');
    const store = createDomainStore({ root: qeLedgerRoot(ws) });
    const pass = await readAcceptanceState(ws); // heals the index before the write
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

    const latest = await readAcceptanceState(ws);
    expect(latest.verdict?.verdict).toBe('FAIL');
    expect(latest.run?.id).toBe(failRun.id);
    // No manifest was built for the induced run — absent is a real answer, not an error.
    expect(latest.manifest).toBeNull();

    const pinned = await readAcceptanceState(ws, { qeRunId: QE_RUN_ID });
    expect(pinned.verdict?.verdict).toBe('PASS');
    expect(pinned.run?.id).toBe(QE_RUN_ID);
  });

  it('heals a stale SQLite index from canonical JSON instead of reporting an empty ledger', async () => {
    // The fixture ships JSON-only, so the store's freshly-created index is empty
    // while the canonical files are not — the exact state a degraded writer leaves.
    const ws = workspaceWithLedger();
    const state = await readAcceptanceState(ws);
    expect(state.verdict, 'an index answering [] with canonical rows present is stale, not empty').not.toBeNull();
    expect(state.verdict?.verdict).toBe('PASS');
  });
});
