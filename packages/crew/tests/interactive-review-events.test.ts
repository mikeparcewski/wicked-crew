// EP-C2 — the interactive-review seam (DES-artifact-editor-plugins §7.6): `review.requested` → ONE
// read-only governed run (never the document's authors) → one wicked-ledger verdict row per
// reviewer, stamped with the crew run → read back → `review.completed` per reviewer; and the one
// checks read, `GET /projects/:id/interactive/docs/:doc/checks?version=`.

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocChecksResponse } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, SessionView, WorkflowDef } from '../src/core/types.js';
import { registerInteractiveDocChecks } from '../src/interactive/doc-checks-routes.js';
import { INTERACTIVE_PRODUCER, STATUS_POSTED } from '../src/interactive/draft-events.js';
import { InteractiveHandoffLedger } from '../src/interactive/ledger.js';
import {
  INTERACTIVE_REVIEW_BUS_FILTER,
  INTERACTIVE_REVIEW_WORKFLOW,
  REVIEWERS,
  REVIEW_COMPLETED,
  REVIEW_REQUESTED,
  authorSeatsOf,
  authoringRunsFromLedgers,
  editRunsBefore,
  extractReviewReport,
  interactiveReviewWorkflowDef,
  parseReviewRequested,
  resultsFromReport,
  reviewHandoffKey,
  rosterWithout,
  startInteractiveReviewSubscriber,
  summaryLine,
} from '../src/interactive/review-events.js';
import { ledgerVerdictOf, removeDocReviews, reviewPartitionOf, reviewRootOf, writeReviewVerdicts } from '../src/interactive/review-ledger.js';
import { readDocReviewVerdicts } from '../src/qe/ledger.js';
import { removeScratch } from './setup/scratch.js';

const REPORT = {
  reviews: [
    { reviewer: 'match', verdict: 'pass', findings: [] },
    { reviewer: 'a11y', verdict: 'changes', findings: [{ wid: 'hero-title', severity: 'high', sentence: 'The hero image has no text alternative.' }, { severity: 'low', sentence: 'Two links read "click here".' }] },
    { reviewer: 'copy', verdict: 'pass', findings: [] },
    { reviewer: 'qe', verdict: 'changes', findings: [{ wid: 'pricing', sentence: 'The pricing table overlaps the footer at 390 px.' }] },
  ],
};
const reportLine = (r: unknown = REPORT): string => `I reviewed the page four ways.\nREVIEW-REPORT ${JSON.stringify(r)}\n`;

describe('parseReviewRequested + the dedupe key', () => {
  it('reads document, version and reviewers; an absent list means all four; ids are deduped and kept in the announce order', () => {
    expect(parseReviewRequested(REVIEW_REQUESTED, { document_id: 'brochure', version: 3, ts: 't' })).toEqual({ documentId: 'brochure', version: 3, reviewers: ['match', 'a11y', 'copy', 'qe'] });
    expect(parseReviewRequested(REVIEW_REQUESTED, { document_id: 'brochure', version: 0, reviewers: ['qe', 'a11y', 'qe', 'nope'], project_id: 'kes' })).toEqual({
      documentId: 'brochure',
      version: 0,
      reviewers: ['a11y', 'qe'],
      projectId: 'kes',
    });
  });

  it('is not actionable without a slug document id, a whole-number version, or at least one known reviewer', () => {
    const bad = (p: unknown) => parseReviewRequested(REVIEW_REQUESTED, p);
    expect(bad({ document_id: 'Bad Name', version: 1 })).toBeNull();
    expect(bad({ document_id: 'brochure' })).toBeNull();
    expect(bad({ document_id: 'brochure', version: 1.5 })).toBeNull();
    expect(bad({ document_id: 'brochure', version: -1 })).toBeNull();
    expect(bad({ document_id: 'brochure', version: 1, reviewers: [] })).toBeNull();
    expect(bad({ document_id: 'brochure', version: 1, reviewers: ['spelling'] })).toBeNull();
    expect(bad({ document_id: 'brochure', version: 1, reviewers: 'a11y' })).toBeNull();
    expect(bad(null)).toBeNull();
    expect(parseReviewRequested('wicked.interactive.review.completed', { document_id: 'brochure', version: 1 })).toBeNull();
  });

  it('one key per document version per reviewer SET per project; it starts `<doc>:` like every handoff key', () => {
    expect(reviewHandoffKey('brochure', 3, ['qe', 'a11y'])).toBe('brochure:review:_unfiled:v3:a11y+qe');
    expect(reviewHandoffKey('brochure', 3, ['a11y', 'qe'])).toBe(reviewHandoffKey('brochure', 3, ['qe', 'a11y']));
    expect(reviewHandoffKey('brochure', 3, ['a11y'], 'kes')).toBe('brochure:review:p-kes:v3:a11y');
    expect(reviewPartitionOf('default')).toBe('_unfiled');
    expect(reviewPartitionOf('../etc')).toBe(`x-${Buffer.from('../etc').toString('hex')}`);
    expect(INTERACTIVE_REVIEW_BUS_FILTER).toBe('wicked.interactive.review.requested@wicked-interactive');
  });
});

