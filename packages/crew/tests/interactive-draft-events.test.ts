// The interactive-draft seam (task #86 spike, Phase 7c first leg).
//
// What these tests pin, and why:
//  - the TRIGGER contract: only `wicked.interactive.doc.created` with `kind: "source"` and a
//    slug-valid document_id is actionable — demo/html docs belong to the assist loop, and a
//    malformed id must never name a ledger key or a file path. UNFILED docs (no `project_id`)
//    are actionable too — DES-UX-001 slice U creates them through crew's synthesized default
//    mount with no project field, and this seam is their only answerer (BRIEF-UX-001 J3);
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
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
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
  groundablePath,
  recallClause,
  recallIntentObject,
  SNAPSHOT_PATH_MAX,
  resolveProjectRepo,
  startInteractiveDraftSubscriber,
} from '../src/interactive/draft-events.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

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

  it('accepts UNBOUND source docs with projectId undefined -- unfiled docs are first-class (DES-UX-001 slice U)', () => {
    const unbound = parseSourceDocCreated(DOC_CREATED, payload);
    expect(unbound).toEqual({
      documentId: 'q3-board-deck',
      brief: 'a Q3 board deck',
      sourcePaths: ['/tmp/q3.md'],
      style: 'ppt',
    });
    expect(unbound?.projectId).toBeUndefined();
    // An empty project_id is treated as absent — unfiled, never a fabricated binding.
    expect(parseSourceDocCreated(DOC_CREATED, { ...payload, project_id: '' })?.projectId).toBeUndefined();
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

  it('carries projectId only when the doc is bound -- never fabricates one for an unfiled doc', () => {
    const bound = parseSourceDocCreated(DOC_CREATED, { ...payload, project_id: 'proj-7' });
    expect(bound?.projectId).toBe('proj-7');
    const unbound = parseSourceDocCreated(DOC_CREATED, payload);
    expect(unbound).not.toBeNull();
    expect(unbound && 'projectId' in unbound).toBe(false); // omitted, not present-as-undefined
    expect(unbound?.projectId).not.toBe('default');
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
    // Brief capped at 2000 + the (always-present) estate-tool grounding clause + fixed words.
    expect(big.length).toBeLessThan(3400);
    expect(big).toContain('…');
  });

  it('grounds via the estate MCP tools PRIMARILY and names the snapshot as a FALLBACK — single-line (DES-GROUNDING-001 §3.3)', () => {
    // The PRIMARY grounding is the wicked-estate MCP index (the repo-less draft run passes the
    // projectGraph binding, so the worker's tools span all bound repos). The deliverable stays
    // the ABSOLUTE external-inbox path; the snapshot is now only a secondary/offline backup.
    const problem = draftProblem(doc, '/tmp/inbox/my-doc-v1.html', '/tmp/inbox/my-doc-repo');
    // PRIMARY: research via the estate tools, named explicitly, across all bound repos.
    expect(problem).toContain('wicked-estate MCP tools');
    expect(problem).toContain('SearchEntity');
    expect(problem).toContain('FetchContent');
    expect(problem).toContain('ContextBundle');
    expect(problem).toContain('RetrieveEntity/TraverseGraph');
    expect(problem).toContain('never placeholders');
    // FALLBACK: the snapshot path appears only as the offline backup, after the estate clause.
    expect(problem).toContain(
      'If the estate tools are unavailable, fall back to the offline repository snapshot at /tmp/inbox/my-doc-repo',
    );
    expect(problem.indexOf('wicked-estate MCP tools')).toBeLessThan(
      problem.indexOf('fall back to the offline repository snapshot'),
    );
    expect(problem).toContain('exactly this absolute file path: /tmp/inbox/my-doc-v1.html');
    expect(problem).not.toMatch(/[\n\r\t]/);
    // The snapshot PATH rides VERBATIM — never flattened, never truncated (Copilot, crew#313:
    // the snapshot sits at exactly one spelling; a respelled path grounds the worker on nothing).
    // The prompt budget is enforced BEFORE snapshotting via groundablePath, not by mangling.
    const longButLegal = `/inbox/${'p'.repeat(SNAPSHOT_PATH_MAX - 20)}`;
    expect(draftProblem(doc, '/o.html', longButLegal)).toContain(longButLegal);
    // WORST CASE stays bounded: pasted-novel brief (capped at 2000) + a guarded path (≤300)
    // + the (now always-present) estate-tool clause + fixed words.
    const worst = draftProblem({ ...doc, brief: 'x'.repeat(10_000) }, '/o.html', longButLegal);
    expect(worst.length).toBeLessThan(3700);
  });

  it('groundablePath guards the clause budget: verbatim-or-nothing (Copilot, crew#313)', () => {
    expect(groundablePath('/tmp/inbox/my-doc/repo')).toBe(true);
    expect(groundablePath(`/x/${'p'.repeat(SNAPSHOT_PATH_MAX)}`)).toBe(false); // over budget → degrade, never truncate
    expect(groundablePath('/tmp/has\nnewline')).toBe(false); // would kill the PTY prompt
    expect(groundablePath('/tmp/has\ttab')).toBe(false); // oneLine would respell it — refuse instead
    expect(groundablePath('p'.repeat(SNAPSHOT_PATH_MAX))).toBe(true); // exactly at budget rides
  });

  it('still grounds via the estate tools with NO snapshot — but adds no snapshot-fallback clause (DES-GROUNDING-001 §3.3)', () => {
    const problem = draftProblem(doc, '/tmp/out.html');
    // The estate-tool grounding is UNCONDITIONAL — present even when no snapshot was made.
    expect(problem).toContain('wicked-estate MCP tools');
    expect(problem).toContain('SearchEntity');
    // No snapshot ⇒ no offline-backup clause (nothing fabricated).
    expect(problem).not.toContain('fall back to the offline repository snapshot');
    expect(problem).not.toContain('repository snapshot');
    expect(problem).toContain('exactly this absolute file path: /tmp/out.html');
    expect(draftProblem(doc, '/tmp/out.html', undefined)).toBe(draftProblem(doc, '/tmp/out.html'));
  });
});

