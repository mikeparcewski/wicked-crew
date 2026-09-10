// `wicked-crew governance replay` (crew#495): the drain for a dead-letter outbox.
//
// The dry run works on every engine (a fold, nothing moved). The real replay needs the engine's
// `Core.replayEmitOutbox` static (wicked-core-ts ≥ the release carrying the crew#495 companion):
// on an older addon the command says so and exits 2 with the outbox UNTOUCHED; on a capable one it
// archives the outbox FIRST (so a running daemon's next spool starts a fresh file), replays from
// the archive, and appends whatever did not land back onto the outbox. Both branches are pinned —
// crew CI builds the addon from core `main`, so whichever is true there is what runs.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { CoreAdapter } from '../src/core/adapter.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  appendFailedLines,
  appendLines,
  archiveNameFor,
  conflationNote,
  GOVERNANCE_USAGE,
  LineBoundaryGuard,
  replayOutbox,
  replayTarget,
  restoreOutbox,
  UsageError,
} from '../src/cli/governance.js';
import { GovernanceStoreError, governanceSidecarDb, resolveGovernanceStore } from '../src/core/governance-store.js';
import { removeScratch } from './setup/scratch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'dist', 'cli', 'index.js');

const RECORD_A = JSON.stringify({
  type: 'wicked.crew.governance.conformance_recorded',
  domain: 'wicked-governance',
  subdomain: 'governance.evaluation',
  payload: { claim_id: 'c1', decision: 'allow' },
  deadletter_reason: 'no shared store (WICKED_ESTATE_DB unset)',
});
const RECORD_B = JSON.stringify({
  type: 'wicked.crew.phase.transitioned',
  domain: 'wicked-crew',
  subdomain: 'crew.phase',
  payload: { run: 'r1' },
  deadletter_reason: 'no shared store (WICKED_ESTATE_DB unset)',
  ts: 1_757_500_000_000,
  pid: 4242,
  origin: 'wicked-crew@0.7.27 serve pid=4242 db=/state/core.db',
});
const TORN = '{"type":"wicked.crew.phase.transitioned","domain":"wicked-c';

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) removeScratch(scratch);
  scratch = undefined;
});

function fixture(): { outbox: string; coreDb: string } {
  scratch = mkdtempSync(join(tmpdir(), 'crew-gov-replay-'));
  const outbox = join(scratch, 'emit-outbox.ndjson');
  writeFileSync(outbox, `${RECORD_A}\n${RECORD_B}\n${TORN}\n`, 'utf8');
  return { outbox, coreDb: join(scratch, 'state', 'core.db') };
}

describe('replayTarget — the target store follows serve\'s rule', () => {
  it('--governance-db › WICKED_CREW_GOVERNANCE_DB › WICKED_ESTATE_DB › the sidecar of --db', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(replayTarget(['--db', '/state/core.db'], env)).toMatchObject({
      dbPath: governanceSidecarDb('/state/core.db'),
      source: 'core-db-sidecar',
    });
    expect(replayTarget(['--db', '/state/core.db', '--governance-db', '/opt/gov.db'], env).source).toBe('flag');
    expect(replayTarget(['--db', '/state/core.db'], { WICKED_ESTATE_DB: '/opt/estate/graph.db' })).toMatchObject({
      dbPath: resolve('/opt/estate/graph.db'),
      source: 'env-estate',
    });
    expect(() => replayTarget(['--db'], env)).toThrow(UsageError);
    expect(() => replayTarget(['--governance-db', '--dry-run'], env)).toThrow(/requires a value/);
    // A URL spec is refused here exactly as `serve` refuses it (the emit seam is SQLite-only) — exit 2, no secret echoed.
    expect(() => replayTarget(['--governance-db', 'postgres://u:s3cret@h/db'], env)).toThrow(GovernanceStoreError);
    expect(() => replayTarget(['--governance-db', 'postgres://u:s3cret@h/db'], env)).not.toThrow(/s3cret/);
    // …and so are the bus db (resolved the way `serve` resolves it: WICKED_BUS_DB › WICKED_BUS_DATA_DIR › the sidecar) and the core db.
    expect(() => replayTarget(['--db', '/state/core.db', '--governance-db', '/state/core.db.bus/bus.db'], env)).toThrow(/bus db/);
    expect(() => replayTarget(['--db', '/state/core.db', '--governance-db', '/shared/bus.db'], { WICKED_BUS_DB: '/shared/bus.db' })).toThrow(/bus db/);
    expect(() => replayTarget(['--db', '/state/core.db', '--governance-db', '/busdir/bus.db'], { WICKED_BUS_DATA_DIR: '/busdir' })).toThrow(/bus db/);
    expect(() => replayTarget(['--db', '/state/core.db', '--governance-db', '/state/core.db'], env)).toThrow(/own core db/);
  });
});

