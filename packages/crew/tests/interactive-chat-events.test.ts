// The interactive-chat seam (CREW-UX-5 — the doc thread's iteration ask).
//
// What these tests pin, and why:
//  - the TRIGGER contract, layered: (a) only `role: "user"` chat.posted frames are asks —
//    agent narration echoes ride the same topic; (b) the doc must exist under the resolved
//    docs root with `kind: "source"` — demo docs and unknown docs are never answered;
//    (c) per-doc serialization — an ask on a doc whose run is in flight QUEUES (FIFO),
//    including runs the sibling draft/edit seams report via `isDocBusy`; (d) the feedback
//    overlay's machine-composed batch echo is NOT an ask (its work rides feedback.submitted);
//  - the WORKER contract: single-line problem (PTY, wicked-core FINDING-011) naming the ask,
//    the CURRENT-version snapshot to read, and the exact output path; the snapshot is COPIED
//    into the chat inbox at LAUNCH time so a queued second ask iterates on what the first
//    landed (J3 "iterate twice") and the one declared write root covers input + deliverable;
//    a repo-bound project's ask launches EXACTLY like an unfiled one — no repoRef, no repo
//    snapshot, no grounding clause (CREW-UX-8 v5 SPLIT: the draft leg keeps its proven
//    snapshot grounding, but the grounded REVISE turn wedged 2/2 on the real engine —
//    crew#288 comment — while ungrounded revisions are proven to land; grounding returns
//    when wicked-core#293 or #294 is fixed);
//  - IDEMPOTENCY: the durable ledger keys the ASK (source_message_id when present, else the
//    bus event_id), a replayed/resent ask launches no second run, and the announce carries a
//    deterministic idempotency key;
//  - the LOOP: a real (temp-file) wicked-bus carries chat.posted in and status.posted /
//    draft.completed back out, stamped `wi-crew` — the SAME announce wire the first draft
//    rides, so the service lands the revision as a generated version. The engine is faked.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_POSTED,
  INTERACTIVE_CHAT_BUS_FILTER,
  INTERACTIVE_CHAT_BUS_PLUGIN,
  INTERACTIVE_CHAT_WORKFLOW,
  INTERACTIVE_CHAT_WORKFLOW_DEF,
  parseChatPosted,
  isIterationAsk,
  chatKey,
  chatIdempotencyKey,
  readDocHead,
  isAnswerableDocKind,
  chatProblem,
  startInteractiveChatSubscriber,
} from '../src/interactive/chat-events.js';
import { DRAFT_COMPLETED, STATUS_POSTED, INTERACTIVE_PRODUCER } from '../src/interactive/draft-events.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../src/core/types.js';

describe('parseChatPosted', () => {
  const payload = {
    role: 'user',
    text: 'Make the intro punchier and add a closing summary.',
    document_id: 'q3-board-deck',
    source_message_id: 'm-17',
    ts: '2026-08-20T00:00:00Z',
  };

  it('accepts a user ask and carries text/sourceMessageId/projectId', () => {
    expect(parseChatPosted(CHAT_POSTED, { ...payload, project_id: 'proj-7' })).toEqual({
      documentId: 'q3-board-deck',
      text: 'Make the intro punchier and add a closing summary.',
      sourceMessageId: 'm-17',
      projectId: 'proj-7',
    });
  });

  it('REJECTS non-user roles — agent narration echoes ride the same topic (contract a)', () => {
    expect(parseChatPosted(CHAT_POSTED, { ...payload, role: 'agent' })).toBeNull();
    expect(parseChatPosted(CHAT_POSTED, { ...payload, role: 'assistant' })).toBeNull();
    expect(parseChatPosted(CHAT_POSTED, { ...payload, role: undefined })).toBeNull();
  });

  it('ignores other event types, malformed payloads, slug-invalid ids, and empty text', () => {
    expect(parseChatPosted('wicked.interactive.doc.created', payload)).toBeNull();
    expect(parseChatPosted(CHAT_POSTED, 'not-an-object')).toBeNull();
    expect(parseChatPosted(CHAT_POSTED, { ...payload, document_id: '../escape' })).toBeNull();
    expect(parseChatPosted(CHAT_POSTED, { ...payload, text: '' })).toBeNull();
    expect(parseChatPosted(CHAT_POSTED, { ...payload, text: '   \n ' })).toBeNull();
    expect(parseChatPosted(CHAT_POSTED, { ...payload, text: 42 })).toBeNull();
  });

  it('treats empty/absent source_message_id and project_id as absent, never fabricated', () => {
    const bare = parseChatPosted(CHAT_POSTED, {
      role: 'user',
      text: 'shorter please',
      document_id: 'a-doc',
      source_message_id: '',
    });
    expect(bare).toEqual({ documentId: 'a-doc', text: 'shorter please' });
    expect(bare && 'sourceMessageId' in bare).toBe(false);
    expect(bare && 'projectId' in bare).toBe(false);
  });
});

