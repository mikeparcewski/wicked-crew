// The interactive-draft seam (task #86 spike, Phase 7c first leg).
//
// What these tests pin, and why:
//  - the TRIGGER contract: only `wicked.interactive.doc.created` with `kind: "source"` and a
//    slug-valid document_id is actionable — demo/html docs belong to the assist loop, and a
//    malformed id must never name a ledger key or a file path;
//  - the WORKER contract: the problem statement and every phase instruction are single-line
//    (the engine's PTY seat runner REFUSES prompts with embedded newlines — wicked-core
//    FINDING-011 — so a multi-line brief must be flattened, not forwarded);
//  - IDEMPOTENCY: the durable ledger survives a reload, a replayed doc.created launches no
//    second run, and the draft announce carries a deterministic idempotency key;
//  - the LOOP: a real (temp-file) wicked-bus carries doc.created in and status.posted /
//    draft.completed back out, stamped `wi-crew`, with the heartbeat feeding the UI's ~20s
//    status window and `sessionCompleted` closing the loop by announcing the file the worker
//    wrote. The engine itself is faked — the governed run's mechanics are wicked-core's tests'
//    business; THIS seam's business is everything around it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOC_CREATED,
  DRAFT_COMPLETED,
  STATUS_POSTED,
  INTERACTIVE_BUS_FILTER,
  INTERACTIVE_BUS_PLUGIN,
  INTERACTIVE_PRODUCER,
  INTERACTIVE_DRAFT_WORKFLOW,
  INTERACTIVE_DRAFT_WORKFLOW_DEF,
  InteractiveHandoffLedger,
  parseSourceDocCreated,
  draftProblem,
  draftIdempotencyKey,
  startInteractiveDraftSubscriber,
} from '../src/interactive/draft-events.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../src/core/types.js';

describe('parseSourceDocCreated', () => {
  const payload = {
    document_id: 'q3-board-deck',
    kind: 'source',
    brief: 'a Q3 board deck',
    source_paths: ['/tmp/q3.md'],
    style: 'ppt',
    ts: '2026-08-12T00:00:00Z',
  };

  it('accepts a project-bound kind:source creation and carries brief/sources/style/projectId', () => {
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, project_id: 'proj-7' })).toEqual({
      documentId: 'q3-board-deck',
      brief: 'a Q3 board deck',
      sourcePaths: ['/tmp/q3.md'],
      style: 'ppt',
      projectId: 'proj-7',
    });
  });

  it('defaults style to web and tolerates a brief-only project-bound creation', () => {
    const doc = parseSourceDocCreated(DOC_CREATED, { document_id: 'a-doc', kind: 'source', project_id: 'proj-1' });
    expect(doc).toEqual({ documentId: 'a-doc', brief: '', sourcePaths: [], style: 'web', projectId: 'proj-1' });
  });

  it('ignores demo and html doc creations -- those belong to the assist loop', () => {
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, kind: 'demo' })).toBeNull();
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, kind: 'html' })).toBeNull();
  });

  it('ignores unbound source docs -- crew only takes project-bound docs; unbound docs are the assist skill solo business', () => {
    expect(parseSourceDocCreated(DOC_CREATED, payload)).toBeNull();
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, project_id: '' })).toBeNull();
  });

  it('ignores other event types, malformed payloads, and slug-invalid document ids', () => {
    expect(parseSourceDocCreated('wicked.interactive.chat.posted', payload)).toBeNull();
    expect(parseSourceDocCreated(DOC_CREATED, 'not-an-object')).toBeNull();
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, document_id: '../escape' })).toBeNull();
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, document_id: 'Nope Caps' })).toBeNull();
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, document_id: undefined })).toBeNull();
  });

  it('drops non-string entries from source_paths rather than forwarding them to a prompt', () => {
    const doc = parseSourceDocCreated(DOC_CREATED, {
      ...payload,
      project_id: 'proj-x',
      source_paths: ['/ok', 42, null, ''],
    });
    expect(doc?.sourcePaths).toEqual(['/ok']);
  });

  it('always includes projectId in the result -- absent or empty project_id returns null (crew only takes project-bound docs)', () => {
    const bound = parseSourceDocCreated(DOC_CREATED, { ...payload, project_id: 'proj-7' });
    expect(bound?.projectId).toBe('proj-7');
    expect(parseSourceDocCreated(DOC_CREATED, payload)).toBeNull();
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, project_id: '' })).toBeNull();
  });
});

