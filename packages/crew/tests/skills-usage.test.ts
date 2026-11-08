// Skill usage (operator 2026-11-08): the rollup of the engine's `skillUsed` / `skillsSnapshotHanded` frames and its
// read, `GET /skills/usage`. Credits a script only through the generation's own files; "used" = opened or a credited
// ran; directed and browsed are counted and are not use; a CLI whose use cannot be seen never reads "unused".

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerSkillsRoutes } from '../src/api/skills.js';
import { DAILY_KEEP_DAYS, SkillUsageRecorder, cliFamily, scriptIndexOf } from '../src/skills/usage.js';
import { symlinkSync } from 'node:fs';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 8, 12);

/** `<root>/snapshots/<gen>` with `skills/<dir>/SKILL.md` naming `refs`, and every referenced script on disk. */
function snapshots(gens: Record<string, Array<{ name: string; dir: string; refs?: string[] }>>): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-usage-'));
  roots.push(root);
  const dir = join(root, 'snapshots');
  for (const [gen, skills] of Object.entries(gens)) {
    const g = join(dir, gen);
    mkdirSync(g, { recursive: true });
    // The publisher's shape: `dir` is plugin-relative (`skills/<dir>`).
    writeFileSync(join(g, 'snapshot.json'), JSON.stringify({ gen: Number(gen), skills: skills.map(({ name, dir: d }) => ({ name, dir: `skills/${d}` })) }));
    for (const s of skills) {
      const sd = join(g, 'skills', ...s.dir.split('/'));
      mkdirSync(sd, { recursive: true });
      writeFileSync(join(sd, 'SKILL.md'), `# ${s.name}\n${(s.refs ?? []).map((r) => `Run \`wicked-garden run ${r} --x\`.`).join('\n')}\n`);
      for (const r of s.refs ?? []) {
        const p = join(g, ...r.split('/'));
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, '# script\n');
      }
    }
  }
  return dir;
}

const SKILLS = [
  { name: 'wicked-garden-domain', dir: 'domain', refs: ['scripts/domain/extract_loop.py', 'scripts/_run.py'] },
  { name: 'wicked-garden-domain-extractor', dir: 'domain-extractor', refs: ['scripts/domain/extract_loop.py', 'scripts/_run.py'] },
  { name: 'wicked-garden-qe', dir: 'qe', refs: ['scripts/qe/prove.py', 'scripts/_run.py'] },
  { name: 'wicked-garden-qe-oracle', dir: 'qe/oracle', refs: ['scripts/qe/oracle.py'] },
  { name: 'wicked-garden-unused', dir: 'unused' },
];

function recorder(opts: { snapshotsDir?: string; chats?: Record<string, string>; path?: string; now?: () => number; floor?: 'container' | 'host'; debounce?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'skill-usage-file-'));
  roots.push(root);
  let now = T0;
  const r = new SkillUsageRecorder({
    path: opts.path ?? join(root, 'daemon-skill-usage.json'),
    now: opts.now ?? (() => now),
    snapshotsDir: () => opts.snapshotsDir ?? null,
    chatOf: (s) => opts.chats?.[s],
    debounce: opts.debounce ?? false,
    floor: () => opts.floor ?? 'container',
  });
  return { r, path: opts.path ?? join(root, 'daemon-skill-usage.json'), at: (ms: number) => (now = ms) };
}

const handed = (session: string, ord: number, cli: string, skills: string[], gen = '000005') => ({
  type: 'skillsSnapshotHanded',
  session,
  ord,
  attempt: 0,
  path: 'wrapped_cli',
  cli,
  gen,
  contentHash: 'sha256:x',
  root: '/x',
  source: 'published',
  lever: 'codex_skills_dir',
  skills,
});
const used = (session: string, ord: number, cli: string, signal: string, what: { skill?: string; script?: string; via?: string }, gen = '000005') => ({
  type: 'skillUsed',
  session,
  ord,
  attempt: 0,
  cli,
  signal,
  skill: what.skill ?? null,
  via: what.via ?? null,
  how: signal === 'opened' ? 'shell' : null,
  script: what.script ?? null,
  gen,
  source: 'published',
});

const ALL = SKILLS.map((s) => s.name);
const catalog = ALL.map((name) => ({ name, enabled: true }));

describe('scriptIndexOf', () => {
  it('credits a script to the skills whose own files name it, a nested skill owning its own subtree', () => {
    const dir = snapshots({ '000005': SKILLS });
    const index = scriptIndexOf(join(dir, '000005'));
    expect(index.get('scripts/domain/extract_loop.py')).toEqual(['wicked-garden-domain', 'wicked-garden-domain-extractor']);
    expect(index.get('scripts/qe/prove.py')).toEqual(['wicked-garden-qe']);
    // qe/oracle's file names oracle.py; its parent `qe` does not own it.
    expect(index.get('scripts/qe/oracle.py')).toEqual(['wicked-garden-qe-oracle']);
    expect(index.get('scripts/_run.py')).toHaveLength(3);
  });
});

describe('SkillUsageRecorder', () => {
  it('credits a ran with one owner, narrows several by what the attempt opened, and keeps a shared one for the script', () => {
    const dir = snapshots({ '000005': SKILLS });
    const { r } = recorder({ snapshotsDir: dir });
    // One owner: prove.py → qe.
    r.ingest(handed('run-1', 1, 'codex', ALL));
    r.ingest(used('run-1', 1, 'codex', 'ran', { script: 'scripts/qe/prove.py' }));
    // Two owners, the attempt opened one of them.
    r.ingest(handed('run-1', 2, 'codex', ALL));
    r.ingest(used('run-1', 2, 'codex', 'opened', { skill: 'wicked-garden-domain-extractor' }));
    r.ingest(used('run-1', 2, 'codex', 'ran', { script: 'scripts/domain/extract_loop.py' }));
    // Two owners, no context: the script only.
    r.ingest(handed('run-1', 3, 'codex', ALL));
    r.ingest(used('run-1', 3, 'codex', 'ran', { script: 'scripts/domain/extract_loop.py' }));
    // A shared script with no owner in the attempt's context: kept for the script.
    r.ingest(used('run-1', 3, 'codex', 'ran', { script: 'scripts/_run.py' }));
    const rep = r.report({ currentGen: 5, catalog });
    const row = (n: string) => rep.skills.find((s) => s.name === n);
    expect(row('wicked-garden-qe')?.byCli['codex']?.ran.d30).toBe(1);
    expect(row('wicked-garden-domain-extractor')?.byCli['codex']?.ran.d30).toBe(1);
    expect(row('wicked-garden-domain')?.byCli['codex']?.ran.d30).toBe(0);
    expect(rep.scripts.map((s) => [s.script, s.d30])).toEqual([
      ['scripts/_run.py', 1],
      ['scripts/domain/extract_loop.py', 1],
    ]);
    expect(rep.scripts.find((s) => s.script === 'scripts/domain/extract_loop.py')?.owners).toEqual([
      'wicked-garden-domain',
      'wicked-garden-domain-extractor',
    ]);
  });

  it('a script owned by a skill the seat was not handed is not credited to it', () => {
    const dir = snapshots({ '000005': SKILLS });
    const { r } = recorder({ snapshotsDir: dir });
    r.ingest(handed('run-1', 1, 'codex', ['wicked-garden-domain']));
    r.ingest(used('run-1', 1, 'codex', 'ran', { script: 'scripts/qe/prove.py' }));
    const rep = r.report({ currentGen: 5, catalog });
    expect(rep.skills.find((s) => s.name === 'wicked-garden-qe')?.byCli['codex']?.ran.d30 ?? 0).toBe(0);
    expect(rep.scripts[0]?.script).toBe('scripts/qe/prove.py');
  });

  it('used = opened or credited ran; directed and browsed are counted but are not use', () => {
    const dir = snapshots({ '000005': SKILLS });
    const { r } = recorder({ snapshotsDir: dir });
    r.ingest(handed('run-1', 1, 'claude', ALL));
    r.ingest(used('run-1', 1, 'claude', 'directed', { skill: 'wicked-garden-domain', via: 'phase' }));
    r.ingest(used('run-1', 1, 'claude', 'browsed', { skill: 'wicked-garden-unused' }));
    r.ingest(used('run-1', 1, 'claude', 'opened', { skill: 'wicked-garden-qe' }));
    const rep = r.report({ currentGen: 5, catalog });
    const row = (n: string) => rep.skills.find((s) => s.name === n)!;
    expect(row('wicked-garden-domain').byCli['claude']?.directed.d30).toBe(1);
    expect(row('wicked-garden-domain').lastUsed).toBeNull();
    expect(row('wicked-garden-domain').unusedSince.all).toBe(true);
    expect(row('wicked-garden-unused').byCli['claude']?.browsed.d30).toBe(1);
    expect(row('wicked-garden-unused').unusedSince.all).toBe(true);
    expect(row('wicked-garden-qe').lastUsed).toEqual({ at: T0, gen: 5, cli: 'claude' });
    expect(row('wicked-garden-qe').unusedSince).toEqual({ all: false, byCli: [], notObservable: false });
  });

  it('a skill handed only to a CLI whose use cannot be seen is "not observable", never "unused"', () => {
    const { r } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }) });
    r.ingest(handed('run-1', 1, 'copilot', ['wicked-garden-qe']));
    r.ingest(handed('run-1', 2, 'codex', ['wicked-garden-domain']));
    const rep = r.report({ currentGen: 5, catalog });
    expect(rep.skills.find((s) => s.name === 'wicked-garden-qe')?.unusedSince).toEqual({ all: false, byCli: [], notObservable: true });
    expect(rep.skills.find((s) => s.name === 'wicked-garden-domain')?.unusedSince).toEqual({ all: true, byCli: ['codex'], notObservable: false });
    expect(rep.observable['copilot']?.signals).toEqual([]);
    expect(cliFamily('codex-2')).toBe('codex');
  });

  it('counts 30 and 90 day windows and drops days past 90 on write', () => {
    const { r, path, at } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }) });
    at(T0 - 100 * DAY);
    r.ingest(used('run-0', 1, 'pi', 'opened', { skill: 'wicked-garden-qe' }));
    at(T0 - 60 * DAY);
    r.ingest(used('run-1', 1, 'pi', 'opened', { skill: 'wicked-garden-qe' }));
    at(T0 - 2 * DAY);
    r.ingest(used('run-2', 1, 'pi', 'opened', { skill: 'wicked-garden-qe' }));
    at(T0);
    r.ingest(used('run-3', 1, 'pi', 'opened', { skill: 'wicked-garden-qe' }));
    const cell = r.report({ currentGen: 5, catalog }).skills.find((s) => s.name === 'wicked-garden-qe')?.byCli['pi']?.opened;
    expect(cell).toMatchObject({ d30: 2, d90: 3, lastAt: T0, lastGen: 5 });
    const days = Object.keys((JSON.parse(readFileSync(path, 'utf8')) as { daily: Record<string, unknown> }).daily);
    expect(days.every((d) => d >= new Date(T0 - DAILY_KEEP_DAYS * DAY).toISOString().slice(0, 10))).toBe(true);
    expect(days).toHaveLength(3);
  });

  it('judges "unused since gen N" from N, and clamps N to when recording began', () => {
    const dir = snapshots({ '000005': SKILLS, '000006': SKILLS });
    const { r } = recorder({ snapshotsDir: dir });
    r.ingest(handed('run-1', 1, 'codex', ['wicked-garden-qe'], '000005'));
    r.ingest(used('run-1', 1, 'codex', 'opened', { skill: 'wicked-garden-qe' }, '000005'));
    r.ingest(handed('run-2', 1, 'codex', ['wicked-garden-qe'], '000006'));
    expect(r.report({ currentGen: 6, catalog, sinceGen: 5 }).skills.find((s) => s.name === 'wicked-garden-qe')?.unusedSince.all).toBe(false);
    expect(r.report({ currentGen: 6, catalog, sinceGen: 6 }).skills.find((s) => s.name === 'wicked-garden-qe')?.unusedSince.all).toBe(true);
    const clamped = r.report({ currentGen: 6, catalog, sinceGen: 1 });
    expect(clamped).toMatchObject({ sinceGen: 5, sinceGenClamped: true, recordingSince: { gen: 5, at: T0 } });
  });

  it('tags origin chat, run and member', () => {
    const { r, path } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }), chats: { 'run-chat': 'chat-1' } });
    r.ingest(used('run-chat', 1, 'claude', 'opened', { skill: 'wicked-garden-qe' }));
    r.ingest(used('run-wf', 1, 'claude', 'opened', { skill: 'wicked-garden-domain' }));
    r.ingest(used('member-x-1-2', 0, 'claude', 'opened', { skill: 'wicked-garden-unused' }));
    const daily = (JSON.parse(readFileSync(path, 'utf8')) as { daily: Record<string, Record<string, number>> }).daily;
    const keys = Object.keys(Object.values(daily)[0] ?? {}).sort();
    expect(keys).toEqual([
      'wicked-garden-domain|claude|opened|run',
      'wicked-garden-qe|claude|opened|chat',
      'wicked-garden-unused|claude|opened|member',
    ]);
  });

  it('records the generation each skill was introduced in, seeding from the oldest snapshot on disk', () => {
    const dir = snapshots({
      '000003': SKILLS.slice(0, 2),
      '000004': SKILLS.slice(0, 3),
      '000005': SKILLS,
    });
    const { r } = recorder({ snapshotsDir: dir });
    r.noteGeneration(5);
    const rep = r.report({ currentGen: 5, catalog });
    const intro = (n: string) => rep.skills.find((s) => s.name === n)?.introduced;
    expect(intro('wicked-garden-domain')).toEqual({ gen: 3, seeded: true });
    expect(intro('wicked-garden-qe')).toEqual({ gen: 4, seeded: false });
    expect(intro('wicked-garden-unused')).toEqual({ gen: 5, seeded: false });
  });

  it('survives a restart and starts empty from a malformed file', () => {
    const dir = snapshots({ '000005': SKILLS });
    const first = recorder({ snapshotsDir: dir });
    first.r.ingest(used('run-1', 1, 'pi', 'opened', { skill: 'wicked-garden-qe' }));
    const again = recorder({ snapshotsDir: dir, path: first.path, now: () => T0 });
    expect(again.r.report({ currentGen: 5, catalog }).skills.find((s) => s.name === 'wicked-garden-qe')?.byCli['pi']?.opened.d30).toBe(1);
    writeFileSync(first.path, '{not json');
    const broken = recorder({ snapshotsDir: dir, path: first.path });
    expect(broken.r.snapshot().daily).toEqual({});
    // Parseable but malformed anywhere inside: refused whole, and the report still answers.
    for (const bad of [
      { version: 2, last: { 'a|codex|opened': null } },
      { version: 2, daily: { '2026-11-08': null } },
      { version: 2, handedLast: { 'a|codex': { gen: 'x', at: 1 } } },
      { version: 2, introduced: { a: 'x' } },
      { version: 2, daily: { '2026-11-08': { 'a|codex|opened|run': -1 } } },
    ]) {
      writeFileSync(first.path, JSON.stringify(bad));
      const b = recorder({ snapshotsDir: dir, path: first.path });
      expect(b.r.snapshot().last).toEqual({});
      expect(() => b.r.report({ currentGen: 5, catalog })).not.toThrow();
    }
  });

  it('ignores other frames, tool-command handoffs and malformed usage', () => {
    const { r } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }) });
    r.ingest({ type: 'toolActivity', session: 'run-1', ord: 1 });
    r.ingest(handed('run-1', 1, 'tool', []));
    r.ingest(used('run-1', 1, 'codex', 'weird', { skill: 'wicked-garden-qe' }));
    r.ingest(used('run-1', 1, 'codex', 'ran', { script: '/etc/passwd' }));
    expect(r.snapshot().daily).toEqual({});
    expect(r.snapshot().recordingSince).toBeNull();
  });
});

describe('GET /skills/usage', () => {
  it('answers the rollup over the manifest catalog, validates sinceGen, and 503s without a recorder', async () => {
    const dir = snapshots({ '000005': SKILLS });
    const { r } = recorder({ snapshotsDir: dir });
    r.ingest(handed('run-1', 1, 'codex', ALL));
    r.ingest(used('run-1', 1, 'codex', 'opened', { skill: 'wicked-garden-qe' }));
    const runtime = {
      store: { manifest: () => ({ revision: 1, skills: Object.fromEntries(ALL.map((n) => [n, { enabled: n !== 'wicked-garden-unused' }])) }) },
      health: () => ({ current: { gen: 5, path: '/x' } }),
    };
    const app = Fastify();
    const audit = { record: () => undefined };
    registerSkillsRoutes(app, { runtime: runtime as never, usage: r, audit: audit as never, actorOf: () => ({}) as never });
    const ok = await app.inject({ method: 'GET', url: '/api/v1/skills/usage' });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.currentGen).toBe(5);
    expect(body.skills.find((s: { name: string }) => s.name === 'wicked-garden-qe').byCli.codex.opened.d30).toBe(1);
    expect(body.skills.find((s: { name: string }) => s.name === 'wicked-garden-unused').enabled).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/usage?sinceGen=-1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/skills/usage?nope=1' })).statusCode).toBe(400);
    const bare = Fastify();
    registerSkillsRoutes(bare, { runtime: runtime as never, audit: audit as never, actorOf: () => ({}) as never });
    expect((await bare.inject({ method: 'GET', url: '/api/v1/skills/usage' })).statusCode).toBe(503);
  });
});

describe('review r1: robustness and correctness', () => {
  it('never reads outside the snapshots dir: a hostile gen token or row dir is refused', () => {
    const dir = snapshots({ '000005': SKILLS });
    // A row climbing out of the snapshot is ignored.
    const g = join(dir, '000005');
    writeFileSync(join(g, 'snapshot.json'), JSON.stringify({ gen: 5, skills: [{ name: 'wicked-garden-x', dir: 'skills/../../../outside' }, { name: 'wicked-garden-qe', dir: 'skills/qe' }] }));
    // Only `qe` is indexed now, so its whole tree (the unindexed oracle dir included) is its own; nothing outside.
    const index = scriptIndexOf(g);
    expect([...index.keys()].sort()).toEqual(['scripts/_run.py', 'scripts/qe/oracle.py', 'scripts/qe/prove.py']);
    expect([...index.values()].flat().every((n) => n === 'wicked-garden-qe')).toBe(true);
    const { r } = recorder({ snapshotsDir: dir });
    expect(() => r.ingest(used('run-1', 1, 'codex', 'ran', { script: 'scripts/qe/prove.py' }, '../../outside'))).not.toThrow();
    expect(r.snapshot().last).toEqual({});
  });

  it('refuses hostile identifiers and ordinals without throwing', () => {
    const { r } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }) });
    r.ingest({ ...used('run-1', 1, 'claude', 'directed', { skill: 'a|codex|opened' }) });
    r.ingest({ ...used('run-1', 1, '__proto__', 'opened', { skill: 'wicked-garden-qe' }) });
    r.ingest({ ...used('run-1', 1, 'claude', 'opened', { skill: 'wicked-garden-qe' }), ord: { toString: null } as never });
    expect(r.snapshot().last).toEqual({});
    r.ingest(used('run-1', 1, 'constructor', 'opened', { skill: 'constructor' }));
    const rep = r.report({ currentGen: 5, catalog });
    expect(rep.skills.find((s) => s.name === 'constructor')?.byCli['constructor']?.opened.d30).toBe(1);
  });

  it('keeps every handed name per CLI, and a use in a newer generation outlives a later old-generation one', () => {
    const { r } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS, '000006': SKILLS }) });
    r.ingest(handed('run-1', 1, 'codex', ['wicked-garden-qe'], '000006'));
    r.ingest(handed('run-1', 2, 'codex', ['wicked-garden-domain'], '000006'));
    r.ingest(used('run-1', 1, 'codex', 'opened', { skill: 'wicked-garden-qe' }, '000006'));
    r.ingest(used('run-0', 1, 'codex', 'opened', { skill: 'wicked-garden-qe' }, '000005'));
    const rep = r.report({ currentGen: 6, catalog, sinceGen: 6 });
    const row = (n: string) => rep.skills.find((s) => s.name === n)!;
    expect(row('wicked-garden-domain').byCli['codex']?.handedLastGen).toBe(6);
    expect(row('wicked-garden-domain').unusedSince.all).toBe(true);
    expect(row('wicked-garden-qe').unusedSince.all).toBe(false);
  });

  it('a use with no generation is never called unused; recording takes the first real generation', () => {
    const { r } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }) });
    r.ingest(used('run-1', 1, 'claude', 'opened', { skill: 'wicked-garden-qe' }, null as never));
    expect(r.snapshot().recordingSince?.gen).toBeNull();
    r.ingest(handed('run-2', 1, 'claude', ['wicked-garden-qe'], '000005'));
    expect(r.snapshot().recordingSince?.gen).toBe(5);
    expect(r.report({ currentGen: 5, catalog, sinceGen: 5 }).skills.find((s) => s.name === 'wicked-garden-qe')?.unusedSince.all).toBe(false);
  });

  it('opencode and agy on the host floor are not observable', () => {
    const { r } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }), floor: 'host' });
    r.ingest(handed('run-1', 1, 'opencode', ['wicked-garden-qe']));
    const rep = r.report({ currentGen: 5, catalog });
    expect(rep.skills.find((s) => s.name === 'wicked-garden-qe')?.unusedSince).toEqual({ all: false, byCli: [], notObservable: true });
    expect(rep.observable['opencode']?.signals).toEqual([]);
  });

  it('lists a handed skill no longer in the catalog', () => {
    const { r } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }) });
    r.ingest(handed('run-1', 1, 'codex', ['wicked-garden-gone']));
    const row = r.report({ currentGen: 5, catalog }).skills.find((s) => s.name === 'wicked-garden-gone');
    expect(row).toMatchObject({ enabled: null, unusedSince: { all: true } });
  });

  it('counts a skill once per attempt however many of its scripts ran', () => {
    const dir = snapshots({ '000005': [{ name: 'wicked-garden-qe', dir: 'qe', refs: ['scripts/qe/prove.py', 'scripts/qe/vault.py'] }] });
    const { r } = recorder({ snapshotsDir: dir });
    r.ingest(handed('run-1', 1, 'codex', ['wicked-garden-qe']));
    r.ingest(used('run-1', 1, 'codex', 'ran', { script: 'scripts/qe/prove.py' }));
    r.ingest(used('run-1', 1, 'codex', 'ran', { script: 'scripts/qe/vault.py' }));
    expect(r.report({ currentGen: 5, catalog }).skills.find((s) => s.name === 'wicked-garden-qe')?.byCli['codex']?.ran.d30).toBe(1);
  });

  it('a missing or symlinked snapshots dir never throws', () => {
    const { r } = recorder({ snapshotsDir: join(tmpdir(), 'no-such-snapshots-dir-xyz') });
    expect(() => r.ingest(handed('run-1', 1, 'codex', ['wicked-garden-qe']))).not.toThrow();
    const real = snapshots({ '000005': SKILLS });
    const link = join(real, '..', 'linked');
    symlinkSync(real, link);
    const viaLink = recorder({ snapshotsDir: link });
    viaLink.r.noteGeneration(5);
    expect(viaLink.r.snapshot().introduced).toEqual({});
  });

  it('writes through the debounce on flush, keeping exactly 90 days', () => {
    const { r, path, at } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }), debounce: true });
    for (let d = 95; d >= 0; d -= 1) {
      at(T0 - d * DAY);
      r.ingest(used(`run-${d}`, 1, 'pi', 'opened', { skill: 'wicked-garden-qe' }));
    }
    r.flush();
    const daily = (JSON.parse(readFileSync(path, 'utf8')) as { daily: Record<string, unknown> }).daily;
    expect(Object.keys(daily)).toHaveLength(DAILY_KEEP_DAYS);
    expect(r.report({ currentGen: 5, catalog }).skills.find((s) => s.name === 'wicked-garden-qe')?.byCli['pi']?.opened.d90).toBe(90);
  });
});

describe('review r2', () => {
  it('bounds the script buckets per (script, CLI) and never credits through a symlinked snapshots dir', () => {
    const real = snapshots({ '000005': SKILLS });
    const link = join(real, '..', 'snap-link');
    symlinkSync(real, link);
    const { r } = recorder({ snapshotsDir: link });
    r.ingest(handed('run-1', 1, 'codex', ALL));
    r.ingest(used('run-1', 1, 'codex', 'ran', { script: 'scripts/qe/prove.py' }));
    // Not credited (the index is not read through the link): it stays with the script.
    expect(r.snapshot().last).toEqual({});
    expect(Object.keys(r.snapshot().scriptLast)).toEqual(['scripts/qe/prove.py']);
  });
});

describe('review r2 (codex)', () => {
  it('a handoff unseen on the host floor stays unseen after the floor changes', () => {
    const dir = snapshots({ '000005': SKILLS });
    const host = recorder({ snapshotsDir: dir, floor: 'host' });
    host.r.ingest(handed('run-1', 1, 'opencode', ['wicked-garden-qe']));
    const later = recorder({ snapshotsDir: dir, path: host.path, floor: 'container' });
    expect(later.r.report({ currentGen: 5, catalog }).skills.find((s) => s.name === 'wicked-garden-qe')?.unusedSince).toEqual({ all: false, byCli: [], notObservable: true });
  });

  it('a malformed generation refuses the frame; a constructor CLI never breaks the report', () => {
    const { r } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }) });
    r.ingest(used('run-1', 1, 'claude', 'opened', { skill: 'wicked-garden-qe' }, '../../outside'));
    expect(r.snapshot().last).toEqual({});
    r.ingest(handed('run-1', 2, 'constructor', ['wicked-garden-qe']));
    expect(() => r.report({ currentGen: 5, catalog })).not.toThrow();
  });

  it('keeps the newest generation of a use the attempt already counted', () => {
    const dir = snapshots({ '000005': SKILLS, '000006': SKILLS });
    const { r } = recorder({ snapshotsDir: dir });
    r.ingest(handed('run-1', 1, 'codex', ALL, '000005'));
    r.ingest(used('run-1', 1, 'codex', 'opened', { skill: 'wicked-garden-qe' }, '000005'));
    r.ingest(used('run-1', 1, 'codex', 'opened', { skill: 'wicked-garden-qe' }, '000006'));
    const row = r.report({ currentGen: 6, catalog, sinceGen: 6 }).skills.find((s) => s.name === 'wicked-garden-qe');
    expect(row?.byCli['codex']?.opened).toMatchObject({ d30: 1, lastGen: 6 });
    expect(row?.unusedSince.all).toBe(false);
  });

  it('counts an uncredited script once per attempt, and ignores days that are not real or not yet', () => {
    const { r, path } = recorder({ snapshotsDir: snapshots({ '000005': SKILLS }) });
    r.ingest(used('run-1', 1, 'codex', 'ran', { script: 'scripts/_run.py' }));
    r.ingest(used('run-1', 1, 'codex', 'ran', { script: 'scripts/_run.py' }));
    expect(r.report({ currentGen: 5, catalog }).scripts[0]?.d30).toBe(1);
    writeFileSync(path, JSON.stringify({ version: 2, daily: { '2026-99-99': {} } }));
    expect(recorder({ snapshotsDir: snapshots({ '000005': SKILLS }), path }).r.snapshot().daily).toEqual({});
  });
});
