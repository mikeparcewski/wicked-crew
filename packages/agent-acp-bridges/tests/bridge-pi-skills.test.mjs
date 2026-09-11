/**
 * `WICKED_PI_SKILL_DIRS` → pi's skill flags (F-079, wicked-crew#531; the env contract
 * wicked-core#441 sets on a pi seat's ACP carrier).
 *
 *   1. the pure derivation: unset/blank → nothing; a delimiter-separated list → `--no-skills`
 *      then `--skill <dir>` per entry, in order, blanks and duplicates dropped;
 *   2. the bridge applies it ONLY to a pi invocation, BEFORE the bridge's own args, and a
 *      non-pi bin's argv is byte-identical to its invocation — proven by spawning a stub `pi`
 *      that echoes its argv back through the bridge's stream;
 *   3. the `wicked-pi` launcher (the shim pi-acp starts through `PI_ACP_PI_COMMAND`) composes
 *      the same argv ahead of its pass-through args and runs the pi binary `WICKED_PI_BINARY`
 *      names — proven with a stub that records its argv to a file.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isPiBinary, PI_SKILL_DIRS_ENV, piSkillFlags, runBridge, skillFlagsFor } from '../bridge.mjs';
import { composePiArgv, piBinary, runPiLauncher } from '../wicked-pi.mjs';

const posix = process.platform !== 'win32';
const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A directory holding an executable `pi` stub (a node script) that prints its argv as JSON, one per line. */
function stubPi(body) {
  const dir = mkdtempSync(join(tmpdir(), 'wicked-pi-stub-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'pi');
  writeFileSync(bin, `#!${process.execPath}\n${body}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

describe('piSkillFlags', () => {
  it('unset or blank → no flags (a launch without a delivery is unchanged)', () => {
    expect(piSkillFlags({})).toEqual([]);
    expect(piSkillFlags({ [PI_SKILL_DIRS_ENV]: '' })).toEqual([]);
    expect(piSkillFlags({ [PI_SKILL_DIRS_ENV]: '   ' })).toEqual([]);
    expect(piSkillFlags({ [PI_SKILL_DIRS_ENV]: delimiter })).toEqual([]);
  });

  it('a delimiter-separated list → `--no-skills` then one `--skill <dir>` per entry, in order, blanks + duplicates dropped', () => {
    const env = { [PI_SKILL_DIRS_ENV]: ['/snap/skills/qe', '/snap/skills/mem', '', '/snap/skills/qe', ' /snap/skills/search '].join(delimiter) };
    expect(piSkillFlags(env)).toEqual(['--no-skills', '--skill', '/snap/skills/qe', '--skill', '/snap/skills/mem', '--skill', '/snap/skills/search']);
  });

  it('splits on the OS path delimiter (`:` / `;`), never on the other one — a Windows path keeps its drive colon', () => {
    expect(piSkillFlags({ [PI_SKILL_DIRS_ENV]: 'C:\\snap\\skills\\qe;C:\\snap\\skills\\mem' }, ';')).toEqual([
      '--no-skills',
      '--skill',
      'C:\\snap\\skills\\qe',
      '--skill',
      'C:\\snap\\skills\\mem',
    ]);
    expect(piSkillFlags({ [PI_SKILL_DIRS_ENV]: '/a:/b' }, ':')).toEqual(['--no-skills', '--skill', '/a', '--skill', '/b']);
  });

  it('skillFlagsFor applies only to the pi binary — bare, path-prefixed, Windows launcher extensions', () => {
    const env = { [PI_SKILL_DIRS_ENV]: '/snap/skills/qe' };
    for (const bin of ['pi', '/usr/local/bin/pi', 'C:\\Users\\x\\AppData\\npm\\pi.cmd', 'pi.exe', 'PI']) {
      expect(isPiBinary(bin), bin).toBe(true);
      expect(skillFlagsFor(bin, env), bin).toEqual(['--no-skills', '--skill', '/snap/skills/qe']);
    }
    for (const bin of ['agy', 'codex', 'pi-acp', 'api', 'copilot', '/x/bin/pip']) {
      expect(isPiBinary(bin), bin).toBe(false);
      expect(skillFlagsFor(bin, env), bin).toEqual([]);
    }
  });
});

// ── The bridge's spawn: pi gets the flags first, everything else is untouched ────────────────

function createTestBridge(invocationFn) {
  const input = new PassThrough();
  const output = new PassThrough();
  runBridge({ name: 'test-bridge', version: '0.0.0', invocation: invocationFn, _streams: { input, output }, _exit: vi.fn() });
  const received = [];
  const waiters = [];
  let buf = '';
  output.on('data', (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiters.length > 0) waiters.shift()(msg);
      else received.push(msg);
    }
  });
  const send = (msg) => input.write(JSON.stringify(msg) + '\n');
  const next = () =>
    received.length > 0
      ? Promise.resolve(received.shift())
      : new Promise((resolve, reject) => {
          waiters.push(resolve);
          setTimeout(() => reject(new Error('bridge next() timed out')), 10_000).unref();
        });
  return { send, next };
}

/** Handshake, one prompt turn, and the CLI's streamed stdout joined — the argv the stub echoed. */
async function turnOutput(b) {
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await b.next();
  b.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
  await b.next();
  b.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'work' }] } });
  const chunks = [];
  for (;;) {
    const msg = await b.next();
    if (msg.id === 3) return { stopReason: msg.result?.stopReason, text: chunks.join('') };
    if (msg.method === 'session/update') chunks.push(msg.params?.update?.content?.text ?? '');
  }
}

describe.skipIf(!posix)('runBridge spawns pi with the skill flags BEFORE the invocation args', () => {
  const saved = process.env[PI_SKILL_DIRS_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[PI_SKILL_DIRS_ENV];
    else process.env[PI_SKILL_DIRS_ENV] = saved;
  });

  it('a pi invocation: `--no-skills --skill <dir>…` then the bridge args; the turn completes', async () => {
    const { bin } = stubPi("process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');");
    process.env[PI_SKILL_DIRS_ENV] = ['/snap/skills/qe', '/snap/skills/mem'].join(delimiter);
    const b = createTestBridge((prompt) => ({ bin, args: ['--mode', 'rpc', '-p', prompt] }));
    const { stopReason, text } = await turnOutput(b);
    expect(stopReason).toBe('end_turn');
    expect(JSON.parse(text.trim())).toEqual(['--no-skills', '--skill', '/snap/skills/qe', '--skill', '/snap/skills/mem', '--mode', 'rpc', '-p', 'work']);
  });

  it('the variable unset: the argv is exactly the invocation (byte-identical to before F-079)', async () => {
    const { bin } = stubPi("process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');");
    delete process.env[PI_SKILL_DIRS_ENV];
    const b = createTestBridge((prompt) => ({ bin, args: ['--mode', 'rpc', '-p', prompt] }));
    const { text } = await turnOutput(b);
    expect(JSON.parse(text.trim())).toEqual(['--mode', 'rpc', '-p', 'work']);
  });

  it('a non-pi bin never receives the flags, even with the variable set', async () => {
    process.env[PI_SKILL_DIRS_ENV] = '/snap/skills/qe';
    const b = createTestBridge((prompt) => ({ bin: process.execPath, args: ['-e', `process.stdout.write(JSON.stringify(process.argv.slice(1)))`, '--', prompt] }));
    const { text } = await turnOutput(b);
    // node's argv after `-e`: the `--` sentinel is consumed by node; the prompt survives, no flags.
    expect(JSON.parse(text.trim())).toEqual(['work']);
  });
});

// ── The wicked-pi launcher (pi-acp's PI_ACP_PI_COMMAND target) ────────────────────────────────

describe('wicked-pi launcher', () => {
  it('composePiArgv: skill flags first, then every pass-through arg (pi-acp\'s `--mode rpc --no-themes`)', () => {
    expect(composePiArgv(['--mode', 'rpc', '--no-themes'], { [PI_SKILL_DIRS_ENV]: ['/a', '/b'].join(delimiter) })).toEqual([
      '--no-skills',
      '--skill',
      '/a',
      '--skill',
      '/b',
      '--mode',
      'rpc',
      '--no-themes',
    ]);
    expect(composePiArgv(['--mode', 'rpc', '--no-themes'], {})).toEqual(['--mode', 'rpc', '--no-themes']);
  });

  it('piBinary: `pi` on PATH by default, `WICKED_PI_BINARY` when set', () => {
    expect(piBinary({})).toBe('pi');
    expect(piBinary({ WICKED_PI_BINARY: '  ' })).toBe('pi');
    expect(piBinary({ WICKED_PI_BINARY: '/opt/pi/bin/pi' })).toBe('/opt/pi/bin/pi');
  });

  it.skipIf(!posix)('runs the pi binary with the composed argv, mirrors its exit code, and passes stdio through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wicked-pi-run-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const record = join(dir, 'argv.json');
    const { bin } = stubPi(`require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2))); process.exit(3);`);
    const env = { ...process.env, WICKED_PI_BINARY: bin, [PI_SKILL_DIRS_ENV]: ['/snap/skills/qe', '/snap/skills/qe', '/snap/skills/mem'].join(delimiter) };
    const code = await runPiLauncher(['--mode', 'rpc', '--no-themes'], env);
    expect(code).toBe(3);
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(['--no-skills', '--skill', '/snap/skills/qe', '--skill', '/snap/skills/mem', '--mode', 'rpc', '--no-themes']);
  });

  it.skipIf(!posix)('a missing pi binary is a named failure with exit 127, not a hang or a crash', async () => {
    const env = { ...process.env, WICKED_PI_BINARY: join(tmpdir(), 'definitely-not-a-pi-binary-' + process.pid) };
    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m) => errors.push(String(m)));
    cleanups.push(() => spy.mockRestore());
    const code = await runPiLauncher(['--mode', 'rpc'], env);
    expect(code).toBe(127);
    expect(errors.join('\n')).toContain('could not start');
  });
});
