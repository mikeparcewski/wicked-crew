// `GET /diagnostics` → `governance` (crew#495 / F-022): the dead-letter fold, its cache, the
// record counter and the findings — over fixture outboxes, never a real engine.

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DeadletterFoldCache,
  emptyDeadletterFold,
  foldDeadletters,
  GovernanceDiagnostics,
  GovernanceRecordCounter,
  governanceHealth,
  isEpochMs,
  probeLegacyOutbox,
  reasonBucket,
  replayCommand,
} from '../src/api/governance-health.js';
import { resolveGovernanceStore } from '../src/core/governance-store.js';
import { removeScratch } from './setup/scratch.js';

/** Spool records exactly as the engine writes them (`emit.rs` `spool_record`): a pre-stamp entry
 *  (no ts), a stamped entry (ts/pid/origin — wicked-core with the crew#495 companion), and a torn line. */
const UNSTAMPED = JSON.stringify({
  type: 'wicked.crew.governance.conformance_recorded',
  domain: 'wicked-governance',
  subdomain: 'governance.evaluation',
  payload: { claim_id: 'c1', decision: 'allow' },
  deadletter_reason: 'no shared store (WICKED_ESTATE_DB unset)',
});
const STAMPED = JSON.stringify({
  type: 'wicked.crew.phase.transitioned',
  domain: 'wicked-crew',
  subdomain: 'crew.phase',
  payload: { run: 'r1', from: 'build', to: 'review' },
  deadletter_reason: 'open shared store failed: open estate store at "/nope/gov.db": unable to open database file',
  ts: 1_757_500_000_000,
  pid: 4242,
  origin: 'wicked-crew@0.7.27 serve pid=4242 port=7701 db=/state/core.db',
});
const STAMPED_LATER = JSON.stringify({
  type: 'wicked.estate.rule.ingested',
  domain: 'wicked-governance',
  subdomain: 'governance.rules',
  payload: { id: 'PAT-001' },
  deadletter_reason: 'no shared store (WICKED_ESTATE_DB unset)',
  ts: 1_757_500_060_000,
  pid: 4242,
});

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) removeScratch(scratch);
  scratch = undefined;
});

function outboxWith(lines: string[]): string {
  scratch = mkdtempSync(join(tmpdir(), 'crew-gov-health-'));
  const path = join(scratch, 'emit-outbox.ndjson');
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

describe('foldDeadletters', () => {
  it('a missing or empty outbox is an EMPTY fold — no dead letters is the good answer, never an error', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-gov-health-'));
    const missing = join(scratch, 'nope.ndjson');
    expect(await foldDeadletters(missing)).toEqual(emptyDeadletterFold(missing));
    const empty = join(scratch, 'empty.ndjson');
    writeFileSync(empty, '', 'utf8');
    expect((await foldDeadletters(empty)).count).toBe(0);
  });

  it('a `ts` outside Date\'s range (or negative) is UNTIMESTAMPED — never a RangeError that turns /diagnostics into a 500 (Copilot on #516)', async () => {
    const huge = JSON.stringify({ ...JSON.parse(STAMPED), ts: 1e20 });
    const negative = JSON.stringify({ ...JSON.parse(STAMPED), ts: -5 });
    const asString = JSON.stringify({ ...JSON.parse(STAMPED), ts: '1757500000000' });
    const path = outboxWith([huge, negative, asString, STAMPED]);
    const fold = await foldDeadletters(path);
    expect(fold.count).toBe(4);
    expect(fold.timestamped).toBe(1);
    expect(fold.untimestamped).toBe(3);
    expect(fold.newestTs).toBe(1_757_500_000_000);
    expect(isEpochMs(1e20)).toBe(false);
    expect(isEpochMs(8.64e15)).toBe(true);
    expect(isEpochMs(8.64e15 + 1)).toBe(false);
    expect(isEpochMs(Number.NaN)).toBe(false);
    // The finding renders the newest timestamp without throwing.
    const location = resolveGovernanceStore({ coreDbPath: '/state/core.db' });
    expect(() =>
      governanceHealth({ location: { ...location, outboxPath: path }, records: { total: null, sinceBoot: null }, fold, legacyOutbox: null }),
    ).not.toThrow();
  });

  it('counts every entry, buckets by type and reason prefix, and reports the timestamp range ONLY over entries that carry one', async () => {
    const path = outboxWith([UNSTAMPED, STAMPED, 'not json at all', '', STAMPED_LATER]);
    const fold = await foldDeadletters(path);
    expect(fold.path).toBe(path);
    expect(fold.count).toBe(4); // the blank line is not an entry; the torn line IS
    expect(fold.byType).toEqual({
      'wicked.crew.governance.conformance_recorded': 1,
      'wicked.crew.phase.transitioned': 1,
      'wicked.estate.rule.ingested': 1,
    });
    // The reason's path/error tail varies per entry; only the prefix before `:` is a bucket.
    expect(fold.byReason).toEqual({
      'no shared store (WICKED_ESTATE_DB unset)': 2,
      'open shared store failed': 1,
    });
    expect(fold.timestamped).toBe(2);
    expect(fold.untimestamped).toBe(2); // the pre-stamp entry + the torn line — counted, never given a time
    expect(fold.oldestTs).toBe(1_757_500_000_000);
    expect(fold.newestTs).toBe(1_757_500_060_000);
    expect(fold.truncated).toBe(false);
    expect(reasonBucket('store write failed: database is locked')).toBe('store write failed');
    expect(reasonBucket('no shared store (WICKED_ESTATE_DB unset)')).toBe('no shared store (WICKED_ESTATE_DB unset)');
  });
});

