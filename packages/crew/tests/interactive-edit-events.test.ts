// The interactive STRUCTURAL-edit seam (task #86, Phase 7c final leg).
//
// What these tests pin, and why:
//  - the TRIGGER contract: only `wicked.interactive.feedback.processed` carrying USABLE
//    structural items is actionable — deterministic-only batches (awaiting_structural 0)
//    stay inside the model-free service, and a malformed document_id/version must never
//    name a ledger key or a file path;
//  - VERSIONED TARGETING: the dedupe unit is doc+version (a handoff), NOT the doc — the same
//    doc's next feedback batch launches normally while a REPLAY of the same handoff never
//    double-launches (in-process, across restart, and at the bus via the doc+version key);
//  - the INV-2 PRE-EMIT SELF-CHECK: a worker fragment that drops a pre-existing data-wid is
//    rejected BEFORE the emit — error status, failure row, NO edit.completed (the service
//    would otherwise reject it silently and the user's edit would just die);
//  - PROJECT ATTRIBUTION: a project-bound doc's `project_id` rides the handoff into
//    LaunchOptions.projectId (the 7b surface), and unbound docs launch without one;
//  - the LOOP: a real (temp-file) wicked-bus carries feedback.processed in and status.posted /
//    edit.completed back out, stamped `wi-crew`. The engine itself is faked — the governed
//    run's mechanics are wicked-core's tests' business; THIS seam's business is everything
//    around it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import {
  FEEDBACK_PROCESSED,
  EDIT_COMPLETED,
  INTERACTIVE_EDIT_BUS_FILTER,
  INTERACTIVE_EDIT_BUS_PLUGIN,
  INTERACTIVE_EDIT_WORKFLOW,
  INTERACTIVE_EDIT_WORKFLOW_DEF,
  parseStructuralFeedback,
  handoffKey,
  editIdempotencyKey,
  handoffFileItems,
  editProblem,
  fragmentWids,
  droppedWids,
  collectEditResults,
  startInteractiveEditSubscriber,
} from '../src/interactive/edit-events.js';
import { STATUS_POSTED, INTERACTIVE_PRODUCER } from '../src/interactive/draft-events.js';
import { InteractiveHandoffLedger } from '../src/interactive/ledger.js';
import { projectGraphDb, projectGraphManifest, repoLabel } from '../src/projects/graph-paths.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const FRAGMENT = '<h2 data-wid="slide-2-heading-1">One bus, many hands</h2>';

const payload = {
  document_id: 'q3-board-deck',
  version: 2,
  applied: ['slide-0-heading-1'],
  rejected: [],
  stale: [],
  awaiting_structural: 1,
  structural_items: [
    { selector: 'slide-2-heading-1', instruction: 'make this punchier', fragment: FRAGMENT },
  ],
  ts: '2026-08-12T00:00:00Z',
};

describe('parseStructuralFeedback', () => {
  it('accepts a structural handoff and carries doc/version/items', () => {
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, payload)).toEqual({
      documentId: 'q3-board-deck',
      version: 2,
      items: [
        { selector: 'slide-2-heading-1', instruction: 'make this punchier', fragment: FRAGMENT },
      ],
    });
  });

  it('carries project_id when the doc is project-bound (the 7b surface)', () => {
    const handoff = parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, project_id: 'proj-1' });
    expect(handoff?.projectId).toBe('proj-1');
    // …and an empty/absent binding yields NO projectId, not an empty string.
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, project_id: '' })?.projectId).toBeUndefined();
  });

  it('ignores deterministic-only batches — those edits already landed inside the service', () => {
    expect(
      parseStructuralFeedback(FEEDBACK_PROCESSED, {
        ...payload,
        awaiting_structural: 0,
        structural_items: [],
      }),
    ).toBeNull();
  });

  it('refuses an inconsistent frame: structural_items present but awaiting_structural 0/absent/garbage', () => {
    // Producer drift must never launch a governed run — the declared size is the explicit gate.
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, awaiting_structural: 0 })).toBeNull();
    const withoutAwaiting: Record<string, unknown> = { ...payload };
    delete withoutAwaiting['awaiting_structural'];
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, withoutAwaiting)).toBeNull();
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, awaiting_structural: '1' })).toBeNull();
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, awaiting_structural: 1.5 })).toBeNull();
  });

  it('drops items whose fragment the service could not extract, and nulls out when none survive', () => {
    const one = parseStructuralFeedback(FEEDBACK_PROCESSED, {
      ...payload,
      structural_items: [
        { selector: 'gone-wid', instruction: 'x', fragment: null },
        ...payload.structural_items,
      ],
    });
    expect(one?.items).toHaveLength(1);
    expect(one?.items[0]?.selector).toBe('slide-2-heading-1');
    expect(
      parseStructuralFeedback(FEEDBACK_PROCESSED, {
        ...payload,
        structural_items: [{ selector: 'gone-wid', instruction: 'x', fragment: null }],
      }),
    ).toBeNull();
  });

  it('ignores other event types, malformed payloads, slug-invalid ids, and bad versions', () => {
    expect(parseStructuralFeedback('wicked.interactive.chat.posted', payload)).toBeNull();
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, 'not-an-object')).toBeNull();
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, document_id: '../escape' })).toBeNull();
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, version: 2.5 })).toBeNull();
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, version: -1 })).toBeNull();
    expect(parseStructuralFeedback(FEEDBACK_PROCESSED, { ...payload, version: '2' })).toBeNull();
  });
});

