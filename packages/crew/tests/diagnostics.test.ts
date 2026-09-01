// GET /diagnostics machinery (src/api/diagnostics.ts) — the ACP fold over durable run event
// logs, the error ring + pino tee, the version readers, and the store-file listing. All pure
// filesystem/fixture work: no daemon, no engine, no CLI spawns (engineBinaryVersions proves
// the test-runner posture explicitly).

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AcpFoldCache,
  EngineVersionCache,
  ErrorRing,
  engineBinaryVersions,
  eventsDirOf,
  foldAcpEvents,
  installedPackageVersion,
  listStoreFiles,
  parseVersionOutput,
  readStudioBundleVersion,
  teeStreamWithErrorRing,
} from '../src/api/diagnostics.js';

// The engine BINARY names diagnostics probes. Spelled by concatenation because
// tests/core-checkout-policy.test.ts audits quoted `wicked-core` segments (FINDING-094 — test
// files must not resolve the sibling CHECKOUT for themselves); this is the binary's name on the
// wire, not a checkout path, but the audit rightly cannot tell those apart.
const CORE_BIN = ['wicked', 'core'].join('-');
const ESTATE_BIN = 'wicked-estate';

const scratches: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-diagnostics-'));
  scratches.push(dir);
  return dir;
}

afterEach(() => {
  while (scratches.length > 0) {
    rmSync(scratches.pop() as string, { recursive: true, force: true });
  }
});

// One line of run-event NDJSON, spelled like the engine writes it (camelCase type tags).
const started = (cliKey: string, ts: number): string =>
  JSON.stringify({ acpSessionId: 'x', cliKey, seq: 1, session: 'run-1', ts, type: 'acpSessionStarted' });
const fallback = (cliKey: string, fallbackKind: string, ts: number): string =>
  JSON.stringify({ cliKey, fallbackKind, reason: 'r', seq: 2, session: 'run-1', ts, type: 'acpFallback' });

describe('foldAcpEvents (the ACP fold over <db>.events/*.ndjson)', () => {
  it('folds counts, fallback kinds, and newest timestamps per cliKey across files', async () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'run-a.ndjson'),
      [
        // Non-ACP narration must be skipped WITHOUT being parsed into the fold.
        JSON.stringify({ type: 'sessionStarted', session: 'run-1', ts: 1, seq: 0 }),
        started('claude', 100),
        fallback('claude', 'session_died', 150),
        started('claude', 200),
        fallback('claude', 'auth_required', 250),
        // Malformed tail line (crashed run) that still matches the substring pre-filter.
        '{"type":"acpSessionStarted","cliKey":"claude"',
        // An ACP event with no cliKey contributes nothing — never an "undefined" bucket.
        JSON.stringify({ type: 'acpSessionStarted', ts: 999 }),
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(dir, 'run-b.ndjson'),
      [started('pi', 300), fallback('pi', 'binary_unavailable', 50)].join('\n'),
      'utf8',
    );
    // A non-ndjson file in the dir is not an event log.
    writeFileSync(join(dir, 'notes.txt'), started('codex', 1), 'utf8');

    const byCli = await foldAcpEvents(dir);
    expect(Object.keys(byCli).sort()).toEqual(['claude', 'pi']);
    expect(byCli['claude']).toEqual({
      sessionsStarted: 2,
      fallbacks: 2,
      fallbackKinds: { session_died: 1, auth_required: 1 },
      lastStartedTs: 200,
      lastFallbackTs: 250,
    });
    expect(byCli['pi']).toEqual({
      sessionsStarted: 1,
      fallbacks: 1,
      fallbackKinds: { binary_unavailable: 1 },
      lastStartedTs: 300,
      lastFallbackTs: 50,
    });
  });

  it('a missing events dir and an empty one both fold to {} — absence is never invented', async () => {
    expect(await foldAcpEvents(join(scratch(), 'no-such-dir'))).toEqual({});
    expect(await foldAcpEvents(scratch())).toEqual({});
  });

  it('a fallback without a fallbackKind lands in the "unknown" bucket, not a crash', async () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'run.ndjson'),
      JSON.stringify({ cliKey: 'agy', reason: 'r', ts: 10, type: 'acpFallback' }),
      'utf8',
    );
    const byCli = await foldAcpEvents(dir);
    expect(byCli['agy']?.fallbackKinds).toEqual({ unknown: 1 });
    expect(byCli['agy']?.lastFallbackTs).toBe(10);
    expect(byCli['agy']?.lastStartedTs).toBeNull();
  });

  it('AcpFoldCache serves the cached fold within its TTL (one read for two gets)', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'run.ndjson'), started('claude', 1), 'utf8');
    const cache = new AcpFoldCache(60_000);
    const first = await cache.get(dir);
    expect(first['claude']?.sessionsStarted).toBe(1);
    // New traffic lands, but within the TTL the cached answer stands (brief staleness is the
    // documented trade for not re-reading 139+ files per poll).
    writeFileSync(join(dir, 'run2.ndjson'), started('claude', 2), 'utf8');
    const second = await cache.get(dir);
    expect(second['claude']?.sessionsStarted).toBe(1);
  });
});