describe('recallClause / recallIntentObject (DES-MEM-FACETED-001 Phase 3, shared helper)', () => {
  it('builds the intent object from only the DEFINED axes — no undefined/null keys', () => {
    expect(recallIntentObject({ project: 'p1' })).toEqual({ project: 'p1' });
    expect(recallIntentObject({ project: 'p1', cli: 'claude', repo: 'r1' })).toEqual({
      project: 'p1',
      cli: 'claude',
      repo: 'r1',
    });
    // An axis left undefined never becomes a key — JSON.stringify carries only what was threaded.
    const json = JSON.stringify(recallIntentObject({ project: 'p1' }));
    expect(json).toBe('{"project":"p1"}');
    expect(json).not.toContain('undefined');
    expect(json).not.toContain('null');
    expect(json).not.toContain('cli');
    expect(json).not.toContain('repo');
  });

  it('returns undefined (→ omitted clause) for no intent and for an all-undefined intent', () => {
    expect(recallIntentObject(undefined)).toBeUndefined();
    expect(recallIntentObject({})).toBeUndefined();
    expect(recallClause(undefined)).toBe('');
    expect(recallClause({})).toBe('');
  });

  it('emits a single-line memory.recall clause carrying the intent JSON when an axis is present', () => {
    const clause = recallClause({ project: 'proj-test' });
    expect(clause).toContain('memory.recall');
    expect(clause).toContain('intent {"project":"proj-test"}');
    expect(clause).not.toMatch(/[\n\r\t]/);
  });
});

describe('draftProblem recall clause (DES-MEM-FACETED-001 Phase 3)', () => {
  const doc = { documentId: 'my-doc', brief: 'a brief', sourcePaths: [], style: 'web', projectId: 'proj-test' };

  it('PRESENT with the correct project intent JSON when an intent with a project is passed', () => {
    const problem = draftProblem(doc, '/tmp/out.html', undefined, { project: 'proj-test' });
    expect(problem).toContain('call the wicked-estate MCP memory.recall tool with intent {"project":"proj-test"}');
    expect(problem).not.toMatch(/[\n\r\t]/); // still single-line (FINDING-011)
  });

  it('ABSENT when no intent / an empty intent is passed (back-compat — existing behavior)', () => {
    expect(draftProblem(doc, '/tmp/out.html')).not.toContain('memory.recall');
    expect(draftProblem(doc, '/tmp/out.html', undefined, {})).not.toContain('memory.recall');
    // The unfiled/no-intent prompt is byte-identical to before this phase.
    expect(draftProblem(doc, '/tmp/out.html', undefined, {})).toBe(draftProblem(doc, '/tmp/out.html'));
  });

  it('carries only the defined axes in the embedded JSON (no undefined/null keys)', () => {
    const problem = draftProblem(doc, '/tmp/out.html', undefined, { project: 'proj-test' });
    // The recall INTENT object is exactly {"project":...} — the closing brace right after the value
    // proves no cli/repo axis leaked in (a stray axis would push the brace past the value). A blanket
    // not.toContain('"cli"') can't be used: the propose clause legitimately carries a {"cli":"codex"}
    // example. undefined/null keys must never appear anywhere.
    expect(problem).toContain('intent {"project":"proj-test"} and');
    expect(problem).not.toContain('undefined');
  });

  it('unconditionally instructs the worker to submit reusable learnings to the proposal queue', () => {
    // The propose clause (DES-MEM-FACETED-001 write side) is present regardless of intent — every
    // worker may propose — and points at the estate MCP proposal.submit tool (a SAFE write: inert
    // until an operator approves it). Single-line by contract.
    const withIntent = draftProblem(doc, '/tmp/out.html', undefined, { project: 'p1' });
    const noIntent = draftProblem(doc, '/tmp/out.html', undefined, undefined);
    for (const p of [withIntent, noIntent]) {
      expect(p).toContain('proposal.submit');
      expect(p).toContain('kind_type "memory"');
      expect(p).not.toMatch(/[\n\r\t]/);
    }
  });
});

