// F-E2E-013: `GET /runs/:id/acceptance` is READ-ONLY and never mis-attributes a legacy verdict.
//
// Observed on the fresh-install E2E (phase 2): two probes of this route against an onboarding run
// on `wicked-core` CREATED `.wicked-testing/wicked-qe.db` inside the customer's clone, failed two
// SQLite inserts on the way (`NOT NULL constraint failed: scenarios.format_version` — the committed
// legacy ledger's scenarios predate that column) and answered with a July-2026 QE PASS from that
// ledger as the run's acceptance verdict — a run that had failed at plan time and produced nothing.
//
// A GET must leave the repository byte-identical (no index, no WAL, no reaped tmp files, nothing
// tracked or untracked touched), answer the empty verdict when no store exists, dual-read a
// committed legacy ledger WITHOUT attaching its verdicts to a run that recorded no evidence, and
// surface an unreadable record as a named failure — never as a silent PASS.
//
// Engine reads are stubbed (as acceptance-route.test.ts stubs them) so the ONLY thing that touches
// the two checkouts is the route under test; byte-identity is witnessed by a sha256 digest of every
// file under the checkout (excluding `.git/`) plus `git status --porcelain`.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { RecordedEvent, RepoEntry, SessionView } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/qe-ledger-pass', import.meta.url));
const QE_RUN_ID = '7ec47687-fb15-4592-bf69-5121359f8bab';
const QE_RUN_STARTED = Date.parse('2026-08-12T02:17:34.799Z');

/** A governed run over a checkout that has NO ledger. */
const CLEAN_RUN = 'clean-run';
/** A governed run, started today, over a checkout whose committed legacy ledger holds an old PASS. */
const FRESH_LEGACY_RUN = 'fresh-legacy-run';
/** The observed shape: an onboarding run (declares no requirement) over that same checkout. */
const ONBOARD_RUN = '4f67808a-ac94-4ce5-adda-68e3197ccc2e';
/** Positive control: a run whose lifetime contains the fixture's QE run — the PASS IS its evidence. */
const CONTAINING_RUN = 'containing-run';
/** A run over a checkout whose ledger holds a record that is not valid JSON. */
const BROKEN_LEDGER_RUN = 'broken-ledger-run';

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;
let clean: string;
let legacy: string;
let broken: string;

function view(id: string, workflowId: string, repoRef: string): SessionView {
  return {
    session: { id, status: 'failed', workflow_id: workflowId, repo_ref: repoRef },
    units: [],
  } as unknown as SessionView;
}

function repoEntry(id: string, rootPath: string): RepoEntry {
  return { id, name: id, root_path: rootPath, default_branch: 'main', registered_at: 0 };
}

function ev(type: string, session: string, ts: number, seq: number): RecordedEvent {
  return { type, session, ts, seq } as unknown as RecordedEvent;
}

function historyOf(runId: string): RecordedEvent[] {
  if (runId === CONTAINING_RUN) {
    return [ev('sessionStarted', runId, QE_RUN_STARTED - 60_000, 1), ev('sessionCompleted', runId, QE_RUN_STARTED + 3_600_000, 2)];
  }
  // Everything else started today and failed a second later — the observed onboarding shape.
  const now = Date.now();
  return [ev('sessionStarted', runId, now - 1_000, 1), ev('sessionFailed', runId, now, 2)];
}

/** `git init` + commit everything under `root`, with a local identity. */
function commitAll(root: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'acceptance readonly fixture');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
}

/** Every file under `root` except `.git/` (relative path → sha256): the byte-identity witness. */
function treeDigest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    if (rel === '.git' || rel.startsWith(`.git${sep}`)) continue;
    const abs = join(root, rel);
    if (!statSync(abs).isFile()) continue;
    out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'));
  }
  return out;
}

function porcelain(root: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, stdio: 'pipe' })
    .toString()
    .trim();
}