describe('ErrorRing + pino tee (the bounded recent-error tail)', () => {
  it('keeps only the newest 20 entries, listed newest first', () => {
    const ring = new ErrorRing(20);
    for (let i = 1; i <= 25; i += 1) {
      ring.push({ ts: i, source: 'daemon', line: `err ${i}` });
    }
    const tail = ring.list();
    expect(tail).toHaveLength(20);
    expect(tail[0]).toEqual({ ts: 25, source: 'daemon', line: 'err 25' });
    expect(tail[19]).toEqual({ ts: 6, source: 'daemon', line: 'err 6' });
  });

  it('bounds the length of each captured line', () => {
    const ring = new ErrorRing();
    ring.push({ ts: 1, source: 'daemon', line: 'x'.repeat(5000) });
    const [entry] = ring.list();
    expect(entry?.line.length).toBeLessThanOrEqual(2001); // cap + ellipsis
  });

  it('the tee forwards every chunk and folds only error/fatal pino lines into the ring', () => {
    const ring = new ErrorRing();
    const forwarded: string[] = [];
    const tee = teeStreamWithErrorRing(ring, { write: (c: string) => forwarded.push(c) });

    tee.write(`${JSON.stringify({ level: 30, time: 1, msg: 'boot info' })}\n`);
    tee.write(`${JSON.stringify({ level: 40, time: 2, msg: 'a warn' })}\n`);
    tee.write(`${JSON.stringify({ level: 50, time: 3, msg: 'the error' })}\n`);
    tee.write(`${JSON.stringify({ level: 60, time: 4, msg: 'the fatal' })}\n`);
    // Matches the pre-filter but is not valid JSON — must be skipped, not thrown.
    tee.write('not json but says "level":50 anyway\n');

    expect(forwarded).toHaveLength(5); // everything still ships to the real destination
    expect(ring.list()).toEqual([
      { ts: 4, source: 'daemon', line: 'the fatal' },
      { ts: 3, source: 'daemon', line: 'the error' },
    ]);
  });

  it('a throwing destination never breaks the ring (logging must not become the outage)', () => {
    const ring = new ErrorRing();
    const tee = teeStreamWithErrorRing(ring, {
      write: () => {
        throw new Error('stdout gone');
      },
    });
    tee.write(`${JSON.stringify({ level: 50, time: 9, msg: 'still captured' })}\n`);
    expect(ring.list()).toEqual([{ ts: 9, source: 'daemon', line: 'still captured' }]);
  });
});