describe('draftProblem (the worker prompt seed)', () => {
  const doc = { documentId: 'my-doc', brief: 'line one\nline two\n\ttabbed', sourcePaths: [], style: 'web', projectId: 'proj-test' };

  it('is ALWAYS single-line — a PTY seat refuses embedded newlines (FINDING-011)', () => {
    const problem = draftProblem(doc, '/tmp/out.html');
    expect(problem).not.toMatch(/[\n\r\t]/);
    expect(problem).toContain('line one line two tabbed');
  });

  it('names the document, the style, and the exact output path', () => {
    const problem = draftProblem(doc, '/tmp/drafts/my-doc-v1.html');
    expect(problem).toContain('"my-doc"');
    expect(problem).toContain('style: web');
    expect(problem).toContain('/tmp/drafts/my-doc-v1.html');
  });

  it('says brief-only generation is the spec when there are no sources, and lists them when there are', () => {
    expect(draftProblem(doc, '/o')).toContain('the brief alone is the spec');
    expect(
      draftProblem({ ...doc, sourcePaths: ['/a.md', '/b/'] }, '/o'),
    ).toContain('Source materials to read: /a.md, /b/.');
  });

  it('caps a pasted-novel brief instead of ballooning the prompt', () => {
    const big = draftProblem({ ...doc, brief: 'x'.repeat(10_000) }, '/o');
    expect(big.length).toBeLessThan(2500);
    expect(big).toContain('…');
  });
});

describe('the interactive-draft workflow def (workflows-as-data)', () => {
  const def = INTERACTIVE_DRAFT_WORKFLOW_DEF;

  it('is outline → draft, creator-role build second, unique phase ids', () => {
    expect(def.id).toBe(INTERACTIVE_DRAFT_WORKFLOW);
    expect(def.phases.map((p) => p.id)).toEqual(['outline', 'draft']);
    expect(def.phases[1]?.role).toBe('creator');
    expect(def.phases[1]?.depends_on).toEqual(['outline']);
  });

  it('keeps every phase instruction single-line (the same PTY constraint as the problem)', () => {
    for (const p of def.phases) {
      expect(p.instructions ?? '').not.toMatch(/[\n\r]/);
      expect((p.instructions ?? '').length).toBeGreaterThan(0);
    }
  });

  it('arms no human gate and no validator floor — the acceptance gate is interactive’s INV-2 pipeline', () => {
    for (const p of def.phases) {
      expect(p.gate).toBe('auto');
      expect(p.validator_pin).toBeNull();
      expect(p.required_deliverables).toEqual([]);
    }
  });

  it('carries the draft-production contract from the assist skill (Step 5), adapted', () => {
    const draft = def.phases[1]?.instructions ?? '';
    expect(draft).toContain('data-wid'); // the INV-2 discipline: never mint anchors
    expect(draft).toMatch(/do NOT add data-wid/i);
    expect(draft).toContain('self-contained HTML');
    expect(draft).toMatch(/never fabricate/i);
  });
});

describe('bus identity constants', () => {
  it('subscribes on an exact-type, domain-guarded filter under a dedicated plugin name', () => {
    expect(INTERACTIVE_BUS_FILTER).toBe('wicked.interactive.doc.created@wicked-interactive');
    // NOT the qe seam's `wicked-crew` — independent cursors, independently stoppable.
    expect(INTERACTIVE_BUS_PLUGIN).toBe('wicked-crew-interactive-draft');
    expect(INTERACTIVE_PRODUCER).toBe('wi-crew');
  });

  it('derives a deterministic idempotency key per document', () => {
    expect(draftIdempotencyKey('my-doc')).toBe('crew:interactive.draft:my-doc:v1');
    expect(draftIdempotencyKey('my-doc')).toBe(draftIdempotencyKey('my-doc'));
  });
});