describe('the interactive-review workflow def', () => {
  it('is ONE phase the engine keeps read-only (not a creator, not a code phase), single-line, ending in the REVIEW-REPORT line; skills are an allowlist', () => {
    const def = interactiveReviewWorkflowDef([REVIEWERS.a11y.skill]);
    expect(def.id).toBe(INTERACTIVE_REVIEW_WORKFLOW);
    expect(def.phases).toHaveLength(1);
    const phase = def.phases[0]!;
    expect(phase).toMatchObject({ id: 'review', kind: 'review', role: 'neutral', executes_code: false, verified_evidence: false, skill_ref: null, allowed_skills: ['wicked-garden-product-a11y-expert'], required_deliverables: [] });
    expect(phase.instructions).not.toMatch(/[\r\n]/u);
    expect(phase.instructions).toContain('REVIEW-REPORT');
    expect(phase.instructions).toContain('write no file');
    expect(interactiveReviewWorkflowDef().phases[0]!.allowed_skills).toEqual([]);
  });

  it('names the four reviewers of DES §7.6 with their skills', () => {
    expect(Object.fromEntries(Object.entries(REVIEWERS).map(([id, r]) => [id, [r.title, r.skill]]))).toEqual({
      match: ['Intent', 'wicked-garden-qe-semantic-reviewer'],
      a11y: ['A11y', 'wicked-garden-product-a11y-expert'],
      copy: ['Copy', 'wicked-garden-wickedizer'],
      qe: ['Quality', 'wicked-garden-product-ui-reviewer'],
    });
  });
});

describe('the report', () => {
  it('is the LAST `REVIEW-REPORT {…}` of the output, braces and quotes inside strings included; prose that only mentions the marker is not a report', () => {
    expect(extractReviewReport(reportLine())).toEqual(REPORT);
    const tricky = { reviews: [{ reviewer: 'copy', verdict: 'changes', findings: [{ sentence: 'A stray "}" and a { sit in the lead.' }] }] };
    expect(extractReviewReport(`REVIEW-REPORT {"reviews":[]}\nthen again\nREVIEW-REPORT ${JSON.stringify(tricky)} \`\`\``)).toEqual(tricky);
    expect(extractReviewReport('I will end with a REVIEW-REPORT line as asked.')).toBeNull();
    expect(extractReviewReport('REVIEW-REPORT {"reviews":[')).toBeNull();
    expect(extractReviewReport('REVIEW-REPORT [1,2]')).toBeNull();
    expect(extractReviewReport(null)).toBeNull();
  });

  it('one result per REQUESTED reviewer: a reviewer left out or without a usable verdict is `error`, never a guessed pass; a pass that lists findings is `changes`', () => {
    const results = resultsFromReport(
      {
        reviews: [
          { reviewer: 'a11y', verdict: 'pass', findings: [{ sentence: 'Low contrast on the footer links.' }] },
          { reviewer: 'copy', verdict: 'fine' },
          { reviewer: 'qe', verdict: 'pass' },
          { reviewer: 'qe', verdict: 'changes', findings: [{ sentence: 'a second entry for the same reviewer is ignored' }] },
        ],
      },
      ['match', 'a11y', 'copy', 'qe'],
    );
    expect(results.map((r) => [r.reviewer, r.verdict, r.findings.length])).toEqual([
      ['match', 'error', 0],
      ['a11y', 'changes', 1],
      ['copy', 'error', 0],
      ['qe', 'pass', 0],
    ]);
    expect(results[0]!.reason).toBe('The report has no result for Intent.');
    expect(resultsFromReport(null, ['a11y'])[0]).toEqual({ reviewer: 'a11y', verdict: 'error', findings: [], reason: 'The review ended without a report.' });
  });

  it('findings: a sentence is required and kept to one line; severity defaults to medium; a wid outside the grammar leaves the finding unanchored; at most 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ sentence: `finding ${i}` }));
    const [r] = resultsFromReport(
      {
        reviews: [
          {
            reviewer: 'qe',
            verdict: 'changes',
            findings: [{ wid: 'ok-1', severity: 'high', sentence: 'line one\nline two' }, { wid: '<script>', severity: 'urgent', sentence: 'bad anchor' }, { wid: 'x' }, 'junk', ...many],
          },
        ],
      },
      ['qe'],
    );
    expect(r!.findings).toHaveLength(50);
    expect(r!.findings[0]).toEqual({ wid: 'ok-1', severity: 'high', sentence: 'line one line two' });
    expect(r!.findings[1]).toEqual({ severity: 'medium', sentence: 'bad anchor' });
    expect(summaryLine([{ reviewer: 'match', reviewVerdict: 'pass', findings: [] }, { reviewer: 'a11y', reviewVerdict: 'changes', findings: [1] }, { reviewer: 'qe', reviewVerdict: 'error', findings: [] }])).toBe(
      'Intent passed · A11y asks for 1 change · Quality could not run',
    );
  });
});

