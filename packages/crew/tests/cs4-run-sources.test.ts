import { fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkSourcePick, projectSources, RUN_SOURCES_MAX, RunSourcePicks, runSourcesDeps, webScopeReason } from '../src/api/run-sources.js';
import { WebSource } from '../src/knowledge/adapters/web/source.js';
import { DataGate } from '../src/knowledge/gate/gate.js';
import type { McpRegistryFile, McpServerRecord } from '../src/mcp/registry-store.js';
import { SourceCatalogStore } from '../src/sources/store.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), openSync: vi.fn(fs.openSync) };
});

const QUERY_OFF = "agents can't query it: turn on 'Agents can query' in Settings → Sources";
const UNKNOWN = 'no source of that name in this project';
const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'cs4-run-sources-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entry(name: string, patch: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: `registry-id-${name}`, name, kind: 'mcp-stdio', command: null, args: [], url: null, auth: null,
    enabled: true, agents: { see: true, query: true, projects: ['proj_a'], everyProject: false },
    health: { state: 'ok', consecutiveFailures: 0, checkedAt: null, lastError: null },
    registeredAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z', tools: [], ...patch,
  };
}

function fixture() {
  const sql = entry('support-pg', {
    kind: 'sql', sql: { driver: 'postgres', host: '127.0.0.1', port: 5432, database: 'support', user: 'reader', tls: 'disable' },
    agents: { see: true, query: false, projects: ['proj_a'], everyProject: false },
  });
  const servers = [
    sql,
    entry('web', { kind: 'web' }),
    entry('jira', { pm: { system: 'jira' } }),
    entry('toolbox-pg', { kind: 'toolbox-source', runtime: 'toolbox', toolbox: { kind: 'source', type: 'postgres', host: '127.0.0.1', port: '5432', database: 'support', user: 'reader' }, tls: { mode: 'disable', ca: null } }),
    ...['estate', 'repository-graph', 'rules'].map((name) => entry(name)),
  ];
  const file: McpRegistryFile = { version: 1, servers };
  const web = new WebSource({ mcpDir: join(scratch(), 'web') });
  // No runtime is started or probed: only the gate's read of availability is under test.
  const setup = vi.spyOn(web, 'setup').mockResolvedValue({ installed: true, search: { ready: true } } as Awaited<ReturnType<WebSource['setup']>>);
  const gate = new DataGate({
    store: { read: async () => structuredClone(file), mutate: async () => { throw new Error('read only'); } },
    catalogs: new SourceCatalogStore(join(scratch(), 'catalogs')),
    secret: async () => { throw new Error('must not read credentials'); },
    record: { append: async () => { throw new Error('must not record a query'); } },
    audit: { record: () => { throw new Error('must not audit a query'); } },
    resolver: () => null, lister: () => null, web,
  });
  return { file, sql, gate, setup, deps: runSourcesDeps(gate) };
}

