// crew#1559 item 7: the cached sample's checksum sidecar is opened once and only that descriptor is checked and read.
// A second process that swaps the sidecar, or grows it, after the check must not change what is read. The window sits
// between two synchronous fs calls, so this file stands in node:fs to act in it: right after the sidecar's check
// (an lstat of the path on the old code, the fstat of its descriptor now).
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({ fire: null as (() => void) | null }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const once = (): void => {
    const f = hook.fire;
    hook.fire = null;
    f?.();
  };
  return {
    ...real,
    lstatSync: ((p: unknown, ...rest: unknown[]) => {
      const out = (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
      if (typeof p === 'string' && p.endsWith('.sha256')) once();
      return out;
    }) as typeof real.lstatSync,
    fstatSync: ((fd: unknown, ...rest: unknown[]) => {
      const out = (real.fstatSync as (...a: unknown[]) => unknown)(fd, ...rest);
      once();
      return out;
    }) as typeof real.fstatSync,
  };
});

const { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = await import('node:fs');
const { TtsService } = await import('../src/voice/tts.js');
const { TTS_ENGINE } = await import('../src/voice/tts-manifest.js');
type VoiceSpawn = import('../src/voice/service.js').VoiceSpawn;
type TtsVoice = import('../src/voice/tts-manifest.js').TtsVoice;

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
function wav(samples: number): Buffer {
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const VOICE: TtsVoice = {
  id: 'en_test-a', name: 'en_test-a', accent: 'test', licence: 'CC0', clearance: { basis: 'test', reviewed: '2026-11-12' },
  model: { path: 'en_test-a.onnx', sha256: '', bytes: 1 }, config: { path: 'en_test-a.onnx.json', sha256: '', bytes: 1 },
};

/** A piper stand-in: writes `fresh` to the file after `-f`, and counts its launches. */
function piperSpawn(fresh: Buffer): { spawn: VoiceSpawn; launches: () => number } {
  let n = 0;
  const spawn = ((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; kill: () => boolean };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 0; child.kill = () => true;
    child.stdin.resume();
    child.stdin.on('finish', () => {
      n += 1;
      writeFileSync(args[args.indexOf('-f') + 1]!, fresh);
      setTimeout(() => { child.stdout.end(''); child.stderr.end(''); child.emit('close', 0); }, 5);
    });
    return child;
  }) as unknown as VoiceSpawn;
  return { spawn, launches: () => n };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tts-sidecar-')); hook.fire = null; });
afterEach(() => { hook.fire = null; rmSync(dir, { recursive: true, force: true }); });

/** A service with the engine and the voice installed, and a cached sample whose sidecar records its digest. */
function cachedSample(fresh: Buffer): { s: InstanceType<typeof TtsService>; launches: () => number; cached: Buffer; sum: string } {
  const p = piperSpawn(fresh);
  const s = new TtsService({ dir, locksDir: join(dir, 'locks'), platform: 'linux', glibc: () => '2.35', probe: () => null, voices: [VOICE], spawn: p.spawn });
  mkdirSync(join(dir, 'tts', 'engine', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'tts', 'engine', 'bin', 'python'), '');
  mkdirSync(join(dir, 'tts', 'voices', VOICE.id), { recursive: true });
  writeFileSync(join(dir, 'tts', 'voices', VOICE.id, 'en_test-a.onnx'), 'm');
  writeFileSync(join(dir, 'tts', 'voices', VOICE.id, 'en_test-a.onnx.json'), 'c');
  const path = join(dir, 'tts', 'sample', `${VOICE.id}-${TTS_ENGINE.version}.wav`);
  mkdirSync(join(dir, 'tts', 'sample'), { recursive: true });
  const cached = wav(400);
  writeFileSync(path, cached);
  writeFileSync(`${path}.sha256`, sha(cached));
  return { s, launches: p.launches, cached, sum: `${path}.sha256` };
}

describe('crew#1559 item 7: the sample sidecar is read through the descriptor that was checked', () => {
  it('a sidecar that grows after its size check is refused, and the sample is made again', async () => {
    const fresh = wav(1600);
    const { s, launches, sum } = cachedSample(fresh);
    // The correct digest padded past the cap: trim() would still accept it, so only the descriptor read refuses it.
    hook.fire = () => appendFileSync(sum, ' '.repeat(4096));
    expect((await s.sample(VOICE.id)).equals(fresh)).toBe(true);
    expect(hook.fire).toBeNull(); // the window was reached
    expect(launches()).toBe(1);
    expect(readFileSync(sum, 'utf8')).toBe(sha(fresh));
  });

  it('a sidecar swapped after its check is not the one read: the checked file decides', async () => {
    const fresh = wav(1600);
    const { s, launches, cached, sum } = cachedSample(fresh);
    hook.fire = () => {
      writeFileSync(`${sum}.swap`, 'f'.repeat(64)); // another digest, renamed over the path
      renameSync(`${sum}.swap`, sum);
    };
    expect((await s.sample(VOICE.id)).equals(cached)).toBe(true);
    expect(hook.fire).toBeNull();
    expect(launches()).toBe(0);
  });
});