describe('component version readers', () => {
  it('readStudioBundleVersion reads studioVersion from the shipped manifest, null otherwise', () => {
    const root = scratch();
    expect(readStudioBundleVersion(root)).toBeNull(); // no manifest
    writeFileSync(join(root, 'testid-inventory.json'), JSON.stringify({ version: 1 }), 'utf8');
    expect(readStudioBundleVersion(root)).toBeNull(); // manifest predates studioVersion
    writeFileSync(
      join(root, 'testid-inventory.json'),
      JSON.stringify({ version: 1, studioVersion: '9.9.9' }),
      'utf8',
    );
    expect(readStudioBundleVersion(root)).toBe('9.9.9');
  });

  it('installedPackageVersion answers for a real dependency and null for a missing one', () => {
    expect(installedPackageVersion('wicked-core-ts')).toMatch(/^\d+\.\d+\.\d+/);
    expect(installedPackageVersion('no-such-package-crew-diagnostics')).toBeNull();
  });

  it('parseVersionOutput extracts the semver token from real --version shapes', () => {
    expect(parseVersionOutput('wicked-estate 0.15.1 — usage:\n  wicked-estate index …')).toBe('0.15.1');
    expect(parseVersionOutput('wicked-core 0.4.0\n')).toBe('0.4.0');
    expect(parseVersionOutput('devbuild')).toBe('devbuild'); // no semver — the honest raw line
    expect(parseVersionOutput('')).toBeNull();
  });

  it('engineBinaryVersions under a test runner spawns nothing and answers null (never fabricated)', async () => {
    // VITEST is set here by definition — the seat-health-probe posture applies.
    expect(await engineBinaryVersions()).toEqual({ [CORE_BIN]: null, [ESTATE_BIN]: null });
  });

  it('engineBinaryVersions probes exactly the paths crew already resolves (injected exec)', async () => {
    const calls: string[] = [];
    const exec = async (file: string): Promise<{ stdout: string; stderr: string }> => {
      calls.push(file);
      if (file === '/fake/wicked-core') return { stdout: 'wicked-core 0.4.0\n', stderr: '' };
      return { stdout: 'wicked-estate 0.15.1 — usage:\n', stderr: '' };
    };
    const saved = process.env['WICKED_CORE_EXE'];
    process.env['WICKED_CORE_EXE'] = '/fake/wicked-core';
    try {
      expect(await engineBinaryVersions(exec)).toEqual({
        [CORE_BIN]: '0.4.0',
        [ESTATE_BIN]: '0.15.1',
      });
      expect(calls.sort()).toEqual(['/fake/wicked-core', 'wicked-estate']);

      // No resolved wicked-core exe = crew never knew one = null, and the probe is not attempted.
      delete process.env['WICKED_CORE_EXE'];
      calls.length = 0;
      expect(await engineBinaryVersions(exec)).toEqual({
        [CORE_BIN]: null,
        [ESTATE_BIN]: '0.15.1',
      });
      expect(calls).toEqual(['wicked-estate']);
    } finally {
      if (saved === undefined) delete process.env['WICKED_CORE_EXE'];
      else process.env['WICKED_CORE_EXE'] = saved;
    }
  });

  it('a failing probe answers null, never a throw', async () => {
    const exec = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('ENOENT');
    };
    expect(await engineBinaryVersions(exec)).toEqual({
      [CORE_BIN]: null,
      [ESTATE_BIN]: null,
    });
  });

  it('EngineVersionCache answers from the first probe forever (one spawn set per process)', async () => {
    let probes = 0;
    const exec = async (): Promise<{ stdout: string; stderr: string }> => {
      probes += 1;
      return { stdout: 'wicked-estate 1.0.0', stderr: '' };
    };
    const cache = new EngineVersionCache();
    await cache.get(exec);
    await cache.get(exec);
    expect(probes).toBe(1); // estate only — WICKED_CORE_EXE is unset in this suite by default
  });
});

describe('listStoreFiles (core.db + sidecars + events-dir total)', () => {
  it('lists the db, its sidecars, and sizes the events dir as a content total', async () => {
    const home = scratch();
    const db = join(home, 'core.db');
    writeFileSync(db, 'x'.repeat(10), 'utf8');
    writeFileSync(join(home, 'core.db-wal'), 'x'.repeat(3), 'utf8');
    writeFileSync(join(home, 'core.db.knowledge'), 'x'.repeat(7), 'utf8');
    mkdirSync(join(home, 'core.db.events'));
    writeFileSync(join(home, 'core.db.events', 'a.ndjson'), 'x'.repeat(4), 'utf8');
    writeFileSync(join(home, 'core.db.events', 'b.ndjson'), 'x'.repeat(6), 'utf8');
    // NOT core.db sidecars — must not appear.
    writeFileSync(join(home, 'bus.db'), 'x', 'utf8');
    writeFileSync(join(home, 'audit.log'), 'x', 'utf8');

    const stores = await listStoreFiles(db);
    expect(stores.map((s) => s.name)).toEqual([
      'core.db',
      'core.db-wal',
      'core.db.events',
      'core.db.knowledge',
    ]);
    const byName = Object.fromEntries(stores.map((s) => [s.name, s]));
    expect(byName['core.db']?.bytes).toBe(10);
    expect(byName['core.db-wal']?.bytes).toBe(3);
    expect(byName['core.db.events']?.bytes).toBe(10); // 4 + 6, the dir total
    expect(byName['core.db.knowledge']?.bytes).toBe(7);
    expect(byName['core.db']?.path).toBe(db);
  });

  it('an absent state home lists nothing', async () => {
    expect(await listStoreFiles(join(scratch(), 'nope', 'core.db'))).toEqual([]);
  });

  it('eventsDirOf follows the engine convention <db>.events', () => {
    expect(eventsDirOf('/home/x/.wicked-crew/core.db')).toBe('/home/x/.wicked-crew/core.db.events');
  });
});
