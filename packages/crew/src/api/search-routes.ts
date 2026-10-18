/**
 * `GET /search` (api-types 0.127.0): one query over runs, projects, repos, transcripts (chat
 * transcripts and unit outputs), rules, memories and documents.
 *
 * The index ({@link SearchIndex}) is built LAZILY: nothing is read until the first search, and that
 * read runs off the request path — the first request waits a short while for it and answers with
 * the sources still reading marked `indexing`. After that the index follows the daemon:
 *  - engine frames: a run's lifecycle re-reads the run list (debounced), a finished unit's output is
 *    read once, a chat reply re-reads that chat's transcript, a closed chat leaves;
 *  - the daemon's own writes: a successful mutating request re-reads the sources its path can change
 *    (`noteWrite`), debounced;
 *  - sources written outside the daemon (memories, rules a worker lands, documents) are also re-read
 *    when a search finds them older than their TTL — in the background, never on the request.
 * A source that fails to read is `unavailable` with its reason; the others still answer.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import type {
  ConformanceRule, CoreEvent, InteractiveDocIndexRow, MemoryItem, Project, RepoEntry, SearchResponse,
  SearchSourceState, SearchType, SessionView, WorkUnit,
} from '../core/types.js';
import { API_PREFIX } from './api-prefix.js';
import { coreUnitId } from './evidence.js';
import { jobTitle } from './job-title.js';
import {
  MAX_QUERY_CHARS, MIN_QUERY_CHARS, SEARCH_TYPES, SearchIndex, parseQuery, type SearchDoc, type SearchIndexOptions,
} from './search-index.js';

/** The sources the service reads. `chat` and `unit` both feed the `transcript` type. */
type Source = 'run' | 'project' | 'repo' | 'chat' | 'rule' | 'memory' | 'doc';

const SOURCES_OF: Record<SearchType, Source[]> = {
  run: ['run'],
  project: ['project'],
  repo: ['repo'],
  transcript: ['chat', 'run'],
  rule: ['rule'],
  memory: ['memory'],
  doc: ['doc'],
};

/** How stale a source may get before a search re-reads it in the background (ms). */
const DEFAULT_TTL: Record<Source, number> = {
  run: 5 * 60_000,
  project: 60_000,
  repo: 60_000,
  chat: 60_000,
  rule: 60_000,
  memory: 5 * 60_000,
  doc: 2 * 60_000,
};

/** Engine frames that change the run list. */
const RUN_FRAMES: ReadonlySet<string> = new Set([
  'sessionStarted', 'unitPlanned', 'unitDistributed', 'unitDispatched', 'unitExecuting', 'gateDecided', 'unitDone',
  'unitDenied', 'awaitingHuman', 'resumed', 'runCancelled', 'sessionFailed', 'sessionCompleted', 'unitReassigned',
]);

/** The largest slice of a chat transcript file read (its head and tail). */
const CHAT_READ_BYTES = 2 * 1024 * 1024;
/** Unit outputs read per run-list load that the index has not tried yet (newest runs first). */
const UNIT_BACKFILL_MAX = 300;
/** Unit outputs read at once. */
const UNIT_CONCURRENCY = 2;

export interface SearchServiceDeps {
  sessionsDetail: () => Promise<SessionView[]>;
  workOutput: (unitId: string) => Promise<string | null>;
  projectList: () => Promise<Project[]>;
  listRepos: () => Promise<RepoEntry[]>;
  listRules: () => Promise<ConformanceRule[]>;
  /** The run→project and chat→project membership. */
  projectOf: (id: string) => string | undefined;
  /** What the daemon remembers about a run beyond the engine's row (unix SECONDS). */
  runFacts?: {
    chatIdFor(runId: string): string | undefined;
    createdAtFor(runId: string): number | undefined;
    endedAtFor(runId: string): number | undefined;
  };
  /** The chat transcript directory (`<id>.jsonl` per live chat); absent = no chat transcripts. */
  chatsDir?: () => string;
  /** The memory store (estate `memory.list`, shaped); absent = memories are not searched. */
  memories?: () => Promise<MemoryItem[]>;
  /** The documents index; absent = documents are not searched. */
  docs?: () => Promise<InteractiveDocIndexRow[]>;
  log?: (m: string) => void;
  index?: SearchIndexOptions;
  ttlMs?: Partial<Record<Source, number>>;
  /** Write/frame bursts coalesce for this long before a re-read (ms). */
  debounceMs?: number;
  /** How long the first search waits for a source's first read (ms). */
  firstReadWaitMs?: number;
  /** The query's hard time budget (ms). */
  budgetMs?: number;
}

