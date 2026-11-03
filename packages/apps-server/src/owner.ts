/**
 * One server owns a data volume (DES-APPS-001 §7.3: "an app with actions runs as ONE server replica"). The action
 * store is a file with an in-process lock; a second server on the same volume could run one record twice and
 * overwrite the other's records. This is the guard against a deployment that starts two (an overlapping restart,
 * a scaled replica):
 *
 * - The first server claims the volume with an atomic `mkdir` of `<data>/.owner` and keeps it alive: every 10 s it
 *   writes a heartbeat (written to a temp file, then renamed in, so it is never seen half-written). Each rename
 *   bumps the directory's mtime, which is the liveness signal: a claim whose directory has not changed for 30 s is
 *   a crashed owner's.
 * - A second server finds a live claim and stops, naming the owner.
 * - A crashed owner's claim is reclaimed by renaming it away (atomic: of two reclaimers one wins the rename), then
 *   claiming afresh, then checking after a moment that the claim is still this server's token.
 * - {@link Claim.held} is checked before every action-store step (see main.ts): a server whose claim is gone stops
 *   writing its store at once, not at the next heartbeat.
 *
 * What it is not: a distributed lock. One server per app with actions is a deployment rule (DES §7.3); this stops
 * the ordinary mistake (a second server started while the first runs). Two replicas racing a crashed owner's
 * reclaim, or a server paused past the stale window in the middle of a step, are outside it: Node has no portable
 * crash-released exclusive lock, and a deployment that runs two replicas on one volume is unsupported.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { SiteError } from './site.js';

const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;
const SETTLE_MS = 250;

export interface Claim {
  /** Whether this server still owns the volume (its token is the heartbeat's). */
  held(): boolean;
  release(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function claimDataDir(dir: string, opts: { now?: () => number; onLost?: () => void; heartbeatMs?: number; staleMs?: number; settleMs?: number } = {}): Promise<Claim> {
  const now = opts.now ?? Date.now;
  const lock = join(dir, '.owner');
  const beatFile = join(lock, 'heartbeat.json');
  const token = randomBytes(12).toString('hex');
  const taken = (): SiteError => new SiteError(`another wicked-apps-server took ${dir} over just now: one server per app with actions`);
  const owner = (): { token?: string; host?: string } | null => {
    try {
      return JSON.parse(readFileSync(beatFile, 'utf8')) as { token?: string; host?: string };
    } catch {
      return null;
    }
  };
  const beat = (): void => {
    const tmp = join(lock, `.beat-${token}`);
    writeFileSync(tmp, `${JSON.stringify({ token, host: hostname(), pid: process.pid, at: now() })}\n`, { mode: 0o600 });
    renameSync(tmp, beatFile);
  };
  const take = (): boolean => {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
    beat();
    return true;
  };
  /** How long the claim has not changed; `null` = it is gone (its owner released it just now). */
  const ageMs = (): number | null => {
    try {
      return now() - statSync(lock).mtimeMs;
    } catch {
      return null;
    }
  };

  if (!take()) {
    const age = ageMs();
    if (age === null) {
      // Released between our mkdir and the look: the volume is free, so this is a first claim after all.
      if (!take()) throw taken();
    } else if (age < (opts.staleMs ?? STALE_MS)) {
      throw new SiteError(`another wicked-apps-server owns ${dir} (${owner()?.host ?? 'starting up'}): one server per app with actions; stop the other first`);
    } else {
      // A crashed owner's claim: move it away atomically (one reclaimer wins), then claim afresh.
      const away = `${lock}.stale-${token}`;
      try {
        renameSync(lock, away);
      } catch {
        throw taken();
      }
      rmSync(away, { recursive: true, force: true });
      if (!take()) throw taken();
      await sleep(opts.settleMs ?? SETTLE_MS);
      if (owner()?.token !== token) throw taken();
    }
  }

  let lost = false;
  const held = (): boolean => {
    if (lost) return false;
    if (owner()?.token !== token) {
      lost = true;
      opts.onLost?.();
    }
    return !lost;
  };
  const timer = setInterval(() => {
    if (held()) beat();
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();
  return {
    held,
    release() {
      clearInterval(timer);
      if (!lost && owner()?.token === token) rmSync(lock, { recursive: true, force: true });
      lost = true;
    },
  };
}