const unit = (runId: string, ord: number, role: 'creator' | 'evaluator' | 'neutral', cli: string | null) => ({ id: `${runId}:u${ord}`, session_id: runId, ord, role, assigned_cli: cli, status: 'done' }) as unknown as SessionView['units'][number];
const view = (runId: string, status: string, units: SessionView['units']): SessionView => ({ session: { id: runId, status } as unknown as SessionView['session'], units });

describe('who wrote it', () => {
  it('the creator seats of the named runs, as cli keys; evaluators, unassigned units and other runs contribute nothing', () => {
    const views = [
      view('draft-1', 'completed', [unit('draft-1', 0, 'neutral', 'pi'), unit('draft-1', 1, 'creator', 'claude#2'), unit('draft-1', 2, 'evaluator', 'codex')]),
      view('edit-1', 'completed', [unit('edit-1', 0, 'creator', 'agy'), unit('edit-1', 1, 'creator', null)]),
      view('other', 'completed', [unit('other', 0, 'creator', 'opencode')]),
    ];
    expect(authorSeatsOf(views, ['draft-1', 'edit-1', 'gone'])).toEqual(['agy', 'claude']);
    expect(authorSeatsOf(views, [])).toEqual([]);
  });

  it('the runs that can have written version N: the draft, edits whose PARENT is below N, and chat revisions — never theme or review rows, never a later edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-irev-ledgers-'));
    const draft = new InteractiveHandoffLedger(join(dir, 'draft.json'));
    const edit = new InteractiveHandoffLedger(join(dir, 'edit.json'));
    const chat = new InteractiveHandoffLedger(join(dir, 'chat.json'));
    draft.recordLaunch('brochure', 'draft-run');
    draft.recordLaunch('brochure-two', 'other-draft');
    edit.recordLaunch('brochure:v1', 'edit-v1');
    edit.recordLaunch('brochure:v4', 'edit-v4');
    edit.recordLaunch('brochure:v5', 'edit-v5');
    edit.recordLaunch('brochure:theme:2026-10-03T00:00:00Z', 'theme-run');
    edit.recordLaunch('brochure:review:_unfiled:v2:a11y', 'review-run');
    edit.recordLaunch('brochure-two:v0', 'other-edit');
    chat.recordLaunch('brochure:m:abc', 'chat-run');
    expect(editRunsBefore(edit, 'brochure', 5).sort()).toEqual(['edit-v1', 'edit-v4']);
    const sources = [{ name: 'draft', ledger: draft, path: '' }, { name: 'edit', ledger: edit, path: '' }, { name: 'chat', path: join(dir, 'chat.json') }];
    expect(authoringRunsFromLedgers(sources, 'brochure', 5).sort()).toEqual(['chat-run', 'draft-run', 'edit-v1', 'edit-v4']);
    expect(authoringRunsFromLedgers(sources, 'never-drafted', 1)).toEqual([]);
    removeScratch(dir);
  });

  it('the review roster is the roster without the authors (by cli key)', () => {
    const roster = [{ key: 'claude' }, { key: 'codex' }, { key: 'agy' }, 'odd'];
    expect(rosterWithout(roster, ['claude#2', 'agy'])).toEqual([{ key: 'codex' }, 'odd']);
    expect(rosterWithout(roster, [])).toEqual(roster);
  });
});