describe('handoff identity (versioned targeting)', () => {
  it('keys the handoff by doc AND version — the same doc re-edits under a new key', () => {
    expect(handoffKey('my-doc', 2)).toBe('my-doc:v2');
    expect(handoffKey('my-doc', 4)).not.toBe(handoffKey('my-doc', 2));
  });

  it('derives a deterministic idempotency key per doc+version, unlike the draft leg (doc-lifetime)', () => {
    expect(editIdempotencyKey('my-doc', 2)).toBe('crew:interactive.edit:my-doc:v2');
    expect(editIdempotencyKey('my-doc', 2)).not.toBe(editIdempotencyKey('my-doc', 3));
  });
});

describe('editProblem + handoff file items (the worker contract)', () => {
  const handoff = {
    documentId: 'my-doc',
    version: 5,
    items: [
      { selector: 'a', instruction: 'first\nline two', fragment: '<p data-wid="a">x</p>' },
      { selector: 'b', instruction: 'second', fragment: '<p data-wid="b">y</p>' },
    ],
  };

  it('is ALWAYS single-line — a PTY seat refuses embedded newlines (FINDING-011)', () => {
    const problem = editProblem(handoff, '/tmp/edits/my-doc-v5-handoff.json');
    expect(problem).not.toMatch(/[\n\r\t]/);
    expect(problem).toContain('first line two; second');
  });

  it('names the document, the version, the item count, and the handoff path — never the fragments', () => {
    const problem = editProblem(handoff, '/tmp/edits/my-doc-v5-handoff.json');
    expect(problem).toContain('"my-doc"');
    expect(problem).toContain('version 5');
    expect(problem).toContain('2 structural edit(s)');
    expect(problem).toContain('/tmp/edits/my-doc-v5-handoff.json');
    expect(problem).not.toContain('<p'); // fragments ride the FILE, not the prompt
  });

  it('caps a pasted-novel instruction instead of ballooning the prompt', () => {
    const big = editProblem(
      { ...handoff, items: [{ selector: 'a', instruction: 'x'.repeat(5000), fragment: '<p data-wid="a">x</p>' }] },
      '/o.json',
    );
    expect(big.length).toBeLessThan(1900);
    expect(big).toContain('…');
  });

  it('names per-item output files by INDEX, never by the bus-supplied selector', () => {
    const items = handoffFileItems(
      {
        documentId: 'd',
        version: 1,
        items: [{ selector: '../../etc/passwd', instruction: 'x', fragment: '<p data-wid="w">x</p>' }],
      },
      '/out',
    );
    expect(items[0]?.output_path).toBe(join('/out', 'fragment-1.html'));
  });
});

