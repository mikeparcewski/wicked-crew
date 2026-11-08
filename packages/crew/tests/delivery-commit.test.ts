// CS11 slice B (DES-CATALOG-002 rev 8) — "record the delivered commit from now on".
//
// The review-change join (`api/review-change.ts`) asks `git merge-base --is-ancestor <delivered
// commit> <reviewed head>` to decide whether a candidate run actually CONTRIBUTED to the change
// under review. That question only has an answer if the delivered HEAD SHA was captured at delivery
// time. These pins cover the capture half:
//   - the resolver attaches the SHA ({@link readDeliveredCommit}) to the record it writes — into the
//     audit detail AND the read-side index;
//   - a SHA read that throws still records the delivery (reading the commit must never block it);
//   - hydrate restores the SHA from the trail, ignores a malformed one, and lets a newer commit-less
//     entry clear an older one's (the newest entry decides the run, url/pushed/commit alike);
//   - `readDeliveredCommit` refuses an unsafe ref, a non-zero git exit, and a non-SHA answer.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeliveryIndex,
  recordDelivery,
  DeliveryResolver,
  deliveredCommitFor,
  noUnitDispatchedAfterDeliver,
  readDeliveredCommit,
  type DeliveredCommitExec,
  type DeliveryRecord,
} from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { SessionView } from '../src/core/types.js';

const PR_URL = 'https://github.com/o/r/pull/1';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
/** The deliver phase's transcript tail on an unchanged lift: push output, then the URL twice. */
const DELIVER_TRANSCRIPT = [
  ' * [new branch]      wicked/run-a -> wicked/run-a',
  PR_URL,
  PR_URL,
].join('\n');