describe('the verdict store (wicked-ledger canonical rows) + the read-back', () => {
  it('one verdicts row per reviewer with its run, scenario and project rows; stamped with the crew run; extra keys kept; read back newest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-irev-store-'));
    const root = reviewRootOf(join(dir, '_reviews'), 'kes', 'brochure');
    expect(root).toBe(join(dir, '_reviews', 'p-kes', 'brochure'));
    const ids = writeReviewVerdicts(root, [
      { runId: 'run-1', doc: 'brochure', version: 3, reviewer: 'a11y', verdict: 'changes', findings: [{ wid: 'hero', severity: 'high', sentence: 'No alt text.' }], reason: 'A11y: 1 finding.', seat: 'codex', excludedSeats: ['claude'], authorKnown: true, skill: 'wicked-garden-product-a11y-expert', projectId: 'kes' },
      { runId: 'run-1', doc: 'brochure', version: 3, reviewer: 'copy', verdict: 'error', findings: [], reason: 'Copy returned no usable verdict.', seat: 'codex', excludedSeats: ['claude'], authorKnown: true, skill: null, projectId: 'kes' },
    ]);
    expect(ids).toEqual(['verdict-run-1-a11y', 'verdict-run-1-copy']);
    const ledger = join(root, '.wicked-qe');
    expect(['projects', 'runs', 'scenarios', 'verdicts'].map((t) => readdirSync(join(ledger, t)).sort())).toEqual([
      ['doc-brochure.json'],
      ['review-run-1-a11y.json', 'review-run-1-copy.json'],
      ['review-a11y.json', 'review-copy.json'],
      ['verdict-run-1-a11y.json', 'verdict-run-1-copy.json'],
    ]);
    const row = JSON.parse(readFileSync(join(ledger, 'verdicts', 'verdict-run-1-a11y.json'), 'utf8')) as Record<string, unknown>;
    expect(row).toMatchObject({ run_id: 'review-run-1-a11y', verdict: 'FAIL', reviewer: 'a11y', crew_run_id: 'run-1', doc: 'brochure', version: 3, review_verdict: 'changes', deleted: 0, findings: [{ wid: 'hero', severity: 'high', sentence: 'No alt text.' }] });
    expect(JSON.parse(readFileSync(join(ledger, 'runs', 'review-run-1-copy.json'), 'utf8'))).toMatchObject({ project_id: 'doc-brochure', scenario_id: 'review-copy', status: 'errored', crew_run_id: 'run-1' });
    expect([ledgerVerdictOf('pass'), ledgerVerdictOf('changes'), ledgerVerdictOf('error')]).toEqual(['PASS', 'FAIL', 'INCONCLUSIVE']);

    const back = readDocReviewVerdicts(root, 'run-1');
    expect(back.found).toBe(true);
    expect(back.rows.map((r) => [r.reviewer, r.reviewVerdict, r.version, r.runId, r.seat, r.excludedSeats, r.authorKnown, r.skill]).sort()).toEqual([
      ['a11y', 'changes', 3, 'run-1', 'codex', ['claude'], true, 'wicked-garden-product-a11y-expert'],
      ['copy', 'error', 3, 'run-1', 'codex', ['claude'], true, null],
    ]);
    expect(readDocReviewVerdicts(root, 'another-run').rows).toEqual([]);
    expect(readDocReviewVerdicts(join(dir, 'nowhere'))).toEqual({ found: false, rows: [] });
    // A record that cannot be parsed is a read FAILURE, never a cleaner answer.
    writeFileSync(join(ledger, 'verdicts', 'torn.json'), '{"id":');
    expect(readDocReviewVerdicts(root).error).toMatch(/torn\.json/u);

    // A deleted document's reviews go with it, in every project partition.
    removeDocReviews(join(dir, '_reviews'), 'brochure');
    expect(existsSync(root)).toBe(false);
    removeDocReviews(join(dir, 'no-such-dir'), 'brochure');
    removeScratch(dir);
  });
});

interface FakeEngine {
  launches: LaunchRunInput[];
  registered: WorkflowDef[];
  views: SessionView[];
  outputs: Map<string, string>;
  fire: (event: CoreEvent) => void;
  /** Launch → the engine "runs" the review: one unit by `seat` with `output`, then the terminal frame. */
  finish: (runId: string, seat: string, output: string | null, terminal?: 'sessionCompleted' | 'sessionFailed') => void;
  asAdapter(): CoreAdapter;
}

