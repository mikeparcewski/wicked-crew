// `wicked-crew governance replay` (crew#495): the drain for a dead-letter outbox.
//
// The dry run works on every engine (a fold, nothing moved). The real replay needs the engine's
// `Core.replayEmitOutbox` static (wicked-core-ts ≥ the release carrying the crew#495 companion):
// on an older addon the command says so and exits 2 with the outbox UNTOUCHED; on a capable one it
// archives the outbox FIRST (so a running daemon's next spool starts a fresh file), replays from
// the archive, and appends whatever did not land back onto the outbox. Both branches are pinned —
// crew CI builds the addon from core `main`, so whichever is true there is what runs.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { CoreAdapter } from '../src/core/adapter.js';
import {
  appendLines,
  archiveNameFor,
  endsWithNewline,
  GOVERNANCE_USAGE,
  replayOutbox,
  replayTarget,
  restoreOutbox,
  UsageError,
} from '../src/cli/governance.js';
import { governanceSidecarDb, resolveGovernanceStore } from '../src/core/governance-store.js';
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
  });

  it('refuses a missing outbox, and a :memory: target for a REAL replay only — a dry run folds the file and touches no store (Copilot on #516)', async () => {
    const { coreDb } = fixture();
    await expect(replayOutbox([join(scratch as string, 'nope.ndjson'), '--db', coreDb], {})).rejects.toThrow(/outbox not found/);
    const { outbox } = fixture();
    await expect(replayOutbox([outbox, '--governance-db', ':memory:'], {})).rejects.toThrow(/refusing to replay into :memory:/);
    const dry = await replayOutbox([outbox, '--governance-db', ':memory:', '--dry-run'], {});
    expect(dry.exitCode).toBe(0);
    expect(dry.outcome.store).toEqual({ path: ':memory:', source: 'flag' });
    expect(dry.outcome.read).toBe(3);
    // Operator-facing output never carries a URL spec's credentials — the dry run's store line is the display spelling.
    const redacted = await replayOutbox([outbox, '--governance-db', 'postgres://user:s3cret@h/db', '--dry-run'], {});
    expect(redacted.outcome.store.path).toBe('postgres://***@h/db');
  });

  it('the archive name is the outbox plus a filesystem-safe timestamp', () => {
    expect(archiveNameFor('/x/emit-outbox.ndjson', new Date('2026-09-10T15:29:07.123Z'))).toBe(
      '/x/emit-outbox.ndjson.replayed-2026-09-10T15-29-07-123Z',
    );
  });

  /** The NDJSON entries of a file — what every reader (the fold, the engine's replay) sees: blank lines are not entries. */
  const entries = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');

  it('a replay that THROWS after the archive rename puts the outbox back — append-only, never "0 dead letters", never a clobbered fresh spool, every boundary kept (Copilot on #516)', async () => {
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
    // `endsWithNewline` is the ARCHIVE-side check: boundary for a missing/empty/terminated file, not for a torn one.
    expect(endsWithNewline(join(scratch as string, 'absent.ndjson'))).toBe(true);
    expect(endsWithNewline(outbox)).toBe(true);
    writeFileSync(archive, TORN, 'utf8');
    expect(endsWithNewline(archive)).toBe(false);
    rmSync(archive);
  });

  it('appendLines keeps the failed batch on its own lines whatever the live outbox\'s tail is doing — one write, always behind a separator; a missing file is created (Copilot on #516)', () => {
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
    'on an engine WITH the binding: archive first, replay into the sidecar store, torn lines go back onto the outbox',
    async () => {
      const { outbox, coreDb } = fixture();
      const { outcome, exitCode } = await replayOutbox([outbox, '--db', coreDb], {});
      expect(outcome.read).toBe(3);
      expect(outcome.replayed).toBe(2);
      expect(outcome.failed).toBe(1);
      expect(exitCode).toBe(1);
      // The archive holds everything that was attempted; the live outbox holds only what did not land.
      expect(outcome.archive).not.toBeNull();
      expect(existsSync(outcome.archive as string)).toBe(true);
      expect(readFileSync(outcome.archive as string, 'utf8')).toBe(`${RECORD_A}\n${RECORD_B}\n${TORN}\n`);
      expect(readFileSync(outbox, 'utf8')).toBe(`\n${TORN}\n`); // the failed batch, behind its unconditional separator
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
