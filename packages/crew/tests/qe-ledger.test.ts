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
  LEGACY_QE_LEDGER_DIRNAME,
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

  it('reads a legacy-dirname ledger end to end (dual-read)', async () => {
    const ws = workspaceWithLedger(LEGACY_QE_LEDGER_DIRNAME);
    const state = await readAcceptanceState(ws);
    expect(state.root).toBe(join(ws, LEGACY_QE_LEDGER_DIRNAME));
    expect(state.found).toBe(true);
    expect(state.verdict?.verdict).toBe('PASS');
    expect(state.manifest).not.toBeNull();
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
