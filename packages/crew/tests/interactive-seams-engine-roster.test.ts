// F-RECON-002/003: the interactive seams (draft / edit / chat / demo) launch with the roster WITH
// crew's standing, so a signed-out seat reaches the engine benched instead of being convened or
// elected. Each seam is armed over a real temp bus with a FAKE adapter that captures `launchRun`'s
// input; the capture is then translated exactly as the real `launchRun` does (`engineRosterJson`)
// and the engine-side shape asserted. One napi-level case (a real stub `CoreAdapter`, its
// `launchRun` binding shadowed) pins that the translation really happens on the way in.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOptions } from 'wicked-core-ts';

import { CoreAdapter } from '../src/core/adapter.js';
import { engineRosterJson } from '../src/core/engine-roster.js';
import type { CoreEvent, LaunchRunInput, WorkflowDef } from '../src/core/types.js';
import { startInteractiveChatSubscriber, CHAT_POSTED } from '../src/interactive/chat-events.js';
import { startInteractiveDraftSubscriber, DOC_CREATED } from '../src/interactive/draft-events.js';
import { startInteractiveEditSubscriber, FEEDBACK_PROCESSED } from '../src/interactive/edit-events.js';
import { startInteractiveDemoSubscriber } from '../src/interactive/demo-events.js';
import { removeScratch } from './setup/scratch.js';

const registrySeat = { display_name: 'x', binary: 'x', enabled_for_council: true, headless_invocation: 'x {PROMPT}' };
const signedOutCodex = { ...registrySeat, key: 'codex', signed_in: false, auth: 'signed_out', council_eligible: false, council_ineligible_reason: 'signed out — a council would bench this seat on its first ballot' };
const signedInClaude = { ...registrySeat, key: 'claude', signed_in: true, auth: 'signed_in', council_eligible: true };
const STANDING = () => [signedOutCodex, signedInClaude].map((s) => ({ ...s }));

function expectEngineBench(clisJson: string): void {
  const engine = JSON.parse(engineRosterJson(clisJson)) as Array<Record<string, unknown>>;
  expect(engine.find((s) => s['key'] === 'codex')!['health']).toEqual({ usable: false, reason: 'signed out' });
  expect(engine.find((s) => s['key'] === 'claude')!['health']).toEqual({ usable: true });
}