async function getAcceptance(id: string, query = '') {
  const res = await fetch(`${baseUrl}/api/v1/runs/${id}/acceptance${query}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function field<T>(body: Record<string, unknown>, key: string): T {
  return body[key] as T;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acceptance-readonly-'));

  // 1. A clean checkout: one committed file, no ledger anywhere.
  clean = join(dir, 'clean');
  mkdirSync(clean);
  writeFileSync(join(clean, 'README.md'), '# clean checkout\n');
  commitAll(clean);

  // 2. A checkout whose LEGACY ledger is committed (as wicked-core's is) — JSON only, no index,
  //    no .gitignore, so any file a read created would show up in porcelain AND in the digest.
  legacy = join(dir, 'legacy');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'README.md'), '# checkout with a committed legacy QE ledger\n');
  cpSync(join(FIXTURE, '.wicked-testing'), join(legacy, '.wicked-testing'), { recursive: true });
  commitAll(legacy);

  // 3. The same, plus a verdict record that is not valid JSON.
  broken = join(dir, 'broken');
  mkdirSync(broken);
  cpSync(join(FIXTURE, '.wicked-testing'), join(broken, '.wicked-testing'), { recursive: true });
  writeFileSync(join(broken, '.wicked-testing', 'verdicts', 'truncated.json'), '{"id":"trunc","run_id":');
  commitAll(broken);

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.sessionsDetail = async () => [
    view(CLEAN_RUN, 'feature', 'repo-clean'),
    view(FRESH_LEGACY_RUN, 'feature', 'repo-legacy'),
    view(ONBOARD_RUN, 'onboarding', 'repo-legacy'),
    view(CONTAINING_RUN, 'feature', 'repo-legacy'),
    view(BROKEN_LEDGER_RUN, 'feature', 'repo-broken'),
  ];
  adapter.listRepos = async () => [
    repoEntry('repo-clean', clean),
    repoEntry('repo-legacy', legacy),
    repoEntry('repo-broken', broken),
  ];
  adapter.runEvents = async (runId: string) => historyOf(runId);

  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  removeScratch(dir);
});

describe('GET /runs/:id/acceptance is read-only (F-E2E-013)', () => {
  it('on a clean checkout answers "no ledger" and leaves the tree byte-identical — creating no store', async () => {
    const before = treeDigest(clean);
    expect(porcelain(clean)).toBe('');

    const res = await getAcceptance(CLEAN_RUN);
    expect(res.status).toBe(200);
    expect(res.body['acceptance']).toMatchObject({ found: false, verdict: null, ledgerVerdicts: 0 });
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: false, verdict: null });
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/no QE ledger at/);

    expect(existsSync(join(clean, '.wicked-qe'))).toBe(false);
    expect(existsSync(join(clean, '.wicked-testing'))).toBe(false);
    expect(porcelain(clean)).toBe('');
    expect(treeDigest(clean)).toEqual(before);
  });

  it('dual-reads a COMMITTED legacy ledger without writing into it — no index, no WAL, porcelain empty', async () => {
    const before = treeDigest(legacy);
    expect(porcelain(legacy)).toBe('');
    expect(before.has(join('.wicked-testing', 'verdicts', '7ae4f27c-57f4-4e36-bfea-3e3d6c4deb48.json'))).toBe(true);

    const res = await getAcceptance(FRESH_LEGACY_RUN);
    expect(res.status).toBe(200);
    // Read from the legacy root …
    expect(res.body['acceptance']).toMatchObject({ ledgerDir: '.wicked-testing', found: true, ledgerVerdicts: 1 });

    // … and NOTHING materialised there. These are the exact files the pre-fix read created.
    for (const stray of ['wicked-qe.db', 'wicked-qe.db-wal', 'wicked-qe.db-shm', 'wicked-testing.db']) {
      expect(existsSync(join(legacy, '.wicked-testing', stray)), `${stray} must not be created by a GET`).toBe(false);
    }
    expect(porcelain(legacy)).toBe('');
    expect(treeDigest(legacy)).toEqual(before);
  });

  it("does NOT attribute the legacy ledger's old PASS to a fresh run that produced no evidence", async () => {
    const res = await getAcceptance(FRESH_LEGACY_RUN);
    expect(res.body['acceptance']).toMatchObject({
      found: true,
      verdict: null,
      qeRun: null,
      manifest: null,
      attribution: { kind: 'none' },
    });
    const attribution = field<{ attribution: { reason: string } }>(res.body, 'acceptance').attribution;
    expect(attribution.reason).toContain('newest PASS');
    expect(attribution.reason).toContain('before this run started');
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: false, verdict: null, runStatus: null });
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/no verdict attributed to this run/);
  });

  it('the observed shape — an onboarding run over that ledger — carries NO borrowed verdict on its vacuous gate', async () => {
    // The phase-2 body had `gate: { required: false, verdict: "PASS", runStatus: "passed" }` and a
    // July-2026 `acceptance.verdict` for a run that failed at plan time. Vacuous stays vacuous.
    const res = await getAcceptance(ONBOARD_RUN);
    expect(res.status).toBe(200);
    expect(res.body['requirement']).toEqual({ declared: false, phases: [] });
    expect(res.body['gate']).toMatchObject({ required: false, satisfied: true, verdict: null, runStatus: null });
    expect(res.body['acceptance']).toMatchObject({ found: true, verdict: null, qeRun: null, manifest: null, ledgerVerdicts: 1 });
    expect(porcelain(legacy)).toBe('');
  });

  it('positive control: a run whose lifetime CONTAINS the QE run is served the PASS — still without writing', async () => {
    const before = treeDigest(legacy);
    const res = await getAcceptance(CONTAINING_RUN);
    expect(res.body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', qeRunId: QE_RUN_ID },
      qeRun: { id: QE_RUN_ID },
      manifest: { artifactCount: 9 },
      attribution: { kind: 'run-window', qeRunId: QE_RUN_ID },
    });
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: true, verdict: 'PASS' });
    expect(treeDigest(legacy)).toEqual(before);
    expect(porcelain(legacy)).toBe('');
  });

  it("an explicit ?qeRun pin serves the verdict on the caller's say-so — and still writes nothing", async () => {
    const before = treeDigest(legacy);
    const res = await getAcceptance(FRESH_LEGACY_RUN, `?qeRun=${QE_RUN_ID}`);
    expect(res.body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', qeRunId: QE_RUN_ID },
      attribution: { kind: 'pinned', qeRunId: QE_RUN_ID },
    });
    expect(treeDigest(legacy)).toEqual(before);
    expect(porcelain(legacy)).toBe('');
  });

  it('surfaces an unreadable ledger record as a NAMED failure (deny) — never a silent PASS, never a repair', async () => {
    const before = treeDigest(broken);
    const res = await getAcceptance(BROKEN_LEDGER_RUN);
    expect(res.status).toBe(200);
    const acceptance = field<{ error?: string; verdict: unknown }>(res.body, 'acceptance');
    expect(acceptance.error).toMatch(/verdicts\/truncated\.json: not valid JSON/);
    expect(acceptance.verdict).toBeNull();
    expect(res.body['gate']).toMatchObject({ required: true, satisfied: false, verdict: null });
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/could not be read: verdicts\/truncated\.json/);
    expect(field<{ reason: string }>(res.body, 'gate').reason).toMatch(/unreadable ⇒ deny/);
    // The broken file is reported, not "healed", deleted or rewritten.
    expect(treeDigest(broken)).toEqual(before);
    expect(porcelain(broken)).toBe('');
  });
});