describe('CS4 source choices and launch checks', () => {
  it('pins source families, broker names, labels, ordering and the query switch', async () => {
    const { deps } = fixture();
    expect(await projectSources('proj_a', deps)).toEqual([
      { id: 'web', label: 'the web', web: true }, { id: 'jira', label: 'jira' },
      { id: 'support-pg', label: 'support-pg', reason: QUERY_OFF }, { id: 'toolbox-pg', label: 'toolbox-pg' },
    ]);
  });

  it('pins refusal of query-off and unknown picks, while accepting web, empty and deduplicated picks', async () => {
    const { deps } = fixture();
    expect(await checkSourcePick('proj_a', ['support-pg', 'missing', 'support-pg'], deps)).toEqual({
      ok: false, refused: [{ id: 'support-pg', reason: QUERY_OFF }, { id: 'missing', reason: UNKNOWN }],
    });
    expect(await checkSourcePick('proj_a', ['web'], deps)).toEqual({ ok: true, ids: ['web'] });
    expect(await checkSourcePick('proj_a', [], deps)).toEqual({ ok: true, ids: [] });
    expect(await checkSourcePick('proj_a', Array(25).fill('web'), deps)).toEqual({ ok: true, ids: ['web'] });
  });

  it('pins an empty pick without depending on source availability', async () => {
    expect(await checkSourcePick('proj_a', [], { sources: async () => { throw new Error('unavailable'); } })).toEqual({ ok: true, ids: [] });
  });

  it('pins hidden, disabled and out-of-project picks to the unknown-name refusal', async () => {
    const { file, deps } = fixture();
    file.servers.push(entry('hidden', { agents: { see: false, query: false, projects: ['proj_a'], everyProject: false } }), entry('disabled', { enabled: false }));
    for (const [project, id] of [['proj_a', 'hidden'], ['proj_a', 'disabled'], ['proj_b', 'web'], [null, 'jira'], ['proj_a', 'unknown']] as const) {
      expect(await checkSourcePick(project, [id], deps)).toEqual({ ok: false, refused: [{ id, reason: UNKNOWN }] });
    }
    file.servers.find((s) => s.name === 'jira')!.agents!.everyProject = true;
    expect(await checkSourcePick(null, ['jira'], deps)).toEqual({ ok: true, ids: ['jira'] });
  });

  it('omits hidden, disabled and out-of-project names from both gate choices and the proposal list', async () => {
    const { file, gate, setup, deps } = fixture();
    file.servers.push(
      entry('hidden', { agents: { see: false, query: true, projects: ['proj_a'], everyProject: false }, pm: { system: 'jira' } }),
      entry('disabled', { enabled: false, kind: 'sql', sql: file.servers[0]!.sql! }),
      entry('other-project', { kind: 'toolbox-source', runtime: 'toolbox', toolbox: file.servers.find((s) => s.name === 'toolbox-pg')!.toolbox!, agents: { see: true, query: true, projects: ['proj_b'], everyProject: false } }),
    );
    const names = ['web', 'jira', 'support-pg', 'toolbox-pg'];
    expect((await gate.pickable('proj_a')).map((s) => s.id).sort()).toEqual([...names].sort());
    expect((await projectSources('proj_a', deps)).map((s) => s.id)).toEqual(names);
    for (const id of ['hidden', 'disabled', 'other-project', 'unknown']) {
      expect(await checkSourcePick('proj_a', [id], deps)).toEqual({ ok: false, refused: [{ id, reason: UNKNOWN }] });
    }
    // The same visibility rule applies to web, before consulting its runtime.
    file.servers.find((s) => s.kind === 'web')!.agents!.see = false;
    setup.mockClear();
    expect((await projectSources('proj_a', deps)).map((s) => s.id)).toEqual(names.slice(1));
    expect(await checkSourcePick('proj_a', ['web'], deps)).toEqual({ ok: false, refused: [{ id: 'web', reason: UNKNOWN }] });
    expect(setup).not.toHaveBeenCalled();
    expect(await projectSources(null, deps)).toEqual([]);
  });

  it('names the projects the web source is set up for when it is out of this project, still unpicked (e2e-1105 CJ3)', async () => {
    const { file, gate } = fixture();
    const named = { scopedElsewhere: (p: string | null) => gate.webScopedElsewhere(p), projectName: async (id: string) => (id === 'proj_a' ? 'Mikes' : null) };
    // In its project, or set up for every project: not the cause, no reason.
    expect(await gate.webScopedElsewhere('proj_a')).toBeNull();
    expect(await webScopeReason('proj_a', named)).toBeUndefined();
    // A no-project chat and another project: scoped elsewhere, named, and still never offered or picked there.
    for (const project of [null, 'proj_b']) {
      expect(await webScopeReason(project, named)).toBe('the web source is set up for project Mikes only');
      expect((await gate.pickable(project)).some((s) => s.web === true)).toBe(false);
    }
    const web = file.servers.find((s) => s.kind === 'web')!;
    web.agents!.projects = ['proj_a', 'proj_c'];
    expect(await webScopeReason(null, named)).toBe('the web source is set up for projects Mikes and proj_c only');
    web.agents!.projects = [];
    expect(await webScopeReason(null, named)).toBe('the web source is not set up for any project: choose its projects in Settings → Sources');
    web.agents!.everyProject = true;
    expect(await webScopeReason(null, named)).toBeUndefined();
    // Hidden from agents or disabled: not a scope question, so the plain fallback stands.
    web.agents!.everyProject = false;
    web.agents!.see = false;
    expect(await gate.webScopedElsewhere(null)).toBeNull();
    web.agents!.see = true;
    web.enabled = false;
    expect(await gate.webScopedElsewhere(null)).toBeNull();
  });

  it('labels and orders web by the gate flag when its registered name differs', async () => {
    const { file, gate, deps } = fixture();
    file.servers.find((s) => s.kind === 'web')!.name = 'z-search';
    expect(await gate.pickable('proj_a')).toContainEqual({ id: 'z-search', web: true });
    expect(await projectSources('proj_a', deps)).toEqual([
      { id: 'z-search', label: 'the web', web: true }, { id: 'jira', label: 'jira' },
      { id: 'support-pg', label: 'support-pg', reason: QUERY_OFF }, { id: 'toolbox-pg', label: 'toolbox-pg' },
    ]);
    expect(await checkSourcePick('proj_a', ['z-search'], deps)).toEqual({ ok: true, ids: ['z-search'] });
    file.servers.find((s) => s.kind === 'web')!.kind = 'mcp-stdio';
    file.servers.push(entry('web', { pm: { system: 'jira' } }));
    expect((await projectSources('proj_a', deps)).at(-1)).toEqual({ id: 'web', label: 'web' });
  });

  it('pins the cap after deduplication, even when every offered source is allowed', async () => {
    const ids = Array.from({ length: RUN_SOURCES_MAX + 1 }, (_, i) => `source-${i}`);
    const deps = { sources: async () => ids.map((id) => ({ id })) };
    expect(await checkSourcePick('proj_a', ids.slice(0, RUN_SOURCES_MAX), deps)).toEqual({ ok: true, ids: ids.slice(0, RUN_SOURCES_MAX) });
    expect(await checkSourcePick('proj_a', ids, deps)).toEqual({ ok: false, refused: ids.map((id) => ({ id, reason: 'pick at most 20 sources' })) });
  });

  it('pins live switch reads and refuses structure-only SQL even when query is on', async () => {
    const { sql, deps } = fixture();
    sql.agents!.query = true;
    expect(await checkSourcePick('proj_a', ['support-pg'], deps)).toEqual({ ok: true, ids: ['support-pg'] });
    sql.sql!.driver = 'mysql';
    expect(await checkSourcePick('proj_a', ['support-pg'], deps)).toEqual({ ok: false, refused: [{ id: 'support-pg', reason: "agents can't query this source" }] });
    sql.agents!.query = false;
    expect(await checkSourcePick('proj_a', ['support-pg'], deps)).toEqual({ ok: false, refused: [{ id: 'support-pg', reason: QUERY_OFF }] });
  });

  it.each([
    [false, true, 'the web source is not installed'],
    [true, false, 'the web source is not running'],
  ])('pins web availability: installed=%s ready=%s', async (installed, ready, reason) => {
    const { setup, deps } = fixture();
    setup.mockResolvedValue({ installed, search: { ready } } as Awaited<ReturnType<WebSource['setup']>>);
    expect(await checkSourcePick('proj_a', ['web'], deps)).toEqual({ ok: false, refused: [{ id: 'web', reason }] });
  });

  it('pins omission of unregistered web and crew services', async () => {
    const { file, setup, deps } = fixture();
    file.servers = file.servers.filter((s) => s.name !== 'web');
    expect((await projectSources('proj_a', deps)).map((s) => s.id)).toEqual(['jira', 'support-pg', 'toolbox-pg']);
    expect(setup).not.toHaveBeenCalled();
    expect(await checkSourcePick('proj_a', ['estate'], deps)).toEqual({ ok: false, refused: [{ id: 'estate', reason: UNKNOWN }] });
  });
});