describe('editProblem recall clause (DES-MEM-FACETED-001 Phase 3)', () => {
  const handoff = {
    documentId: 'my-doc',
    version: 5,
    items: [{ selector: 'a', instruction: 'punchier', fragment: '<p data-wid="a">x</p>' }],
  };

  it('PRESENT with the correct project intent JSON when an intent with a project is passed', () => {
    const problem = editProblem(handoff, '/tmp/edits/handoff.json', { project: 'proj-test' });
    expect(problem).toContain('call the wicked-estate MCP memory.recall tool with intent {"project":"proj-test"}');
    expect(problem).not.toMatch(/[\n\r\t]/); // still single-line (FINDING-011)
  });

  it('ABSENT when no intent / an empty intent is passed (back-compat — existing behavior)', () => {
    expect(editProblem(handoff, '/tmp/edits/handoff.json')).not.toContain('memory.recall');
    expect(editProblem(handoff, '/tmp/edits/handoff.json', {})).not.toContain('memory.recall');
    // The unfiled/no-intent prompt is byte-identical to before this phase.
    expect(editProblem(handoff, '/tmp/edits/handoff.json', {})).toBe(
      editProblem(handoff, '/tmp/edits/handoff.json'),
    );
  });

  it('carries only the defined axes in the embedded JSON (no undefined/null keys)', () => {
    const problem = editProblem(handoff, '/tmp/edits/handoff.json', { project: 'proj-test' });
    // The recall INTENT object is exactly {"project":...}; the propose clause legitimately carries a
    // {"cli":"codex"} example, so scope the axis check to the recall intent rather than a blanket not.
    expect(problem).toContain('intent {"project":"proj-test"} and');
    expect(problem).not.toContain('undefined');
    // the propose clause (write side) rides every interactive prompt
    expect(problem).toContain('proposal.submit');
  });
});

describe('the interactive-edit workflow def (workflows-as-data)', () => {
  const def = INTERACTIVE_EDIT_WORKFLOW_DEF;

  it('is a single creator-role build phase — the handoff already carries the plan', () => {
    expect(def.id).toBe(INTERACTIVE_EDIT_WORKFLOW);
    expect(def.phases.map((p) => p.id)).toEqual(['edit']);
    expect(def.phases[0]?.role).toBe('creator');
    expect(def.phases[0]?.depends_on).toEqual([]);
  });

  it('keeps the phase instruction single-line (the same PTY constraint as the problem)', () => {
    for (const p of def.phases) {
      expect(p.instructions ?? '').not.toMatch(/[\n\r]/);
      expect((p.instructions ?? '').length).toBeGreaterThan(0);
    }
  });

  it('arms no human gate and no validator floor — the seam’s own self-check + interactive’s INV-2 gate stand watch', () => {
    for (const p of def.phases) {
      expect(p.gate).toBe('auto');
      expect(p.validator_pin).toBeNull();
      expect(p.required_deliverables).toEqual([]);
    }
  });

  it('carries the fragment-edit contract from the assist skill (Step 2/3), adapted', () => {
    const edit = def.phases[0]?.instructions ?? '';
    expect(edit).toContain('data-wid');
    expect(edit).toContain('byte-for-byte'); // INV-2 at scale: preservation, not just non-minting
    expect(edit).toContain('INV-2');
    expect(edit).toContain('output_path');
    expect(edit).toMatch(/never fabricate/i);
  });
});

describe('bus identity constants', () => {
  it('subscribes on an exact-type, domain-guarded filter under a dedicated plugin name', () => {
    expect(INTERACTIVE_EDIT_BUS_FILTER).toBe('wicked.interactive.feedback.processed@wicked-interactive');
    // NOT the draft seam's plugin — independent cursors, independently stoppable.
    expect(INTERACTIVE_EDIT_BUS_PLUGIN).toBe('wicked-crew-interactive-edit');
  });
});