describe('isIterationAsk (contract d — the feedback-batch echo is not an ask)', () => {
  it('rejects the feedback overlay batch echo (studio composeBatchMessage shape)', () => {
    expect(isIterationAsk('Feedback on 1 place in this document:\n1. [w-3] fix the typo')).toBe(false);
    expect(isIterationAsk('Feedback on 4 places in the Q3 deck:\n1. [a] x')).toBe(false);
    expect(isIterationAsk('  feedback on 2 places in it: stuff')).toBe(false);
  });

  it('accepts real conversational asks — including ones that MENTION feedback', () => {
    expect(isIterationAsk('Make the intro punchier.')).toBe(true);
    expect(isIterationAsk('Add a feedback form at the bottom')).toBe(true);
    expect(isIterationAsk('I have feedback on 3 charts — make them bar charts')).toBe(true);
  });
});

describe('chatKey / chatIdempotencyKey (the dedupe unit is the ASK, never the doc lifetime)', () => {
  it('keys by source_message_id when present — a studio resend reuses the id, so it dedupes', () => {
    expect(chatKey('my-doc', 41, 'm-17')).toBe('my-doc:m:m-17');
    expect(chatKey('my-doc', 99, 'm-17')).toBe(chatKey('my-doc', 41, 'm-17'));
  });

  it('falls back to the bus event_id (pure redelivery) and stays deterministic', () => {
    expect(chatKey('my-doc', 41)).toBe('my-doc:e:41');
    expect(chatIdempotencyKey('my-doc', 41)).toBe('crew:interactive.chat:my-doc:e:41');
    expect(chatIdempotencyKey('my-doc', 41, 'm-17')).toBe('crew:interactive.chat:my-doc:m:m-17');
  });
});

describe('readDocHead (contract b — the versions.json read)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-ich-root-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedDoc(name: string, manifest: unknown): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'versions.json'), JSON.stringify(manifest), 'utf8');
    return dir;
  }

  it('resolves kind, head, and the head html path from the manifest', () => {
    seedDoc('my-doc', {
      kind: 'source',
      head: 2,
      versions: [
        { version: 0, html_file: '_v0.html' },
        { version: 2, html_file: '_v2.html' },
      ],
    });
    expect(readDocHead(root, 'my-doc')).toEqual({
      kind: 'source',
      head: 2,
      headHtmlPath: join(root, 'my-doc', '_v2.html'),
    });
  });

  it("defaults kind to 'doc' when absent (interactive's own listDocs rule) — the REAL source-doc shape, which PASSES the gate", () => {
    // Interactive's initManifest records kind ONLY for demo docs: a genuine kind:"source" doc's
    // versions.json carries no kind field at all (verified against interactive 0.8.0 + main).
    seedDoc('real-source-doc', { head: 0, versions: [{ version: 0, html_file: '_v0.html' }] });
    expect(readDocHead(root, 'real-source-doc')?.kind).toBe('doc');
    expect(isAnswerableDocKind('doc')).toBe(true);
    expect(isAnswerableDocKind('source')).toBe(true);
    expect(isAnswerableDocKind('demo')).toBe(false);
    expect(isAnswerableDocKind('storyboard')).toBe(false);
  });

  it('falls back to the _v{head}.html spelling when the head entry is missing', () => {
    seedDoc('thin-doc', { kind: 'source', head: 3, versions: [] });
    expect(readDocHead(root, 'thin-doc')?.headHtmlPath).toBe(join(root, 'thin-doc', '_v3.html'));
  });

  it('returns null for unknown docs, malformed manifests, bad heads, and slug-invalid ids', () => {
    expect(readDocHead(root, 'never-created')).toBeNull();
    seedDoc('broken-doc', 'not-a-manifest' as unknown);
    // (the string was JSON.stringified — still parses to a string, not an object shape)
    expect(readDocHead(root, 'broken-doc')).toBeNull();
    seedDoc('bad-head', { kind: 'source', head: 'two', versions: [] });
    expect(readDocHead(root, 'bad-head')).toBeNull();
    expect(readDocHead(root, '../escape')).toBeNull();
  });
});