describe('DeadletterFoldCache', () => {
  it('re-folds only when the outbox changes (size/mtime) and sees an appended entry on the next read', async () => {
    const path = outboxWith([UNSTAMPED]);
    const cache = new DeadletterFoldCache();
    expect((await cache.get(path)).count).toBe(1);
    const again = await cache.get(path);
    expect(again.count).toBe(1);
    appendFileSync(path, `${STAMPED}\n`, 'utf8');
    const after = await cache.get(path);
    expect(after.count).toBe(2);
    expect(after.newestTs).toBe(1_757_500_000_000);
  });
});

describe('GovernanceRecordCounter', () => {
  it('sinceBoot is total − the boot baseline; an engine that cannot count answers null for both, never 0', async () => {
    let n = 5;
    const counting = new GovernanceRecordCounter('/state/gov.db', async () => n, 0);
    await counting.ready();
    expect(await counting.records()).toEqual({ total: 5, sinceBoot: 0 });
    n = 9;
    expect(await counting.records()).toEqual({ total: 9, sinceBoot: 4 });
    const noBinding = new GovernanceRecordCounter('/state/gov.db', null, 0);
    expect(await noBinding.records()).toEqual({ total: null, sinceBoot: null });
    const noStore = new GovernanceRecordCounter(null, async () => 1, 0);
    expect(await noStore.records()).toEqual({ total: null, sinceBoot: null });
    const failing = new GovernanceRecordCounter('/state/gov.db', async () => { throw new Error('locked'); }, 0);
    expect(await failing.records()).toEqual({ total: null, sinceBoot: null });
  });
});