describe('the INV-2 pre-emit self-check (assist skill Step 3c, deterministically)', () => {
  it('extracts data-wids and reports byte-exact drops', () => {
    const before = '<div data-wid="card-1"><p data-wid="p-1">x</p><p data-wid="p-2">y</p></div>';
    expect(fragmentWids(before)).toEqual(['card-1', 'p-1', 'p-2']);
    expect(droppedWids(before, before)).toEqual([]);
    expect(droppedWids(before, '<div data-wid="card-1"><p data-wid="p-1">x</p></div>')).toEqual(['p-2']);
    // A re-valued anchor is a drop, not a rename.
    expect(droppedWids('<p data-wid="a">x</p>', '<p data-wid="A">x</p>')).toEqual(['a']);
    // ADDING content (even with new wids) is never a violation — INV-2 is about survival.
    expect(droppedWids(before, `${before}<p>new</p>`)).toEqual([]);
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-iee-check-'));
  });
  afterEach(() => {
    removeScratch(dir);
  });

  it('collects results when every output file preserves its fragment’s wids', () => {
    const items = [
      { selector: 'a', instruction: 'x', fragment: '<p data-wid="a">old</p>', output_path: join(dir, 'f1.html') },
    ];
    writeFileSync(items[0]!.output_path, '<p data-wid="a">new</p>\n', 'utf8');
    const { results, violations } = collectEditResults(items);
    expect(violations).toEqual([]);
    expect(results).toEqual([{ selector: 'a', fragment: '<p data-wid="a">new</p>' }]);
  });

  it('rejects a dropped wid AND a missing/empty output file — all-or-nothing per handoff', () => {
    const items = [
      { selector: 'a', instruction: 'x', fragment: '<p data-wid="a">old</p>', output_path: join(dir, 'f1.html') },
      { selector: 'b', instruction: 'y', fragment: '<p data-wid="b">old</p>', output_path: join(dir, 'f2.html') },
    ];
    writeFileSync(items[0]!.output_path, '<p>anchor stripped</p>', 'utf8'); // INV-2 violation
    // items[1] output never written — a phantom edit
    const { results, violations } = collectEditResults(items);
    expect(results).toEqual([]); // 'a' violated; 'b' missing — nothing usable
    expect(violations).toHaveLength(2);
    expect(violations[0]?.reason).toContain('data-wid');
    expect(violations[0]?.reason).toContain('a');
    expect(violations[1]?.reason).toContain('no edited fragment');
  });
});

describe('InteractiveHandoffLedger (shared with the draft leg)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-ihl-'));
  });
  afterEach(() => {
    removeScratch(dir);
  });

  it('treats each doc+version handoff as its own row', () => {
    const path = join(dir, 'ledger.json');
    const ledger = new InteractiveHandoffLedger(path);
    ledger.recordLaunch(handoffKey('doc-a', 2), 'run-1');
    expect(ledger.has(handoffKey('doc-a', 2))).toBe(true);
    expect(ledger.has(handoffKey('doc-a', 4))).toBe(false); // the doc's NEXT handoff is fresh
    const reloaded = new InteractiveHandoffLedger(path);
    expect(reloaded.get('doc-a:v2')?.runId).toBe('run-1');
  });

  it('migrates the draft leg’s original draftEmittedAt field on load', () => {
    const path = join(dir, 'ledger.json');
    writeFileSync(
      path,
      JSON.stringify({
        docs: { 'doc-a': { runId: 'run-1', launchedAt: 't0', draftEmittedAt: 't1' } },
      }),
      'utf8',
    );
    const ledger = new InteractiveHandoffLedger(path);
    expect(ledger.get('doc-a')?.emittedAt).toBe('t1');
  });

  it('a malformed row costs that row alone — the valid rows still dedupe replays', () => {
    const path = join(dir, 'ledger.json');
    writeFileSync(
      path,
      JSON.stringify({
        docs: {
          'doc-null': null,
          'doc-string': 'not-a-row',
          'doc-no-run': { launchedAt: 't0' },
          'doc-empty-run': { runId: '', launchedAt: 't0' },
          'doc-no-launch': { runId: 'run-9' },
          'doc-good:v2': { runId: 'run-1', launchedAt: 't0', emittedAt: 't1' },
        },
      }),
      'utf8',
    );
    const ledger = new InteractiveHandoffLedger(path);
    expect(ledger.has('doc-good:v2')).toBe(true); // replay-dedup survives the bad neighbors
    expect(ledger.has('doc-null')).toBe(false);
    expect(ledger.has('doc-string')).toBe(false);
    expect(ledger.has('doc-no-run')).toBe(false);
    expect(ledger.has('doc-empty-run')).toBe(false);
    expect(ledger.has('doc-no-launch')).toBe(false);
    expect(ledger.size()).toBe(1);
  });
});

// ── The loop over a real (temp) bus, with a fake engine ─────────────────────────────────────

interface FakeAdapter {
  launches: LaunchRunInput[];
  registered: WorkflowDef[];
  fire: (event: CoreEvent) => void;
  asAdapter(): CoreAdapter;
}

