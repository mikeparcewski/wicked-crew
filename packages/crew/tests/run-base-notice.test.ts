import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/api/audit.js';
import { recordBaseUnfetched } from '../src/api/run-base-notice.js';
import type { Actor, CoreEvent } from '../src/core/types.js';

const actor: Actor = { id: 'daemon', kind: 'system', trust: 'admin' };
const event: CoreEvent = {
  type: 'runBaseResolved',
  session: 'run-private-repo',
  fetched: false,
  baseRef: 'origin/main',
  baseCommit: '1234567890abcdef1234567890abcdef12345678',
  localHead: 'abcdef1234567890abcdef1234567890abcdef12',
  note: 'git fetch origin failed: authentication required',
};

describe('recordBaseUnfetched', () => {
  let dir: string;
  let audit: AuditLog;
  const log = vi.fn();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-base-notice-'));
    audit = new AuditLog(join(dir, 'audit.log'));
    log.mockClear();
  });

  afterEach(async () => {
    await audit.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records one run-scoped notice with the engine base and note, and logs a warning', async () => {
    recordBaseUnfetched(event, audit, actor, log);

    const entries = await audit.read({ runId: 'run-private-repo' });
    expect(entries).toHaveLength(1);
    const message = `This run started from origin/main at 1234567, and the daemon could not fetch origin (${event['note']}), so it may be behind the remote.`;
    expect(entries[0]).toMatchObject({
      action: 'run.base_unfetched',
      actor,
      runId: event.session,
      detail: {
        message,
        baseRef: event['baseRef'],
        baseCommit: event['baseCommit'],
        localHead: event['localHead'],
        note: event['note'],
      },
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(message);
  });

  it.each([
    { ...event, fetched: true },
    { ...event, fetched: undefined },
    { ...event, fetched: null },
    { ...event, type: 'sessionStarted' },
    { ...event, session: undefined },
    { ...event, session: 42 },
  ])('ignores an ineligible event: %j', async (input) => {
    recordBaseUnfetched(input, audit, actor, log);

    expect(await audit.read()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("names the folder's current HEAD when the engine has no base ref, without requiring a logger", async () => {
    recordBaseUnfetched({ ...event, baseRef: null }, audit, actor);

    const entries = await audit.read({ runId: 'run-private-repo' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toMatchObject({
      baseRef: null,
      message: expect.stringContaining("This run started from the folder's current HEAD at 1234567"),
    });
  });

  it('never throws on a sparse event (no commit, no note)', async () => {
    expect(() => recordBaseUnfetched({ type: 'runBaseResolved', session: 'r', fetched: false }, audit, actor)).not.toThrow();
    const entries = await audit.read({ runId: 'r' });
    expect(entries[0]?.detail).toMatchObject({
      message: "This run started from the folder's current HEAD, and the daemon could not fetch origin, so it may be behind the remote.",
    });
  });
});