describe('governanceHealth (the findings)', () => {
  const location = resolveGovernanceStore({ coreDbPath: '/state/core.db' });

  it('a resolved store with an empty outbox: store reported with its source, no findings', () => {
    const health = governanceHealth({
      location,
      records: { total: 0, sinceBoot: 0 },
      fold: emptyDeadletterFold(location.outboxPath),
      legacyOutbox: null,
    });
    expect(health.store).toEqual({ path: location.dbPath, source: 'core-db-sidecar' });
    expect(health.deadletters.count).toBe(0);
    expect(health.deadletters.path).toBe(location.outboxPath);
    expect(health.deadletters.legacyOutbox).toBeNull();
    expect(health.findings).toEqual([]);
  });

  it('dead letters in the outbox raise governance.deadletter (error) naming the count, the reasons and the replay command', async () => {
    const path = outboxWith([UNSTAMPED, STAMPED]);
    const health = governanceHealth({
      location: { ...location, outboxPath: path },
      records: { total: null, sinceBoot: null },
      fold: await foldDeadletters(path),
      legacyOutbox: null,
    });
    expect(health.findings.map((f) => [f.kind, f.severity])).toEqual([['governance.deadletter', 'error']]);
    const msg = health.findings[0]!.message;
    expect(msg).toContain('2 governance event(s) dead-lettered to');
    expect(msg).toContain('no shared store (WICKED_ESTATE_DB unset)');
    // The recipe names THIS daemon's target — the default sidecar through its core db — so following
    // it on a custom --db daemon never replays into a different store (Copilot on #516).
    expect(msg).toContain(`wicked-crew governance replay ${JSON.stringify(path)} --db ${JSON.stringify(resolve('/state/core.db'))}`);
    expect(msg).toContain(new Date(1_757_500_000_000).toISOString());
  });

  it('replayCommand is target-specific: --db for the sidecar default, --governance-db (credentials redacted) for an explicit store, bare when no store is known', () => {
    const sidecar = resolveGovernanceStore({ coreDbPath: '/state/core.db' });
    expect(replayCommand('/o.ndjson', sidecar)).toBe(`wicked-crew governance replay "/o.ndjson" --db ${JSON.stringify(resolve('/state/core.db'))}`);
    const explicit = resolveGovernanceStore({ coreDbPath: '/state/core.db', flagDb: '/opt/gov.db' });
    expect(replayCommand('/o.ndjson', explicit)).toBe(`wicked-crew governance replay "/o.ndjson" --governance-db ${JSON.stringify(resolve('/opt/gov.db'))}`);
    const url = resolveGovernanceStore({ coreDbPath: '/state/core.db', envCrewDb: 'postgres://u:s3cret@h/db' });
    const cmd = replayCommand('/o.ndjson', url);
    expect(cmd).toContain('--governance-db "postgres://***@h/db"');
    expect(cmd).toContain('credentials redacted');
    expect(cmd).not.toContain('s3cret');
    expect(replayCommand('/o.ndjson', null)).toBe('wicked-crew governance replay "/o.ndjson"');
  });

  it('no store resolved (a library boot) is governance.store (error): every emit dead-letters', () => {
    const health = governanceHealth({
      location: null,
      records: { total: null, sinceBoot: null },
      fold: emptyDeadletterFold(null),
      legacyOutbox: null,
    });
    expect(health.store).toBeNull();
    expect(health.deadletters.path).toBeNull();
    expect(health.findings.map((f) => f.kind)).toEqual(['governance.store']);
    expect(health.findings[0]!.severity).toBe('error');
    expect(health.findings[0]!.message).toContain('WICKED_ESTATE_DB');
    // Every governance finding carries a copyable recipe — with no store known, the bare dry-run one.
    expect(health.findings[0]!.message).toContain('wicked-crew governance replay "<outbox.ndjson>" --dry-run');
  });

  it('a pre-fix outbox under HOME is governance.legacy-outbox (warning) with the dry-run recipe', () => {
    const health = governanceHealth({
      location,
      records: { total: 3, sinceBoot: 1 },
      fold: emptyDeadletterFold(location.outboxPath),
      legacyOutbox: { path: '/homes/op/.something-wicked/wicked-apps/emit-outbox.ndjson', bytes: 3415 },
    });
    expect(health.findings.map((f) => [f.kind, f.severity])).toEqual([['governance.legacy-outbox', 'warning']]);
    expect(health.findings[0]!.message).toContain('--dry-run');
    expect(health.findings[0]!.message).toContain(`--db ${JSON.stringify(resolve('/state/core.db'))}`);
    expect(health.deadletters.legacyOutbox).toEqual({ path: '/homes/op/.something-wicked/wicked-apps/emit-outbox.ndjson', bytes: 3415 });
  });
});

describe('GovernanceDiagnostics (the per-daemon assembly)', () => {
  it('folds the daemon\'s own outbox, probes only a legacy path that is NOT that outbox, and never stats a null one', async () => {
    const path = outboxWith([STAMPED]);
    const loc = { ...resolveGovernanceStore({ coreDbPath: join(scratch as string, 'core.db') }), outboxPath: path };
    // Legacy pointer == the daemon's own outbox → not reported as legacy.
    const own = new GovernanceDiagnostics(loc, null, path);
    await own.ready();
    const h1 = await own.health();
    expect(h1.deadletters.count).toBe(1);
    expect(h1.deadletters.legacyOutbox).toBeNull();
    expect(h1.records).toEqual({ total: null, sinceBoot: null });
    expect(h1.findings.map((f) => f.kind)).toEqual(['governance.deadletter']);
    // A separate legacy file → reported.
    const legacy = join(scratch as string, 'legacy-outbox.ndjson');
    writeFileSync(legacy, `${UNSTAMPED}\n`, 'utf8');
    const withLegacy = new GovernanceDiagnostics(loc, null, legacy);
    const h2 = await withLegacy.health();
    expect(h2.deadletters.legacyOutbox).toEqual({ path: legacy, bytes: UNSTAMPED.length + 1 });
    expect(h2.findings.map((f) => f.kind)).toEqual(['governance.deadletter', 'governance.legacy-outbox']);
    // `null` = report none (tests never stat the developer's real home).
    expect(await probeLegacyOutbox(null)).toBeNull();
    expect(await probeLegacyOutbox(join(scratch as string, 'absent.ndjson'))).toBeNull();
  });
});