describe('chatProblem (the worker prompt seed)', () => {
  const ask = {
    documentId: 'my-doc',
    text: 'make it\nshorter\n\tand bolder',
    sourceMessageId: 'm-1',
  };

  it('is ALWAYS single-line — a PTY seat refuses embedded newlines (FINDING-011)', () => {
    const problem = chatProblem(ask, '/in/current.html', '/out/revised.html');
    expect(problem).not.toMatch(/[\n\r\t]/);
    expect(problem).toContain('make it shorter and bolder');
  });

  it('names the document, the CURRENT-version snapshot to read, and the exact output path', () => {
    const problem = chatProblem(ask, '/tmp/chats/k-current.html', '/tmp/chats/k-revised.html');
    expect(problem).toContain('"my-doc"');
    expect(problem).toContain('read it first: /tmp/chats/k-current.html');
    expect(problem).toContain('exactly this absolute file path: /tmp/chats/k-revised.html');
  });

  it('caps a pasted-novel ask instead of ballooning the prompt', () => {
    const big = chatProblem({ ...ask, text: 'x'.repeat(10_000) }, '/i', '/o');
    expect(big.length).toBeLessThan(2500);
    expect(big).toContain('…');
  });

  it('carries NO repo-grounding clause — the revision prompt is the proven CREW-UX-5 shape (CREW-UX-8 v5 split)', () => {
    // The draft leg grounds its v1 in a repo snapshot (proven live); the SAME grounded prompt
    // on the REVISE turn wedged 2/2 on the real engine (crew#288 comment — the repo-grounded
    // revise turn hits the known second-turn wedge), while ungrounded revisions are proven to
    // land (the CREW-UX-5 verification). Grounding returns when wicked-core#293 or #294 is fixed.
    const problem = chatProblem(ask, '/i/current.html', '/tmp/chats/k-revised.html');
    expect(problem).not.toContain('Ground the revision');
    expect(problem).not.toContain('repository snapshot');
    expect(problem).toContain('read it first: /i/current.html');
    expect(problem).toContain('exactly this absolute file path: /tmp/chats/k-revised.html');
    expect(problem).not.toMatch(/[\n\r\t]/);
  });
});

describe('the interactive-chat workflow def (workflows-as-data)', () => {
  const def = INTERACTIVE_CHAT_WORKFLOW_DEF;

  it('is understand → revise, creator-role build second, unique phase ids', () => {
    expect(def.id).toBe(INTERACTIVE_CHAT_WORKFLOW);
    expect(def.phases.map((p) => p.id)).toEqual(['understand', 'revise']);
    expect(def.phases[1]?.role).toBe('creator');
    expect(def.phases[1]?.depends_on).toEqual(['understand']);
  });

  it('keeps every phase instruction single-line (the same PTY constraint as the problem)', () => {
    for (const p of def.phases) {
      expect(p.instructions ?? '').not.toMatch(/[\n\r]/);
      expect((p.instructions ?? '').length).toBeGreaterThan(0);
    }
  });

  it('arms no human gate and no validator floor — the acceptance gate is the canvas', () => {
    for (const p of def.phases) {
      expect(p.gate).toBe('auto');
      expect(p.validator_pin).toBeNull();
      expect(p.required_deliverables).toEqual([]);
    }
  });

  it('carries the ITERATION contract: start from the current doc, keep data-wids, mint none', () => {
    const revise = def.phases[1]?.instructions ?? '';
    expect(revise).toMatch(/KEEP every existing data-wid/i);
    expect(revise).toMatch(/add NO data-wid/i);
    expect(revise).toContain('self-contained HTML');
    expect(revise).toMatch(/never fabricate/i);
    expect(revise).toMatch(/change only what the ask touches/i);
  });
});

describe('bus identity constants', () => {
  it('subscribes on an exact-type, domain-guarded filter under a dedicated plugin name', () => {
    expect(INTERACTIVE_CHAT_BUS_FILTER).toBe('wicked.interactive.chat.posted@wicked-interactive');
    // NOT the draft/edit seams' plugins — independent cursors, independently stoppable.
    expect(INTERACTIVE_CHAT_BUS_PLUGIN).toBe('wicked-crew-interactive-chat');
  });
});

// ── The loop over a real (temp) bus, with a fake engine ─────────────────────────────────────

interface FakeAdapter {
  launches: LaunchRunInput[];
  registered: WorkflowDef[];
  fire: (event: CoreEvent) => void;
  asAdapter(): CoreAdapter;
}

/** Optional project→repo world: projectMembers/listRepos answer from these fixtures. The
 *  CREW-UX-8 v5 split means the chat seam must IGNORE this world entirely (the revision leg
 *  launches ungrounded) — the repo-backed test seeds it precisely to prove that. */