describe('replayOutbox (the command body)', () => {
  it('--dry-run folds the outbox and moves nothing', async () => {
    const { outbox, coreDb } = fixture();
    const { outcome, exitCode } = await replayOutbox([outbox, '--db', coreDb, '--dry-run'], {});
    expect(exitCode).toBe(0);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.archive).toBeNull();
    expect(outcome.read).toBe(3);
    expect(outcome.store).toEqual({ path: governanceSidecarDb(coreDb), source: 'core-db-sidecar' });
    expect(outcome.fold?.byType).toEqual({
      'wicked.crew.governance.conformance_recorded': 1,
      'wicked.crew.phase.transitioned': 1,
    });
    expect(outcome.fold?.timestamped).toBe(1);
    expect(outcome.fold?.untimestamped).toBe(2);
    expect(existsSync(outbox)).toBe(true);
    expect(readdirSync(scratch as string)).toEqual(['emit-outbox.ndjson']); // no archive, no store
    expect(outcome.note).toBeNull();
  });

  it('refuses a missing outbox, and a :memory: target for a REAL replay only — a dry run folds the file and touches no store', async () => {
    const { coreDb } = fixture();
    await expect(replayOutbox([join(scratch as string, 'nope.ndjson'), '--db', coreDb], {})).rejects.toThrow(/outbox not found/);
    const { outbox } = fixture();
    await expect(replayOutbox([outbox, '--governance-db', ':memory:'], {})).rejects.toThrow(/refusing to replay into :memory:/);
    const dry = await replayOutbox([outbox, '--governance-db', ':memory:', '--dry-run'], {});
    expect(dry.exitCode).toBe(0);
    expect(dry.outcome.store).toEqual({ path: ':memory:', source: 'flag' });
    expect(dry.outcome.read).toBe(3);
    expect(dry.outcome.alreadyPresent).toBeNull();
  });

  it('the archive name is the outbox plus a filesystem-safe timestamp, the pid and a nonce — two replays in one millisecond never share it', () => {
    expect(archiveNameFor('/x/emit-outbox.ndjson', new Date('2026-09-10T15:29:07.123Z'), 'abc123')).toBe(
      `/x/emit-outbox.ndjson.replayed-2026-09-10T15-29-07-123Z-${process.pid}-abc123`,
    );
    const now = new Date();
    expect(archiveNameFor('/x/o.ndjson', now)).not.toBe(archiveNameFor('/x/o.ndjson', now));
    expect(archiveNameFor('/x/o.ndjson', now)).toMatch(/\.replayed-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-[0-9a-f]{6}$/);
  });

  it('a failed write-back of the failed lines names the retained archive instead of hiding the dead letters', () => {
    fixture();
    const archive = join(scratch as string, 'emit-outbox.ndjson.replayed-x');
    const outboxAsDir = join(scratch as string, 'live-is-a-dir.ndjson');
    mkdirSync(outboxAsDir); // appending to a directory fails (EISDIR)
    expect(() => appendFailedLines(outboxAsDir, archive, [TORN])).toThrow(/remain in the retained archive/);
    expect(() => appendFailedLines(outboxAsDir, archive, [TORN])).toThrow(new RegExp(archive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // Nothing to write back → nothing to fail.
    expect(() => appendFailedLines(outboxAsDir, archive, [])).not.toThrow();
  });

  it('conflationNote states the pre-stamp caveat only when entries were already present AND the outbox holds untimestamped lines', () => {
    expect(conflationNote(0, { untimestamped: 3 })).toBeNull();
    expect(conflationNote(2, { untimestamped: 0 })).toBeNull();
    const note = conflationNote(2, { untimestamped: 3 }) as string;
    expect(note).toContain('2 entries were already on the store');
    expect(note).toContain('3 untimestamped');
    expect(note).toContain('byte-identical unstamped lines share one replay id');
    expect(conflationNote(1, { untimestamped: 1 })).toContain('1 entry was already on the store');
  });

  /** The NDJSON entries of a file — what every reader (the fold, the engine's replay) sees: blank lines are not entries. */
  const entries = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');

  it('LineBoundaryGuard emits WHOLE records per chunk: a record split across read chunks is never exposed half-written, the leading separator opens the first chunk, a torn last record is terminated in its own chunk', async () => {
    const source = `${RECORD_A}\n${RECORD_B}\n${TORN}`; // no trailing newline
    // Feed the stream in chunks that split records mid-line (as a 64 KiB read stream would).
    const chunks: Buffer[] = [];
    for (let i = 0; i < source.length; i += 37) chunks.push(Buffer.from(source.slice(i, i + 37)));
    const emitted: Buffer[] = [];
    await pipeline(Readable.from(chunks), new LineBoundaryGuard(true), async function* (src) {
      for await (const c of src) emitted.push(c as Buffer);
    });
    // Every emitted chunk is a whole number of NDJSON records (ends at a newline)…
    for (const c of emitted) expect(c[c.length - 1]).toBe(0x0a);
    // …the first one opens with the separator, and the concatenation is the source with its torn tail terminated.
    expect(emitted[0]![0]).toBe(0x0a);
    expect(Buffer.concat(emitted).toString('utf8')).toBe(`\n${RECORD_A}\n${RECORD_B}\n${TORN}\n`);
    // Without a leading separator and with a terminated source, the output equals the input.
    const emitted2: Buffer[] = [];
    await pipeline(Readable.from([Buffer.from(`${RECORD_A}\n`)]), new LineBoundaryGuard(false), async function* (src) {
      for await (const c of src) emitted2.push(c as Buffer);
    });
    expect(Buffer.concat(emitted2).toString('utf8')).toBe(`${RECORD_A}\n`);
  });

  it('a replay that THROWS after the archive rename puts the outbox back — append-only, never "0 dead letters", never a clobbered fresh spool, every boundary kept', async () => {
    // No live outbox appeared meanwhile → the live file is re-created with the archive's entries.
    // The leading separator is UNCONDITIONAL (a torn tail can appear between any look and the
    // write), so the raw file starts with one empty line every reader skips.
    const { outbox } = fixture();
    const archive = archiveNameFor(outbox);
    renameSync(outbox, archive);
    expect(existsSync(outbox)).toBe(false);
    await restoreOutbox(outbox, archive);
    expect(existsSync(archive)).toBe(false);
    expect(readFileSync(outbox, 'utf8')).toBe(`\n${RECORD_A}\n${RECORD_B}\n${TORN}\n`);
    expect(entries(outbox)).toEqual([RECORD_A, RECORD_B, TORN]);

    // The daemon spooled a fresh entry while the replay ran → the archive is APPENDED to the live
    // file (the new entry is never clobbered — no rename ever targets the live path) and removed.
    renameSync(outbox, archive);
    const fresh = JSON.stringify({ type: 'wicked.estate.rule.retired', domain: 'wicked-governance', subdomain: 'governance.rules', payload: {}, deadletter_reason: 'store write failed: locked' });
    writeFileSync(outbox, `${fresh}\n`, 'utf8');
    await restoreOutbox(outbox, archive);
    expect(existsSync(archive)).toBe(false);
    expect(entries(outbox)).toEqual([fresh, RECORD_A, RECORD_B, TORN]);

    // An archive without a trailing newline (a torn tail) is repaired so a later spool never joins onto its last line.
    writeFileSync(archive, `${RECORD_A}\n${TORN}`, 'utf8');
    rmSync(outbox);
    await restoreOutbox(outbox, archive);
    expect(readFileSync(outbox, 'utf8')).toBe(`\n${RECORD_A}\n${TORN}\n`);

    // The LIVE file is mid-record (the daemon is writing) → the restore lands behind the separator,
    // never concatenated onto the half-written record; both repairs ride inside the data writes.
    writeFileSync(archive, `${RECORD_B}`, 'utf8'); // no trailing newline either
    writeFileSync(outbox, `${TORN}`, 'utf8'); // torn live tail, no newline
    await restoreOutbox(outbox, archive);
    expect(readFileSync(outbox, 'utf8')).toBe(`${TORN}\n${RECORD_B}\n`);
    expect(entries(outbox)).toEqual([TORN, RECORD_B]);
    expect(existsSync(archive)).toBe(false);
    // An EMPTY archive restores nothing and is simply removed.
    writeFileSync(archive, '', 'utf8');
    await restoreOutbox(outbox, archive);
    expect(readFileSync(outbox, 'utf8')).toBe(`${TORN}\n${RECORD_B}\n`);
    expect(existsSync(archive)).toBe(false);
  });

  it('appendLines keeps the failed batch on its own lines whatever the live outbox\'s tail is doing — one write, always behind a separator; a missing file is created', () => {
    fixture();
    const outbox = join(scratch as string, 'live.ndjson');
    appendLines(outbox, [RECORD_A]); // absent → created
    expect(readFileSync(outbox, 'utf8')).toBe(`\n${RECORD_A}\n`);
    expect(entries(outbox)).toEqual([RECORD_A]);
    writeFileSync(outbox, `${RECORD_A}\n${TORN}`, 'utf8'); // the daemon is mid-record
    appendLines(outbox, [RECORD_B, TORN]);
    expect(readFileSync(outbox, 'utf8')).toBe(`${RECORD_A}\n${TORN}\n${RECORD_B}\n${TORN}\n`);
    appendLines(outbox, [RECORD_A]); // at a boundary → the separator is an empty line, skipped by every reader
    expect(entries(outbox)).toEqual([RECORD_A, TORN, RECORD_B, TORN, RECORD_A]);
    const before = readFileSync(outbox, 'utf8');
    appendLines(outbox, []); // nothing to append → untouched
    expect(readFileSync(outbox, 'utf8')).toBe(before);
  });

  it.runIf(!CoreAdapter.replayEmitOutboxSupported())(
    'on an engine WITHOUT the binding: GovernanceReplayUnsupportedError, and the outbox is untouched',
    async () => {
      const { outbox, coreDb } = fixture();
      await expect(replayOutbox([outbox, '--db', coreDb], {})).rejects.toThrow(/replayEmitOutbox binding/);
      expect(existsSync(outbox)).toBe(true);
      expect(readdirSync(scratch as string)).toEqual(['emit-outbox.ndjson']);
    },
  );

  it.runIf(CoreAdapter.replayEmitOutboxSupported())(
    'on an engine WITH the binding: archive first, replay into the sidecar store, torn lines go back onto the outbox; a re-replay of the archive lands nothing twice',
    async () => {
      const { outbox, coreDb } = fixture();
      const { outcome, exitCode } = await replayOutbox([outbox, '--db', coreDb], {});
      expect(outcome.read).toBe(3);
      expect(outcome.replayed).toBe(2);
      expect(outcome.alreadyPresent).toBe(0);
      expect(outcome.failed).toBe(1);
      expect(exitCode).toBe(1);
      // Idempotent: replaying the archive again reports both records already present and the store count is unchanged.
      const again = await CoreAdapter.replayEmitOutbox(outcome.archive as string, resolveGovernanceStore({ coreDbPath: coreDb }).dbPath);
      expect(again.replayed).toBe(0);
      expect(again.already_present).toBe(2);
      // The archive holds everything that was attempted; the live outbox holds only what did not land.
      expect(outcome.archive).not.toBeNull();
      expect(existsSync(outcome.archive as string)).toBe(true);
      expect(readFileSync(outcome.archive as string, 'utf8')).toBe(`${RECORD_A}\n${RECORD_B}\n${TORN}\n`);
      expect(readFileSync(outbox, 'utf8')).toBe(`\n${TORN}\n`); // the failed batch, behind its unconditional separator
      expect(outcome.note).toBeNull(); // nothing was already present on a first replay
      // Both records are EVENT nodes on the store now — counted through the same engine binding.
      const count = CoreAdapter.eventStoreCounter();
      expect(count).not.toBeNull();
      const store = resolveGovernanceStore({ coreDbPath: coreDb });
      expect(existsSync(store.dbPath)).toBe(true);
      expect(await count!(store.dbPath)).toBe(2);
    },
  );
});

describe.runIf(existsSync(CLI))('wicked-crew governance (dist CLI)', () => {
  it('prints usage and exits 2 without a subcommand; `replay --dry-run` prints the fold as JSON', () => {
    const bad = spawnSync(process.execPath, [CLI, 'governance'], { encoding: 'utf8', timeout: 20_000 });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('Usage: wicked-crew governance replay');
    expect(GOVERNANCE_USAGE).toContain('--dry-run');

    const { outbox, coreDb } = fixture();
    const out = execFileSync(process.execPath, [CLI, 'governance', 'replay', outbox, '--db', coreDb, '--dry-run'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    const parsed = JSON.parse(out) as { dryRun: boolean; read: number; store: { path: string } };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.read).toBe(3);
    expect(parsed.store.path).toBe(governanceSidecarDb(coreDb));
    expect(existsSync(outbox)).toBe(true);
  });
});
