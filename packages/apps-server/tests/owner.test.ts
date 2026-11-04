// One server per data volume (DES-APPS-001 §7.3): concurrent claims, a crashed owner's claim reclaimed by one of two
// racing starts, and the fence (a server whose claim was taken over holds nothing any more).

import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type Claim, claimDataDir } from '../src/owner.js';

describe('the volume claim', () => {
  const dirs: string[] = [];
  const claims: Claim[] = [];
  afterEach(() => {
    for (const c of claims.splice(0)) c.release();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fresh = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'k6-owner-'));
    dirs.push(d);
    return d;
  };

  it('of several concurrent first claims exactly one wins; the others stop, naming the owner', async () => {
    const dir = fresh();
    const all = await Promise.allSettled(Array.from({ length: 6 }, () => claimDataDir(dir, { settleMs: 20 })));
    const won = all.filter((r): r is PromiseFulfilledResult<Claim> => r.status === 'fulfilled').map((r) => r.value);
    claims.push(...won);
    expect(won).toHaveLength(1);
    for (const r of all) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/another wicked-apps-server owns/);
    expect(won[0]!.held()).toBe(true);
  });

  it("a crashed owner's claim (not seen for 30 s) is reclaimed by at most one of two racing starts", async () => {
    const dir = fresh();
    const dead = await claimDataDir(dir, { settleMs: 0 });
    // Crashed: no release, and its claim has not changed for a minute.
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, '.owner'), old, old);
    const racers = await Promise.allSettled([claimDataDir(dir, { settleMs: 50 }), claimDataDir(dir, { settleMs: 50 })]);
    const won = racers.filter((r): r is PromiseFulfilledResult<Claim> => r.status === 'fulfilled').map((r) => r.value);
    claims.push(...won);
    expect(won).toHaveLength(1);
    expect(won[0]!.held()).toBe(true);
    // The crashed owner, were it to come back, holds nothing.
    expect(dead.held()).toBe(false);
  });

  it('a server whose claim was taken over is fenced at once (held() is false, and onLost runs)', async () => {
    const dir = fresh();
    let lost = 0;
    const first = await claimDataDir(dir, { settleMs: 0, onLost: () => lost++ });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, '.owner'), old, old); // as if paused past the stale window
    const second = await claimDataDir(dir, { settleMs: 0 });
    claims.push(second);
    expect(first.held()).toBe(false);
    expect(lost).toBe(1);
    expect(second.held()).toBe(true);
    first.release(); // a fenced server's release never removes the new owner's claim
    expect(second.held()).toBe(true);
  });

  it('a live claim refuses a second start; a release lets it start', async () => {
    const dir = fresh();
    const one = await claimDataDir(dir, { settleMs: 0 });
    await expect(claimDataDir(dir, { settleMs: 0 })).rejects.toThrow(/another wicked-apps-server owns/);
    one.release();
    const two = await claimDataDir(dir, { settleMs: 0 });
    claims.push(two);
    expect(two.held()).toBe(true);
  });
});