function view(id: string, deliverStatus = 'done', status = 'completed'): SessionView {
  return {
    session: {
      id,
      workflow_id: 'feature',
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status,
      human_confirm: 'none',
      unit_ix: 5,
      attempt: 0,
      workdir: `/tmp/${id}`,
      repo_ref: 'repo-1',
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [
      { id: `${id}:u4`, ord: 4, status: 'done', tool_cmd: [] },
      { id: `${id}:deliver`, ord: 5, status: deliverStatus, tool_cmd: [] },
    ],
  } as unknown as SessionView;
}

/** A DeliveryResolver whose `record` mirrors `api/server.ts`: the audit detail first, then the
 *  index, both carrying the record's optional `commit`. */
function harness(opts: {
  output?: string | null;
  deliveredCommit?: (view: SessionView) => Promise<string | null>;
}) {
  const views = [view('run-a')];
  const index = new DeliveryIndex();
  const audited: Array<{ runId: string; detail: DeliveryRecord }> = [];
  const resolver = new DeliveryResolver({
    listViews: async () => views,
    workOutput: async () => (opts.output === undefined ? DELIVER_TRANSCRIPT : opts.output),
    isDelivered: (runId) => index.isDelivered(runId),
    record: (runId, record) => {
      // Mirror server.ts: `detail: record` carries `commit`, and the same SHA goes to the index.
      audited.push({ runId, detail: record });
      if ('url' in record) index.set(runId, record.url, undefined, record.commit);
      else index.setPushed(runId, record.pushed, undefined, record.commit);
    },
    ...(opts.deliveredCommit !== undefined ? { deliveredCommit: opts.deliveredCommit } : {}),
  });
  return { index, audited, resolver };
}

describe('CS11 slice B — the resolver records the delivered commit', () => {
  it('attaches the SHA to the audit detail AND the index', async () => {
    const h = harness({ deliveredCommit: async () => SHA });
    await h.resolver.resolve('run-a');
    expect(h.audited).toEqual([{ runId: 'run-a', detail: { url: PR_URL, commit: SHA } }]);
    expect(h.index.urlFor('run-a')).toBe(PR_URL);
    expect(h.index.commitFor('run-a')).toBe(SHA);
  });

  it('a `deliveredCommit` that throws still records the URL, without a commit', async () => {
    const h = harness({
      deliveredCommit: async () => {
        throw new Error('git could not answer');
      },
    });
    await h.resolver.resolve('run-a');
    expect(h.audited).toEqual([{ runId: 'run-a', detail: { url: PR_URL } }]);
    expect(h.index.urlFor('run-a')).toBe(PR_URL);
    expect(h.index.commitFor('run-a')).toBeUndefined();
  });

  it('a `deliveredCommit` that resolves null records the URL, without a commit', async () => {
    const h = harness({ deliveredCommit: async () => null });
    await h.resolver.resolve('run-a');
    expect(h.audited).toEqual([{ runId: 'run-a', detail: { url: PR_URL } }]);
    expect(h.index.commitFor('run-a')).toBeUndefined();
  });
});

interface FixtureEntry {
  action: string;
  runId: string;
  detail?: Record<string, unknown>;
}

/** Serialize entries in FILE ORDER (index 0 = oldest) with monotonic timestamps — the trail reads
 *  newest first, so the LAST entry here is the one hydrate sees first. */
function toTrail(entries: FixtureEntry[]): string {
  const base = 1_700_000_000_000;
  return entries
    .map((e, i) =>
      JSON.stringify({
        ts: base + i,
        action: e.action,
        actor: 'daemon',
        runId: e.runId,
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
      }),
    )
    .join('\n');
}

describe('CS11 slice B — hydrate restores the delivered commit', () => {
  let dir: string;
  let trailPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crew-delivery-commit-'));
    trailPath = join(dir, 'audit.log');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function hydrate(entries: FixtureEntry[]): Promise<DeliveryIndex> {
    await writeFile(trailPath, `${toTrail(entries)}\n`, 'utf8');
    const index = new DeliveryIndex();
    await index.hydrate(new AuditLog(trailPath, () => undefined));
    return index;
  }

  it('restores the SHA from the same entry that decides the run', async () => {
    const index = await hydrate([{ action: 'run.delivered', runId: 'run-a', detail: { url: PR_URL, commit: SHA } }]);
    expect(index.urlFor('run-a')).toBe(PR_URL);
    expect(index.commitFor('run-a')).toBe(SHA);
  });

  it('restores the SHA from a push-only entry', async () => {
    const index = await hydrate([
      { action: 'run.delivered', runId: 'run-p', detail: { pushed: { branch: 'wicked/run-p', remote: '/srv/r.git' }, commit: SHA } },
    ]);
    expect(index.pushedFor('run-p')).toEqual({ branch: 'wicked/run-p', remote: '/srv/r.git' });
    expect(index.commitFor('run-p')).toBe(SHA);
  });

  it('ignores a malformed commit in the trail (the delivery still hydrates)', async () => {
    const index = await hydrate([{ action: 'run.delivered', runId: 'run-a', detail: { url: PR_URL, commit: 'not-a-sha' } }]);
    expect(index.urlFor('run-a')).toBe(PR_URL);
    expect(index.commitFor('run-a')).toBeUndefined();
  });

  it('a newer entry without a commit clears an older one', async () => {
    // Oldest-first in the file: the deliver that recorded a SHA, then a later re-delivery that did
    // not. The newest entry decides the run — the old SHA must not survive.
    const index = await hydrate([
      { action: 'run.delivered', runId: 'run-a', detail: { url: PR_URL, commit: OTHER_SHA } },
      { action: 'run.delivered', runId: 'run-a', detail: { url: PR_URL } },
    ]);
    expect(index.urlFor('run-a')).toBe(PR_URL);
    expect(index.commitFor('run-a')).toBeUndefined();
  });

  // P2/contract (cs11-b review): the commit must come from the SAME entry that decides the run. A
  // URL outranks a push-only entry (even an OLDER URL over a NEWER push), so when the URL wins its
  // commit is authoritative — the push entry's SHA must never ride the PR URL. Oldest-first below:
  // the URL entry is index 0 (older), the push entry index 1 (newer, seen first by hydrate).
  it('a PR URL that wins over a newer push-only entry drops the push entry\'s commit (URL commit absent)', async () => {
    const index = await hydrate([
      { action: 'run.delivered', runId: 'run-m', detail: { url: PR_URL } },
      { action: 'run.delivered', runId: 'run-m', detail: { pushed: { branch: 'wicked/run-m', remote: '/srv/r.git' }, commit: OTHER_SHA } },
    ]);
    expect(index.urlFor('run-m')).toBe(PR_URL);
    expect(index.pushedFor('run-m')).toBeUndefined();
    expect(index.commitFor('run-m')).toBeUndefined();
  });

  it('a PR URL that wins pairs its OWN commit, never the push entry\'s', async () => {
    const index = await hydrate([
      { action: 'run.delivered', runId: 'run-m', detail: { url: PR_URL, commit: SHA } },
      { action: 'run.delivered', runId: 'run-m', detail: { pushed: { branch: 'wicked/run-m', remote: '/srv/r.git' }, commit: OTHER_SHA } },
    ]);
    expect(index.urlFor('run-m')).toBe(PR_URL);
    expect(index.commitFor('run-m')).toBe(SHA);
  });

  it('a PR URL with a MALFORMED commit drops the push entry\'s commit too', async () => {
    const index = await hydrate([
      { action: 'run.delivered', runId: 'run-m', detail: { url: PR_URL, commit: 'not-a-sha' } },
      { action: 'run.delivered', runId: 'run-m', detail: { pushed: { branch: 'wicked/run-m', remote: '/srv/r.git' }, commit: OTHER_SHA } },
    ]);
    expect(index.urlFor('run-m')).toBe(PR_URL);
    expect(index.commitFor('run-m')).toBeUndefined();
  });
});

describe('CS11 — recordDelivery, the daemon resolver\'s own writer (server.ts calls exactly this)', () => {
  it('puts the commit on the run.delivered audit detail AND the index, for a PR and a push-only delivery', () => {
    type RecordFn = (action: string, actor: unknown, fields?: { runId?: string; detail?: Record<string, unknown> }) => number;
    const audit = { record: vi.fn<RecordFn>(() => 1) };
    const index = new DeliveryIndex();
    recordDelivery(audit, index, { id: 'daemon', kind: 'daemon' } as never, 'run-a', { url: PR_URL, commit: SHA });
    recordDelivery(audit, index, { id: 'daemon', kind: 'daemon' } as never, 'run-b', {
      pushed: { branch: 'wicked/run-b', remote: 'git@example.test:o/r.git' },
      commit: OTHER_SHA,
    });
    expect(audit.record).toHaveBeenNthCalledWith(1, 'run.delivered', expect.anything(), { runId: 'run-a', detail: { url: PR_URL, commit: SHA } });
    expect(audit.record.mock.calls[1]![2]).toEqual({
      runId: 'run-b',
      detail: { pushed: { branch: 'wicked/run-b', remote: 'git@example.test:o/r.git' }, commit: OTHER_SHA },
    });
    expect(index.commitFor('run-a')).toBe(SHA);
    expect(index.commitFor('run-b')).toBe(OTHER_SHA);
  });
});

describe('CS11 — the live index: the newest delivery decides the commit', () => {
  it('a later set() or setPushed() without a commit clears the SHA an earlier delivery recorded', () => {
    const index = new DeliveryIndex();
    index.set('run-a', PR_URL, undefined, OTHER_SHA);
    expect(index.commitFor('run-a')).toBe(OTHER_SHA);
    index.set('run-a', PR_URL);
    expect(index.commitFor('run-a')).toBeUndefined();
    index.setPushed('run-b', { branch: 'wicked/run-b', remote: 'git@example.test:o/r.git' }, undefined, OTHER_SHA);
    index.setPushed('run-b', { branch: 'wicked/run-b', remote: 'git@example.test:o/r.git' });
    expect(index.commitFor('run-b')).toBeUndefined();
  });
});

describe('CS11 slice B — readDeliveredCommit', () => {
  const okExec: DeliveredCommitExec = async () => ({ stdout: `${SHA}\n`, stderr: '', code: 0 });

  it('returns the 40-hex SHA on an exact read of `refs/heads/<branch>`, confirmed a commit', async () => {
    const exec = vi.fn(okExec);
    const got = await readDeliveredCommit('/repo', 'wicked/run-a', exec);
    expect(got).toBe(SHA);
    // P1/security: the lookup is pinned to the local-branch namespace, so a same-named tag cannot answer.
    expect(exec).toHaveBeenCalledWith(
      ['show-ref', '--verify', '--hash', 'refs/heads/wicked/run-a'],
      { cwd: '/repo', timeoutMs: 5_000 },
    );
  });

  it('accepts an already-qualified `refs/heads/...` name without double-qualifying it', async () => {
    const exec = vi.fn(okExec);
    await readDeliveredCommit('/repo', 'refs/heads/wicked/run-a', exec);
    expect(exec).toHaveBeenCalledWith(
      ['show-ref', '--verify', '--hash', 'refs/heads/wicked/run-a'],
      { cwd: '/repo', timeoutMs: 5_000 },
    );
  });

  it('refuses an unsafe ref name before it reaches git', async () => {
    const exec = vi.fn(okExec);
    expect(await readDeliveredCommit('/repo', '../evil', exec)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns null on a non-zero git exit EVEN when stdout is a valid SHA (the exit guard, not the format check)', async () => {
    // P3 (cs11-b review): a nonzero exit must be rejected on its own — a valid 40-hex stdout proves
    // the `if (code !== 0) return null` guard is what rejects it, not the downstream SHA-format test.
    const exec: DeliveredCommitExec = async () => ({ stdout: `${SHA}\n`, stderr: '', code: 1 });
    expect(await readDeliveredCommit('/repo', 'wicked/run-a', exec)).toBeNull();
  });

  it('returns null when the exact ref names a non-commit object', async () => {
    // show-ref answers a SHA; the commit check answers nothing (exit 1): never recorded.
    const exec: DeliveredCommitExec = async (args) =>
      args[0] === 'show-ref' ? { stdout: `${SHA}\n`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 };
    expect(await readDeliveredCommit('/repo', 'wicked/run-a', exec)).toBeNull();
  });

  it('returns null when git answers a non-SHA', async () => {
    const exec: DeliveredCommitExec = async () => ({ stdout: 'HEAD\n', stderr: '', code: 0 });
    expect(await readDeliveredCommit('/repo', 'wicked/run-a', exec)).toBeNull();
  });

  it('returns null when the exec seam throws', async () => {
    const exec: DeliveredCommitExec = async () => {
      throw new Error('spawn failed');
    };
    expect(await readDeliveredCommit('/repo', 'wicked/run-a', exec)).toBeNull();
  });
});

describe('CS11 slice B — readDeliveredCommit resolves the branch namespace, never a same-named tag', () => {
  // P1/security (cs11-b review): a tag `wicked/<run>` pointing at an unrelated commit must never
  // answer. Driven against a REAL temp git repo through the production default exec (execCapped),
  // with a branch and a tag of the same name pointing at DIFFERENT commits.
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crew-rdc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  function git(...args: string[]): string {
    // Disable commit AND tag signing so the temp repo does not depend on the host's git config
    // (some hosts set `tag.gpgSign=true`, which turns `git tag` into a signed annotated tag that
    // demands a message — here we want plain lightweight tags).
    return execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', '-c', 'tag.forceSignAnnotated=false', ...args],
      { cwd: dir, encoding: 'utf8' },
    );
  }

  it('returns the BRANCH commit, not the same-named tag\'s', async () => {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@test');
    git('config', 'user.name', 't');
    await writeFile(join(dir, 'a'), '1');
    git('add', '-A');
    git('commit', '-qm', 'c1');
    git('branch', 'wicked/run-x');
    const branchSha = git('rev-parse', 'refs/heads/wicked/run-x').trim();
    await writeFile(join(dir, 'a'), '2');
    git('add', '-A');
    git('commit', '-qm', 'c2');
    const tagSha = git('rev-parse', 'HEAD').trim();
    git('tag', 'wicked/run-x', tagSha); // same short name as the branch, different commit
    expect(branchSha).not.toBe(tagSha);
    expect(await readDeliveredCommit(dir, 'wicked/run-x')).toBe(branchSha);
  });

  it('returns null when only a same-named tag exists (no branch)', async () => {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@test');
    git('config', 'user.name', 't');
    await writeFile(join(dir, 'a'), '1');
    git('add', '-A');
    git('commit', '-qm', 'c1');
    git('tag', 'wicked/run-y'); // a tag, but NO refs/heads/wicked/run-y
    expect(await readDeliveredCommit(dir, 'wicked/run-y')).toBeNull();
  });

  it('returns null for a tag literally named `refs/heads/<branch>` when the branch is absent (codex r2)', async () => {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@test');
    git('config', 'user.name', 't');
    await writeFile(join(dir, 'a'), '1');
    git('add', '-A');
    git('commit', '-qm', 'c1');
    // Stored as refs/tags/refs/heads/wicked/run-z: a revision name would fall back to it.
    git('tag', 'refs/heads/wicked/run-z');
    expect(git('rev-parse', '--verify', '-q', 'refs/heads/wicked/run-z^{commit}').trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(await readDeliveredCommit(dir, 'wicked/run-z')).toBeNull();
  });
});

describe('CS11 slice B — the production terminal-frame wiring (noUnitDispatchedAfterDeliver + deliveredCommitFor)', () => {
  const okExec: DeliveredCommitExec = async () => ({ stdout: `${SHA}\n`, stderr: '', code: 0 });

  /** A view whose units are the deliver unit plus one later unit with the given status. */
  function withLater(status: string): SessionView {
    return {
      session: view('run-a').session,
      units: [
        { id: 'run-a:deliver', ord: 5, status: 'done', tool_cmd: [] },
        { id: 'run-a:u6', ord: 6, status, tool_cmd: [] },
      ],
    } as unknown as SessionView;
  }

  it('noUnitDispatchedAfterDeliver: true when every unit after the deliver unit is still pending', () => {
    expect(noUnitDispatchedAfterDeliver(view('run-a'))).toBe(true); // no later unit at all
    expect(noUnitDispatchedAfterDeliver(withLater('pending'))).toBe(true);
  });

  it('noUnitDispatchedAfterDeliver: false once a later phase ran (its commit could outrun the pushed tip)', () => {
    expect(noUnitDispatchedAfterDeliver(withLater('done'))).toBe(false);
    expect(noUnitDispatchedAfterDeliver(withLater('rejected'))).toBe(false);
  });

  it('deliveredCommitFor: reads refs/heads/<branch> when no later unit ran', async () => {
    const exec = vi.fn(okExec);
    const got = await deliveredCommitFor(view('run-a'), async () => '/repo', exec);
    expect(got).toBe(SHA);
    expect(exec).toHaveBeenCalledWith(
      ['show-ref', '--verify', '--hash', 'refs/heads/wicked/run-a'],
      { cwd: '/repo', timeoutMs: 5_000 },
    );
  });

  it('deliveredCommitFor: records NO commit (null) when a later unit ran, without touching git', async () => {
    const exec = vi.fn(okExec);
    expect(await deliveredCommitFor(withLater('done'), async () => '/repo', exec)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('deliveredCommitFor: null for a repo-less run and for an unresolved repo root', async () => {
    const exec = vi.fn(okExec);
    const noRepo = {
      session: { ...view('run-a').session, repo_ref: null },
      units: view('run-a').units,
    } as unknown as SessionView;
    expect(await deliveredCommitFor(noRepo, async () => '/repo', exec)).toBeNull();
    expect(await deliveredCommitFor(view('run-a'), async () => undefined, exec)).toBeNull();
  });
});
