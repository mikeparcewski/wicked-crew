// The interactive-demo seam (CREW-UX-9 — video generation's missing brain, the retired assist
// agent's Step 8).
//
// What these tests pin, and why:
//  - the TRIGGER contract: only `wicked.interactive.doc.created` with `kind: "demo"`, a
//    slug-valid document_id, and a usable http(s) URL is actionable — source/html docs stay the
//    draft seam's business (kind ROUTING is split, never shared), and a malformed id/url must
//    never name a ledger key, a file path, or a PTY prompt;
//  - the WORKER contract: the deliverable is `<inbox>/demo.spec.mjs` (THE WRITE-BOUNDARY
//    LESSON, wicked-core#293/#294 — the unbound worker cannot touch the doc workspace, so the
//    task names the per-run inbox and crew installs the spec at finalize), the problem carries
//    the url + brief verbatim/capped, and everything is single-line (PTY, FINDING-011);
//  - FINALIZE ORDERING: copy the spec into the doc workspace FIRST, emit demo.requested
//    SECOND — the model-free service reads `<docDir>/demo.spec.mjs` when the request arrives
//    (interactive demo.js recordDemo), so emit-first would record a missing/stale spec;
//  - IDEMPOTENCY: durable ledger dedupe across redelivery AND restarts, deterministic
//    demo.requested keys that differ per authoring generation (a re-record must not dedupe
//    against the first record);
//  - HONEST FAILURE: no spec / self-check violation / missing doc workspace / failed run each
//    end in an error status and NO demo.requested — never a hollow record request;
//  - the STEP-FEEDBACK loop (assist SKILL.md Step 8c): a demo-kind doc's
//    `feedback.processed` re-authors the spec and re-records — answered HERE and REJECTED by
//    the edit seam (both gate on the doc manifest's kind), so exactly one seam answers.
//    The engine itself is faked — the governed run's mechanics are wicked-core's tests'
//    business; THIS seam's business is everything around it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_REQUESTED,
  DEMO_SPEC_FILE,
  DEMO_URL_MAX,
  INTERACTIVE_DEMO_BUS_FILTER,
  INTERACTIVE_DEMO_FEEDBACK_BUS_FILTER,
  INTERACTIVE_DEMO_BUS_PLUGIN,
  INTERACTIVE_DEMO_FEEDBACK_BUS_PLUGIN,
  INTERACTIVE_DEMO_WORKFLOW,
  INTERACTIVE_DEMO_WORKFLOW_DEF,
  INTERACTIVE_DEMO_REAUTHOR_WORKFLOW,
  INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF,
  parseDemoDocCreated,
  demoProblem,
  demoReauthorProblem,
  demoIdempotencyKey,
  demoReauthorIdempotencyKey,
  specSelfCheck,
  startInteractiveDemoSubscriber,
} from '../src/interactive/demo-events.js';
import { DOC_CREATED, STATUS_POSTED, INTERACTIVE_PRODUCER, parseSourceDocCreated } from '../src/interactive/draft-events.js';
import { FEEDBACK_PROCESSED, EDIT_COMPLETED, startInteractiveEditSubscriber } from '../src/interactive/edit-events.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../src/core/types.js';

const DEMO_PAYLOAD = {
  document_id: 'checkout-demo',
  kind: 'demo',
  url: 'https://staging.example.com/app',
  brief: 'show sign-in, adding the Pro plan, and checkout',
  ts: '2026-08-24T00:00:00Z',
};

/** A minimal spec satisfying the executable contract (interactive demo.js recordDemo). */
const VALID_SPEC = [
  'export const meta = { url: "https://staging.example.com/app", title: "Checkout demo" };',
  'export async function run({ page, step, meta }) {',
  '  await page.goto(meta.url);',
  '  await step("Sign in", async () => { await page.click("text=Sign in"); }, { say: "One click to get in." });',
  '}',
  '',
].join('\n');

