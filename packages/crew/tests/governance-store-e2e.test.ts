// Governance events LAND on a fresh `--db` daemon, and dead letters are visible and never under
// HOME (crew#495, acceptance finding F-022) — through the REAL dist CLI and the REAL engine
// (`--stub` swaps the council + step runner, not the store actor or the emit seam).
//
//  A. `serve --db <scratch>/core.db`: a steering-rule upsert (the actor's `register_rule` fires the
//     engine's `wicked.estate.rule.ingested` emit) lands in `<core db>.governance/governance.db`;
//     no outbox appears; the daemon's stderr carries no EMIT-DEADLETTER; `/diagnostics.governance`
//     names the store, counts zero dead letters and raises no finding.
//  B. `serve --governance-db :memory:` (the engine treats `:memory:` as "no shared store" — the exact
//     reason the finding recorded): the same upsert dead-letters to `<core db>.governance/
//     emit-outbox.ndjson`, under the scratch state home; `/diagnostics` counts it and raises
//     `governance.deadletter` (error); the pre-fix HOME outbox does not grow.
//
// Runs only when dist is built (CI builds before test; locally `npm run build -w packages/crew`).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiagnosticsResponse } from 'wicked-crew-api-types';

import { legacyHomeOutboxPath } from '../src/core/governance-store.js';
import { removeScratch } from './setup/scratch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'dist', 'cli', 'index.js');
const BOOT_TIMEOUT_MS = 90_000;

interface Daemon {
  proc: ChildProcess;
  port: number;
  ready: Record<string, unknown>;
  stderr: () => string;
  stop: () => Promise<void>;
}

/** Boot `serve --stub --port 0 …` on a scratch state home and wait for the readiness marker. */
async function bootDaemon(scratch: string, extraArgs: string[]): Promise<Daemon> {
  // The child inherits the hermetic arming (`...process.env`) — its state home is the scratch
  // `--db` parent, so everything durable it writes lands under the OS temp root. The ONE variable
  // dropped is the engine's outbox override: the harness arms it to a shared per-process file, and
  // the point of this test is the daemon's OWN default — `<core db>.governance/emit-outbox.ndjson`
  // beside the scratch core db, equally hermetic and the very path the fix is about.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['WICKED_APPS_EMIT_DEADLETTER'];
  delete env['WICKED_ESTATE_DB'];
  delete env['WICKED_CREW_GOVERNANCE_DB'];
  const dbPath = join(scratch, 'state', 'core.db');
  const proc = spawn(process.execPath, [CLI, 'serve', '--stub', '--port', '0', '--db', dbPath, ...extraArgs], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (c: string) => {
    stderr += c;
  });
  const ready = await new Promise<Record<string, unknown>>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon did not report ready in ${BOOT_TIMEOUT_MS}ms\n${stderr}`)), BOOT_TIMEOUT_MS);
    proc.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      const line = stdout.split('\n').find((l) => l.startsWith('WICKED_CREW_READY '));
      if (line !== undefined) {
        clearTimeout(timer);
        resolveReady(JSON.parse(line.slice('WICKED_CREW_READY '.length)) as Record<string, unknown>);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited (${code}) before ready\n${stderr}`));
    });
  });
  const port = ready['port'] as number;
  return {
    proc,
    port,
    ready,
    stderr: () => stderr,
    stop: () =>
      new Promise<void>((done) => {
        if (proc.exitCode !== null) return done();
        proc.once('exit', () => done());
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }, 5_000).unref();
      }),
  };
}

const RULE = {
  id: 'PAT-495',
  rule_type: 'pattern',
  statement: 'governance events must land, never silently dead-letter',
  severity: 'warn',
  confidence: 0.9,
  targets: {},
  provenance: { source: 'markdown', source_kinds: ['doc'] },
};

async function upsertRule(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/governance/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(RULE),
  });
  return res.status;
}

