// `GET /search`'s service (search-routes.ts `SearchService`): the lazy first read, index maintenance
// from engine frames and from the daemon's own writes, the sources' mapping onto hits, unavailable
// sources, the first-read wait, and a huge transcript that must not hang a query.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SearchService, parseTypes, type SearchServiceDeps } from '../src/api/search-routes.js';
import type { CoreEvent, SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const ALL = ['run', 'project', 'repo', 'transcript', 'rule', 'memory', 'doc'] as const;

function view(id: string, problem: string, units: Array<{ ord: number; description: string; status: string }> = [], extra: Record<string, unknown> = {}): SessionView {
  return {
    session: { id, problem, status: 'completed', workflow_id: 'build', repo_ref: null, archived_at: null, ...extra },
    units: units.map((u) => ({ id: `${id}:u${u.ord}`, session_id: id, ord: u.ord, description: u.description, status: u.status })),
  } as unknown as SessionView;
}

const frame = (f: Record<string, unknown>): CoreEvent => f as unknown as CoreEvent;

async function waitFor(pred: () => boolean | Promise<boolean>, label: string, ms = 4_000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const scratches: string[] = [];
const services: SearchService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of scratches.splice(0)) removeScratch(d);
});

function make(over: Record<string, unknown> = {}): { svc: SearchService; deps: Record<"sessionsDetail" | "workOutput" | "projectList" | "listRepos" | "listRules" | "memories" | "docs", Mock> & Record<string, Mock>; runs: SessionView[]; chats: string } {
  const runs: SessionView[] = [
    view('r-upload', 'add rate-limiting to the upload endpoint', [{ ord: 0, description: 'Build', status: 'done' }]),
    view('r-auth', 'refactor the auth middleware', [], { archived_at: 5 }),
  ];
  const chats = mkdtempSync(join(tmpdir(), 'search-chats-'));
  scratches.push(chats);
  const deps = {
    sessionsDetail: vi.fn(async () => runs),
    workOutput: vi.fn(async (unitId: string) => (unitId === 'r-upload:u0' ? 'Added a token bucket limiter in upload.ts' : null)),
    projectList: vi.fn(async () => [
      { id: 'default', name: 'Unfiled', description: null, status: 'active', scope: '', created_at: 1, updated_at: 1 },
      { id: 'p-up', name: 'upload-endpoint', description: 'Rate limits', status: 'active', scope: 'project:p-up', created_at: 1, updated_at: 2 },
    ]),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'upload-api', root_path: '/src/upload-api', default_branch: 'main', registered_at: 1_700_000_000 }]),
    listRules: vi.fn(async () => [
      { id: 'POL-1', rule_type: 'policy', statement: 'Every upload endpoint is rate limited', severity: 'error', confidence: 1, targets: {}, provenance: { source: 's', source_kinds: [] }, steering_type: 'security' },
      { id: 'POL-2', rule_type: 'policy', statement: 'Old upload rule', severity: 'warn', confidence: 1, targets: {}, provenance: { source: 's', source_kinds: [] }, retired: true },
    ]),
    memories: vi.fn(async () => [{ id: 'm1', content: 'Uploads over 10 MB go to the bucket', tier: 'semantic', scope: 'project:p-up/notes', facets: { repo: 'studio-api' }, created_at: 1_700_000_000 }]),
    docs: vi.fn(async () => [{ projectId: 'p-up', name: 'upload-design', kind: 'doc', head: 2, versions: 2, updatedAt: '2026-10-01T00:00:00Z', kinds: [], runs: [] }]),
    projectOf: (id: string) => (id === 'r-upload' ? 'p-up' : undefined),
    runFacts: { chatIdFor: () => undefined, createdAtFor: () => 1_700_000_000, endedAtFor: () => undefined },
    chatsDir: () => chats,
    debounceMs: 20,
    ...over,
  } as unknown as SearchServiceDeps;
  const svc = new SearchService(deps);
  services.push(svc);
  return { svc, deps: deps as unknown as Record<"sessionsDetail" | "workOutput" | "projectList" | "listRepos" | "listRules" | "memories" | "docs", Mock> & Record<string, Mock>, runs, chats };
}

describe('lazy', () => {
  it('reads nothing until the first search; frames and writes before it cost nothing', async () => {
    const { svc, deps } = make();
    svc.ingest(frame({ type: 'sessionStarted', session: 'r-x' }));
    svc.noteWrite('POST', '/api/v1/repos');
    await new Promise((r) => setTimeout(r, 60));
    for (const fn of ['sessionsDetail', 'projectList', 'listRepos', 'listRules', 'memories', 'docs', 'workOutput']) {
      expect(deps[fn], fn).not.toHaveBeenCalled();
    }
    await svc.search('upload', { types: ALL, limit: 5, offset: 0 });
    for (const fn of ['sessionsDetail', 'projectList', 'listRepos', 'listRules', 'memories', 'docs']) {
      expect(deps[fn], fn).toHaveBeenCalledTimes(1);
    }
  });

  it('reads only the sources the asked types need', async () => {
    const { svc, deps } = make();
    await svc.search('upload', { types: ['repo'], limit: 5, offset: 0 });
    expect(deps.listRepos).toHaveBeenCalledTimes(1);
    expect(deps.sessionsDetail).not.toHaveBeenCalled();
    expect(deps.memories).not.toHaveBeenCalled();
  });
});