/** Optional project→repo world for the grounding-binding path: projectMembers/listRepos answer
 *  from these fixtures. Omitted (the default) = an engine that cannot answer either — the
 *  graceful-degradation path every pre-existing test rides (binding degrades to null). */
interface RepoWorld {
  members?: Record<string, Array<{ member_kind: string; member_ref: string }>>;
  repos?: Array<{ id: string; root_path: string; code_graph_db?: string }>;
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

describe('startInteractiveEditSubscriber (real bus, fake engine)', () => {
  let dir: string;
  let busDb: string;
  let subs: { stop(): Promise<void> | void }[];
  let probeEvents: Array<{
    event_type: string;
    payload: unknown;
    producer_id?: string | null;
    idempotency_key?: string;
  }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-iee-'));
    busDb = join(dir, 'bus.db');
    subs = [];
    probeEvents = [];
  });

  afterEach(async () => {
    for (const s of subs) await s.stop();
    removeScratch(dir);
  });

  async function emitFeedbackProcessed(
    bus: typeof import('wicked-bus'),
    overrides: Record<string, unknown> = {},
  ) {
    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    bus.emit(db, config, {
      event_type: FEEDBACK_PROCESSED,
      domain: 'wicked-interactive',
      subdomain: 'feedback',
      payload: { ...payload, document_id: 'spike-doc', ...overrides },
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

  async function arm(engine: FakeAdapter, extra: Record<string, unknown> = {}) {
    const sub = await startInteractiveEditSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      log: () => {},
      ...extra,
    });
    expect(sub).not.toBeNull();
    subs.push(sub!);
    return sub!;
  }

  it('answers a structural handoff with ONE governed run, hands off by file, self-checks, and announces the edit', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const sub = await arm(engine, { heartbeatMs: 60 });
    armProbe(bus);

    // The workflow def rode the normal registration path before the cursor armed.
    expect(engine.registered.map((w) => w.id)).toEqual([INTERACTIVE_EDIT_WORKFLOW]);

    await emitFeedbackProcessed(bus);
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect(launch.workflow).toBe(INTERACTIVE_EDIT_WORKFLOW);
    expect(launch.clisJson).toBe(SEATS);
    expect(launch.projectId).toBeUndefined(); // unbound doc → unfiled run
    expect(launch.problem).toContain('"spike-doc"');
    const handoffPath = join(dir, 'edits', 'spike-doc-v2', 'handoff.json');
    expect(launch.problem).toContain(handoffPath);
    // crew#263: the edit inbox rides the launch as a declared write root — the task names the
    // handoff JSON + output files, all outside the unit sandbox; without the declaration the
    // wrapped-CLI boundary denies both the reads and the deliverable writes. crew#314: that
    // root is the PER-HANDOFF directory, never the shared editDir.
    expect(launch.extraWriteRoots).toEqual([join(dir, 'edits', 'spike-doc-v2')]);

    // The handoff FILE carries the fragments + index-named output paths.
    const handoffFile = JSON.parse(readFileSync(handoffPath, 'utf8')) as {
      items: Array<{ selector: string; fragment: string; output_path: string }>;
    };
    expect(handoffFile.items).toHaveLength(1);
    expect(handoffFile.items[0]?.fragment).toBe(FRAGMENT);
    const outPath = handoffFile.items[0]!.output_path;
    expect(outPath).toBe(join(dir, 'edits', 'spike-doc-v2', 'fragment-1.html'));
    // crew#311: EVERY handed-off fragment file is declared as a deliverable — the floor is
    // per-path, so a run that reworked three blocks and wrote one still fails.
    expect(launch.requireDeliverables).toEqual(handoffFile.items.map((i) => i.output_path));

    // Narration reached the bus as wi-crew; the heartbeat keeps feeding the ~20s window.
    await waitFor(() =>
      probeEvents.some((e) => e.event_type === STATUS_POSTED && e.producer_id === INTERACTIVE_PRODUCER),
    );
    const beats = () =>
      probeEvents.filter(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'working',
      ).length;
    const before = beats();
    await waitFor(() => beats() >= before + 2);

    // The worker wrote a wid-preserving edit; completion emits edit.completed with the results.
    writeFileSync(outPath, '<h2 data-wid="slide-2-heading-1">Punchier!</h2>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: launch.sessionId });
    await waitFor(() => probeEvents.some((e) => e.event_type === EDIT_COMPLETED));
    const edit = probeEvents.find((e) => e.event_type === EDIT_COMPLETED)!;
    const p = edit.payload as {
      document_id?: string;
      version?: number;
      results?: Array<{ selector: string; fragment: string }>;
    };
    expect(p.document_id).toBe('spike-doc');
    expect(p.version).toBe(2); // the handoff's parent version, not a head guess
    expect(p.results).toEqual([
      { selector: 'slide-2-heading-1', fragment: '<h2 data-wid="slide-2-heading-1">Punchier!</h2>' },
    ]);
    expect(edit.producer_id).toBe(INTERACTIVE_PRODUCER);
    expect(edit.idempotency_key).toBe(editIdempotencyKey('spike-doc', 2));

    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'complete',
      ),
    );
    expect(sub.ledger.get('spike-doc:v2')?.emittedAt).toBeTruthy();
  });

  it('crew#314: each handoff declares ONLY its own subdirectory — a run cannot reach a sibling handoff’s state', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    await arm(engine);

    // Two handoffs, live at the same time: a different doc, and a different version of the
    // first doc (the two ways sibling runs coexist in one editDir).
    await emitFeedbackProcessed(bus);
    await waitFor(() => engine.launches.length === 1);
    await emitFeedbackProcessed(bus, { document_id: 'other-doc' });
    await waitFor(() => engine.launches.length === 2);
    await emitFeedbackProcessed(bus, { version: 7 });
    await waitFor(() => engine.launches.length === 3);

    const editDir = join(dir, 'edits');
    const covers = (root: string, p: string): boolean => {
      const rel = relative(root, p);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };

    // Every declared root is a PROPER subdirectory of editDir — never editDir itself. A
    // wholesale `editDir` declaration is exactly the cross-run exposure crew#314 reports.
    const roots = engine.launches.map((l) => {
      expect(l.extraWriteRoots).toHaveLength(1);
      const root = l.extraWriteRoots![0]!;
      expect(root, 'the shared inbox must never be the declared root').not.toBe(editDir);
      expect(covers(editDir, root)).toBe(true);
      return root;
    });
    expect(new Set(roots).size, 'each handoff owns a distinct directory').toBe(3);

    // …and every file a run is told to touch lives inside ITS root and outside every sibling's.
    for (const [i, launch] of engine.launches.entries()) {
      const owned = [...launch.requireDeliverables!];
      // The handoff JSON moved under the run dir too — while it sat directly in editDir it
      // FORCED the wholesale declaration.
      const handoffPath = join(roots[i]!, 'handoff.json');
      expect(existsSync(handoffPath), 'the handoff JSON lives inside the run dir').toBe(true);
      expect(launch.problem).toContain(handoffPath);
      owned.push(handoffPath);
      for (const p of owned) {
        expect(covers(roots[i]!, p)).toBe(true);
        for (const [j, other] of roots.entries()) {
          if (i === j) continue;
          expect(covers(other, p), `run ${j} must not reach run ${i}'s ${p}`).toBe(false);
        }
      }
    }
  });

  it('files the run into the doc’s project when the handoff carries project_id (7b)', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const filed: Array<[string, string]> = [];
    await arm(engine, { onRunFiled: (runId: string, projectId: string) => filed.push([runId, projectId]) });
    await emitFeedbackProcessed(bus, { project_id: 'proj-42' });
    await waitFor(() => engine.launches.length === 1);
    expect(engine.launches[0]!.projectId).toBe('proj-42');
    // …and the post-commit hook fires so the daemon can tag /ws frames + emit membership.attached.
    expect(filed).toEqual([[engine.launches[0]!.sessionId, 'proj-42']]);
  });

  it('a REPLAYED handoff launches no second run — but the SAME doc’s next version does', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const sub = await arm(engine);

    await emitFeedbackProcessed(bus);
    await waitFor(() => engine.launches.length === 1);

    // Redelivery/replay of the SAME handoff (at-least-once semantics): no second launch.
    await emitFeedbackProcessed(bus);
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.launches.length, 'a replayed handoff must not double-launch').toBe(1);

    // VERSIONED TARGETING: the same doc's NEXT feedback batch is a NEW handoff — it launches.
    await emitFeedbackProcessed(bus, { version: 4 });
    await waitFor(() => engine.launches.length === 2);
    expect(engine.launches[1]!.problem).toContain('version 4');

    // And a RESTART (fresh subscriber, same ledger) still refuses to relaunch either handoff.
    await sub.stop();
    const engine2 = fakeAdapter();
    const sub2 = await startInteractiveEditSubscriber(engine2.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      ledgerPath: join(dir, 'ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub2!);
    await emitFeedbackProcessed(bus);
    await emitFeedbackProcessed(bus, { version: 4 });
    await new Promise((r) => setTimeout(r, 300));
    expect(engine2.launches.length, 'the durable ledger survives a restart').toBe(0);
  });

  it('NEGATIVE: a worker fragment that drops a data-wid is rejected by the self-check — error status, no emit', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const sub = await arm(engine);
    armProbe(bus);

    await emitFeedbackProcessed(bus);
    await waitFor(() => engine.launches.length === 1);
    const outPath = join(dir, 'edits', 'spike-doc-v2', 'fragment-1.html');
    mkdirSync(join(dir, 'edits', 'spike-doc-v2'), { recursive: true });
    // The violation: the anchor is gone (INV-2) — the service would silently reject this.
    writeFileSync(outPath, '<h2>Punchier, but the anchor is gone</h2>', 'utf8');
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });

    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          (e.payload as { state?: string }).state === 'error' &&
          String((e.payload as { message?: string }).message).includes('data-wid'),
      ),
    );
    expect(probeEvents.some((e) => e.event_type === EDIT_COMPLETED)).toBe(false);
    expect(sub.ledger.get('spike-doc:v2')?.failedAt).toBeTruthy();
    expect(sub.ledger.get('spike-doc:v2')?.emittedAt).toBeUndefined();
  });

  it('a completed run whose worker wrote NO fragment posts an error instead of a phantom edit', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    await arm(engine);
    armProbe(bus);

    await emitFeedbackProcessed(bus);
    await waitFor(() => engine.launches.length === 1);
    expect(existsSync(join(dir, 'edits', 'spike-doc-v2', 'fragment-1.html'))).toBe(false);
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(probeEvents.some((e) => e.event_type === EDIT_COMPLETED)).toBe(false);
  });

  it('a failed run posts an error status, records the failure, and emits no edit', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const sub = await arm(engine);
    armProbe(bus);

    await emitFeedbackProcessed(bus);
    await waitFor(() => engine.launches.length === 1);
    engine.fire({ type: 'sessionFailed', session: engine.launches[0]!.sessionId, ord: 1 });
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(probeEvents.some((e) => e.event_type === EDIT_COMPLETED)).toBe(false);
    expect(sub.ledger.get('spike-doc:v2')?.failedAt).toBeTruthy();
  });

  it('a FAILED LAUNCH closes the thread with an error status and writes no ledger row (a replay can retry)', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const adapter = engine.asAdapter();
    (adapter as unknown as { launchRun: unknown }).launchRun = async () => {
      throw new Error('engine is busy');
    };
    const sub = await startInteractiveEditSubscriber(adapter, {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      log: () => {},
    });
    subs.push(sub!);
    armProbe(bus);

    await emitFeedbackProcessed(bus);
    await waitFor(() =>
      probeEvents.some(
        (e) =>
          e.event_type === STATUS_POSTED &&
          (e.payload as { state?: string }).state === 'error' &&
          String((e.payload as { message?: string }).message).includes('engine is busy'),
      ),
    );
    expect(sub!.ledger.has('spike-doc:v2')).toBe(false);
    expect(engine.launches.length).toBe(0);
  });

  // ── grounding follow-on #1: the (read-only) estate MCP reaches the repo-less EDIT worker ──────
  //
  // The gap this closes: the edit seam filed `projectId` but NOT `projectGraph`, so its repo-less
  // worker hit `run_code_graph_db → None → no estate MCP at all`. The fix is CAPABILITY-ONLY —
  // resolve the project graph (repoRef undefined) and attach it; no prompt/repo/snapshot change,
  // so no CREW-UX-8 revise-turn wedge. Binding is resolved from the on-disk manifest, never indexed.
  describe('project-graph binding (grounding follow-on #1)', () => {
    beforeEach(() => {
      process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = join(dir, 'project-graphs');
    });
    afterEach(() => {
      delete process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'];
    });

    /** A built project graph holding `repos` — the db AND the manifest, because `projectGraphStatus`
     *  ignores a manifest whose database is gone. Mirrors project-graph-binding.test.ts::buildGraph. */
    function buildProjectGraph(
      projectId: string,
      repos: Array<{ repoId: string; rootPath: string }>,
    ): void {
      const db = projectGraphDb(projectId);
      mkdirSync(join(db, '..'), { recursive: true });
      writeFileSync(db, 'a database is all existsSync checks for here');
      writeFileSync(
        projectGraphManifest(projectId),
        JSON.stringify({
          version: 1,
          projectId,
          repos: repos.map(({ repoId, rootPath }) => ({
            repoId,
            label: repoLabel(repoId),
            rootPath,
            head: 'abc1234def5678',
            indexedAt: 1,
          })),
        }),
      );
    }

    it('a FILED edit whose project graph is built launches with projectGraph.dbPath = the project graph db (repo-less, no label)', async () => {
      const bus = await import('wicked-bus');
      buildProjectGraph('proj-graph', [{ repoId: 'repo-a', rootPath: '/repos/repo-a' }]);
      const engine = fakeAdapter({
        members: { 'proj-graph': [{ member_kind: 'crew.repo', member_ref: 'repo-a' }] },
        repos: [{ id: 'repo-a', root_path: '/repos/repo-a', code_graph_db: '/repos/repo-a/.codegraph/estate.db' }],
      });
      await arm(engine, { resolveDocsRoot: () => join(dir, 'docs') });

      await emitFeedbackProcessed(bus, { project_id: 'proj-graph' });
      await waitFor(() => engine.launches.length === 1);
      const launch = engine.launches[0]!;
      expect(launch.projectId).toBe('proj-graph');
      // The (read-only) estate MCP over the PROJECT's graph now reaches the repo-less edit worker.
      expect(launch.projectGraph).toEqual({ dbPath: projectGraphDb('proj-graph') });
      // repo-LESS: no repoLabel, and STILL no repoRef (capability-only, not a repo binding).
      expect(launch.projectGraph?.repoLabel).toBeUndefined();
      expect('repoRef' in launch).toBe(false);
    });

    it('a FILED edit whose project graph was NEVER built launches with NO projectGraph key, and logs the degrade reason', async () => {
      const bus = await import('wicked-bus');
      const logged: string[] = [];
      const engine = fakeAdapter({
        members: { 'proj-nograph': [{ member_kind: 'crew.repo', member_ref: 'repo-a' }] },
        repos: [{ id: 'repo-a', root_path: '/repos/repo-a', code_graph_db: '/repos/repo-a/.codegraph/estate.db' }],
      });
      await arm(engine, { resolveDocsRoot: () => join(dir, 'docs'), log: (m: string) => logged.push(m) });

      await emitFeedbackProcessed(bus, { project_id: 'proj-nograph' });
      await waitFor(() => engine.launches.length === 1);
      const launch = engine.launches[0]!;
      expect(launch.projectId).toBe('proj-nograph');
      expect('projectGraph' in launch).toBe(false);
      // The decision is RECORDED even on the degrade — a repo-less run is told it gets NOTHING.
      expect(logged.some((m) => /no code graph yet|repo-less run gets no code graph/.test(m))).toBe(true);
    });

    it('an UNFILED edit (no project_id) launches with NO projectGraph key — nothing to bind', async () => {
      const bus = await import('wicked-bus');
      // A graph exists for some other project, but this handoff is unfiled, so nothing is resolved.
      buildProjectGraph('proj-graph', [{ repoId: 'repo-a', rootPath: '/repos/repo-a' }]);
      const engine = fakeAdapter({
        members: { 'proj-graph': [{ member_kind: 'crew.repo', member_ref: 'repo-a' }] },
        repos: [{ id: 'repo-a', root_path: '/repos/repo-a', code_graph_db: '/repos/repo-a/.codegraph/estate.db' }],
      });
      await arm(engine, { resolveDocsRoot: () => join(dir, 'docs') });

      await emitFeedbackProcessed(bus); // no project_id → unfiled
      await waitFor(() => engine.launches.length === 1);
      const launch = engine.launches[0]!;
      expect('projectId' in launch).toBe(false);
      expect('projectGraph' in launch).toBe(false);
    });
  });
});