async function diagnostics(port: number): Promise<DiagnosticsResponse> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/diagnostics`);
  expect(res.status).toBe(200);
  return (await res.json()) as DiagnosticsResponse;
}

/** Size of the pre-fix HOME outbox (0 when absent) — read-only; the assertion is that it does not GROW. */
function legacyOutboxBytes(): number {
  const p = legacyHomeOutboxPath();
  if (p === null || !existsSync(p)) return 0;
  return statSync(p).size;
}

let scratch: string | undefined;
let daemon: Daemon | undefined;
afterEach(async () => {
  if (daemon !== undefined) await daemon.stop();
  daemon = undefined;
  if (scratch !== undefined) removeScratch(scratch);
  scratch = undefined;
});

describe.runIf(existsSync(CLI))('governance store on a fresh --db daemon (crew#495)', () => {
  it('C. a `postgres://` governance store is REFUSED at boot — the emit seam is SQLite-only — exit 1 before anything starts, and the credential is never echoed', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-gov-e2e-c-'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['WICKED_ESTATE_DB'];
    delete env['WICKED_CREW_GOVERNANCE_DB'];
    const dbPath = join(scratch, 'state', 'core.db');
    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolveResult) => {
      const proc = spawn(process.execPath, [CLI, 'serve', '--stub', '--port', '0', '--db', dbPath, '--governance-db', 'postgres://user:s3cret@h/gov'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout!.setEncoding('utf8');
      proc.stderr!.setEncoding('utf8');
      proc.stdout!.on('data', (c: string) => { stdout += c; });
      proc.stderr!.on('data', (c: string) => { stderr += c; });
      proc.on('exit', (code) => resolveResult({ code, stderr, stdout }));
    });
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('WICKED_CREW_READY');
    expect(result.stderr).toMatch(/emit seam stores to SQLite/);
    expect(result.stderr).toContain('postgres://***@h/gov');
    expect(result.stderr).not.toContain('s3cret');
    expect(existsSync(join(scratch, 'state', 'core.db.governance'))).toBe(false); // nothing was created
  }, 60_000);

  it('A. records LAND in <core db>.governance/governance.db — no outbox, no EMIT-DEADLETTER, diagnostics clean', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-gov-e2e-a-'));
    const legacyBefore = legacyOutboxBytes();
    daemon = await bootDaemon(scratch, []);
    const sidecar = join(scratch, 'state', 'core.db.governance');
    const storePath = join(sidecar, 'governance.db');
    const outboxPath = join(sidecar, 'emit-outbox.ndjson');
    // The readiness marker names the store an evidence harness can open.
    expect(daemon.ready['governanceDb']).toBe(storePath);
    // The boot log says which rule won.
    expect(daemon.stderr()).toContain(`governance store: ${storePath} (core-db-sidecar)`);
    expect(daemon.stderr()).toContain(`dead letters: ${outboxPath} (core-db-sidecar)`);

    expect(await upsertRule(daemon.port)).toBe(200);

    // The store exists (the engine created it on first emit), the outbox does not.
    expect(existsSync(storePath)).toBe(true);
    expect(existsSync(outboxPath)).toBe(false);
    expect(daemon.stderr()).not.toContain('EMIT-DEADLETTER');

    const body = await diagnostics(daemon.port);
    expect(body.governance.store).toEqual({ path: storePath, source: 'core-db-sidecar' });
    expect(body.governance.deadletters.path).toBe(outboxPath);
    expect(body.governance.deadletters.count).toBe(0);
    expect(body.governance.findings.filter((f) => f.kind !== 'governance.legacy-outbox')).toEqual([]);
    // With an engine that can count (the crew#495 companion binding) the record is VISIBLE: at least
    // the rule.ingested event landed since boot. An older addon answers null — never a fabricated 0.
    if (body.governance.records.total !== null) {
      expect(body.governance.records.sinceBoot).toBeGreaterThanOrEqual(1);
    } else {
      expect(body.governance.records.sinceBoot).toBeNull();
    }
    // The sidecar is a store file diagnostics already lists (the `core.db` prefix), and it is under scratch.
    const listed = body.stores.find((s) => s.name === 'core.db.governance');
    expect(listed?.path).toBe(sidecar);
    expect(legacyOutboxBytes()).toBe(legacyBefore);
  }, BOOT_TIMEOUT_MS + 30_000);

  it('B. a store the engine cannot write dead-letters UNDER THE STATE HOME, and /diagnostics raises governance.deadletter', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-gov-e2e-b-'));
    const legacyBefore = legacyOutboxBytes();
    daemon = await bootDaemon(scratch, ['--governance-db', ':memory:']);
    const outboxPath = join(scratch, 'state', 'core.db.governance', 'emit-outbox.ndjson');
    expect(daemon.stderr()).toContain('governance store: :memory: (flag)');

    expect(await upsertRule(daemon.port)).toBe(200);

    // The engine said so loudly, and spooled to the SIDECAR — never to HOME.
    expect(daemon.stderr()).toContain('EMIT-DEADLETTER');
    expect(daemon.stderr()).toContain(`spooled \`wicked.estate.rule.ingested\` to ${outboxPath}`);
    expect(existsSync(outboxPath)).toBe(true);
    const entries = readFileSync(outboxPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const ingested = entries.find((e) => e['type'] === 'wicked.estate.rule.ingested');
    expect(ingested).toBeDefined();
    expect(ingested!['deadletter_reason']).toBe('no shared store (WICKED_ESTATE_DB unset)');
    // An engine carrying the crew#495 companion stamps every entry (ts = epoch ms, pid, origin from
    // WICKED_APPS_EMIT_ORIGIN — this daemon). An older engine writes none; the fold below reports
    // whichever honestly.
    const stamped = entries.filter((e) => typeof e['ts'] === 'number');
    for (const e of stamped) {
      expect(e['ts'] as number).toBeGreaterThan(1_700_000_000_000);
      expect(e['pid']).toBe(daemon.proc.pid);
      expect(String(e['origin'])).toMatch(/^wicked-crew@\d+\.\d+\.\d+ serve pid=\d+ port=\d+ db=/);
    }

    const body = await diagnostics(daemon.port);
    expect(body.governance.store).toEqual({ path: ':memory:', source: 'flag' });
    expect(body.governance.deadletters.path).toBe(outboxPath);
    expect(body.governance.deadletters.count).toBe(entries.length);
    expect(body.governance.deadletters.byType['wicked.estate.rule.ingested']).toBeGreaterThanOrEqual(1);
    expect(body.governance.deadletters.byReason).toEqual({ 'no shared store (WICKED_ESTATE_DB unset)': entries.length });
    expect(body.governance.deadletters.timestamped).toBe(stamped.length);
    expect(body.governance.deadletters.untimestamped).toBe(entries.length - stamped.length);
    const finding = body.governance.findings.find((f) => f.kind === 'governance.deadletter');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain(`dead-lettered to ${outboxPath}`);
    expect(finding?.message).toContain('wicked-crew governance replay');
    expect(legacyOutboxBytes()).toBe(legacyBefore);
  }, BOOT_TIMEOUT_MS + 30_000);
});