describe('InteractiveHandoffLedger', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-idl-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a launch durably — a fresh load sees it (restart-safe replay dedupe)', () => {
    const path = join(dir, 'ledger.json');
    const ledger = new InteractiveHandoffLedger(path);
    expect(ledger.has('doc-a')).toBe(false);
    ledger.recordLaunch('doc-a', 'run-1');
    const reloaded = new InteractiveHandoffLedger(path);
    expect(reloaded.has('doc-a')).toBe(true);
    expect(reloaded.get('doc-a')?.runId).toBe('run-1');
    expect(reloaded.get('doc-a')?.emittedAt).toBeUndefined();
  });

  it('tracks the emit and failure lifecycle', () => {
    const path = join(dir, 'ledger.json');
    const ledger = new InteractiveHandoffLedger(path);
    ledger.recordLaunch('doc-a', 'run-1');
    ledger.recordEmitted('doc-a');
    ledger.recordLaunch('doc-b', 'run-2');
    ledger.recordFailure('doc-b');
    const reloaded = new InteractiveHandoffLedger(path);
    expect(reloaded.get('doc-a')?.emittedAt).toBeTruthy();
    expect(reloaded.get('doc-b')?.failedAt).toBeTruthy();
    expect(reloaded.size()).toBe(2);
  });

  it('starts empty on a malformed file rather than killing the daemon', () => {
    const path = join(dir, 'ledger.json');
    writeFileSync(path, '{not json', 'utf8');
    const ledger = new InteractiveHandoffLedger(path);
    expect(ledger.size()).toBe(0);
    // …and recovers the file on the next write.
    ledger.recordLaunch('doc-a', 'run-1');
    expect(JSON.parse(readFileSync(path, 'utf8')).docs['doc-a'].runId).toBe('run-1');
  });
});

// ── The loop over a real (temp) bus, with a fake engine ─────────────────────────────────────

interface FakeAdapter {
  launches: LaunchRunInput[];
  registered: WorkflowDef[];
  fire: (event: CoreEvent) => void;
  asAdapter(): CoreAdapter;
}