interface RepoWorld {
  members?: Record<string, Array<{ member_kind: string; member_ref: string }>>;
  repos?: Array<{ id: string; root_path: string }>;
}

function fakeAdapter(repoWorld?: RepoWorld): FakeAdapter {
  const listeners = new Set<(e: CoreEvent) => void>();
  const state: FakeAdapter = {
    launches: [],
    registered: [],
    fire: (event) => {
      for (const l of listeners) l(event);
    },
    asAdapter() {
      return {
        registerWorkflow: async (def: WorkflowDef) => {
          state.registered.push(def);
          return def.id;
        },
        launchRun: async (input: LaunchRunInput) => {
          state.launches.push(input);
          return input.sessionId;
        },
        onEvent: (listener: (e: CoreEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ...(repoWorld !== undefined
          ? {
              projectMembers: async (projectId: string) => repoWorld.members?.[projectId] ?? [],
              listRepos: async () => repoWorld.repos ?? [],
            }
          : {}),
      } as unknown as CoreAdapter;
    },
  };
  return state;
}

const SEATS = JSON.stringify([
  { key: 'stub', display_name: 'Stub', binary: 'stub', headless_invocation: 'stub {PROMPT}' },
]);

async function waitFor(cond: () => boolean, ms = 5000, step = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

describe('startInteractiveChatSubscriber (real bus, fake engine)', () => {
  let dir: string;
  let busDb: string;
  let docsRoot: string;
  let chatDir: string;
  let subs: { stop(): Promise<void> | void }[];
  let probeEvents: Array<{ event_type: string; payload: unknown; producer_id?: string | null; idempotency_key?: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-ice-'));
    busDb = join(dir, 'bus.db');
    docsRoot = join(dir, 'docs');
    chatDir = join(dir, 'chats');
    subs = [];
    probeEvents = [];
  });

  afterEach(async () => {
    for (const s of subs) await s.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed a doc workspace the way interactive's initWorkspace/fork would leave it. The default
   *  writes NO `kind` field — the real on-disk shape of a kind:"source" doc (interactive's
   *  initManifest keeps every non-demo kind implicit). */
  function seedDoc(
    name: string,
    { kind, head = 1, html = '<html><body data-wid="w-root"><h1>v1</h1></body></html>' }: { kind?: string; head?: number; html?: string } = {},
  ): void {
    const docDir = join(docsRoot, name);
    mkdirSync(docDir, { recursive: true });
    const versions = [];
    for (let v = 0; v <= head; v += 1) versions.push({ version: v, parent: v === 0 ? null : v - 1, html_file: `_v${v}.html` });
    writeFileSync(
      join(docDir, 'versions.json'),
      JSON.stringify({ ...(kind !== undefined ? { kind } : {}), head, versions }),
      'utf8',
    );
    writeFileSync(join(docDir, `_v${head}.html`), html, 'utf8');
  }

  /** Advance a seeded doc's head — what the service's materializeDraft does on landing. */
  function landVersion(name: string, html: string): number {
    const docDir = join(docsRoot, name);
    const manifest = JSON.parse(readFileSync(join(docDir, 'versions.json'), 'utf8')) as {
      kind: string; head: number; versions: Array<{ version: number }>;
    };
    const version = manifest.head + 1;
    manifest.versions.push({ version });
    (manifest.versions[manifest.versions.length - 1] as { html_file?: string }).html_file = `_v${version}.html`;
    manifest.head = version;
    writeFileSync(join(docDir, 'versions.json'), JSON.stringify(manifest), 'utf8');
    writeFileSync(join(docDir, `_v${version}.html`), html, 'utf8');
    return version;
  }

  async function emitChatPosted(
    bus: typeof import('wicked-bus'),
    documentId = 'iter-doc',
    overrides: Record<string, unknown> = {},
  ) {
    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    return bus.emit(db, config, {
      event_type: CHAT_POSTED,
      domain: 'wicked-interactive',
      subdomain: 'chat',
      payload: {
        role: 'user',
        text: 'Make the intro punchier.',
        document_id: documentId,
        ts: new Date().toISOString(),
        ...overrides,
      },
      producer_id: 'wi-ui',
    });
  }

  /** Probe subscription capturing every wicked-interactive event on the temp bus. */
  function armProbe(bus: typeof import('wicked-bus')) {
    const db = bus.openDb({ db_path: busDb });
    const probe = bus.subscribe({
      db,
      plugin: 'test-probe',
      filter: '*@wicked-interactive',
      cursor_init: 'oldest',
      pollIntervalMs: 25,
      maxRetries: 0,
      handler: (e) => {
        probeEvents.push({
          event_type: e.event_type,
          payload: e.payload,
          producer_id: (e as { producer_id?: string | null }).producer_id ?? null,
          idempotency_key: e.idempotency_key,
        });
      },
    });
    subs.push(probe);
  }

  function startSub(engine: FakeAdapter, extra: Record<string, unknown> = {}) {
    return startInteractiveChatSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      queueSweepMs: 25,
      landingGateMs: 60_000,
      ledgerPath: join(dir, 'chat-ledger.json'),
      chatDir,
      clisJson: SEATS,
      resolveDocsRoot: () => docsRoot,
      log: () => {},
      ...extra,
    });
  }

  it('answers a user ask with ONE governed run: snapshot in, narration out, draft.completed announce', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('iter-doc', { head: 2, html: '<html><body data-wid="w-root"><h1 data-wid="w-h1">v2</h1></body></html>' });
    const sub = await startSub(engine, { heartbeatMs: 60 });
    expect(sub).not.toBeNull();
    subs.push(sub!);
    armProbe(bus);

    // The workflow def rode the normal registration path before the cursor armed.
    expect(engine.registered.map((w) => w.id)).toEqual([INTERACTIVE_CHAT_WORKFLOW]);

    const { event_id } = await emitChatPosted(bus, 'iter-doc', { project_id: 'proj-7', source_message_id: 'm-1' });
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect(launch.workflow).toBe(INTERACTIVE_CHAT_WORKFLOW);
    expect(launch.clisJson).toBe(SEATS);
    expect(launch.projectId).toBe('proj-7');
    expect(launch.problem).toContain('"iter-doc"');
    expect(launch.problem).toContain('Make the intro punchier.');

    // The snapshot is a COPY of the current head, inside the declared write root — the worker
    // never needs the doc workspace. The root is the ask's OWN per-run subdir, never the
    // shared chatDir (per-run isolation — Copilot, crew#313).
    const key = chatKey('iter-doc', event_id, 'm-1');
    const runDir = join(chatDir, key.replace(/[^a-zA-Z0-9_-]/g, '-'));
    expect(launch.extraWriteRoots).toEqual([runDir]);
    const currentPath = join(runDir, 'current.html');
    const outPath = join(runDir, 'revised.html');
    expect(launch.problem).toContain(currentPath);
    expect(launch.problem).toContain(outPath);
    expect(readFileSync(currentPath, 'utf8')).toContain('data-wid="w-h1"');

    // Pickup narration reached the bus as wi-crew (the studio's 90s budget rides on this).
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          e.producer_id === INTERACTIVE_PRODUCER &&
          (e.payload as { state?: string }).state === 'processing',
      ),
    );

    // Heartbeat: with no engine events at all, working statuses keep arriving.
    const beats = () =>
      probeEvents.filter(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'working',
      ).length;
    const before = beats();
    await waitFor(() => beats() >= before + 2);

    // Narration ladder folds the run's own events into the thread.
    const narrated = (needle: string) => () =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          String((e.payload as { message?: string }).message).includes(needle),
      );
    engine.fire({ type: 'unitDispatched', session: launch.sessionId, ord: 2, attempt: 0 });
    await waitFor(narrated('2/2'));
    engine.fire({ type: 'gateDecided', session: launch.sessionId, ord: 2, allow: true });
    await waitFor(narrated('landing it now'));

    // The worker "wrote" the revision; completion announces it by path on the DRAFT wire.
    writeFileSync(outPath, '<html><body><h1>revised</h1></body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: launch.sessionId });
    await waitFor(() => probeEvents.some((e) => e.event_type === DRAFT_COMPLETED));
    const announce = probeEvents.find((e) => e.event_type === DRAFT_COMPLETED)!;
    expect((announce.payload as { html_path?: string }).html_path).toBe(outPath);
    expect((announce.payload as { document_id?: string }).document_id).toBe('iter-doc');
    expect(announce.producer_id).toBe(INTERACTIVE_PRODUCER);
    expect(announce.idempotency_key).toBe(chatIdempotencyKey('iter-doc', event_id, 'm-1'));

    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'complete',
      ),
    );
    expect(sub!.ledger.get(key)?.emittedAt).toBeTruthy();
    expect(sub!.inFlightDocs()).toEqual([]);
  });

  it('ROLE FILTER: agent narration echoes and feedback-batch echoes launch nothing', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('iter-doc');
    const sub = await startSub(engine);
    subs.push(sub!);

    await emitChatPosted(bus, 'iter-doc', { role: 'agent', text: 'First draft is in — landing it now.' });
    await emitChatPosted(bus, 'iter-doc', {
      role: 'user',
      text: 'Feedback on 2 places in this document:\n1. [w-a] fix\n2. [w-b] tweak',
      source_message_id: 'm-batch',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.launches.length, 'echoes must never launch a run').toBe(0);
    expect(sub!.ledger.size()).toBe(0);

    // …while a real user ask on the same doc still launches.
    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-real' });
    await waitFor(() => engine.launches.length === 1);
  });

  it('KIND/EXISTENCE FILTER (contract b): demo docs and unknown docs are never answered — a kindless (real source) doc is', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('demo-doc', { kind: 'demo' });
    seedDoc('kindless-doc'); // the real source-doc manifest shape: no kind field at all
    const sub = await startSub(engine);
    subs.push(sub!);

    await emitChatPosted(bus, 'demo-doc');
    await emitChatPosted(bus, 'never-created');
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.launches.length).toBe(0);
    expect(sub!.ledger.size()).toBe(0);

    // …while the kindless manifest — what interactive ACTUALLY writes for a source doc — is answered.
    await emitChatPosted(bus, 'kindless-doc', { source_message_id: 'm-kindless' });
    await waitFor(() => engine.launches.length === 1);
  });

  it('LEDGER DEDUPE: a resend reusing the message id launches no second run — and survives a restart', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('iter-doc');
    const sub = await startSub(engine);
    subs.push(sub!);

    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-9' });
    await waitFor(() => engine.launches.length === 1);
    const runId = engine.launches[0]!.sessionId;

    // Complete the run so the doc is no longer busy — a duplicate must be stopped by the
    // LEDGER, not by the serialization queue.
    const key = chatKey('iter-doc', 0, 'm-9'); // event_id irrelevant when msg id present
    const outPath = join(chatDir, key.replace(/[^a-zA-Z0-9_-]/g, '-'), 'revised.html');
    mkdirSync(join(chatDir, key.replace(/[^a-zA-Z0-9_-]/g, '-')), { recursive: true });
    writeFileSync(outPath, '<html><body>ok</body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: runId });
    await waitFor(() => sub!.ledger.get(key)?.emittedAt !== undefined);

    // The studio resend: same message id, a NEW bus event.
    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-9' });
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.launches.length, 'a resent ask must not double-launch').toBe(1);

    // And a RESTART (fresh subscriber, same ledger) still refuses to relaunch.
    await sub!.stop();
    const engine2 = fakeAdapter();
    const sub2 = await startSub(engine2);
    subs.push(sub2!);
    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-9' });
    await new Promise((r) => setTimeout(r, 300));
    expect(engine2.launches.length, 'the durable ledger survives a restart').toBe(0);
  });

  it('SERIALIZATION (contract c): a second ask QUEUES, then iterates on the version the first landed', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('iter-doc', { head: 1, html: '<html><body><h1>v1</h1></body></html>' });
    const sub = await startSub(engine, { landingGateMs: 60_000 });
    subs.push(sub!);
    armProbe(bus);

    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-1', text: 'First ask.' });
    await waitFor(() => engine.launches.length === 1);
    expect(sub!.inFlightDocs()).toEqual(['iter-doc']);

    // Ask 2 arrives while run 1 is in flight → queued, with an immediate narration.
    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-2', text: 'Second ask.' });
    await waitFor(() => sub!.queuedCount('iter-doc') === 1);
    expect(engine.launches.length).toBe(1);
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          String((e.payload as { message?: string }).message).includes('queued'),
      ),
    );

    // …but a DIFFERENT doc is not blocked (per-doc, not global).
    seedDoc('other-doc');
    await emitChatPosted(bus, 'other-doc', { source_message_id: 'm-x' });
    await waitFor(() => engine.launches.length === 2);
    expect(engine.launches[1]!.problem).toContain('"other-doc"');

    // Run 1 completes and announces; the LANDING GATE holds ask 2 until the service lands
    // the new version (the manifest head advances) — draining on the stale head would drop
    // the revision the user just watched land.
    const key1 = chatKey('iter-doc', 0, 'm-1');
    const out1 = join(chatDir, key1.replace(/[^a-zA-Z0-9_-]/g, '-'), 'revised.html');
    writeFileSync(out1, '<html><body><h1>after ask 1</h1></body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });
    await waitFor(() => sub!.ledger.get(key1)?.emittedAt !== undefined);
    await new Promise((r) => setTimeout(r, 200));
    expect(engine.launches.length, 'the landing gate holds the queue until the version lands').toBe(2);

    // The service lands v2 → the gate opens → ask 2 launches on the NEW head.
    landVersion('iter-doc', '<html><body><h1 data-wid="w-new">landed after ask 1</h1></body></html>');
    await waitFor(() => engine.launches.length === 3);
    const launch2 = engine.launches[2]!;
    expect(launch2.problem).toContain('Second ask.');
    const key2 = chatKey('iter-doc', 0, 'm-2');
    const current2 = join(chatDir, key2.replace(/[^a-zA-Z0-9_-]/g, '-'), 'current.html');
    expect(readFileSync(current2, 'utf8')).toContain('landed after ask 1');
    // Per-run isolation (Copilot, crew#313): ask 2's declared root is ITS dir, not ask 1's.
    expect(launch2.extraWriteRoots).toEqual([join(chatDir, key2.replace(/[^a-zA-Z0-9_-]/g, '-'))]);
    expect(sub!.queuedCount('iter-doc')).toBe(0);
  });

  it('SERIALIZATION across seams: isDocBusy (a draft/edit run) parks the ask until it clears', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('iter-doc');
    let foreignBusy = true;
    const sub = await startSub(engine, { isDocBusy: (doc: string) => doc === 'iter-doc' && foreignBusy });
    subs.push(sub!);

    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-1' });
    await waitFor(() => sub!.queuedCount('iter-doc') === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(engine.launches.length, 'a foreign in-flight run must park the ask').toBe(0);

    foreignBusy = false; // the draft/edit run finished — the sweep drains the queue
    await waitFor(() => engine.launches.length === 1);
    expect(sub!.queuedCount('iter-doc')).toBe(0);
  });

  it('a failed run posts an error status, records the failure, and the queue still drains', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('iter-doc');
    const sub = await startSub(engine);
    subs.push(sub!);
    armProbe(bus);

    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-1' });
    await waitFor(() => engine.launches.length === 1);
    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-2' });
    await waitFor(() => sub!.queuedCount('iter-doc') === 1);

    engine.fire({ type: 'sessionFailed', session: engine.launches[0]!.sessionId, ord: 1 });
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(probeEvents.some((e) => e.event_type === DRAFT_COMPLETED)).toBe(false);
    expect(sub!.ledger.get(chatKey('iter-doc', 0, 'm-1'))?.failedAt).toBeTruthy();
    // No landing gate on failure: the parked second ask launches on the head that is there.
    await waitFor(() => engine.launches.length === 2);
    expect(engine.launches[1]!.problem).toContain('"iter-doc"');
  });

  it('a FAILED LAUNCH closes the thread with an error status and writes no ledger row (a replay can retry)', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('iter-doc');
    const adapter = engine.asAdapter();
    (adapter as unknown as { launchRun: unknown }).launchRun = async () => {
      throw new Error('engine is busy');
    };
    const sub = await startInteractiveChatSubscriber(adapter, {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      queueSweepMs: 25,
      ledgerPath: join(dir, 'chat-ledger.json'),
      chatDir,
      clisJson: SEATS,
      resolveDocsRoot: () => docsRoot,
      log: () => {},
    });
    subs.push(sub!);
    armProbe(bus);

    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-1' });
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          (e.payload as { state?: string }).state === 'error' &&
          String((e.payload as { message?: string }).message).includes('engine is busy'),
      ),
    );
    expect(sub!.ledger.size()).toBe(0);
  });

  it('a completed run whose worker wrote NO file posts an error instead of announcing a phantom revision', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('iter-doc');
    const sub = await startSub(engine);
    subs.push(sub!);
    armProbe(bus);

    await emitChatPosted(bus, 'iter-doc', { source_message_id: 'm-1' });
    await waitFor(() => engine.launches.length === 1);
    const key = chatKey('iter-doc', 0, 'm-1');
    expect(existsSync(join(chatDir, key.replace(/[^a-zA-Z0-9_-]/g, '-'), 'revised.html'))).toBe(false);
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(probeEvents.some((e) => e.event_type === DRAFT_COMPLETED)).toBe(false);
    expect(sub!.ledger.get(key)?.failedAt).toBeTruthy();
  });

  it('an UNBOUND doc launches an unfiled run (no projectId, onRunFiled never fires); a bound one FILES it', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    seedDoc('unbound-doc');
    seedDoc('bound-doc');
    const filed: Array<[string, string]> = [];
    const sub = await startSub(engine, { onRunFiled: (runId: string, projectId: string) => filed.push([runId, projectId]) });
    subs.push(sub!);

    await emitChatPosted(bus, 'unbound-doc', { source_message_id: 'm-u' });
    await waitFor(() => engine.launches.length === 1);
    const unfiled = engine.launches[0]!;
    expect('projectId' in unfiled).toBe(false);
    expect(filed).toHaveLength(0);

    await emitChatPosted(bus, 'bound-doc', { source_message_id: 'm-b', project_id: 'proj-7' });
    await waitFor(() => engine.launches.length === 2);
    expect(engine.launches[1]!.projectId).toBe('proj-7');
    expect(filed).toEqual([[engine.launches[1]!.sessionId, 'proj-7']]);
    // Neither launch is repo-grounded — the CREW-UX-8 v5 split: the revision leg never
    // resolves a repo binding at all (see the repo-backed test below for the rationale).
    expect('repoRef' in unfiled).toBe(false);
    expect('repoRef' in engine.launches[1]!).toBe(false);
    expect(engine.launches[1]!.problem).not.toContain('Ground the revision');
  });

  /** A real (plain-dir) repo fixture — present so the test below proves the seam ignores it. */
  function seedRepoFixture(name = 'the-repo'): string {
    const root = join(dir, name);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# the real studio project\n', 'utf8');
    writeFileSync(join(root, 'src', 'main.ts'), 'export const real = true;\n', 'utf8');
    return root;
  }

  it('a REPO-BACKED project launches EXACTLY like an unfiled ask — no repoRef, no snapshot, no clause; filing unaffected (CREW-UX-8 v5 split)', async () => {
    // The orchestrator split, from live evidence: the draft leg's snapshot grounding is proven
    // (grounded v1s land — it stays as-is in draft-events.ts), but the SAME grounded prompt on
    // the REVISE turn wedged 2/2 on the real engine (crew#288 comment — the repo-grounded
    // revise turn hits the known second-turn wedge), while ungrounded revisions are proven to
    // land (the CREW-UX-5 verification). So even with a fully resolvable repo binding, the
    // chat seam launches the proven CREW-UX-5 shape: external-inbox head-copy, the ONE write
    // root, no repoRef (wicked-core#293), no live-repo path or snapshot (wicked-core#294),
    // projectId still filed. Revision grounding returns when either core issue is fixed.
    const bus = await import('wicked-bus');
    const repoRoot = seedRepoFixture();
    const engine = fakeAdapter({
      members: { 'proj-repo': [{ member_kind: 'crew.repo', member_ref: 'repo-studio' }] },
      repos: [{ id: 'repo-studio', root_path: repoRoot }],
    });
    seedDoc('repo-doc');
    const filed: Array<[string, string]> = [];
    const sub = await startSub(engine, { onRunFiled: (runId: string, projectId: string) => filed.push([runId, projectId]) });
    subs.push(sub!);
    armProbe(bus);

    await emitChatPosted(bus, 'repo-doc', { source_message_id: 'm-r', project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    const safeKey = chatKey('repo-doc', 0, 'm-r').replace(/[^a-zA-Z0-9_-]/g, '-');
    const runDir = join(chatDir, safeKey);
    // The proven unfiled launch shape, exactly (per-run subdir — Copilot, crew#313):
    expect('repoRef' in launch).toBe(false);
    expect(launch.problem).not.toContain('Ground the revision');
    expect(launch.problem).not.toContain(repoRoot); // the live root never reaches the task
    expect(launch.problem).toContain(`read it first: ${join(runDir, 'current.html')}`);
    expect(launch.problem).toContain(
      `exactly this absolute file path: ${join(runDir, 'revised.html')}`,
    );
    expect(launch.extraWriteRoots).toEqual([runDir]);
    expect(launch.problem).not.toMatch(/[\n\r]/);
    // No repo snapshot is ever created in the inbox…
    expect(existsSync(join(runDir, 'repo'))).toBe(false);
    // …and filing is unaffected by the revert: the run is still project-bound.
    expect(launch.projectId).toBe('proj-repo');
    expect(filed).toEqual([[launch.sessionId, 'proj-repo']]);

    // The full loop still closes through the ONE standard finalize: inbox file in, inbox
    // path announced on the draft wire.
    const inboxPath = join(runDir, 'revised.html');
    writeFileSync(inboxPath, '<html><body><h1>ungrounded revision</h1></body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: launch.sessionId });
    await waitFor(() => probeEvents.some((e) => e.event_type === DRAFT_COMPLETED));
    const announce = probeEvents.find((e) => e.event_type === DRAFT_COMPLETED)!;
    expect((announce.payload as { html_path?: string }).html_path).toBe(inboxPath);
    expect(sub!.ledger.get(chatKey('repo-doc', 0, 'm-r'))?.emittedAt).toBeTruthy();
  });
});