function fakeEngine(): FakeEngine {
  const listeners = new Set<(e: CoreEvent) => void>();
  const state: FakeEngine = {
    launches: [],
    registered: [],
    views: [],
    outputs: new Map(),
    fire: (event) => {
      for (const l of listeners) l(event);
    },
    finish: (runId, seat, output, terminal = 'sessionCompleted') => {
      state.views.push(view(runId, terminal === 'sessionCompleted' ? 'completed' : 'failed', [unit(runId, 0, 'neutral', seat)]));
      if (output !== null) state.outputs.set(`${runId}:u0`, output);
      state.fire({ type: terminal, session: runId } as unknown as CoreEvent);
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
        sessionsDetail: async () => state.views,
        workOutput: async (unitId: string) => state.outputs.get(unitId) ?? null,
      } as unknown as CoreAdapter;
    },
  };
  return state;
}

const SEATS = JSON.stringify([{ key: 'claude' }, { key: 'codex' }, { key: 'agy' }]);

async function waitFor(cond: () => boolean, ms = 8000, step = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

describe('startInteractiveReviewSubscriber (real bus, fake engine, stub reader)', () => {
  let dir: string;
  let busDb: string;
  let subs: { stop(): Promise<void> | void }[];
  let probeEvents: Array<{ event_type: string; payload: Record<string, unknown>; producer_id?: string | null }>;
  let reads: Array<[string, string | undefined, number]>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-irev-'));
    busDb = join(dir, 'bus.db');
    subs = [];
    probeEvents = [];
    reads = [];
  });
  afterEach(async () => {
    for (const s of subs) await s.stop();
    removeScratch(dir);
  });

  async function request(bus: typeof import('wicked-bus'), overrides: Record<string, unknown> = {}) {
    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    bus.emit(db, config, {
      event_type: REVIEW_REQUESTED,
      domain: 'wicked-interactive',
      subdomain: 'review',
      payload: { document_id: 'brochure', version: 3, ts: new Date().toISOString(), ...overrides },
      producer_id: 'wi-ui',
    });
  }

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
        probeEvents.push({ event_type: e.event_type, payload: e.payload as Record<string, unknown>, producer_id: (e as { producer_id?: string | null }).producer_id ?? null });
      },
    });
    subs.push(probe);
  }

  async function arm(engine: FakeEngine, extra: Partial<Parameters<typeof startInteractiveReviewSubscriber>[1]> = {}) {
    const sub = await startInteractiveReviewSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      readDocVersion: async (documentId, projectId, version) => {
        reads.push([documentId, projectId, version]);
        return `<html><body><h1 data-wid="hero-title">Brochure v${version}</h1></body></html>`;
      },
      log: () => {},
      ...extra,
    });
    expect(sub).not.toBeNull();
    subs.push(sub!);
    return sub!;
  }

  const completed = () => probeEvents.filter((e) => e.event_type === REVIEW_COMPLETED);
  const statuses = () => probeEvents.filter((e) => e.event_type === STATUS_POSTED && e.producer_id === INTERACTIVE_PRODUCER).map((e) => e.payload);

  it('answers a request with ONE read-only run that the document\'s authors neither review nor judge; records one stamped ledger row per reviewer; announces each from the record', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeEngine();
    // The document was drafted by claude (run draft-1); codex only evaluated it.
    engine.views.push(view('draft-1', 'completed', [unit('draft-1', 0, 'creator', 'claude'), unit('draft-1', 1, 'evaluator', 'codex')]));
    const sub = await arm(engine, { authoringRuns: () => ['draft-1'], skillHeld: (name) => name === REVIEWERS.a11y.skill });
    armProbe(bus);
    expect(engine.registered.map((d) => [d.id, d.phases[0]!.allowed_skills])).toEqual([[INTERACTIVE_REVIEW_WORKFLOW, ['wicked-garden-product-a11y-expert']]]);

    await request(bus, { project_id: 'kes' });
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect(launch.workflow).toBe(INTERACTIVE_REVIEW_WORKFLOW);
    // exclude_seats filled from the authoring run and honoured: off the roster AND out of the judge choice.
    expect(launch.excludeSeats).toEqual(['claude']);
    expect((JSON.parse(launch.clisJson) as Array<{ key: string }>).map((s) => s.key)).toEqual(['codex', 'agy']);
    expect(launch.projectId).toBe('kes');
    expect(launch.requireDeliverables).toBeUndefined();
    expect(launch.problem).not.toMatch(/[\r\n]/u);
    expect(reads).toEqual([['brochure', 'kes', 3]]);
    const runDir = launch.extraWriteRoots![0]!;
    const handoff = JSON.parse(readFileSync(join(runDir, 'handoff.json'), 'utf8')) as { doc_path: string; version: number; reviewers: Array<Record<string, unknown>> };
    expect(handoff.version).toBe(3);
    expect(readFileSync(handoff.doc_path, 'utf8')).toContain('Brochure v3');
    expect(handoff.reviewers.map((r) => [r['reviewer'], r['title'], r['skill'] ?? null, typeof r['rubric']])).toEqual([
      ['match', 'Intent', null, 'string'],
      ['a11y', 'A11y', 'wicked-garden-product-a11y-expert', 'string'],
      ['copy', 'Copy', null, 'string'],
      ['qe', 'Quality', null, 'string'],
    ]);
    // Nothing is announced before the run reports.
    expect(completed()).toEqual([]);

    engine.finish(launch.sessionId, 'codex', reportLine());
    await waitFor(() => completed().length === 4);
    // The record first: one verdicts row per reviewer, stamped with the crew run.
    const root = reviewRootOf(sub.reviewsDir, 'kes', 'brochure');
    const rows = readDocReviewVerdicts(root, launch.sessionId).rows;
    expect(rows.map((r) => r.reviewer).sort()).toEqual(['a11y', 'copy', 'match', 'qe']);
    expect(rows.every((r) => r.runId === launch.sessionId && r.seat === 'codex' && r.authorKnown && r.excludedSeats.join() === 'claude')).toBe(true);
    // Then the announcement, per reviewer, in reviewer order, by crew.
    expect(completed().every((e) => e.producer_id === INTERACTIVE_PRODUCER)).toBe(true);
    expect(completed().map((e) => [e.payload['reviewer'], e.payload['verdict'], e.payload['passed'], (e.payload['findings'] as unknown[]).length])).toEqual([
      ['match', 'pass', true, 0],
      ['a11y', 'changes', false, 2],
      ['copy', 'pass', true, 0],
      ['qe', 'changes', false, 1],
    ]);
    expect(completed()[1]!.payload).toMatchObject({ document_id: 'brochure', project_id: 'kes', version: 3, run_id: launch.sessionId, findings: [{ wid: 'hero-title', severity: 'high', sentence: 'The hero image has no text alternative.' }, { severity: 'low', sentence: 'Two links read "click here".' }] });
    await waitFor(() => statuses().some((s) => s['state'] === 'complete'));
    expect(statuses().at(-1)).toMatchObject({ state: 'complete', message: 'Review of version 3: Intent passed · A11y asks for 2 changes · Copy passed · Quality asks for 1 change.' });
    expect(sub.ledger.get(reviewHandoffKey('brochure', 3, ['match', 'a11y', 'copy', 'qe'], 'kes'))).toMatchObject({ runId: launch.sessionId, emittedAt: expect.any(String) });

    // The same request again (a replay, or a second press): no second run — the record answers.
    await request(bus, { project_id: 'kes' });
    await waitFor(() => completed().length === 8);
    expect(engine.launches).toHaveLength(1);
    expect(statuses().at(-1)).toMatchObject({ state: 'complete', message: expect.stringMatching(/^Version 3 was already reviewed: /u) });
    // A different reviewer set, or another version, is its own review.
    await request(bus, { project_id: 'kes', reviewers: ['copy'] });
    await waitFor(() => engine.launches.length === 2);
    expect(engine.launches[1]!.sessionId).not.toBe(launch.sessionId);
  });

  it('a reviewer the report leaves out is recorded and announced as `error`; with no authoring run on record nothing is excluded and the row says so', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeEngine();
    const sub = await arm(engine);
    armProbe(bus);
    await request(bus, { reviewers: ['a11y', 'copy'] });
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect(launch.excludeSeats).toBeUndefined();
    expect((JSON.parse(launch.clisJson) as unknown[]).length).toBe(3);
    engine.finish(launch.sessionId, 'agy', reportLine({ reviews: [{ reviewer: 'copy', verdict: 'pass', findings: [] }] }));
    await waitFor(() => completed().length === 2);
    expect(completed().map((e) => [e.payload['reviewer'], e.payload['verdict'], e.payload['passed']])).toEqual([['a11y', 'error', false], ['copy', 'pass', true]]);
    const rows = readDocReviewVerdicts(reviewRootOf(sub.reviewsDir, undefined, 'brochure')).rows;
    expect(rows.every((r) => !r.authorKnown && r.excludedSeats.length === 0)).toBe(true);
    expect(rows.find((r) => r.reviewer === 'a11y')!.reason).toBe('The report has no result for A11y.');
  });

  it('a run that fails is recorded and announced as `error` for every reviewer, and the same request may be asked again', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeEngine();
    const sub = await arm(engine);
    armProbe(bus);
    await request(bus, { reviewers: ['qe'] });
    await waitFor(() => engine.launches.length === 1);
    const first = engine.launches[0]!.sessionId;
    engine.fire({ type: 'stepFailed', session: first, detail: 'the seat signed out' } as unknown as CoreEvent);
    engine.finish(first, 'codex', null, 'sessionFailed');
    await waitFor(() => completed().length === 1);
    expect(completed()[0]!.payload).toMatchObject({ reviewer: 'qe', verdict: 'error', passed: false, run_id: first });
    await waitFor(() => statuses().some((s) => s['state'] === 'error'));
    expect(statuses().at(-1)!['message']).toMatch(/failed \(run .+\)\. Reason: the seat signed out\. Ask again to retry\./u);
    expect(sub.ledger.get(reviewHandoffKey('brochure', 3, ['qe']))).toMatchObject({ failedAt: expect.any(String) });

    await request(bus, { reviewers: ['qe'] });
    await waitFor(() => engine.launches.length === 2);
    engine.finish(engine.launches[1]!.sessionId, 'codex', reportLine({ reviews: [{ reviewer: 'qe', verdict: 'pass' }] }));
    await waitFor(() => completed().length === 2);
    expect(completed()[1]!.payload).toMatchObject({ reviewer: 'qe', verdict: 'pass', passed: true });
    // The run that ended WITHOUT a report line is `error` too — never a silent pass.
    await request(bus, { reviewers: ['copy'] });
    await waitFor(() => engine.launches.length === 3);
    engine.finish(engine.launches[2]!.sessionId, 'codex', 'Looks great to me!');
    await waitFor(() => completed().length === 3);
    expect(completed()[2]!.payload).toMatchObject({ reviewer: 'copy', verdict: 'error', passed: false });
  });

  it('refuses honestly, launching nothing: when every seat wrote part of the document, when the version cannot be read, and when the authors cannot be read', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeEngine();
    engine.views.push(view('draft-1', 'completed', [unit('draft-1', 0, 'creator', 'claude'), unit('draft-1', 1, 'creator', 'codex'), unit('draft-1', 2, 'creator', 'agy')]));
    let mode: 'all-authors' | 'unreadable-version' | 'unreadable-authors' = 'all-authors';
    await arm(engine, {
      authoringRuns: () => {
        if (mode === 'unreadable-authors') throw new Error('edit ledger: EACCES');
        return mode === 'all-authors' ? ['draft-1'] : [];
      },
      readDocVersion: async () => {
        throw new Error('interactive answered 404 for version 9');
      },
    });
    armProbe(bus);
    await request(bus);
    await waitFor(() => statuses().length === 1);
    expect(statuses()[0]).toMatchObject({ state: 'error', message: 'Every available seat (agy, claude, codex) wrote part of this document, so none can review it independently. Add another seat and ask again.' });
    mode = 'unreadable-version';
    await request(bus, { version: 9 });
    await waitFor(() => statuses().length === 2);
    expect(statuses()[1]!['message']).toMatch(/could not read version 9 to review it: interactive answered 404/u);
    mode = 'unreadable-authors';
    await request(bus, { version: 10 });
    await waitFor(() => statuses().length === 3);
    expect(statuses()[2]!['message']).toMatch(/could not read who wrote this document, so it will not pick a reviewer blindly: edit ledger: EACCES/u);
    expect(engine.launches).toEqual([]);
    expect(completed()).toEqual([]);
  });
});