interface FakeAdapter {
  launches: LaunchRunInput[];
  asAdapter(): CoreAdapter;
}
function fakeAdapter(): FakeAdapter {
  const listeners = new Set<(e: CoreEvent) => void>();
  const state: FakeAdapter = {
    launches: [],
    asAdapter: () =>
      ({
        registerWorkflow: async (def: WorkflowDef) => def.id,
        launchRun: async (input: LaunchRunInput) => {
          state.launches.push(input);
          return input.sessionId;
        },
        onEvent: (l: (e: CoreEvent) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        listRepos: async () => [],
      }) as unknown as CoreAdapter,
  };
  return state;
}

async function waitFor(cond: () => boolean, ms = 8000, step = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

describe('interactive seams launch with the standing roster (F-RECON-002/003)', () => {
  let dir: string;
  let busDb: string;
  let docsRoot: string;
  let subs: Array<{ stop(): Promise<void> | void }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-seam-roster-'));
    busDb = join(dir, 'bus.db');
    docsRoot = join(dir, 'docs');
    subs = [];
  });
  afterEach(async () => {
    for (const s of subs) await s.stop();
    removeScratch(dir);
  });

  function seedDoc(name: string, kind?: string, html = '<html><body data-wid="w"><h1>v1</h1></body></html>'): void {
    const d = join(docsRoot, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'versions.json'), JSON.stringify({ ...(kind !== undefined ? { kind } : {}), head: 1, versions: [{ version: 0, html_file: '_v0.html' }, { version: 1, html_file: '_v1.html' }] }));
    writeFileSync(join(d, '_v1.html'), html);
    if (kind === 'demo') writeFileSync(join(d, '_v0.html'), '<section class="wi-demo">placeholder</section>');
  }

  async function emit(event_type: string, subdomain: string, payload: Record<string, unknown>) {
    const bus = await import('wicked-bus');
    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    bus.emit(db, config, { event_type, domain: 'wicked-interactive', subdomain, payload, producer_id: 'wi-ui' });
  }

  const common = () => ({ dbPath: busDb, pollIntervalMs: 25, heartbeatMs: 60_000, roster: STANDING, resolveDocsRoot: () => docsRoot, log: () => {} });

  it('draft seam: doc.created launches with the standing roster — codex benched at the engine', async () => {
    const engine = fakeAdapter();
    const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), { ...common(), ledgerPath: join(dir, 'l.json'), draftDir: join(dir, 'drafts') });
    subs.push(sub!);
    await emit(DOC_CREATED, 'docs', { document_id: 'spike-doc', kind: 'source', brief: 'a two-page brochure', source_paths: [], style: 'brochure', ts: new Date().toISOString() });
    await waitFor(() => engine.launches.length === 1);
    const seats = JSON.parse(engine.launches[0]!.clisJson) as Array<Record<string, unknown>>;
    expect(seats.find((s) => s['key'] === 'codex')!['council_eligible']).toBe(false);
    expectEngineBench(engine.launches[0]!.clisJson);
  });

  it('chat seam: an ask launches with the standing roster', async () => {
    const engine = fakeAdapter();
    seedDoc('iter-doc');
    const sub = await startInteractiveChatSubscriber(engine.asAdapter(), { ...common(), queueSweepMs: 25, landingGateMs: 60_000, ledgerPath: join(dir, 'c.json'), chatDir: join(dir, 'chats') });
    subs.push(sub!);
    await emit(CHAT_POSTED, 'chat', { role: 'user', text: 'Make the intro punchier.', document_id: 'iter-doc', ts: new Date().toISOString() });
    await waitFor(() => engine.launches.length === 1);
    expectEngineBench(engine.launches[0]!.clisJson);
  });

  it('edit seam: a structural handoff launches with the standing roster', async () => {
    const engine = fakeAdapter();
    const sub = await startInteractiveEditSubscriber(engine.asAdapter(), { ...common(), ledgerPath: join(dir, 'e.json'), editDir: join(dir, 'edits') });
    subs.push(sub!);
    await emit(FEEDBACK_PROCESSED, 'feedback', {
      document_id: 'q3-board-deck', version: 2, applied: [], rejected: [], stale: [], awaiting_structural: 1,
      structural_items: [{ selector: 'slide-2-heading-1', instruction: 'make this punchier', fragment: '<h2 data-wid="slide-2-heading-1">One bus</h2>' }],
      ts: new Date().toISOString(),
    });
    await waitFor(() => engine.launches.length === 1);
    expectEngineBench(engine.launches[0]!.clisJson);
  });

  it('demo seam: doc.created(kind:demo) launches with the standing roster — the seat the recon saw ELECTED is benched', async () => {
    const engine = fakeAdapter();
    seedDoc('checkout-demo', 'demo');
    const sub = await startInteractiveDemoSubscriber(engine.asAdapter(), { ...common(), ledgerPath: join(dir, 'd.json'), demoDir: join(dir, 'demos') });
    subs.push(sub!);
    await emit(DOC_CREATED, 'docs', { document_id: 'checkout-demo', kind: 'demo', url: 'https://staging.example.com/app', brief: 'show sign-in', ts: new Date().toISOString() });
    await waitFor(() => engine.launches.length === 1);
    expectEngineBench(engine.launches[0]!.clisJson);
  });

  it('NAPI-LEVEL: through the real adapter, the ENGINE receives health {usable:false, reason:"signed out"} for the signed-out seat (chat seam)', async () => {
    const prior = process.env['WICKED_WORKFLOWS_DIR'];
    process.env['WICKED_WORKFLOWS_DIR'] = join(dir, 'workflows');
    mkdirSync(process.env['WICKED_WORKFLOWS_DIR'], { recursive: true });
    const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    const launched: LaunchOptions[] = [];
    const core = (adapter as unknown as { core: Record<string, unknown> }).core;
    core['registerWorkflow'] = () => Promise.resolve('ok');
    core['launchRun'] = (opts: LaunchOptions) => {
      launched.push(opts);
      return Promise.resolve(opts.sessionId);
    };
    try {
      // The daemon wires the same accessor onto the adapter (server.ts); a seam with no `roster` option asks it.
      adapter.setRosterProvider(STANDING);
      seedDoc('iter-doc');
      const sub = await startInteractiveChatSubscriber(adapter, {
        dbPath: busDb, pollIntervalMs: 25, heartbeatMs: 60_000, queueSweepMs: 25, landingGateMs: 60_000,
        ledgerPath: join(dir, 'c2.json'), chatDir: join(dir, 'chats2'), resolveDocsRoot: () => docsRoot, log: () => {},
      });
      subs.push(sub!);
      await emit(CHAT_POSTED, 'chat', { role: 'user', text: 'Shorter please.', document_id: 'iter-doc', ts: new Date().toISOString() });
      await waitFor(() => launched.length === 1);
      const engine = JSON.parse(launched[0]!.clisJson) as Array<Record<string, unknown>>;
      expect(engine.find((s) => s['key'] === 'codex')!['health']).toEqual({ usable: false, reason: 'signed out' });
      expect('council_eligible' in engine.find((s) => s['key'] === 'codex')!).toBe(false);
    } finally {
      adapter.close();
      if (prior === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
      else process.env['WICKED_WORKFLOWS_DIR'] = prior;
    }
  });
});
