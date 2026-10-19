// crew#1068 — through the REAL dist CLI: the daemon hands its engine a wicked-vault CLI that works.
//
//  A. A default boot (no inherited WICKED_VAULT_BIN): `/diagnostics.vault` names crew's own shipped
//     bin (absolute, existing), `/health.warnings` says nothing about the vault, and that bin —
//     invoked with EXACTLY the argv and env wicked-core's `CliVault` uses for a held team finding
//     (`src/team/vault.rs`: `init --cwd <evidence root>/team/vault`, then `record --cwd … --scope
//     run:<run> --phase team:<ord> --claim finding:<id> --kind team-finding-<kind> --criteria …
//     --artifact <evidence root>/team/holds/<stem>.json --actor <seat>`, `WICKED_VAULT_NO_BUS=1`) —
//     answers a vault entry id. That is the record a held boundary finding gets instead of "not
//     vaulted".
//  B. An operator who switched the vault off (`WICKED_VAULT_BIN=""`): the daemon still boots, the
//     value stays empty, and `/health.warnings`, `/diagnostics.vault` and `wicked-crew status` all
//     say held boundary findings will not be vaulted, with the remedy.
//
// Driving a governed run until the engine HOLDS a boundary finding is not reachable from crew's CI:
// the `--stub` engine convenes no team monitors, and a hold needs a monitor's withdrawal request or
// a cited text that disappears (wicked-core#959). The engine half — that a hold calls this CLI and
// records its entry id on the settled finding — is wicked-core's own supervisor test; this suite
// proves crew's half end to end: the variable the engine reads names a CLI that records.
//
// Runs only when dist is built (CI builds before test; locally `npm run build -w packages/crew`).

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import type { DiagnosticsResponse, HealthResponse } from '../../src/core/types.js';
import { baseSkillOff } from '../setup/base-skill-off.js';
import { removeScratch } from '../setup/scratch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', '..', 'dist', 'cli', 'index.js');
const BOOT_TIMEOUT_MS = 90_000;
const run = promisify(execFile);

interface Daemon {
  proc: ChildProcess;
  port: number;
}

const daemons: Daemon[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    if (d.proc.exitCode === null) {
      const exited = new Promise<void>((done) => d.proc.once('exit', () => done()));
      d.proc.kill('SIGTERM');
      setTimeout(() => {
        if (d.proc.exitCode === null) d.proc.kill('SIGKILL');
      }, 5_000).unref();
      await exited;
    }
  }
  for (const s of scratch.splice(0)) removeScratch(s);
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'crew-1068-e2e-'));
  scratch.push(d);
  return d;
}

async function bootDaemon(vaultBin: string | undefined): Promise<Daemon> {
  baseSkillOff();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['WICKED_VAULT_BIN'];
  if (vaultBin !== undefined) env['WICKED_VAULT_BIN'] = vaultBin;
  const proc = spawn(process.execPath, [CLI, 'serve', '--stub', '--port', '0', '--db', join(tmp(), 'core.db')], {
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
  const port = await new Promise<number>((ok, fail) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      fail(new Error(`daemon did not report ready in ${BOOT_TIMEOUT_MS}ms\n${stderr}`));
    }, BOOT_TIMEOUT_MS);
    proc.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      const line = stdout.split('\n').find((l) => l.startsWith('WICKED_CREW_READY '));
      if (line === undefined) return;
      clearTimeout(timer);
      ok((JSON.parse(line.slice('WICKED_CREW_READY '.length)) as { port: number }).port);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`daemon exited (${code}) before ready\n${stderr}`));
    });
  });
  const d = { proc, port };
  daemons.push(d);
  return d;
}

async function get<T>(d: Daemon, path: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${d.port}/api/v1${path}`);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe.runIf(existsSync(CLI))('the engine\'s wicked-vault CLI (crew#1068)', () => {
  it.skipIf(process.platform === 'win32')(
    'A: a default boot hands the engine crew\'s own bin, and core\'s held-finding record through it answers an entry id',
    async () => {
      const d = await bootDaemon(undefined);
      const diag = await get<DiagnosticsResponse>(d, '/diagnostics');
      expect(diag.vault?.source).toBe('shipped');
      expect(diag.vault?.finding).toBeNull();
      const bin = diag.vault!.bin!;
      expect(isAbsolute(bin)).toBe(true);
      expect(existsSync(bin)).toBe(true);
      const health = await get<HealthResponse>(d, '/health');
      expect((health.warnings ?? []).filter((w) => w.kind.startsWith('vault.'))).toEqual([]);

      // wicked-core's CliVault, verbatim: the run's team vault under its evidence root, the hold's
      // artifact beside it, `init` then `record`, with the bus switched off for the child.
      const evidenceRoot = tmp();
      const vaultDir = join(evidenceRoot, 'team', 'vault');
      const holds = join(evidenceRoot, 'team', 'holds');
      mkdirSync(vaultDir, { recursive: true });
      mkdirSync(holds, { recursive: true });
      const artifact = join(holds, 'run-1-u2-a1-r3-f-9-withdrawal-request.json');
      writeFileSync(artifact, JSON.stringify({ run: 'run-1', ord: 2, attempt: 1, raise_seq: 3, finding: { finding_id: 'f-9' } }));
      const env = { ...process.env, WICKED_VAULT_NO_BUS: '1' };
      await run(bin, ['init', '--cwd', vaultDir], { env });
      expect(existsSync(join(vaultDir, '.wicked-vault'))).toBe(true);
      const { stdout } = await run(
        bin,
        [
          'record', '--cwd', vaultDir,
          '--scope', 'run:run-1',
          '--phase', 'team:2',
          '--claim', 'finding:f-9',
          '--kind', 'team-finding-withdrawal-request',
          '--criteria', 'a team finding naming a boundary circumvention, held for the operator: only the operator clears it (core#959)',
          '--artifact', artifact,
          '--actor', 'claude',
        ],
        { env },
      );
      const id = (JSON.parse(stdout.trim()) as { id?: unknown }).id;
      expect(typeof id).toBe('string');
      expect((id as string).length).toBeGreaterThan(0);
    },
    120_000,
  );

  it('B: an operator who switched the vault off — boot succeeds, and health, diagnostics and status say so', async () => {
    const d = await bootDaemon('');
    const health = await get<HealthResponse>(d, '/health');
    expect(health.status).toBe('ok');
    const warning = (health.warnings ?? []).find((w) => w.kind === 'vault.off');
    expect(warning?.message).toMatch(/held boundary findings will not be vaulted — unset WICKED_VAULT_BIN/);
    const diag = await get<DiagnosticsResponse>(d, '/diagnostics');
    expect(diag.vault).toMatchObject({ bin: null, source: 'off', finding: { kind: 'vault.off' } });
    expect(diag.vault?.finding?.remedy).toMatch(/unset WICKED_VAULT_BIN/);
    const status = await run(process.execPath, [CLI, 'status', '--port', String(d.port)]);
    expect(status.stderr).toContain(`wicked-crew: ${warning!.message}`);
  }, 120_000);
});