describe('GET /projects/:projectId/interactive/docs/:doc/checks', () => {
  let dir: string;
  let app: FastifyInstance;
  const at = (iso: string) => () => new Date(iso);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-irev-route-'));
    app = Fastify();
    const adapter = { projectGet: async (id: string) => (id === 'kes' ? { id } : null) } as unknown as CoreAdapter;
    registerInteractiveDocChecks(app, adapter, { reviewsDir: () => join(dir, '_reviews') });
    await app.ready();
    const root = reviewRootOf(join(dir, '_reviews'), 'kes', 'brochure');
    const row = (runId: string, version: number, reviewer: string, verdict: 'pass' | 'changes' | 'error', seat: string | null, authorKnown: boolean) => ({
      runId,
      doc: 'brochure',
      version,
      reviewer,
      verdict,
      findings: verdict === 'changes' ? [{ wid: 'hero', severity: 'high' as const, sentence: 'No alt text.' }, { severity: 'low' as const, sentence: 'Unanchored note.' }] : [],
      reason: `${reviewer} on v${version}`,
      seat,
      excludedSeats: authorKnown ? ['claude'] : [],
      authorKnown,
      skill: null,
      projectId: 'kes',
    });
    writeReviewVerdicts(root, [row('run-1', 2, 'a11y', 'changes', 'codex', true), row('run-1', 2, 'copy', 'pass', 'codex', true)], at('2026-10-03T10:00:00.000Z'));
    writeReviewVerdicts(root, [row('run-2', 4, 'a11y', 'pass', 'claude#2', true), row('run-2', 4, 'qe', 'error', null, false)], at('2026-10-03T11:00:00.000Z'));
  });
  afterEach(async () => {
    await app.close();
    removeScratch(dir);
  });

  const get = async (path: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1${path}` });
    return { status: res.statusCode, body: res.json() as DocChecksResponse & { error?: string; detail?: string } };
  };

  it('per reviewer, the newest verdict at or below the version asked for; an older review stays until a newer one replaces it', async () => {
    const head = await get('/projects/kes/interactive/docs/brochure/checks');
    expect(head.status).toBe(200);
    expect(head.body).toMatchObject({ document_id: 'brochure', version: null });
    expect(head.body.checks.map((c) => [c.source, c.reviewer, c.version, c.state, c.run_id])).toEqual([
      ['review:a11y', 'a11y', 4, 'pass', 'run-2'],
      ['review:copy', 'copy', 2, 'pass', 'run-1'],
      ['review:quality', 'qe', 4, 'inconclusive', 'run-2'],
    ]);
    const v3 = await get('/projects/kes/interactive/docs/brochure/checks?version=3');
    expect(v3.body.version).toBe(3);
    expect(v3.body.checks.map((c) => [c.reviewer, c.version, c.state, c.findings.length])).toEqual([['a11y', 2, 'fail', 2], ['copy', 2, 'pass', 0]]);
    expect(v3.body.checks[0]).toMatchObject({
      id: 'verdict-run-1-a11y',
      sentence: 'a11y on v2',
      findings: [{ wid: 'hero', severity: 'high', sentence: 'No alt text.' }, { wid: null, severity: 'low', sentence: 'Unanchored note.' }],
      by: { seat: 'codex', evaluator: true, excluded_seats: ['claude'], author_known: true },
      skill: null,
      at: '2026-10-03T10:00:00.000Z',
    });
    expect((await get('/projects/kes/interactive/docs/brochure/checks?version=1')).body.checks).toEqual([]);
  });

  it('`by.evaluator` is shown, never inferred: an excluded seat that reviewed anyway, and an unknown author, both read false', async () => {
    const { body } = await get('/projects/kes/interactive/docs/brochure/checks');
    expect(body.checks.map((c) => [c.reviewer, c.by])).toEqual([
      ['a11y', { seat: 'claude#2', evaluator: false, excluded_seats: ['claude'], author_known: true }],
      ['copy', { seat: 'codex', evaluator: true, excluded_seats: ['claude'], author_known: true }],
      ['qe', { seat: null, evaluator: false, excluded_seats: [], author_known: false }],
    ]);
  });

  it('never reviewed is an empty list; another project does not see this project\'s reviews; bad input and an unreadable record are named', async () => {
    expect((await get('/projects/kes/interactive/docs/never-reviewed/checks')).body).toEqual({ document_id: 'never-reviewed', version: null, checks: [] });
    expect((await get('/projects/default/interactive/docs/brochure/checks')).body.checks).toEqual([]);
    expect((await get('/projects/ghost/interactive/docs/brochure/checks')).status).toBe(404);
    expect((await get('/projects/kes/interactive/docs/Bad%20Name/checks')).status).toBe(400);
    expect((await get('/projects/kes/interactive/docs/brochure/checks?version=two')).status).toBe(400);
    writeFileSync(join(reviewRootOf(join(dir, '_reviews'), 'kes', 'brochure'), '.wicked-qe', 'verdicts', 'torn.json'), '{');
    const broken = await get('/projects/kes/interactive/docs/brochure/checks');
    expect(broken.status).toBe(500);
    expect(broken.body.detail).toMatch(/torn\.json/u);
  });
});
