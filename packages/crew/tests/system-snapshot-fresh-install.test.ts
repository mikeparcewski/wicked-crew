// J1 (fresh install, crew 0.16.11 on a fresh home): the Nerve Center said "Model gateway: down —
// Start Docker" while Docker ran (the gateway container simply did not exist yet), and it did not
// list the missing wicked-garden that refuses every launch. Both probes are driven here the way the
// daemon drives them: the gateway probe through a REAL child process whose error is execFile-shaped
// ("Command failed: <cmd>\n<stderr>"), not a hand-made one-line Error.

import { describe, expect, it } from 'vitest';

import { execCapped } from '../src/core/exec.js';
import { buildNeeds, errText, probeGateway, skillsRow } from '../src/api/system-snapshot.js';

/** A stand-in runtime: node itself, printing what docker prints to stderr and exiting `code`. The
 *  words ride in the environment, not argv, so they never appear on the error's command line. */
const runtimeSaying = (stderr: string, code = 1) =>
  (_file: string, _args: string[], opts: { timeout: number }) =>
    execCapped(process.execPath, ['-e', 'process.stderr.write(process.env.J1_SAY ?? ""); process.exit(Number(process.env.J1_CODE))'], {
      timeout: opts.timeout,
      env: { ...process.env, J1_SAY: stderr, J1_CODE: String(code) },
    });

const base = { containerFloor: true, gatewayDir: '/state/gateway', runtime: '/usr/bin/docker', timeoutMs: 15_000 };

describe('a fresh install: no gateway container yet', () => {
  it('a real child error carries the command on its first line and the cause on stderr; errText keeps the cause', async () => {
    const err = await runtimeSaying('Error response from daemon: No such container: wicked-agw-x\n')('docker', [], { timeout: 15_000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.split('\n', 1)[0]).toMatch(/^Command failed:/);
    expect(errText(err)).toBe('Error response from daemon: No such container: wicked-agw-x');
  });

  it('"No such container" from the runtime reads "not started" (degraded), not "down: start Docker"', async () => {
    const row = await probeGateway({ ...base, exec: runtimeSaying('Error response from daemon: No such container: wicked-agw-x\n') });
    expect(row.state).toBe('degraded');
    expect(row.reason).toMatch(/^not started/);
    expect(row.remedy ?? '').not.toMatch(/Start Docker/);
  });

  it('a runtime that cannot be reached is still down, and the reason is what the runtime said, not the command line', async () => {
    const row = await probeGateway({
      ...base,
      exec: runtimeSaying('failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory\n'),
    });
    expect(row.state).toBe('down');
    expect(row.reason).toMatch(/failed to connect to the docker API/);
    expect(row.reason).not.toMatch(/Command failed/);
  });

  it('an error with no stderr (spawn ENOENT, a plain Error) keeps its message', () => {
    expect(errText(Object.assign(new Error('spawn wicked-estate-mcp ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' }))).toBe('spawn wicked-estate-mcp ENOENT');
    expect(errText(new Error('first\nsecond'))).toBe('first');
    expect(errText('plain')).toBe('plain');
  });
});

describe('a fresh install: no wicked-garden', () => {
  const baseSkillMissing = {
    state: 'fallback',
    findings: [
      { kind: 'skills.fallback', severity: 'warning', message: 'no wicked-garden plugin source' },
      { kind: 'skills.base-skill', severity: 'error', message: 'the base skill "wicked-garden-governed-worker" is REQUIRED but no published snapshot is handed to the engine: the engine refuses every launch at intake' },
    ],
  };

  it('the base skill missing refuses every launch: the skills row is down with the install command', () => {
    const row = skillsRow(baseSkillMissing);
    expect(row.state).toBe('down');
    expect(row.reason).toMatch(/refuses every launch/);
    expect(row.remedy).toMatch(/npx wicked-installer install wicked-garden/);
  });

  it('a fallback with only a warning stays degraded', () => {
    expect(skillsRow({ state: 'fallback', findings: [{ severity: 'warning', message: 'w' }] }).state).toBe('degraded');
  });

  it('the Nerve Center lists it as something that stops work', () => {
    const n = buildNeeds({ now: Date.now(), views: [], runs: [], infra: [skillsRow(baseSkillMissing)], clis: [], gaps: [], infraHoldsLive: () => false });
    const item = n.attention.find((a) => a.id === 'infra:skills');
    expect(item).toBeDefined();
    expect(item!.kind).toBe('prevents');
    expect(item!.severity).toBe('red');
  });
});