describe('resolveProjectRepo (CREW-UX-8: the project → repo binding)', () => {
  const adapterWith = (
    members: Array<{ member_kind: string; member_ref: string }>,
    repos: Array<{ id: string; root_path: string }>,
  ) =>
    ({
      projectMembers: async () => members,
      listRepos: async () => repos,
    }) as unknown as CoreAdapter;

  it('resolves a crew.repo member through the repo registry to {repoRef, rootPath}', async () => {
    const adapter = adapterWith(
      [
        { member_kind: 'crew.run', member_ref: 'run-1' },
        { member_kind: 'crew.repo', member_ref: 'repo-1' },
      ],
      [{ id: 'repo-1', root_path: '/home/me/src/wicked-studio' }],
    );
    await expect(resolveProjectRepo(adapter, 'proj-7')).resolves.toEqual({
      repoRef: 'repo-1',
      rootPath: '/home/me/src/wicked-studio',
    });
  });

  it('returns undefined for a repo-less project (no crew.repo member)', async () => {
    const adapter = adapterWith([{ member_kind: 'crew.run', member_ref: 'run-1' }], []);
    await expect(resolveProjectRepo(adapter, 'proj-7')).resolves.toBeUndefined();
  });

  it('returns undefined for a STALE member whose repo left the registry — never a fabricated ref', async () => {
    const logged: string[] = [];
    const adapter = adapterWith([{ member_kind: 'crew.repo', member_ref: 'gone' }], []);
    await expect(resolveProjectRepo(adapter, 'proj-7', (m) => logged.push(m))).resolves.toBeUndefined();
    expect(logged.some((m) => m.includes('gone'))).toBe(true);
  });

  it('degrades to undefined when the adapter cannot answer (old addon / engine hiccup)', async () => {
    const throwing = {
      projectMembers: async () => {
        throw new Error('projects unsupported');
      },
    } as unknown as CoreAdapter;
    await expect(resolveProjectRepo(throwing, 'proj-7', () => {})).resolves.toBeUndefined();
    // A fake with NO projectMembers at all (the sibling tests' adapters) degrades the same way.
    await expect(resolveProjectRepo({} as CoreAdapter, 'proj-7', () => {})).resolves.toBeUndefined();
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
    removeScratch(dir);
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

/** Optional project→repo world for the CREW-UX-8 grounding path: projectMembers/listRepos
 *  answer from these fixtures. Omitted (the default) = an engine that cannot answer either —
 *  the graceful-degradation path every pre-existing test rides. */
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
    removeScratch(dir);
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
    // Per-run isolation (Copilot, crew#313): the deliverable lives in the run's OWN subdir.
    const outPath = join(draftDir, 'spike-doc', 'spike-doc-v1.html');
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

    // Phase transition narration folds the run's own events into the thread. 2/3, not 2/2: the
    // run carries the crew#311 deliverable floor as a third unit.
    engine.fire({ type: 'unitDispatched', session: launch.sessionId, ord: 2, attempt: 0 });
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          String((e.payload as { message?: string }).message).includes('2/3'),
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
    await waitFor(narrated('checking the file landed'));
    // The floor's own gate is what says "landing it now" — the draft is announced once the
    // FILE is verified, never on the strength of the worker's reply alone (crew#311).
    engine.fire({ type: 'unitDispatched', session: launch.sessionId, ord: 3, attempt: 0 });
    await waitFor(narrated('3/3'));
    engine.fire({ type: 'gateDecided', session: launch.sessionId, ord: 3, allow: true });
    await waitFor(narrated('landing it now'));

    // The worker "wrote" the draft; completion announces it by path with the deterministic key.
    mkdirSync(join(draftDir, 'spike-doc'), { recursive: true });
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
    const outPath = join(draftDir, 'spike-doc', 'spike-doc-v1.html');
    mkdirSync(join(draftDir, 'spike-doc'), { recursive: true });
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

  // ── crew#311: the deliverable floor ────────────────────────────────────────────────────────
  //
  // THE REPRODUCER, at the seam. A draft run's worker had its Write policy-denied, so no file
  // was ever produced — and the unit still passed its execution gate on ~200 chars of narration.
  // The seam now DECLARES the draft path as the run's deliverable, so the engine runs crew's
  // floor phase, that phase exits non-zero, and the RUN FAILS. The thread must say which file
  // was expected and what was found, and must announce no draft.
  it('DECLARES the draft file as the run deliverable so a run that writes nothing FAILS its gate', async () => {
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
    armProbe(bus);

    await emitDocCreated(bus, 'spike-doc');
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    const outPath = join(draftDir, 'spike-doc', 'spike-doc-v1.html');
    // The declaration IS the fix: without it the engine composes no floor phase and the only
    // check left is the 200-char prose floor the reproducer cleared.
    expect(launch.requireDeliverables).toEqual([outPath]);

    // The engine runs the floor, it finds nothing, and the run fails carrying the floor's own
    // report as `stepFailed.detail`.
    const denied =
      '[wicked-crew] EXPECTED: ' + outPath + '\n' +
      '[wicked-crew] FOUND:    (nothing)\n' +
      '[wicked-crew] MISSING:  ' + outPath + ' (does not exist)\n' +
      '[wicked-crew] DELIVERABLE FLOOR FAILED — the run reported done without producing the artifact(s) it was launched to produce.\n[exit 1]';
    engine.fire({
      type: 'stepFailed',
      session: launch.sessionId,
      ord: 3,
      attempt: 0,
      detail: denied,
      failureKind: 'workerError',
    });
    engine.fire({ type: 'sessionFailed', session: launch.sessionId, ord: 3 });

    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    const err = probeEvents.filter(
      (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
    ).pop()!;
    const message = String((err.payload as { message?: string }).message);
    // HONEST: names the artifact that was expected and says nothing was found.
    expect(message).toContain(outPath);
    expect(message).toContain('DELIVERABLE FLOOR FAILED');
    // `oneLine` collapses the report's runs of whitespace onto the single-line status.
    expect(message).toContain('FOUND: (nothing)');
    // No phantom draft, and the ledger records the failure so a replay can retry.
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
    // produced (run eed69dfa) — the declared outPath must be inside a declared root. And the
    // root is the run's OWN subdir, never the shared draftDir (Copilot, crew#313: wholesale
    // declaration = cross-project read/write exposure).
    expect(engine.launches[0]!.extraWriteRoots).toEqual([join(dir, 'drafts', 'bound-doc')]);

    // Unbound doc → an UNFILED governed run (DES-UX-001 slice U): the launch happens, the
    // projectId key is OMITTED (never a fabricated 'default'), and onRunFiled does NOT fire —
    // there is no project to attach the membership to (CREW-UX-2: project_id null on the DTO).
    await emitDocCreated(bus, 'unbound-doc');
    await waitFor(() => engine.launches.length === 2);
    const unfiled = engine.launches[1]!;
    expect(unfiled.projectId).toBeUndefined();
    expect('projectId' in unfiled).toBe(false);
    expect(unfiled.workflow).toBe(INTERACTIVE_DRAFT_WORKFLOW);
    expect(unfiled.problem).toContain('"unbound-doc"');
    // The launch is otherwise IDENTICAL to the bound one: same write-root SHAPE (crew#263) —
    // its own per-run subdir, disjoint from every other run's (Copilot, crew#313).
    expect(unfiled.extraWriteRoots).toEqual([join(dir, 'drafts', 'unbound-doc')]);
    // …and the same ledger row shape, so replay dedupe works for unfiled docs too.
    expect(sub!.ledger.get('unbound-doc')?.runId).toBe(unfiled.sessionId);
    expect(filed).toHaveLength(1); // still only the bound doc's filing
  });

  /** A real (plain-dir) repo fixture the v4 snapshot path can clone/copy from. */
  function seedRepoFixture(name = 'the-repo'): string {
    const root = join(dir, name);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# the real studio project\n', 'utf8');
    writeFileSync(join(root, 'src', 'main.ts'), 'export const real = true;\n', 'utf8');
    return root;
  }

  it('SNAPSHOTS the repo into the inbox BEFORE the launch and grounds the task on the snapshot — the launch stays UNBOUND (CREW-UX-8 v4)', async () => {
    const bus = await import('wicked-bus');
    const repoRoot = seedRepoFixture();
    const engine = fakeAdapter({
      members: {
        'proj-repo': [
          { member_kind: 'crew.run', member_ref: 'run-0' },
          { member_kind: 'crew.repo', member_ref: 'repo-studio' },
        ],
        'proj-bare': [{ member_kind: 'crew.run', member_ref: 'run-1' }],
      },
      repos: [{ id: 'repo-studio', root_path: repoRoot }],
    });
    const draftDir = join(dir, 'drafts');
    let snapshotExistedAtLaunch = false;
    const adapter = engine.asAdapter();
    const inner = adapter.launchRun.bind(adapter);
    (adapter as unknown as { launchRun: unknown }).launchRun = async (input: LaunchRunInput) => {
      // The ORDER is the contract: the snapshot must be on disk before launchRun resolves —
      // a worker grounded on a path that appears later would race its own recon phase.
      snapshotExistedAtLaunch = existsSync(join(draftDir, 'repo-doc', 'repo', 'README.md'));
      return inner(input);
    };
    const sub = await startInteractiveDraftSubscriber(adapter, {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir,
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub!);

    // Bound to a repo-backed project → the task names the in-inbox SNAPSHOT to read, and the
    // launch carries NO repoRef and keeps the ONE unbound write shape (external inbox
    // deliverable + extraWriteRoots): a repoRef binding kills the session (wicked-core#293)
    // and the unbound boundary denies live-repo reads (wicked-core#294) — the snapshot sits
    // inside extraWriteRoots, which are readable (wicked-core#259).
    await emitDocCreated(bus, 'repo-doc', { project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 1);
    const grounded = engine.launches[0]!;
    // Per-run isolation (Copilot, crew#313): snapshot AND deliverable live inside the run's
    // OWN subdir, which is the ONE declared write root — another project's worker has no path
    // into this project's source.
    const runDir = join(draftDir, 'repo-doc');
    const snapDir = join(runDir, 'repo');
    expect(snapshotExistedAtLaunch, 'snapshot must exist before launchRun').toBe(true);
    expect('repoRef' in grounded).toBe(false);
    // PRIMARY grounding is the estate MCP index; the snapshot is named only as the offline
    // fallback (DES-GROUNDING-001 §3.3).
    expect(grounded.problem).toContain('wicked-estate MCP tools');
    expect(grounded.problem).toContain(
      `If the estate tools are unavailable, fall back to the offline repository snapshot at ${snapDir}`,
    );
    expect(grounded.problem).not.toContain(repoRoot); // the live root never reaches the task
    expect(grounded.problem).toContain(
      `exactly this absolute file path: ${join(runDir, 'repo-doc-v1.html')}`,
    );
    expect(grounded.extraWriteRoots).toEqual([runDir]);
    expect(grounded.problem).not.toMatch(/[\n\r]/);
    expect(grounded.projectId).toBe('proj-repo'); // filing is unaffected by the unbound launch
    // The snapshot holds the repo's REAL content, inside the readable inbox.
    expect(readFileSync(join(snapDir, 'README.md'), 'utf8')).toContain('the real studio project');
    expect(readFileSync(join(snapDir, 'src', 'main.ts'), 'utf8')).toContain('real = true');

    // Bound to a REPO-LESS project → launches exactly as today: no clause, no snapshot dir,
    // same write shape.
    await emitDocCreated(bus, 'bare-doc', { project_id: 'proj-bare' });
    await waitFor(() => engine.launches.length === 2);
    const bare = engine.launches[1]!;
    expect('repoRef' in bare).toBe(false);
    // Still estate-grounded (§3.3), just no snapshot fallback clause since none was made.
    expect(bare.problem).toContain('wicked-estate MCP tools');
    expect(bare.problem).not.toContain('fall back to the offline repository snapshot');
    expect(bare.problem).toContain(join(draftDir, 'bare-doc', 'bare-doc-v1.html'));
    expect(bare.extraWriteRoots).toEqual([join(draftDir, 'bare-doc')]);
    expect(existsSync(join(draftDir, 'bare-doc', 'repo'))).toBe(false);

    // UNBOUND doc → no membership lookup at all: no clause, no projectId, same write shape.
    await emitDocCreated(bus, 'free-doc');
    await waitFor(() => engine.launches.length === 3);
    const free = engine.launches[2]!;
    expect('repoRef' in free).toBe(false);
    expect('projectId' in free).toBe(false);
    // Unbound docs still carry the estate-tool grounding clause; no snapshot fallback.
    expect(free.problem).toContain('wicked-estate MCP tools');
    expect(free.problem).not.toContain('fall back to the offline repository snapshot');
    expect(free.extraWriteRoots).toEqual([join(draftDir, 'free-doc')]);

    // ISOLATION is the point (Copilot, crew#313): no launch ever declares the SHARED root, and
    // the grounded run's snapshot is invisible to every other run's declared root.
    for (const l of engine.launches) expect(l.extraWriteRoots).not.toEqual([draftDir]);
    expect(free.extraWriteRoots![0]!.startsWith(join(draftDir, 'repo-doc'))).toBe(false);
  });

  it('DEGRADES HONESTLY when the repo cannot be snapshotted: ungrounded launch + a visible status note (CREW-UX-8 v4)', async () => {
    const bus = await import('wicked-bus');
    const repoRoot = seedRepoFixture(); // ~50 bytes — over a 10-byte budget
    const engine = fakeAdapter({
      members: { 'proj-repo': [{ member_kind: 'crew.repo', member_ref: 'repo-studio' }] },
      repos: [{ id: 'repo-studio', root_path: repoRoot }],
    });
    const logged: string[] = [];
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir: join(dir, 'drafts'),
      clisJson: SEATS,
      repoSnapshotMaxBytes: 10,
      log: (m) => logged.push(m),
    });
    subs.push(sub!);
    armProbe(bus);

    await emitDocCreated(bus, 'big-doc', { project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 1);
    // The launch HAPPENED — degradation never eats the doc — but ungrounded: no clause, no
    // snapshot on disk, the standard unbound shape.
    const launch = engine.launches[0]!;
    // Degraded snapshot ⇒ no fallback clause, but the estate-tool grounding still stands.
    expect(launch.problem).toContain('wicked-estate MCP tools');
    expect(launch.problem).not.toContain('fall back to the offline repository snapshot');
    expect(launch.problem).not.toContain(repoRoot);
    expect(existsSync(join(dir, 'drafts', 'big-doc', 'repo'))).toBe(false);
    expect(launch.extraWriteRoots).toEqual([join(dir, 'drafts', 'big-doc')]);
    // The user sees WHY the draft is not repo-grounded…
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          String((e.payload as { message?: string }).message).includes(
            'repository too large to snapshot — drafting without repo grounding',
          ),
      ),
    );
    // …and the operator sees the real reason in the log.
    expect(logged.some((m) => m.includes('snapshot budget'))).toBe(true);
    expect(logged.some((m) => m.includes('launching ungrounded'))).toBe(true);
  });

  it('REFUSES the whole launch when the configured draft dir overlaps the repo — fail closed, no mkdir, no run, no ledger row (Copilot round 2)', async () => {
    const bus = await import('wicked-bus');
    const repoRoot = seedRepoFixture();
    const engine = fakeAdapter({
      members: { 'proj-repo': [{ member_kind: 'crew.repo', member_ref: 'repo-studio' }] },
      repos: [{ id: 'repo-studio', root_path: repoRoot }],
    });
    // The bad config this guards: a draft dir INSIDE the registered repo. An "ungrounded"
    // degrade would still declare extraWriteRoots inside the live repo — the run must not
    // happen at all.
    const draftDir = join(repoRoot, 'drafts');
    const logged: string[] = [];
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir,
      clisJson: SEATS,
      log: (m) => logged.push(m),
    });
    subs.push(sub!);
    armProbe(bus);

    await emitDocCreated(bus, 'trapped-doc', { project_id: 'proj-repo' });
    // The refusal closes the thread with an error status that names the CONFIG problem…
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          (e.payload as { state?: string }).state === 'error' &&
          String((e.payload as { message?: string }).message).includes('overlaps'),
      ),
    );
    const refusal = probeEvents.find(
      (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
    )!;
    expect(String((refusal.payload as { message?: string }).message)).toContain(draftDir);
    // …and NOTHING else happened: no launch, no ledger row (a replay after the config fix
    // gets a real retry), no directory materialized inside the live repository, no lingering
    // busy state.
    expect(engine.launches.length).toBe(0);
    expect(sub!.ledger.has('trapped-doc')).toBe(false);
    expect(existsSync(join(draftDir, 'trapped-doc'))).toBe(false);
    expect(sub!.inFlightDocs()).toEqual([]);
    expect(logged.some((m) => m.includes('REFUSING launch'))).toBe(true);
    // The live repo content survived the refusal untouched.
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toContain('the real studio project');
  });

  it('marks the doc BUSY across the whole pre-launch window — a pre-flight placeholder covers the snapshot/launch awaits (Copilot round 2)', async () => {
    const bus = await import('wicked-bus');
    const repoRoot = seedRepoFixture();
    const engine = fakeAdapter({
      members: { 'proj-repo': [{ member_kind: 'crew.repo', member_ref: 'repo-studio' }] },
      repos: [{ id: 'repo-studio', root_path: repoRoot }],
    });
    const draftDir = join(dir, 'drafts');
    // Hold launchRun open: everything up to the engine accepting the run is "pre-launch".
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const adapter = engine.asAdapter();
    const inner = adapter.launchRun.bind(adapter);
    (adapter as unknown as { launchRun: unknown }).launchRun = async (input: LaunchRunInput) => {
      const p = inner(input);
      await gate;
      return p;
    };
    const sub = await startInteractiveDraftSubscriber(adapter, {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir,
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub!);

    await emitDocCreated(bus, 'slow-doc', { project_id: 'proj-repo' });
    // BEFORE the launch (or even the snapshot) resolves, the doc already reads busy — this is
    // what the chat seam's isDocBusy consults, so the old post-launch registration left a
    // double-launch window across the whole snapshot-then-launch stretch.
    await waitFor(() => sub!.inFlightDocs().includes('slow-doc'));
    // …and it STAYS busy through the engine call while the launch is held open.
    await waitFor(() => engine.launches.length === 1);
    expect(sub!.inFlightDocs()).toContain('slow-doc');
    // …with no ledger row yet (that still waits for the launch to resolve).
    expect(sub!.ledger.has('slow-doc')).toBe(false);

    release();
    await waitFor(() => sub!.ledger.get('slow-doc')?.runId !== undefined);
    expect(sub!.inFlightDocs()).toEqual(['slow-doc']); // now a live flight with a heartbeat
  });

  it('stop() during the pre-launch window sweeps the placeholder AND its snapshot, and the wedged launch still earns its dedupe row (Copilot round 2)', async () => {
    const bus = await import('wicked-bus');
    const repoRoot = seedRepoFixture();
    const engine = fakeAdapter({
      members: { 'proj-repo': [{ member_kind: 'crew.repo', member_ref: 'repo-studio' }] },
      repos: [{ id: 'repo-studio', root_path: repoRoot }],
    });
    const draftDir = join(dir, 'drafts');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const adapter = engine.asAdapter();
    const inner = adapter.launchRun.bind(adapter);
    (adapter as unknown as { launchRun: unknown }).launchRun = async (input: LaunchRunInput) => {
      const p = inner(input);
      await gate;
      return p;
    };
    const sub = await startInteractiveDraftSubscriber(adapter, {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir,
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub!);

    await emitDocCreated(bus, 'wedged-doc', { project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 1);
    const snap = join(draftDir, 'wedged-doc', 'repo');
    expect(existsSync(join(snap, 'README.md'))).toBe(true);

    // stop() while the launch is still pending: the sweep sees the PLACEHOLDER (the old code
    // registered the flight only after launchRun resolved, so this snapshot was stranded).
    const stopping = sub!.stop();
    expect(existsSync(snap), 'the shutdown sweep must remove a pre-launch snapshot').toBe(false);
    expect(sub!.inFlightDocs()).toEqual([]);

    // When the wedged launch finally resolves, the closed seam records the ledger row (the
    // engine DID accept the run — a post-restart redelivery must not double-launch) and goes
    // quiet: no heartbeat, no filing, no revived flight.
    release();
    await stopping;
    await waitFor(() => sub!.ledger.get('wedged-doc')?.runId !== undefined);
    expect(sub!.inFlightDocs()).toEqual([]);
  });

  it('REMOVES the snapshot when the run ends — success AND failure paths (CREW-UX-8 v4)', async () => {
    const bus = await import('wicked-bus');
    const repoRoot = seedRepoFixture();
    const engine = fakeAdapter({
      members: { 'proj-repo': [{ member_kind: 'crew.repo', member_ref: 'repo-studio' }] },
      repos: [{ id: 'repo-studio', root_path: repoRoot }],
    });
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

    // Success path: the run completes with a real deliverable → finalize removes the snapshot.
    await emitDocCreated(bus, 'ok-doc', { project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 1);
    const okSnap = join(draftDir, 'ok-doc', 'repo');
    expect(existsSync(join(okSnap, 'README.md'))).toBe(true);
    writeFileSync(join(draftDir, 'ok-doc', 'ok-doc-v1.html'), '<html><body>grounded</body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });
    await waitFor(() => sub!.ledger.get('ok-doc')?.emittedAt !== undefined);
    expect(existsSync(okSnap), 'success finalize must remove the snapshot').toBe(false);

    // Failure path: the run dies → the failure fold removes the snapshot too.
    await emitDocCreated(bus, 'dead-doc', { project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 2);
    const deadSnap = join(draftDir, 'dead-doc', 'repo');
    expect(existsSync(join(deadSnap, 'README.md'))).toBe(true);
    engine.fire({ type: 'sessionFailed', session: engine.launches[1]!.sessionId, ord: 1 });
    await waitFor(() => sub!.ledger.get('dead-doc')?.failedAt !== undefined);
    expect(existsSync(deadSnap), 'the failure path must remove the snapshot too').toBe(false);

    // Shutdown path (Copilot, crew#313): stop() with a run STILL IN FLIGHT sweeps its snapshot
    // too — after a restart the ledger row suppresses redelivery, so nothing would ever
    // revisit a clone stranded here.
    await emitDocCreated(bus, 'live-doc', { project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 3);
    const liveSnap = join(draftDir, 'live-doc', 'repo');
    expect(existsSync(join(liveSnap, 'README.md'))).toBe(true);
    await sub!.stop();
    expect(existsSync(liveSnap), 'stop() must sweep in-flight snapshots').toBe(false);
  });

  it('a GROUNDED doc completes the full loop through the ONE standard finalize — inbox file in, inbox path announced, snapshot gone', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter({
      members: { 'proj-repo': [{ member_kind: 'crew.repo', member_ref: 'repo-studio' }] },
      repos: [{ id: 'repo-studio', root_path: seedRepoFixture() }],
    });
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
    armProbe(bus);

    await emitDocCreated(bus, 'repo-doc', { project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 1);

    // The worker wrote the external-inbox deliverable — the ONLY write shape v4 has (the
    // in-inbox snapshot is READ-only grounding context; wicked-core#293 killed every
    // bound-write variant and wicked-core#294 killed live-repo reads).
    const inboxPath = join(draftDir, 'repo-doc', 'repo-doc-v1.html');
    mkdirSync(join(draftDir, 'repo-doc'), { recursive: true });
    writeFileSync(inboxPath, '<html><body><h1>grounded draft</h1></body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });

    await waitFor(() => probeEvents.some((e) => e.event_type === DRAFT_COMPLETED));
    const draft = probeEvents.find((e) => e.event_type === DRAFT_COMPLETED)!;
    expect((draft.payload as { html_path?: string }).html_path).toBe(inboxPath);
    expect(readFileSync(inboxPath, 'utf8')).toContain('grounded draft');
    expect(draft.idempotency_key).toBe(draftIdempotencyKey('repo-doc'));
    expect(sub!.ledger.get('repo-doc')?.emittedAt).toBeTruthy();
    // The launch-scoped snapshot did not outlive its run.
    expect(existsSync(join(draftDir, 'repo-doc', 'repo'))).toBe(false);
  });

  it('a STALE repo membership never fabricates a repoRef — the launch degrades to repo-less (CREW-UX-8)', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter({
      members: { 'proj-repo': [{ member_kind: 'crew.repo', member_ref: 'deleted-repo' }] },
      repos: [], // the registry no longer knows the ref
    });
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

    await emitDocCreated(bus, 'stale-doc', { project_id: 'proj-repo' });
    await waitFor(() => engine.launches.length === 1);
    expect('repoRef' in engine.launches[0]!).toBe(false);
    // Registry no longer knows the ref ⇒ no snapshot fallback, estate grounding still present.
    expect(engine.launches[0]!.problem).toContain('wicked-estate MCP tools');
    expect(engine.launches[0]!.problem).not.toContain('fall back to the offline repository snapshot');
  });

  it('an UNFILED doc completes the full loop -- draft.completed lands with the same idempotency key discipline', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const draftDir = join(dir, 'drafts');
    const filed: Array<[string, string]> = [];
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      draftDir,
      clisJson: SEATS,
      onRunFiled: (runId, projectId) => filed.push([runId, projectId]),
      log: () => {},
    });
    subs.push(sub!);
    armProbe(bus);

    await emitDocCreated(bus, 'unfiled-doc'); // no project_id at all — the slice-U shape
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect('projectId' in launch).toBe(false);

    // A replayed unbound doc.created must not double-launch (ledger dedupe is project-agnostic).
    await emitDocCreated(bus, 'unfiled-doc');
    await new Promise((r) => setTimeout(r, 200));
    expect(engine.launches.length).toBe(1);

    const outPath = join(draftDir, 'unfiled-doc', 'unfiled-doc-v1.html');
    mkdirSync(join(draftDir, 'unfiled-doc'), { recursive: true });
    writeFileSync(outPath, '<html><body><h1>Unfiled draft</h1></body></html>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: launch.sessionId });
    await waitFor(() => probeEvents.some((e) => e.event_type === DRAFT_COMPLETED));
    const draft = probeEvents.find((e) => e.event_type === DRAFT_COMPLETED)!;
    expect((draft.payload as { document_id?: string }).document_id).toBe('unfiled-doc');
    expect((draft.payload as { html_path?: string }).html_path).toBe(outPath);
    expect(draft.idempotency_key).toBe(draftIdempotencyKey('unfiled-doc'));
    expect(sub!.ledger.get('unfiled-doc')?.emittedAt).toBeTruthy();
    expect(filed).toHaveLength(0); // an unfiled run is never reported as filed
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
    expect(existsSync(join(dir, 'drafts', 'spike-doc', 'spike-doc-v1.html'))).toBe(false);
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
