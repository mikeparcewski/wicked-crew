// crew#1813: a test's audit appends have all landed before its after-hooks run, with no `flush()` in the test file.
// The test body records many entries and never awaits them (the shape of a route test: the route answers, the appends
// follow on the log's chain); the `afterEach` below is where a test file removes its temp dir, and it finds every line
// already written. Without the suite runner's settle (tests/setup/audit-flush-runner.ts) the hook runs while most of
// those appends are still queued.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { settleAuditLogs } from './setup/audit-settle.js';
import { removeScratch } from './setup/scratch.js';

const N = 300;
let dir = '';
let paths: string[] = [];

function lines(path: string): number {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').length;
  } catch {
    return 0;
  }
}

describe('audit appends settle before cleanup (crew#1813)', () => {
  afterEach(() => {
    // The cleanup point: every append the body issued is already on disk.
    const counts = paths.map(lines);
    removeScratch(dir);
    paths = [];
    expect(counts).toEqual(counts.map(() => N));
  });

  it('one log built inline, never flushed', () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-audit-settle-'));
    paths = [join(dir, 'nested', 'audit.log')];
    const log = new AuditLog(paths[0]!, () => undefined);
    for (let i = 0; i < N; i++) log.record('test.settle', LOCAL_ACTOR, { detail: { i } });
  });

  it('several logs in nested dirs, the body awaiting nothing of theirs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-audit-settle-'));
    paths = [join(dir, 'a.log'), join(dir, 'b', 'b.log')];
    const logs = paths.map((p) => new AuditLog(p, () => undefined));
    for (let i = 0; i < N; i++) for (const l of logs) l.record('test.settle', LOCAL_ACTOR);
    await Promise.resolve();
  });
});

describe('settleAuditLogs (crew#1813)', () => {
  it('an overlapping settle still waits for the logs another settle is draining (concurrent tests; xreview r1)', async () => {
    const own = mkdtempSync(join(tmpdir(), 'crew-audit-settle-'));
    try {
      const files = [join(own, 'a.log'), join(own, 'b.log')];
      const logs = files.map((p) => new AuditLog(p, () => undefined));
      for (let i = 0; i < N; i++) for (const l of logs) l.record('test.settle', LOCAL_ACTOR);
      const first = settleAuditLogs();
      await settleAuditLogs();
      expect(files.map(lines)).toEqual([N, N]);
      await first;
    } finally {
      removeScratch(own);
    }
  });
});