describe('one query, every entity', () => {
  it('answers grouped by type with titles, spans, snippets and targets', async () => {
    const { svc } = make();
    await svc.search('upload', { types: ALL, limit: 5, offset: 0 });
    // The unit outputs are read after the run list (off the request): the next search sees them.
    await waitFor(() => svc.index.count('transcript') > 0, 'the unit output');
    const res = await svc.search('upload', { types: ALL, limit: 5, offset: 0 });
    expect(res.groups.map((g) => g.type)).toEqual(['run', 'project', 'repo', 'transcript', 'rule', 'memory', 'doc']);
    const by = Object.fromEntries(res.groups.map((g) => [g.type, g]));
    expect(by['run']!.hits[0]).toMatchObject({ id: 'r-upload', project_id: 'p-up', target: { kind: 'run', run_id: 'r-upload', chat_id: null } });
    expect(by['run']!.hits[0]!.title_spans.length).toBeGreaterThan(0);
    // Unfiled is not a project anyone searches for.
    expect(by['project']!.hits.map((h) => h.id)).toEqual(['p-up']);
    expect(by['repo']!.hits[0]).toMatchObject({ title: 'upload-api', target: { kind: 'repo', repo_id: 'repo-1' } });
    expect(by['transcript']!.hits[0]).toMatchObject({ id: 'unit:r-upload:0', title: 'Add rate-limiting to the upload endpoint · Build', target: { kind: 'unit', run_id: 'r-upload', ord: 0 } });
    expect(by['transcript']!.hits[0]!.snippet).toContain('upload.ts');
    // A retired rule still answers, after the live one, and says it is retired.
    expect(by['rule']!.hits.map((h) => [h.id, h.status])).toEqual([['POL-1', 'error'], ['POL-2', 'retired']]);
    expect(by['memory']!.hits[0]).toMatchObject({ id: 'm1', project_id: 'p-up', target: { kind: 'memory', memory_id: 'm1', scope: 'project:p-up/notes' } });
    expect(by['doc']!.hits[0]).toMatchObject({ id: 'p-up/upload-design', target: { kind: 'doc', project_id: 'p-up', doc: 'upload-design' } });
    expect(res.sources.every((s) => s.state === 'ready')).toBe(true);
    expect(res.partial).toBe(false);
  });

  it('a source that cannot be read is unavailable, with its reason; the others still answer', async () => {
    const { svc } = make({ memories: vi.fn(async () => { throw new Error('wicked-estate-mcp not found'); }) });
    const res = await svc.search('upload', { types: ['run', 'memory'], limit: 5, offset: 0 });
    expect(res.groups.map((g) => g.type)).toEqual(['run']);
    expect(res.sources.find((s) => s.type === 'memory')).toEqual({ type: 'memory', state: 'unavailable', indexed: 0, note: 'wicked-estate-mcp not found' });
  });

  it('a daemon with no memory source says so instead of searching nothing silently', async () => {
    const { svc } = make({ memories: undefined });
    const res = await svc.search('upload', { types: ['memory'], limit: 5, offset: 0 });
    expect(res.sources[0]).toMatchObject({ type: 'memory', state: 'unavailable' });
  });

  it('the first search waits only so long for a slow first read, then answers with it as indexing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc } = make({ firstReadWaitMs: 30, memories: vi.fn(async () => { await gate; return []; }) });
    const t0 = Date.now();
    const res = await svc.search('upload', { types: ['run', 'memory'], limit: 5, offset: 0 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(res.sources.find((s) => s.type === 'memory')!.state).toBe('indexing');
    expect(res.groups.map((g) => g.type)).toEqual(['run']);
    release();
  });

  it('an aborted query rejects (the client went away)', async () => {
    const { svc } = make();
    const ac = new AbortController();
    ac.abort(new Error('superseded'));
    await expect(svc.search('upload', { types: ['run'], limit: 5, offset: 0, signal: ac.signal })).rejects.toThrow('superseded');
  });
});

describe('keeping current', () => {
  it('a run lifecycle frame re-reads the run list (debounced, one read for a burst)', async () => {
    const { svc, deps, runs } = make();
    await svc.search('upload', { types: ['run'], limit: 5, offset: 0 });
    runs.push(view('r-new', 'ship the search modal'));
    for (let i = 0; i < 5; i += 1) svc.ingest(frame({ type: 'sessionStarted', session: 'r-new' }));
    await waitFor(() => svc.index.has('run', 'r-new'), 'the new run');
    expect(deps.sessionsDetail).toHaveBeenCalledTimes(2);
  });

  it('unitDone reads that unit output again (a retry replaced it); a run that leaves takes its outputs', async () => {
    const outputs: Record<string, string> = { 'r-upload:u0': 'first attempt' };
    const { svc, runs } = make({ workOutput: vi.fn(async (u: string) => outputs[u] ?? null) });
    await svc.search('attempt', { types: ['transcript'], limit: 5, offset: 0 });
    await waitFor(() => svc.index.has('transcript', 'unit:r-upload:0'), 'the first output');
    outputs['r-upload:u0'] = 'second try landed';
    svc.ingest(frame({ type: 'unitDone', session: 'r-upload', ord: 0 }));
    await waitFor(async () => (await svc.search('landed', { types: ['transcript'], limit: 5, offset: 0 })).groups.length === 1, 'the new output');
    runs.splice(0, runs.length);
    svc.ingest(frame({ type: 'sessionCompleted', session: 'r-upload' }));
    await waitFor(() => !svc.index.has('transcript', 'unit:r-upload:0'), 'the output to leave');
  });

  it('a chat reply re-reads that chat transcript; chatClosed drops it', async () => {
    const { svc, chats } = make();
    const file = join(chats, 'c1.jsonl');
    writeFileSync(file, `${JSON.stringify({ at: 1, turnId: 't', kind: 'user', text: 'how do uploads work?', seats: [] })}\n`);
    await svc.search('uploads', { types: ['transcript'], limit: 5, offset: 0 });
    expect(svc.index.has('transcript', 'chat:c1')).toBe(true);
    writeFileSync(file, `${JSON.stringify({ at: 2, turnId: 't', kind: 'seat', cliKey: 'codex', text: 'They stream to the bucket', ok: true })}\n`, { flag: 'a' });
    svc.ingest(frame({ type: 'chatReply', chat: 'c1', cliKey: 'codex', text: '…' }));
    await waitFor(async () => (await svc.search('stream bucket', { types: ['transcript'], limit: 5, offset: 0 })).groups.length === 1, 'the reply');
    const res = await svc.search('stream bucket', { types: ['transcript'], limit: 5, offset: 0 });
    expect(res.groups[0]!.hits).toHaveLength(1);
    expect(res.groups[0]!.hits[0]).toMatchObject({ id: 'chat:c1', title: 'How do uploads work?', target: { kind: 'chat', chat_id: 'c1' } });
    expect(res.groups[0]!.hits[0]!.snippet).toContain('codex: They stream to the bucket');
    svc.ingest(frame({ type: 'chatClosed', chat: 'c1' }));
    expect(svc.index.has('transcript', 'chat:c1')).toBe(false);
  });

  it('a successful write re-reads the sources its path can change, and only those', async () => {
    const { svc, deps } = make();
    await svc.search('upload', { types: ALL, limit: 5, offset: 0 });
    svc.noteWrite('POST', '/api/v1/repos');
    svc.noteWrite('PATCH', '/api/v1/projects/p-up?x=1');
    svc.noteWrite('POST', '/api/v1/governance/rules');
    svc.noteWrite('GET', '/api/v1/memory');
    await waitFor(() => deps.listRepos.mock.calls.length === 2 && deps.projectList.mock.calls.length === 2 && deps.listRules.mock.calls.length === 2, 're-reads');
    expect(deps.memories).toHaveBeenCalledTimes(1);
    expect(deps.docs).toHaveBeenCalledTimes(1);
  });

  it('a source past its TTL is re-read in the background by the next search', async () => {
    const { svc, deps } = make({ ttlMs: { repo: 0 } });
    await svc.search('upload', { types: ['repo'], limit: 5, offset: 0 });
    await new Promise((r) => setTimeout(r, 5));
    await svc.search('upload', { types: ['repo'], limit: 5, offset: 0 });
    await waitFor(() => deps.listRepos.mock.calls.length === 2, 'the TTL re-read');
  });
});

describe('a huge transcript', () => {
  it('an 8 MB unit output is indexed from its head and tail, and a query over it answers promptly', async () => {
    const huge = `START-MARK ${'log line with nothing in it\n'.repeat(300_000)} END-MARK`;
    expect(huge.length).toBeGreaterThan(8_000_000);
    const { svc } = make({ workOutput: vi.fn(async () => huge) });
    await svc.search('mark', { types: ['transcript'], limit: 5, offset: 0 });
    await waitFor(() => svc.index.has('transcript', 'unit:r-upload:0'), 'the huge output');
    expect(svc.index.chars('transcript')).toBeLessThanOrEqual(64 * 1024 + 8);
    const t0 = performance.now();
    for (const w of ['start-mark', 'end-mark']) {
      const res = await svc.search(w, { types: ['transcript'], limit: 5, offset: 0 });
      expect(res.groups[0]?.hits[0]?.id).toBe('unit:r-upload:0');
    }
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('parseTypes', () => {
  it('defaults to every type, refuses unknown ones, de-duplicates', () => {
    expect(parseTypes(undefined)).toEqual([...ALL]);
    expect(parseTypes('run, repo,run')).toEqual(['run', 'repo']);
    expect(parseTypes('run,widgets')).toBeNull();
  });
});