describe('CS4 durable run source picks', () => {
  it.each([false, true])('makes the same source ids an idempotent no-op (reloaded: %s)', (reload) => {
    const file = join(scratch(), 'picks.json');
    let picks = new RunSourcePicks(file);
    picks.set('run', ['web', 'support-pg']);
    picks.set('empty', []);
    if (reload) picks = new RunSourcePicks(file);
    const before = readFileSync(file, 'utf8');
    const sync = vi.mocked(fsyncSync).mockClear();
    picks.set('run', ['support-pg', 'web', 'web']);
    picks.set('empty', []);
    expect(sync).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(picks.get('run')).toEqual(['web', 'support-pg']);
  });

  it.each([false, true])('makes a recorded source pick immutable (reloaded: %s)', (reload) => {
    const file = join(scratch(), 'picks.json');
    let picks = new RunSourcePicks(file);
    picks.set('run', ['web']);
    picks.set('empty', []);
    if (reload) picks = new RunSourcePicks(file);
    const before = readFileSync(file, 'utf8');
    for (const changed of [[], ['support-pg'], ['web', 'support-pg']]) {
      expect(() => picks.set('run', changed)).toThrow("a run's source pick can't change");
    }
    expect(() => picks.set('empty', ['web'])).toThrow("a run's source pick can't change");
    expect(picks.get('run')).toEqual(['web']);
    expect(picks.get('empty')).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(new RunSourcePicks(file).get('run')).toEqual(['web']);
    expect(new RunSourcePicks(file).get('empty')).toEqual([]);
  });

  it('pins persistence, explicit empty picks, unknown runs and safe object keys', () => {
    const file = join(scratch(), 'state', 'run-source-picks.json');
    const picks = new RunSourcePicks(file);
    expect(picks.get('missing')).toBeNull();
    expect(picks.get('constructor')).toBeNull();
    picks.set('run-1', ['web', 'web', 'support-pg']);
    picks.set('run.none', []);
    picks.set('constructor', ['jira']);
    picks.set('r'.repeat(128), Array(25).fill('web'));
    const loaded = new RunSourcePicks(file);
    expect(loaded.get('run-1')).toEqual(['web', 'support-pg']);
    expect(loaded.get('run.none')).toEqual([]);
    expect(loaded.get('missing')).toBeNull();
    expect(loaded.get('constructor')).toEqual(['jira']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, runs: {
      'run-1': { ids: ['web', 'support-pg'], at: expect.any(Number) },
      'run.none': { ids: [], at: expect.any(Number) }, constructor: { ids: ['jira'], at: expect.any(Number) },
      ['r'.repeat(128)]: { ids: ['web'], at: expect.any(Number) },
    } });
    expect(readdirSync(join(file, '..'))).toEqual(['run-source-picks.json']);
  });

  it('pins cached reads and copies on input and output', () => {
    const file = join(scratch(), 'picks.json');
    const picks = new RunSourcePicks(file);
    const ids = ['web'];
    picks.set('run', ids);
    ids.push('support-pg');
    picks.get('run')!.push('jira');
    writeFileSync(file, 'corrupt after loading');
    expect(picks.get('run')).toEqual(['web']);
    expect(() => new RunSourcePicks(file)).toThrow('corrupt run source picks');
  });

  it.each(['', '../run', '.run', 'run/path', 'a'.repeat(129), null, 123])('pins the run id grammar: %j', (id) => {
    const picks = new RunSourcePicks(join(scratch(), 'picks.json'));
    expect(() => picks.set(id as string, [])).toThrow('invalid run id');
  });

  it.each([[''], ['Web'], ['bad/name'], ['a'.repeat(64)], [null], Array.from({ length: 21 }, (_, i) => `s${i}`)])('pins stored source id validation: %j', (...ids) => {
    const picks = new RunSourcePicks(join(scratch(), 'picks.json'));
    expect(() => picks.set('run', ids as string[])).toThrow('registered source names');
    expect(picks.get('run')).toBeNull();
  });

  it.each([
    '{', 'null', '[]', '{}', '{"version":2,"runs":{}}', '{"version":1,"runs":[]}',
    ...[null, {}, { ids: 'web', at: 1 }, { ids: ['web', 'web'], at: 1 }, { ids: ['bad/name'], at: 1 },
      { ids: Array.from({ length: 21 }, (_, i) => `s${i}`), at: 1 }, { ids: [], at: -1 }, { ids: [], at: 1.5 }, { ids: [] }]
      .map((pick) => JSON.stringify({ version: 1, runs: { run: pick } })),
    JSON.stringify({ version: 1, runs: { '../run': { ids: [], at: 1 } } }),
  ])('pins fail-closed loading of corrupt data: %s', (raw) => {
    const file = join(scratch(), 'picks.json');
    writeFileSync(file, raw);
    expect(() => new RunSourcePicks(file)).toThrow('corrupt run source picks');
  });

  it('pins propagation of read failures rather than treating them as no pick', () => {
    expect(() => new RunSourcePicks(scratch())).toThrow();
  });

  it('pins atomic replacement, retaining the cached pick and cleaning temporary files on write failure', () => {
    const root = scratch();
    const file = join(root, 'picks.json');
    const picks = new RunSourcePicks(file);
    picks.set('run', ['web']);
    rmSync(file);
    mkdirSync(file);
    expect(() => picks.set('next', [])).toThrow();
    expect(picks.get('next')).toBeNull();
    expect(picks.get('run')).toEqual(['web']);
    expect(readdirSync(root)).toEqual(['picks.json']);
  });

  it.each(['open', 'fsync'] as const)('keeps file and cache aligned and logs a post-rename directory %s failure', (operation) => {
    const file = join(scratch(), 'picks.json');
    const picks = new RunSourcePicks(file);
    picks.set('run', ['web']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fail = () => { throw new Error('directory sync failed'); };
    if (operation === 'open') vi.mocked(openSync).mockImplementationOnce(fail);
    else vi.mocked(fsyncSync).mockImplementationOnce(fail);
    expect(() => picks.set('other', ['jira'])).not.toThrow();
    expect(warn).toHaveBeenCalledWith('run source picks: directory sync failed after replacement');
    expect(picks.get('other')).toEqual(['jira']);
    expect(picks.get('run')).toEqual(['web']);
    expect(new RunSourcePicks(file).get('other')).toEqual(picks.get('other'));
    // A later write must preserve both picks already committed on disk.
    picks.set('next', []);
    expect(new RunSourcePicks(file).get('other')).toEqual(['jira']);
    expect(new RunSourcePicks(file).get('run')).toEqual(['web']);
    expect(readdirSync(join(file, '..'))).toEqual(['picks.json']);
  });
});