describe('parseDemoDocCreated (the kind-routing gate)', () => {
  it('accepts a project-bound kind:demo creation and carries url/brief/projectId', () => {
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, project_id: 'proj-7' })).toEqual({
      documentId: 'checkout-demo',
      url: 'https://staging.example.com/app',
      brief: 'show sign-in, adding the Pro plan, and checkout',
      projectId: 'proj-7',
    });
  });

  it('accepts UNFILED demo docs with projectId omitted — never fabricates a binding', () => {
    const doc = parseDemoDocCreated(DOC_CREATED, DEMO_PAYLOAD);
    expect(doc).toEqual({
      documentId: 'checkout-demo',
      url: 'https://staging.example.com/app',
      brief: 'show sign-in, adding the Pro plan, and checkout',
    });
    expect(doc && 'projectId' in doc).toBe(false);
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, project_id: '' })?.projectId).toBeUndefined();
  });

  it('KIND ROUTING is split, never shared: demo here, source/html stay in the draft seam', () => {
    // This seam refuses non-demo kinds…
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, kind: 'source' })).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, kind: 'html' })).toBeNull();
    // …and the draft seam refuses demo — the SAME frame is actionable in exactly one place.
    expect(parseSourceDocCreated(DOC_CREATED, DEMO_PAYLOAD)).toBeNull();
    expect(
      parseSourceDocCreated(DOC_CREATED, { document_id: 'a-doc', kind: 'source', brief: 'x' }),
    ).not.toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { document_id: 'a-doc', kind: 'source', brief: 'x' })).toBeNull();
  });

  it('tolerates a missing brief (empty string) — the URL alone is a valid demo ask', () => {
    const noBrief = { document_id: 'd', kind: 'demo', url: 'https://x.dev/' };
    expect(parseDemoDocCreated(DOC_CREATED, noBrief)).toEqual({ documentId: 'd', url: 'https://x.dev/', brief: '' });
  });

  it('rejects unusable URLs: missing, non-http(s), whitespace/control chars, over budget, unparseable', () => {
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, url: undefined })).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, url: '' })).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, url: 'ftp://files.example.com' })).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, url: 'file:///etc/passwd' })).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, url: 'not a url' })).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, url: 'https://x.dev/a\nb' })).toBeNull();
    expect(
      parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, url: `https://x.dev/${'p'.repeat(DEMO_URL_MAX)}` }),
    ).toBeNull();
    // Ordinary URL punctuation is NOT rejected (the guard is whitespace/control, not a range).
    expect(
      parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, url: 'https://x.dev/a-b_c?d=1&e=2#f' }),
    ).not.toBeNull();
  });

  it('ignores other event types, malformed payloads, and slug-invalid document ids', () => {
    expect(parseDemoDocCreated(FEEDBACK_PROCESSED, DEMO_PAYLOAD)).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, 'not-an-object')).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, document_id: '../escape' })).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, document_id: 'Nope Caps' })).toBeNull();
    expect(parseDemoDocCreated(DOC_CREATED, { ...DEMO_PAYLOAD, document_id: undefined })).toBeNull();
  });
});

describe('demoProblem (the worker prompt seed — the spec is the deliverable)', () => {
  const doc = { documentId: 'checkout-demo', url: 'https://staging.example.com/app', brief: 'line one\nline two\n\ttabbed' };

  it('is ALWAYS single-line — a PTY seat refuses embedded newlines (FINDING-011)', () => {
    const problem = demoProblem(doc, '/tmp/inbox/demo.spec.mjs');
    expect(problem).not.toMatch(/[\n\r\t]/);
    expect(problem).toContain('line one line two tabbed');
  });

  it('names the document, the URL VERBATIM, and the exact inbox spec path — never a doc-workspace path', () => {
    const problem = demoProblem(doc, '/tmp/demos/checkout-demo/demo.spec.mjs');
    expect(problem).toContain('"checkout-demo"');
    expect(problem).toContain('https://staging.example.com/app');
    expect(problem).toContain('exactly this absolute file path: /tmp/demos/checkout-demo/demo.spec.mjs');
  });

  it('caps a pasted-novel brief and substitutes an honest placeholder when the brief is empty', () => {
    const big = demoProblem({ ...doc, brief: 'x'.repeat(10_000) }, '/o');
    expect(big.length).toBeLessThan(2600);
    expect(big).toContain('…');
    expect(demoProblem({ ...doc, brief: '  ' }, '/o')).toContain('no brief provided');
  });
});

describe('demoReauthorProblem (the step-feedback prompt seed)', () => {
  const handoff = {
    documentId: 'checkout-demo',
    version: 3,
    items: [
      { selector: '[data-wid="w-1"]', instruction: 'also show the coupon field', fragment: '<li data-wid="w-1">Checkout</li>' },
    ],
  };

  it('is single-line and names the current-spec copy, the feedback file, and the output path', () => {
    const p = demoReauthorProblem(handoff, '/inbox/current.spec.mjs', '/inbox/feedback.json', '/inbox/demo.spec.mjs');
    expect(p).not.toMatch(/[\n\r\t]/);
    expect(p).toContain('read it first: /inbox/current.spec.mjs');
    expect(p).toContain('/inbox/feedback.json');
    expect(p).toContain('exactly this absolute file path: /inbox/demo.spec.mjs');
    expect(p).toContain('version 3');
    expect(p).toContain('also show the coupon field');
  });

  it('caps the instruction gist instead of ballooning the prompt', () => {
    const many = {
      ...handoff,
      items: Array.from({ length: 40 }, (_, i) => ({ selector: `#s${i}`, instruction: 'y'.repeat(100), fragment: '<p>x</p>' })),
    };
    const p = demoReauthorProblem(many, '/c', '/f', '/o');
    expect(p.length).toBeLessThan(1400);
    expect(p).toContain('…');
  });
});