function fakeAdapter(): FakeAdapter {
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

describe('startInteractiveDraftSubscriber (real bus, fake engine)', () => {
  let dir: string;
  let busDb: string;
  let subs: { stop(): Promise<void> | void }[];
  let probeEvents: Array<{ event_type: string; payload: unknown; producer_id?: string | null; idempotency_key?: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-ide-'));
    busDb = join(dir, 'bus.db');
    subs = [];
    probeEvents = [];
  });

  afterEach(async () => {
    for (const s of subs) await s.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function emitDocCreated(
    bus: typeof import('wicked-bus'),
    documentId = 'spike-doc',
    overrides: Record<string, unknown> = {},
  ) {
    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    bus.emit(db, config, {
      event_type: DOC_CREATED,
      domain: 'wicked-interactive',
      subdomain: 'docs',
      payload: {
        document_id: documentId,
        kind: 'source',
        brief: 'a one-page overview of the wicked ecosystem',
        source_paths: [],
        style: 'web',
        ts: new Date().toISOString(),
        ...overrides,
      },
      producer_id: 'wi-service',
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

  it('answers doc.created with ONE governed run, narrates, and announces the finished draft', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const draftDir = join(dir, 'drafts');
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60, // fast heartbeat so the test observes the cadence, not just transitions
      ledgerPath: join(dir, 'ledger.json'),
      draftDir,
      clisJson: SEATS,
      log: () => {},
    });
    expect(sub).not.toBeNull();
    subs.push(sub!);
    armProbe(bus);

    // The workflow def rode the normal registration path before the cursor armed.
    expect(engine.registered.map((w) => w.id)).toEqual([INTERACTIVE_DRAFT_WORKFLOW]);

    await emitDocCreated(bus, 'spike-doc', { project_id: 'proj-7' });
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect(launch.workflow).toBe(INTERACTIVE_DRAFT_WORKFLOW);
    expect(launch.clisJson).toBe(SEATS);
    expect(launch.problem).toContain('"spike-doc"');
    const outPath = join(draftDir, 'spike-doc-v1.html');
    expect(launch.problem).toContain(outPath);

    // Narration reached the bus as wi-crew before any engine event: the pickup status.
    await waitFor(() =>
      probeEvents.some((e) => e.event_type === STATUS_POSTED && e.producer_id === INTERACTIVE_PRODUCER),
    );

    // Heartbeat: with no engine events at all, working statuses keep arriving (~every heartbeatMs).
    const beats = () =>
      probeEvents.filter(
        (e) =>
          e.event_type === STATUS_POSTED &&
          (e.payload as { state?: string }).state === 'working',
      ).length;
    const before = beats();
    await waitFor(() => beats() >= before + 2);

    // Phase transition narration folds the run's own events into the thread.
    engine.fire({ type: 'unitDispatched', session: launch.sessionId, ord: 2, attempt: 0 });
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          String((e.payload as { message?: string }).message).includes('2/2'),
      ),
    );

    // Narration LADDER: council, seat choice, tools, gate — each event ADVANCES the line, so
    // the heartbeat repeats progress instead of echoing one thin phrase (user feedback).
    const narrated = (needle: string) => () =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          String((e.payload as { message?: string }).message).includes(needle),
      );
    engine.fire({ type: 'councilConvened', session: launch.sessionId, ord: 2, clis: ['a', 'b', 'c'] });
    await waitFor(narrated('3-seat council'));
    engine.fire({ type: 'unitDistributed', session: launch.sessionId, ord: 2, cli: 'stub', agreement_pct: 100 });
    await waitFor(narrated('picked stub'));
    engine.fire({ type: 'toolInvoked', session: launch.sessionId, ord: 2, attempt: 0, tools: ['Write', 'Write', 'Read'] });
    await waitFor(narrated('using Write, Read'));
    engine.fire({ type: 'gateDecided', session: launch.sessionId, ord: 2, allow: true });
    await waitFor(narrated('landing it now'));

    // The worker "wrote" the draft; completion announces it by path with the deterministic key.
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(outPath, '<html><body><h1>Draft</h1></body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: launch.sessionId });
    await waitFor(() => probeEvents.some((e) => e.event_type === DRAFT_COMPLETED));
    const draft = probeEvents.find((e) => e.event_type === DRAFT_COMPLETED)!;
    expect((draft.payload as { html_path?: string }).html_path).toBe(outPath);
    expect((draft.payload as { document_id?: string }).document_id).toBe('spike-doc');
    expect(draft.producer_id).toBe(INTERACTIVE_PRODUCER);
    expect(draft.idempotency_key).toBe(draftIdempotencyKey('spike-doc'));

    // …and closes out with a complete status.
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          (e.payload as { state?: string }).state === 'complete',
      ),
    );
    expect(sub!.ledger.get('spike-doc')?.emittedAt).toBeTruthy();
  });

  it('a REPLAYED doc.created launches no second run (ledger dedupe), and a second completion emits no second draft', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const draftDir = join(dir, 'drafts');
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir,
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub!);

    await emitDocCreated(bus, 'spike-doc', { project_id: 'proj-7' });
    await waitFor(() => engine.launches.length === 1);

    // Redelivery/replay: the same creation arrives again (at-least-once semantics).
    await emitDocCreated(bus, 'spike-doc', { project_id: 'proj-7' });
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.launches.length, 'a replayed doc.created must not double-launch').toBe(1);

    // Complete the run; then complete it "again" (a redelivered terminal event).
    const runId = engine.launches[0]!.sessionId;
    const outPath = join(draftDir, 'spike-doc-v1.html');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(outPath, '<html><body>ok</body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: runId });
    await waitFor(() => sub!.ledger.get('spike-doc')?.emittedAt !== undefined);
    engine.fire({ type: 'sessionCompleted', session: runId }); // in-flight entry is gone — a no-op
    armProbe(bus);
    await waitFor(() => probeEvents.some((e) => e.event_type === DRAFT_COMPLETED));
    await new Promise((r) => setTimeout(r, 200));
    expect(
      probeEvents.filter((e) => e.event_type === DRAFT_COMPLETED).length,
      'exactly one draft.completed for the doc',
    ).toBe(1);

    // And a RESTART (fresh subscriber, same ledger) still refuses to relaunch.
    await sub!.stop();
    const engine2 = fakeAdapter();
    const sub2 = await startInteractiveDraftSubscriber(engine2.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir,
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub2!);
    await emitDocCreated(bus, 'spike-doc', { project_id: 'proj-7' });
    await new Promise((r) => setTimeout(r, 300));
    expect(engine2.launches.length, 'the durable ledger survives a restart').toBe(0);
  });

  it('a failed run posts an error status, records the failure, and emits no draft', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir: join(dir, 'drafts'),
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub!);
    armProbe(bus);

    await emitDocCreated(bus, 'spike-doc', { project_id: 'proj-7' });
    await waitFor(() => engine.launches.length === 1);
    engine.fire({ type: 'sessionFailed', session: engine.launches[0]!.sessionId, ord: 1 });
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(probeEvents.some((e) => e.event_type === DRAFT_COMPLETED)).toBe(false);
    expect(sub!.ledger.get('spike-doc')?.failedAt).toBeTruthy();
  });

  it('a FAILED LAUNCH closes the thread with an error status and writes no ledger row (a replay can retry)', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const adapter = engine.asAdapter();
    (adapter as unknown as { launchRun: unknown }).launchRun = async () => {
      throw new Error('engine is busy');
    };
    const sub = await startInteractiveDraftSubscriber(adapter, {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir: join(dir, 'drafts'),
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub!);
    armProbe(bus);

    await emitDocCreated(bus, 'spike-doc', { project_id: 'proj-7' });
    // The 'processing' pickup was posted, then the launch failure closed it out as an error…
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          (e.payload as { state?: string }).state === 'error' &&
          String((e.payload as { message?: string }).message).includes('engine is busy'),
      ),
    );
    // …and no ledger row exists, so a later replay (e.g. DLQ redrive) gets a real retry.
    expect(sub!.ledger.has('spike-doc')).toBe(false);
    expect(engine.launches.length).toBe(0);
  });

  it('FILES the run when doc.created carries project_id — and reports it via onRunFiled (P7 DEFECT-1 regression)', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const filed: Array<[string, string]> = [];
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir: join(dir, 'drafts'),
      clisJson: SEATS,
      onRunFiled: (runId, projectId) => filed.push([runId, projectId]),
      log: () => {},
    });
    subs.push(sub!);

    // Project-bound doc → the launch carries projectId and the post-commit hook fires.
    await emitDocCreated(bus, 'bound-doc', { project_id: 'proj-7' });
    await waitFor(() => engine.launches.length === 1);
    expect(engine.launches[0]!.projectId).toBe('proj-7');
    expect(filed).toEqual([[engine.launches[0]!.sessionId, 'proj-7']]);
    // crew#263: the launch DECLARES the draft inbox as an extra write root. Without it the
    // wrapped-CLI boundary denies the deliverable write and fails the run AFTER the draft is
    // produced (run eed69dfa) — the declared outPath must be inside a declared root.
    expect(engine.launches[0]!.extraWriteRoots).toEqual([join(dir, 'drafts')]);

    // Unbound doc → crew ignores it entirely (the assist skill handles it solo).
    await emitDocCreated(bus, 'unbound-doc');
    // Give the subscriber a moment to process; launch count must stay at 1.
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.launches.length).toBe(1);
    expect(filed).toHaveLength(1);
  });

  it('a completed run whose worker wrote NO file posts an error instead of announcing a phantom draft', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir: join(dir, 'drafts'),
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub!);
    armProbe(bus);

    await emitDocCreated(bus, 'spike-doc', { project_id: 'proj-7' });
    await waitFor(() => engine.launches.length === 1);
    expect(existsSync(join(dir, 'drafts', 'spike-doc-v1.html'))).toBe(false);
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(probeEvents.some((e) => e.event_type === DRAFT_COMPLETED)).toBe(false);
  });
});