interface SourceState {
  loadedAt: number | null;
  loading: Promise<void> | null;
  again: boolean;
  error: string | null;
  timer: NodeJS.Timeout | null;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const secondsToMs = (s: number | undefined): number | null => (s === undefined ? null : s * 1000);
const firstLine = (s: string, max: number): string => {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export class SearchService {
  readonly index: SearchIndex;
  private readonly deps: SearchServiceDeps;
  private readonly states = new Map<Source, SourceState>();
  /** Off until the first search: before it, frames and writes cost nothing. */
  private active = false;
  private closed = false;
  /** The last run list, for titling unit transcripts. */
  private runsById = new Map<string, SessionView>();
  /** Unit outputs read (or found empty) — a backfill does not read them again; a `unitDone` does. */
  private readonly unitsTried = new Set<string>();
  private readonly unitQueue: Array<{ runId: string; ord: number }> = [];
  private unitWorkers = 0;
  private readonly chatTimers = new Map<string, NodeJS.Timeout>();

  constructor(deps: SearchServiceDeps) {
    this.deps = deps;
    this.index = new SearchIndex(deps.index);
    for (const s of ['run', 'project', 'repo', 'chat', 'rule', 'memory', 'doc'] as const) {
      this.states.set(s, { loadedAt: null, loading: null, again: false, error: null, timer: null });
    }
  }

  private state(s: Source): SourceState {
    return this.states.get(s)!;
  }

  private ttl(s: Source): number {
    return this.deps.ttlMs?.[s] ?? DEFAULT_TTL[s];
  }

  /** Whether the source exists on this daemon. */
  private available(s: Source): boolean {
    if (s === 'chat') return this.deps.chatsDir !== undefined;
    if (s === 'memory') return this.deps.memories !== undefined;
    if (s === 'doc') return this.deps.docs !== undefined;
    return true;
  }

  close(): void {
    this.closed = true;
    for (const st of this.states.values()) if (st.timer !== null) clearTimeout(st.timer);
    for (const t of this.chatTimers.values()) clearTimeout(t);
    this.chatTimers.clear();
    this.unitQueue.length = 0;
  }

  // ── Keeping current ──────────────────────────────────────────────────────────────────────────

  /** One engine frame (the daemon's fan-in calls this for every frame; cheap until the first search). */
  ingest(event: CoreEvent): void {
    if (!this.active || this.closed) return;
    const f = event as CoreEvent & Record<string, unknown>;
    if (RUN_FRAMES.has(event.type)) this.markDirty('run');
    if ((event.type === 'unitDone' || event.type === 'unitDenied') && typeof f['session'] === 'string' && typeof f['ord'] === 'number') {
      this.enqueueUnit(f['session'], f['ord'], true);
    }
    if (event.type === 'chatReply' && typeof f['chat'] === 'string') this.markChat(f['chat']);
    if (event.type === 'chatClosed' && typeof f['chat'] === 'string') {
      const t = this.chatTimers.get(f['chat']);
      if (t !== undefined) clearTimeout(t);
      this.chatTimers.delete(f['chat']);
      this.index.remove('transcript', `chat:${f['chat']}`);
    }
  }

  /** A mutating request answered 2xx/3xx: re-read what its path can change. */
  noteWrite(method: string, url: string): void {
    if (!this.active || this.closed || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const path = (url.split('?')[0] ?? '').replace(API_PREFIX, '');
    const chat = /^\/chats\/([^/]+)\/messages$/.exec(path);
    if (chat !== null && chat[1] !== undefined) { this.markChat(decodeURIComponent(chat[1])); return; }
    const touched = new Set<Source>();
    if (path.startsWith('/projects')) { touched.add('project'); touched.add('run'); if (path.includes('/interactive')) touched.add('doc'); }
    if (path.startsWith('/repos')) touched.add('repo');
    if (path.startsWith('/runs')) touched.add('run');
    if (path.startsWith('/interactive')) touched.add('doc');
    if (path.startsWith('/memory')) touched.add('memory');
    if (/^\/(proposals|decisions)/.test(path)) { touched.add('memory'); touched.add('rule'); }
    if (/^\/(governance|steering|policies|rules|editors)/.test(path)) touched.add('rule');
    for (const s of touched) this.markDirty(s);
  }

  private markDirty(s: Source): void {
    const st = this.state(s);
    if (st.loadedAt === null && st.loading === null) return; // never read: the first search reads it
    // Already scheduled: that re-read will see this change too. (Never pushed back, so a steady stream
    // of frames cannot starve it: a change waits at most one debounce.)
    if (st.timer !== null) return;
    st.timer = setTimeout(() => { st.timer = null; void this.refresh(s); }, this.deps.debounceMs ?? 400);
    st.timer.unref?.();
  }

  private markChat(chatId: string): void {
    if (!this.available('chat')) return;
    if (this.chatTimers.has(chatId)) return; // the scheduled read will see this reply too
    const t = setTimeout(() => {
      this.chatTimers.delete(chatId);
      void this.readChat(chatId).catch((err) => this.deps.log?.(`[search] chat ${chatId} transcript unread: ${message(err)}`));
    }, this.deps.debounceMs ?? 400);
    t.unref?.();
    this.chatTimers.set(chatId, t);
  }

  /** Re-read one source (coalesced: a refresh asked for mid-read runs once more after it). */
  private refresh(s: Source): Promise<void> {
    const st = this.state(s);
    if (this.closed || !this.available(s)) return Promise.resolve();
    if (st.loading !== null) { st.again = true; return st.loading; }
    st.loading = (async () => {
      try {
        await this.load(s);
        st.error = null;
      } catch (err) {
        st.error = message(err);
        this.deps.log?.(`[search] ${s} not readable: ${st.error}`);
      } finally {
        st.loadedAt = Date.now();
        st.loading = null;
      }
      if (st.again && !this.closed) { st.again = false; await this.refresh(s); }
    })();
    return st.loading;
  }

  /** Before a query: read what was never read, re-read what is past its TTL (both off the request). */
  private ensure(types: readonly SearchType[]): Promise<void>[] {
    this.active = true;
    const first: Promise<void>[] = [];
    const seen = new Set<Source>();
    for (const t of types) {
      for (const s of SOURCES_OF[t]) {
        if (seen.has(s) || !this.available(s)) continue;
        seen.add(s);
        const st = this.state(s);
        if (st.loadedAt === null) first.push(st.loading ?? this.refresh(s));
        else if (st.loading === null && Date.now() - st.loadedAt > this.ttl(s)) void this.refresh(s);
      }
    }
    return first;
  }

  // ── The sources ──────────────────────────────────────────────────────────────────────────────

  private async load(s: Source): Promise<void> {
    switch (s) {
      case 'run': return this.loadRuns();
      case 'project': {
        const projects = await this.deps.projectList();
        this.index.replaceType('project', projects.filter((p) => p.id !== 'default').map((p) => ({
          type: 'project', id: p.id, title: p.name, body: p.description ?? '',
          updatedAt: p.updated_at, projectId: p.id, status: p.status,
          target: { kind: 'project', project_id: p.id }, boost: p.status === 'active' ? 0 : -3,
        })));
        return;
      }
      case 'repo': {
        const repos = await this.deps.listRepos();
        this.index.replaceType('repo', repos.map((r) => ({
          type: 'repo', id: r.id, title: r.name,
          body: [r.root_path, r.git_url ?? '', r.default_branch].filter((x) => x !== '').join('\n'),
          updatedAt: r.registered_at > 1e12 ? r.registered_at : r.registered_at * 1000, projectId: null, status: null,
          target: { kind: 'repo', repo_id: r.id },
        })));
        return;
      }
      case 'rule': {
        const rules = await this.deps.listRules();
        this.index.replaceType('rule', rules.map((r): SearchDoc => ({
          type: 'rule', id: r.id, title: firstLine(r.statement, 140) || r.id,
          body: [r.statement, r.criteria ?? '', ...(r.obligations ?? []), r.id, r.steering_type ?? '', r.rule_type].filter((x) => x !== '').join('\n'),
          updatedAt: r.created_at !== undefined ? r.created_at * 1000 : null,
          projectId: r.targets.project ?? null,
          status: r.retired === true ? 'retired' : r.severity,
          target: { kind: 'rule', rule_id: r.id, steering_type: r.steering_type ?? null },
          boost: r.retired === true ? -4 : 0,
        })));
        return;
      }
      case 'memory': {
        const items = await this.deps.memories!();
        this.index.replaceType('memory', items.map((m): SearchDoc => ({
          type: 'memory', id: m.id, title: firstLine(m.content, 140) || m.id,
          body: [m.content, ...Object.entries(m.facets).map(([k, v]) => `${k}:${v}`), m.tier].join('\n'),
          updatedAt: m.created_at !== undefined && m.created_at !== null ? m.created_at * 1000 : null,
          projectId: /(?:^|\/)project:([^/]+)/.exec(m.scope)?.[1] ?? null,
          status: m.tier,
          target: { kind: 'memory', memory_id: m.id, scope: m.scope },
        })));
        return;
      }
      case 'doc': {
        const rows = await this.deps.docs!();
        this.index.replaceType('doc', rows.filter((d) => d.retired !== true).map((d): SearchDoc => {
          const at = d.updatedAt !== null ? Date.parse(d.updatedAt) : NaN;
          return {
            type: 'doc', id: `${d.projectId}/${d.name}`, title: d.name,
            body: [d.name.replace(/[-_.]+/g, ' '), d.kind].join('\n'),
            updatedAt: Number.isFinite(at) ? at : null, projectId: d.projectId === 'default' ? null : d.projectId,
            status: d.kind, target: { kind: 'doc', project_id: d.projectId, doc: d.name },
          };
        }));
        return;
      }
      case 'chat': return this.loadChats();
    }
  }

  private runUpdatedAt(id: string): number | null {
    return secondsToMs(this.deps.runFacts?.endedAtFor(id) ?? this.deps.runFacts?.createdAtFor(id));
  }

  private async loadRuns(): Promise<void> {
    const views = await this.deps.sessionsDetail();
    this.runsById = new Map(views.map((v) => [v.session.id, v]));
    this.index.replaceType('run', views.map((v): SearchDoc => {
      const s = v.session;
      const archived = s.archived_at !== null && s.archived_at !== undefined;
      const unitText = v.units.flatMap((u) => [u.description, u.denial_reason ?? '']).filter((x) => x !== '');
      return {
        type: 'run', id: s.id, title: jobTitle(s.problem) || s.id,
        body: [s.problem, ...unitText, s.workflow_id ?? '', s.repo_ref ?? '', s.id].filter((x) => x !== '').join('\n'),
        updatedAt: this.runUpdatedAt(s.id), projectId: this.deps.projectOf(s.id) ?? null,
        status: archived ? 'archived' : s.status,
        target: { kind: 'run', run_id: s.id, chat_id: this.deps.runFacts?.chatIdFor(s.id) ?? null },
        boost: archived ? -3 : 0,
      };
    }));
    // A run that left the list takes its unit transcripts with it.
    this.index.removeWhere('transcript', (id) => id.startsWith('unit:') && !this.runsById.has(id.slice(5, id.lastIndexOf(':'))));
    // Backfill: outputs of finished units not read yet, newest runs first, bounded per load.
    const newest = [...views].sort((a, b) => (this.runUpdatedAt(b.session.id) ?? 0) - (this.runUpdatedAt(a.session.id) ?? 0));
    let queued = 0;
    for (const v of newest) {
      for (const u of v.units) {
        if (queued >= UNIT_BACKFILL_MAX) break;
        if (u.status !== 'done' && u.status !== 'rejected') continue;
        if (this.unitsTried.has(`${v.session.id}:${u.ord}`)) continue;
        this.enqueueUnit(v.session.id, u.ord, false);
        queued += 1;
      }
    }
  }

  private enqueueUnit(runId: string, ord: number, again: boolean): void {
    const key = `${runId}:${ord}`;
    if (again) this.unitsTried.delete(key);
    if (this.unitsTried.has(key) || this.unitQueue.some((q) => q.runId === runId && q.ord === ord)) return;
    this.unitQueue.push({ runId, ord });
    this.drainUnits();
  }

  private drainUnits(): void {
    while (this.unitWorkers < UNIT_CONCURRENCY && this.unitQueue.length > 0 && !this.closed) {
      const next = this.unitQueue.shift()!;
      this.unitWorkers += 1;
      void this.readUnit(next.runId, next.ord)
        .catch((err) => this.deps.log?.(`[search] unit ${next.runId}:${next.ord} output unread: ${message(err)}`))
        .finally(() => { this.unitWorkers -= 1; this.drainUnits(); });
    }
  }

  private async readUnit(runId: string, ord: number): Promise<void> {
    this.unitsTried.add(`${runId}:${ord}`);
    const view = this.runsById.get(runId);
    const unit: WorkUnit | undefined = view?.units.find((u) => u.ord === ord);
    const unitId = unit !== undefined ? coreUnitId(runId, unit) : `${runId}:u${ord}`;
    const output = await this.deps.workOutput(unitId);
    const id = `unit:${runId}:${ord}`;
    if (output === null || output.trim() === '') { this.index.remove('transcript', id); return; }
    const runTitle = view !== undefined ? jobTitle(view.session.problem) || runId : runId;
    this.index.upsert({
      type: 'transcript', id,
      title: `${runTitle} · ${unit?.description.trim() || `step ${ord + 1}`}`,
      body: output,
      updatedAt: this.runUpdatedAt(runId), projectId: this.deps.projectOf(runId) ?? null,
      status: unit?.status ?? null,
      target: { kind: 'unit', run_id: runId, ord, chat_id: this.deps.runFacts?.chatIdFor(runId) ?? null },
    });
  }

  private async loadChats(): Promise<void> {
    const dir = this.deps.chatsDir!();
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') files = [];
      else throw err;
    }
    const live = new Set(files.map((f) => f.slice(0, -6)));
    this.index.removeWhere('transcript', (id) => id.startsWith('chat:') && !live.has(id.slice(5)));
    for (const chatId of live) await this.readChat(chatId);
  }

  /** One chat's transcript file: its head and tail (bounded), as one entity. */
  private async readChat(chatId: string): Promise<void> {
    if (this.closed || !/^[A-Za-z0-9._-]+$/.test(chatId)) return;
    const file = join(this.deps.chatsDir!(), `${chatId}.jsonl`);
    let text: string;
    try {
      const size = (await stat(file)).size;
      const fh = await open(file, 'r');
      try {
        if (size <= CHAT_READ_BYTES) {
          text = (await fh.readFile('utf8'));
        } else {
          const half = CHAT_READ_BYTES / 2;
          const head = Buffer.alloc(half);
          const tail = Buffer.alloc(half);
          await fh.read(head, 0, half, 0);
          await fh.read(tail, 0, half, size - half);
          // Cut lines are dropped: the head's last and the tail's first.
          const h = head.toString('utf8');
          const t = tail.toString('utf8');
          text = `${h.slice(0, h.lastIndexOf('\n'))}\n${t.slice(t.indexOf('\n') + 1)}`;
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { this.index.remove('transcript', `chat:${chatId}`); return; }
      throw err;
    }
    let title = '';
    let last: number | null = null;
    const parts: string[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (typeof rec['at'] === 'number') last = rec['at'];
      const said = typeof rec['text'] === 'string' ? rec['text'] : '';
      if (said === '') continue;
      if (rec['kind'] === 'user') {
        if (title === '') title = jobTitle(said);
        parts.push(said);
      } else if (rec['kind'] === 'seat') {
        parts.push(`${typeof rec['cliKey'] === 'string' ? rec['cliKey'] : 'agent'}: ${said}`);
      }
    }
    if (parts.length === 0) { this.index.remove('transcript', `chat:${chatId}`); return; }
    this.index.upsert({
      type: 'transcript', id: `chat:${chatId}`, title: title || 'A chat', body: parts.join('\n'),
      updatedAt: last, projectId: this.deps.projectOf(chatId) ?? null, status: 'chat',
      target: { kind: 'chat', chat_id: chatId },
    });
  }

  // ── The query ────────────────────────────────────────────────────────────────────────────────

  async search(q: string, opts: { types: readonly SearchType[]; limit: number; offset: number; signal?: AbortSignal }): Promise<SearchResponse> {
    const started = performance.now();
    const budget = this.deps.budgetMs ?? 300;
    const first = this.ensure(opts.types);
    if (first.length > 0) {
      // The first read is off the request path: wait for it a little, then answer with what is in.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(first),
        new Promise<void>((r) => { timer = setTimeout(r, Math.min(this.deps.firstReadWaitMs ?? 1500, budget * 5)); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.throwIfAborted();
    }
    const parsed = parseQuery(q);
    const searchable = opts.types.filter((t) => SOURCES_OF[t].some((s) => this.available(s) && this.state(s).loadedAt !== null));
    const { groups, partial } = await this.index.query(parsed, {
      types: searchable, limit: opts.limit, offset: opts.offset,
      budgetMs: Math.max(1, budget - (performance.now() - started)),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const sources: SearchSourceState[] = opts.types.map((type) => this.sourceState(type));
    return { query: parsed.text, groups, sources, partial, took_ms: Math.round(performance.now() - started) };
  }

  private sourceState(type: SearchType): SearchSourceState {
    const srcs = SOURCES_OF[type].filter((s) => this.available(s));
    if (srcs.length === 0) return { type, state: 'unavailable', indexed: 0, note: 'This daemon has no source for it.' };
    const sts = srcs.map((s) => this.state(s));
    const indexed = this.index.count(type);
    if (sts.some((st) => st.loadedAt === null)) return { type, state: 'indexing', indexed, note: null };
    // Unit outputs are read after the run list, a few at a time: until the queue drains, more may come.
    if (type === 'transcript' && (this.unitQueue.length > 0 || this.unitWorkers > 0)) return { type, state: 'indexing', indexed, note: null };
    const failed = sts.find((st) => st.error !== null);
    // A source that failed but still holds an earlier read answers from it, and says so.
    if (failed !== undefined && indexed === 0) return { type, state: 'unavailable', indexed, note: failed.error };
    return { type, state: 'ready', indexed, note: failed !== undefined ? `Showing the last read: ${failed.error}` : null };
  }
}

/** Parse `types`: comma-separated; unknown → `null`. */
export function parseTypes(raw: string | undefined): SearchType[] | null {
  if (raw === undefined || raw.trim() === '') return [...SEARCH_TYPES];
  const out: SearchType[] = [];
  for (const t of raw.split(',').map((x) => x.trim()).filter((x) => x !== '')) {
    if (!(SEARCH_TYPES as readonly string[]).includes(t)) return null;
    if (!out.includes(t as SearchType)) out.push(t as SearchType);
  }
  return out.length > 0 ? out : null;
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function registerSearchRoutes(app: FastifyInstance, service: SearchService): void {
  // Writes keep the index current: a successful mutating request re-reads what its path can change.
  app.addHook('onResponse', (req, reply, done) => {
    if (reply.statusCode < 400) service.noteWrite(req.method, req.url);
    done();
  });
  app.addHook('onClose', async () => { service.close(); });

  app.get(
    `${API_PREFIX}/search`,
    { config: { manifest: { responseType: 'SearchResponse', statusCodes: [200, 400] } } },
    async (req, reply) => {
      const qs = req.query as Record<string, string | string[] | undefined>;
      const q = (one(qs['q']) ?? '').trim();
      if (q.length < MIN_QUERY_CHARS) return reply.code(400).send({ error: `\`q\` needs at least ${MIN_QUERY_CHARS} characters` });
      if (q.length > MAX_QUERY_CHARS) return reply.code(400).send({ error: `\`q\` is longer than ${MAX_QUERY_CHARS} characters` });
      const types = parseTypes(one(qs['types']));
      if (types === null) return reply.code(400).send({ error: `\`types\` must be a comma-separated list of: ${SEARCH_TYPES.join(', ')}` });
      const rawLimit = one(qs['limit']);
      const limit = rawLimit === undefined || rawLimit === '' ? 5 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return reply.code(400).send({ error: '`limit` must be an integer from 1 to 50' });
      const cursor = one(qs['cursor']);
      let offset = 0;
      if (cursor !== undefined && cursor !== '') {
        if (types.length !== 1) return reply.code(400).send({ error: '`cursor` pages one type: pass exactly one in `types`' });
        offset = Number(cursor);
        if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) return reply.code(400).send({ error: '`cursor` is not a cursor this endpoint gave' });
      }
      // A client that goes away (a superseded query) stops the scan.
      const ac = new AbortController();
      const onClose = (): void => { if (!reply.raw.writableEnded) ac.abort(new Error('client closed')); };
      reply.raw.once('close', onClose);
      try {
        return await service.search(q, { types, limit, offset, signal: ac.signal });
      } catch (err) {
        // Nobody is listening: hand the (closed) socket back instead of answering it.
        if (ac.signal.aborted) { reply.hijack(); return undefined; }
        throw err;
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );
}