describe('specSelfCheck (the pre-install gate — recordDemo would reject these at import time)', () => {
  it('passes a spec exporting meta + async run', () => {
    expect(specSelfCheck(VALID_SPEC)).toBeNull();
  });

  it('accepts the named-export-list spelling too', () => {
    const listForm = 'const meta = { url: "https://x.dev" };\nasync function run(ctx) {}\nexport { meta, run };\n';
    expect(specSelfCheck(listForm)).toBeNull();
  });

  it('fails an empty file, a missing meta export, and a missing run export — each with a reason', () => {
    expect(specSelfCheck('')).toMatch(/empty/);
    expect(specSelfCheck('   \n ')).toMatch(/empty/);
    expect(specSelfCheck('export async function run() {}')).toMatch(/meta/);
    expect(specSelfCheck('export const meta = {};')).toMatch(/run/);
    // A prose apology instead of a module — the classic worker failure — is caught.
    expect(specSelfCheck('I could not author the spec because…')).not.toBeNull();
  });
});

describe('the demo workflow defs (workflows-as-data)', () => {
  it('interactive-demo is scenes → spec, creator-role build second, unique phase ids', () => {
    const def = INTERACTIVE_DEMO_WORKFLOW_DEF;
    expect(def.id).toBe(INTERACTIVE_DEMO_WORKFLOW);
    expect(def.phases.map((p) => p.id)).toEqual(['scenes', 'spec']);
    expect(def.phases[0]?.role).toBe('neutral');
    expect(def.phases[1]?.role).toBe('creator');
    expect(def.phases[1]?.depends_on).toEqual(['scenes']);
  });

  it('THE #293 INVARIANT: the phase that inspects the app IS the phase that writes, and nothing before it may touch a tool', () => {
    // Measured on a real seat, not reasoned: a recon phase that inspects the app kills the
    // spec phase's write (4/4), and collapsing inspect+write into ONE phase kills the write
    // too (3/3 — the turn ends AT the write). Only "tool-free plan, then inspect-and-write"
    // survives (15/15 end-to-end). These assertions pin that arrangement so a future
    // simplification has to argue with the evidence in the def's doc comment.
    const [plan, write] = INTERACTIVE_DEMO_WORKFLOW_DEF.phases;
    // Phase 1 forbids tools OUTRIGHT (naming them), and says what the prohibition protects.
    expect(plan?.instructions ?? '').toMatch(/USE NO TOOLS AT ALL/);
    expect(plan?.instructions ?? '').toMatch(/no web fetch, no shell, no file reads/i);
    expect(plan?.instructions ?? '').toMatch(/breaks that phase's ability to write/i);
    expect(plan?.executes_code).toBe(false);
    // Phase 2 does the inspecting AND the writing, in that order.
    const spec = write?.instructions ?? '';
    const inspect = spec.indexOf('FIRST inspect the live target application');
    const save = spec.indexOf('write the COMPLETE Playwright demo spec and SAVE it');
    const report = spec.indexOf('REPORT IN PROSE');
    expect(inspect).toBe(0);
    expect(save).toBeGreaterThan(inspect);
    expect(report).toBeGreaterThan(save);
    expect(spec).toMatch(/never guess a selector/i);
    expect(spec).toMatch(/use curl/i);
    // …and the re-author leg, which writes in its FIRST phase, must not fetch the network
    // there: that is the shape measured to lose the write.
    const respec = INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF.phases[0]?.instructions ?? '';
    expect(respec).toMatch(/do NOT fetch the live application in this phase/i);
  });

  it('interactive-demo-reauthor is a single respec build phase — the edit leg\'s rationale', () => {
    const def = INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF;
    expect(def.id).toBe(INTERACTIVE_DEMO_REAUTHOR_WORKFLOW);
    expect(def.phases.map((p) => p.id)).toEqual(['respec']);
    expect(def.phases[0]?.role).toBe('creator');
  });

  it('keeps every phase instruction single-line (the same PTY constraint as the problem)', () => {
    for (const def of [INTERACTIVE_DEMO_WORKFLOW_DEF, INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF]) {
      for (const p of def.phases) {
        expect(p.instructions ?? '').not.toMatch(/[\n\r]/);
        expect((p.instructions ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('arms no human gate and no validator floor — the acceptance gate is the recording itself', () => {
    for (const def of [INTERACTIVE_DEMO_WORKFLOW_DEF, INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF]) {
      for (const p of def.phases) {
        expect(p.gate).toBe('auto');
        expect(p.validator_pin).toBeNull();
        expect(p.required_deliverables).toEqual([]);
      }
    }
  });

  it('every FILE-deliverable phase demands a prose report — the unbound run has no worktree diff to clear the substance floor', () => {
    // wicked-core rejects a governed creator phase whose fold carries neither a worktree diff
    // nor >=200 trimmed chars ("phase produced no reviewable substance"). These runs are
    // UNBOUND (workdir null) and write their deliverable into the inbox, so PROSE is the only
    // substance available: an instruction that invites a bare-path reply fails the run.
    for (const instructions of [
      INTERACTIVE_DEMO_WORKFLOW_DEF.phases[1]?.instructions ?? '',
      INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF.phases[0]?.instructions ?? '',
    ]) {
      expect(instructions).toMatch(/REPORT IN PROSE/);
      expect(instructions).toMatch(/at least 120 words/);
      expect(instructions).toMatch(/only the path is an unreviewable phase/);
    }
  });

  it('carries the Step 8 authoring contract (assist skill + demo.js recordDemo), adapted', () => {
    const spec = INTERACTIVE_DEMO_WORKFLOW_DEF.phases[1]?.instructions ?? '';
    expect(spec).toContain('meta'); // export const meta { url, title, … }
    expect(spec).toContain('run({ page, step, meta })');
    expect(spec).toContain('page.goto(meta.url)');
    expect(spec).toContain('step(label'); // every meaningful action wrapped in step()
    expect(spec).toContain('say'); // capability narration
    expect(spec).toMatch(/NEVER write credentials/i); // secrets stay in process.env
    expect(spec).toContain('process.env');
    const scenes = INTERACTIVE_DEMO_WORKFLOW_DEF.phases[0]?.instructions ?? '';
    expect(scenes).toContain('3-6'); // Step 8a: scene decomposition, not brief-copying
    const respec = INTERACTIVE_DEMO_REAUTHOR_WORKFLOW_DEF.phases[0]?.instructions ?? '';
    expect(respec).toContain('feedback');
    expect(respec).toMatch(/NEVER write credentials/i);
    // The re-author leg works from files, never the network (see the #293 invariant test).
    expect(respec).toMatch(/Work from the two files and the current spec's own selectors/i);
  });
});

describe('bus identity constants', () => {
  it('subscribes on exact-type, domain-guarded filters under dedicated plugin names', () => {
    expect(INTERACTIVE_DEMO_BUS_FILTER).toBe('wicked.interactive.doc.created@wicked-interactive');
    expect(INTERACTIVE_DEMO_FEEDBACK_BUS_FILTER).toBe('wicked.interactive.feedback.processed@wicked-interactive');
    expect(INTERACTIVE_DEMO_BUS_PLUGIN).toBe('wicked-crew-interactive-demo');
    expect(INTERACTIVE_DEMO_FEEDBACK_BUS_PLUGIN).toBe('wicked-crew-interactive-demo-feedback');
    expect(DEMO_REQUESTED).toBe('wicked.interactive.demo.requested');
    expect(DEMO_SPEC_FILE).toBe('demo.spec.mjs');
  });

  it('derives deterministic idempotency keys that NEVER collide across authoring generations', () => {
    expect(demoIdempotencyKey('my-demo')).toBe('crew:interactive.demo:my-demo:spec');
    expect(demoReauthorIdempotencyKey('my-demo', 3)).toBe('crew:interactive.demo:my-demo:v3');
    expect(demoIdempotencyKey('my-demo')).not.toBe(demoReauthorIdempotencyKey('my-demo', 1));
    expect(demoReauthorIdempotencyKey('my-demo', 3)).not.toBe(demoReauthorIdempotencyKey('my-demo', 4));
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

describe('startInteractiveDemoSubscriber (real bus, fake engine)', () => {
  let dir: string;
  let busDb: string;
  let docsRoot: string;
  let subs: { stop(): Promise<void> | void }[];
  let probeEvents: Array<{ event_type: string; payload: unknown; producer_id?: string | null; idempotency_key?: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-idm-'));
    busDb = join(dir, 'bus.db');
    docsRoot = join(dir, 'docs');
    subs = [];
    probeEvents = [];
  });

  afterEach(async () => {
    for (const s of subs) await s.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Materialize a doc workspace the way interactive's initWorkspace does for a demo:
   *  versions.json carries `kind: "demo"` (the one kind interactive records on disk). */
  function makeDemoWorkspace(name: string, { spec }: { spec?: string } = {}): string {
    const docDir = join(docsRoot, name);
    mkdirSync(docDir, { recursive: true });
    writeFileSync(
      join(docDir, 'versions.json'),
      JSON.stringify({ kind: 'demo', head: 0, versions: [{ version: 0, html_file: '_v0.html' }] }),
      'utf8',
    );
    writeFileSync(join(docDir, '_v0.html'), '<section class="wi-demo">placeholder</section>', 'utf8');
    if (spec !== undefined) writeFileSync(join(docDir, DEMO_SPEC_FILE), spec, 'utf8');
    return docDir;
  }

  async function emitDocCreated(
    bus: typeof import('wicked-bus'),
    documentId = 'checkout-demo',
    overrides: Record<string, unknown> = {},
  ) {
    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    bus.emit(db, config, {
      event_type: DOC_CREATED,
      domain: 'wicked-interactive',
      subdomain: 'docs',
      payload: { ...DEMO_PAYLOAD, document_id: documentId, ...overrides },
      producer_id: 'wi-service',
    });
  }

  async function emitFeedbackProcessed(
    bus: typeof import('wicked-bus'),
    documentId = 'checkout-demo',
    overrides: Record<string, unknown> = {},
  ) {
    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    bus.emit(db, config, {
      event_type: FEEDBACK_PROCESSED,
      domain: 'wicked-interactive',
      subdomain: 'feedback',
      payload: {
        document_id: documentId,
        version: 3,
        applied: [],
        rejected: [],
        stale: [],
        awaiting_structural: 1,
        structural_items: [
          {
            selector: '[data-wid="w-step-3"]',
            instruction: 'also show the coupon field before paying',
            fragment: '<li data-wid="w-step-3">Checkout</li>',
          },
        ],
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

  async function startSub(engine: FakeAdapter, extra: Record<string, unknown> = {}) {
    const sub = await startInteractiveDemoSubscriber(engine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'demo-ledger.json'),
      demoDir: join(dir, 'demos'),
      clisJson: SEATS,
      resolveDocsRoot: () => docsRoot,
      log: () => {},
      ...extra,
    });
    expect(sub).not.toBeNull();
    subs.push(sub!);
    return sub!;
  }

  it('answers doc.created(kind:demo) with ONE governed spec run — inbox deliverable, unbound launch', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    makeDemoWorkspace('checkout-demo');
    const sub = await startSub(engine, { heartbeatMs: 60 });
    armProbe(bus);

    // BOTH workflow defs rode the normal registration path before the cursors armed.
    expect(engine.registered.map((w) => w.id)).toEqual([
      INTERACTIVE_DEMO_WORKFLOW,
      INTERACTIVE_DEMO_REAUTHOR_WORKFLOW,
    ]);

    await emitDocCreated(bus, 'checkout-demo', { project_id: 'proj-7' });
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect(launch.workflow).toBe(INTERACTIVE_DEMO_WORKFLOW);
    expect(launch.clisJson).toBe(SEATS);
    expect(launch.projectId).toBe('proj-7');
    // THE WRITE-BOUNDARY LESSON (wicked-core#293/#294): unbound — never repo-bound — with the
    // per-run inbox as the SOLE extra root; the task names the INBOX spec as the deliverable.
    const runDir = join(dir, 'demos', 'checkout-demo');
    const outPath = join(runDir, DEMO_SPEC_FILE);
    expect(launch.repoRef).toBeUndefined();
    expect(launch.extraWriteRoots).toEqual([runDir]);
    expect(launch.problem).toContain(outPath);
    expect(launch.problem).toContain('https://staging.example.com/app');
    expect(launch.problem).toContain('show sign-in, adding the Pro plan, and checkout');
    expect(launch.problem).not.toContain(docsRoot); // no doc-workspace path reaches the worker

    // Narration reached the bus as wi-crew (pickup), and the heartbeat keeps feeding the
    // UI's ~20s status window with no engine events at all.
    await waitFor(() =>
      probeEvents.some((e) => e.event_type === STATUS_POSTED && e.producer_id === INTERACTIVE_PRODUCER),
    );
    const beats = () =>
      probeEvents.filter(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'working',
      ).length;
    const before = beats();
    await waitFor(() => beats() >= before + 2);

    // Kind routing at the live seam: a kind:source creation is NOT this seam's trigger.
    await emitDocCreated(bus, 'a-source-doc', { kind: 'source', url: undefined });
    await new Promise((r) => setTimeout(r, 200));
    expect(engine.launches.length).toBe(1);
    expect(sub.inFlightDocs()).toEqual(['checkout-demo']);
  });

  it('finalize is copy-THEN-emit: installs the spec into the doc workspace, then demo.requested, then complete', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const docDir = makeDemoWorkspace('checkout-demo');
    const sub = await startSub(engine);
    armProbe(bus);

    await emitDocCreated(bus);
    await waitFor(() => engine.launches.length === 1);
    const runId = engine.launches[0]!.sessionId;
    const outPath = join(dir, 'demos', 'checkout-demo', DEMO_SPEC_FILE);

    // The worker "wrote" the spec into the inbox; the doc workspace has none yet.
    writeFileSync(outPath, VALID_SPEC, 'utf8');
    expect(existsSync(join(docDir, DEMO_SPEC_FILE))).toBe(false);
    engine.fire({ type: 'sessionCompleted', session: runId });

    await waitFor(() => probeEvents.some((e) => e.event_type === DEMO_REQUESTED));
    const req = probeEvents.find((e) => e.event_type === DEMO_REQUESTED)!;
    expect((req.payload as { document_id?: string }).document_id).toBe('checkout-demo');
    expect(req.producer_id).toBe(INTERACTIVE_PRODUCER);
    expect(req.idempotency_key).toBe(demoIdempotencyKey('checkout-demo'));
    // ORDERING: the copy strictly precedes the emit (finalize is synchronous copy → emit), so
    // by the time demo.requested is observable the service-side spec MUST already be in place —
    // recordDemo reads <docDir>/demo.spec.mjs the moment the request arrives.
    expect(readFileSync(join(docDir, DEMO_SPEC_FILE), 'utf8')).toBe(VALID_SPEC);

    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'complete',
      ),
    );
    const complete = probeEvents.find(
      (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'complete',
    )!;
    expect(String((complete.payload as { message?: string }).message)).toMatch(/recording now/i);
    expect(sub.ledger.get('checkout-demo')?.emittedAt).toBeTruthy();
  });

  it('a REPLAYED doc.created launches no second run (ledger dedupe), surviving a restart', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    makeDemoWorkspace('checkout-demo');
    const sub = await startSub(engine);

    await emitDocCreated(bus);
    await waitFor(() => engine.launches.length === 1);

    // Redelivery/replay: the same creation arrives again (at-least-once semantics).
    await emitDocCreated(bus);
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.launches.length, 'a replayed doc.created must not double-launch').toBe(1);

    // Land it, then restart (fresh subscriber, same ledger): still refuses to relaunch.
    const runId = engine.launches[0]!.sessionId;
    writeFileSync(join(dir, 'demos', 'checkout-demo', DEMO_SPEC_FILE), VALID_SPEC, 'utf8');
    engine.fire({ type: 'sessionCompleted', session: runId });
    await waitFor(() => sub.ledger.get('checkout-demo')?.emittedAt !== undefined);
    await sub.stop();

    const engine2 = fakeAdapter();
    await startSub(engine2);
    await emitDocCreated(bus);
    await new Promise((r) => setTimeout(r, 300));
    expect(engine2.launches.length, 'the durable ledger survives a restart').toBe(0);
  });

  it('HONEST FAILURE: a run that produced no spec posts an error, records the failure, and emits NO demo.requested', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const docDir = makeDemoWorkspace('checkout-demo');
    const sub = await startSub(engine);
    armProbe(bus);

    await emitDocCreated(bus);
    await waitFor(() => engine.launches.length === 1);
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId }); // no file written
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(probeEvents.some((e) => e.event_type === DEMO_REQUESTED)).toBe(false);
    expect(existsSync(join(docDir, DEMO_SPEC_FILE))).toBe(false);
    expect(sub.ledger.get('checkout-demo')?.failedAt).toBeTruthy();
  });

  it('HONEST FAILURE: a spec failing the pre-install self-check is NOT installed and triggers NO recording', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const docDir = makeDemoWorkspace('checkout-demo');
    const sub = await startSub(engine);
    armProbe(bus);

    await emitDocCreated(bus);
    await waitFor(() => engine.launches.length === 1);
    // A prose apology instead of a module — recordDemo would reject it at import time.
    writeFileSync(
      join(dir, 'demos', 'checkout-demo', DEMO_SPEC_FILE),
      'Sorry, I was unable to explore the app.',
      'utf8',
    );
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    const error = probeEvents.find(
      (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
    )!;
    expect(String((error.payload as { message?: string }).message)).toMatch(/self-check/);
    expect(probeEvents.some((e) => e.event_type === DEMO_REQUESTED)).toBe(false);
    expect(existsSync(join(docDir, DEMO_SPEC_FILE))).toBe(false);
    expect(sub.ledger.get('checkout-demo')?.failedAt).toBeTruthy();
  });

  it('HONEST FAILURE: a missing doc workspace fails the install loudly — no copy, no demo.requested', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    // Deliberately NO makeDemoWorkspace: the docs root has no such doc.
    const sub = await startSub(engine);
    armProbe(bus);

    await emitDocCreated(bus);
    await waitFor(() => engine.launches.length === 1);
    writeFileSync(join(dir, 'demos', 'checkout-demo', DEMO_SPEC_FILE), VALID_SPEC, 'utf8');
    engine.fire({ type: 'sessionCompleted', session: engine.launches[0]!.sessionId });
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    const error = probeEvents.find(
      (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
    )!;
    expect(String((error.payload as { message?: string }).message)).toMatch(/doc workspace/);
    expect(probeEvents.some((e) => e.event_type === DEMO_REQUESTED)).toBe(false);
    expect(sub.ledger.get('checkout-demo')?.failedAt).toBeTruthy();
  });

  it('HONEST FAILURE: a failed/cancelled run posts an error and triggers no recording', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    makeDemoWorkspace('checkout-demo');
    const sub = await startSub(engine);
    armProbe(bus);

    await emitDocCreated(bus);
    await waitFor(() => engine.launches.length === 1);
    engine.fire({ type: 'sessionFailed', session: engine.launches[0]!.sessionId, ord: 1 });
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(probeEvents.some((e) => e.event_type === DEMO_REQUESTED)).toBe(false);
    expect(sub.ledger.get('checkout-demo')?.failedAt).toBeTruthy();
  });

  it('HONEST FAILURE: a launch that never happened writes no ledger row (a replay can retry)', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    makeDemoWorkspace('checkout-demo');
    const adapter = engine.asAdapter();
    (adapter as unknown as { launchRun: unknown }).launchRun = async () => {
      throw new Error('engine is busy');
    };
    const sub = await startInteractiveDemoSubscriber(adapter, {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'demo-ledger.json'),
      demoDir: join(dir, 'demos'),
      clisJson: SEATS,
      resolveDocsRoot: () => docsRoot,
      log: () => {},
    });
    subs.push(sub!);
    armProbe(bus);

    await emitDocCreated(bus);
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(sub!.ledger.has('checkout-demo')).toBe(false);
    expect(probeEvents.some((e) => e.event_type === DEMO_REQUESTED)).toBe(false);
  });

  it('STEP FEEDBACK (Step 8c): a demo-kind handoff re-authors the spec, reinstalls, and re-records', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    const docDir = makeDemoWorkspace('checkout-demo', { spec: VALID_SPEC });
    const sub = await startSub(engine);
    armProbe(bus);

    await emitFeedbackProcessed(bus);
    await waitFor(() => engine.launches.length === 1);
    const launch = engine.launches[0]!;
    expect(launch.workflow).toBe(INTERACTIVE_DEMO_REAUTHOR_WORKFLOW);
    const runDir = join(dir, 'demos', 'checkout-demo-v3');
    expect(launch.repoRef).toBeUndefined();
    expect(launch.extraWriteRoots).toEqual([runDir]);
    // The CURRENT spec was copied INTO the inbox crew-side (the worker cannot read the doc
    // workspace, wicked-core#294), and the feedback items ride a file, not the PTY prompt.
    expect(readFileSync(join(runDir, 'current.spec.mjs'), 'utf8')).toBe(VALID_SPEC);
    const feedback = JSON.parse(readFileSync(join(runDir, 'feedback.json'), 'utf8'));
    expect(feedback.items[0].instruction).toBe('also show the coupon field before paying');
    expect(launch.problem).toContain(join(runDir, 'current.spec.mjs'));
    expect(launch.problem).toContain(join(runDir, 'feedback.json'));
    expect(launch.problem).toContain(join(runDir, DEMO_SPEC_FILE));
    expect(launch.problem).not.toMatch(/[\n\r\t]/);

    // The worker revised the spec; completion installs it and re-triggers the recording.
    const revised = VALID_SPEC.replace('Sign in', 'Sign in and apply a coupon');
    writeFileSync(join(runDir, DEMO_SPEC_FILE), revised, 'utf8');
    engine.fire({ type: 'sessionCompleted', session: launch.sessionId });
    await waitFor(() => probeEvents.some((e) => e.event_type === DEMO_REQUESTED));
    const req = probeEvents.find((e) => e.event_type === DEMO_REQUESTED)!;
    expect(req.idempotency_key).toBe(demoReauthorIdempotencyKey('checkout-demo', 3));
    expect(readFileSync(join(docDir, DEMO_SPEC_FILE), 'utf8')).toBe(revised);
    expect(sub.ledger.get('checkout-demo:v3')?.emittedAt).toBeTruthy();

    // Replay of the SAME handoff: no second run; a LATER handoff (new version) launches fresh.
    await emitFeedbackProcessed(bus);
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.launches.length).toBe(1);
    await emitFeedbackProcessed(bus, 'checkout-demo', { version: 5 });
    await waitFor(() => engine.launches.length === 2);
    expect(engine.launches[1]!.workflow).toBe(INTERACTIVE_DEMO_REAUTHOR_WORKFLOW);
  });

  it('NO DOUBLE-ANSWER: the edit seam rejects a demo-kind handoff the demo seam answers — and keeps non-demo ones', async () => {
    const bus = await import('wicked-bus');
    makeDemoWorkspace('checkout-demo', { spec: VALID_SPEC });
    armProbe(bus);
    const demoEngine = fakeAdapter();
    await startSub(demoEngine);
    const editEngine = fakeAdapter();
    const editSub = await startInteractiveEditSubscriber(editEngine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'edit-ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      resolveDocsRoot: () => docsRoot,
      // The demo seam IS up in this test (startSub above) — so the kind gate may hand off.
      demoSeamArmed: () => true,
      log: () => {},
    });
    expect(editSub).not.toBeNull();
    subs.push(editSub!);

    // One frame, two subscribers, exactly ONE answerer: the demo seam launches, the edit
    // seam gates the demo-kind doc out.
    await emitFeedbackProcessed(bus, 'checkout-demo');
    await waitFor(() => demoEngine.launches.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(editEngine.launches.length, 'the edit seam must not double-answer a demo doc').toBe(0);
    expect(demoEngine.launches[0]!.workflow).toBe(INTERACTIVE_DEMO_REAUTHOR_WORKFLOW);

    // The inverse: a doc the demo seam cannot claim (no demo manifest) stays the edit seam's.
    await emitFeedbackProcessed(bus, 'a-source-doc');
    await waitFor(() => editEngine.launches.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(demoEngine.launches.length, 'the demo seam must not claim non-demo docs').toBe(1);
    expect(editEngine.launches[0]!.workflow).toBe('interactive-edit');
    // No edit.completed rode the bus for the demo doc from either seam.
    expect(probeEvents.filter((e) => e.event_type === EDIT_COMPLETED).length).toBe(0);
  });

  it('NO SILENT DROP: with the demo seam NOT armed, the edit seam answers a demo handoff with an honest error status', async () => {
    // The kind gate hands demo docs to the demo seam. When that seam never armed (opted out,
    // or its bus/workflow registration failed), an unconditional skip drops the user's feedback
    // into nothing: no run, no status, a canvas waiting forever. The gate must therefore be
    // conditional on the demo seam actually being there — and say so when it is not.
    const bus = await import('wicked-bus');
    makeDemoWorkspace('checkout-demo', { spec: VALID_SPEC });
    armProbe(bus);
    const editEngine = fakeAdapter();
    const editSub = await startInteractiveEditSubscriber(editEngine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'edit-ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      resolveDocsRoot: () => docsRoot,
      demoSeamArmed: () => false, // the demo seam is NOT running on this daemon
      log: () => {},
    });
    expect(editSub).not.toBeNull();
    subs.push(editSub!);

    await emitFeedbackProcessed(bus, 'checkout-demo');
    const isDemoError = (e: { event_type: string; payload: unknown }): boolean =>
      e.event_type === STATUS_POSTED &&
      (e.payload as { state?: string }).state === 'error' &&
      (e.payload as { document_id?: string }).document_id === 'checkout-demo';
    await waitFor(() => probeEvents.some(isDemoError));
    const err = probeEvents.find(isDemoError)!;
    // Honest: names the reason (demo seam not running) and that nothing changed.
    const message = String((err.payload as { message?: string }).message ?? '');
    expect(message).toMatch(/seam is not running on this daemon/i);
    expect(message).toMatch(/nothing was changed/i);
    // …and it stayed a status, not a storyboard rewrite: no run, no edit.completed.
    await new Promise((r) => setTimeout(r, 300));
    expect(editEngine.launches.length, 'an un-answerable demo handoff must not become a storyboard edit').toBe(0);
    expect(probeEvents.filter((e) => e.event_type === EDIT_COMPLETED).length).toBe(0);
  });

  it('the default demoSeamArmed probe is FALSE — a caller that wires no demo seam is told so, not guessed for', async () => {
    const bus = await import('wicked-bus');
    makeDemoWorkspace('checkout-demo', { spec: VALID_SPEC });
    armProbe(bus);
    const editEngine = fakeAdapter();
    const editSub = await startInteractiveEditSubscriber(editEngine.asAdapter(), {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'edit-ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      resolveDocsRoot: () => docsRoot,
      // demoSeamArmed deliberately omitted.
      log: () => {},
    });
    subs.push(editSub!);
    await emitFeedbackProcessed(bus, 'checkout-demo');
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    expect(editEngine.launches.length).toBe(0);
  });

  it('STEP FEEDBACK honest edge: a demo doc with NO spec yet posts an error and launches nothing', async () => {
    const bus = await import('wicked-bus');
    const engine = fakeAdapter();
    makeDemoWorkspace('no-spec-demo'); // manifest says demo, but no demo.spec.mjs on disk
    await startSub(engine);
    armProbe(bus);

    await emitFeedbackProcessed(bus, 'no-spec-demo');
    await waitFor(() =>
      probeEvents.some(
        (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
      ),
    );
    const error = probeEvents.find(
      (e) => e.event_type === STATUS_POSTED && (e.payload as { state?: string }).state === 'error',
    )!;
    expect(String((error.payload as { message?: string }).message)).toMatch(/no demo\.spec\.mjs/);
    expect(engine.launches.length).toBe(0);
  });
});
