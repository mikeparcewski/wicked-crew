/** The accepted card's displayed checks must agree with its engine run, all the way through Go. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bus from 'wicked-bus';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ArtifactProposal, CoreEvent, LaunchRunInput, Preset } from '../src/core/types.js';
import { draftPresetFor, derivedGate, resolveOption, servedState } from '../src/workflow-catalog/build-v2.js';
import { CreateLauncher } from '../src/interactive/proposal-create.js';
import { DocBindingStore } from '../src/interactive/doc-binding.js';
import { DRAFT_COMPLETED, startInteractiveDraftSubscriber, type InteractiveDraftSubscription } from '../src/interactive/draft-events.js';
import { removeScratch } from './setup/scratch.js';

// CS8 owns the catalog flip: simulate its future launches without changing the coming-soon seeds.
vi.mock('../src/workflow-catalog/catalog-data-v2.js', async (original) => {
  const actual = await original<typeof import('../src/workflow-catalog/catalog-data-v2.js')>();
  return { ...actual, CATALOG_V2_CARDS: actual.CATALOG_V2_CARDS.map((c) => {
    if (c.id !== 'respond' && c.id !== 'rework') return c;
    const card: Record<string, unknown> = { ...c };
    delete card['status'];
    delete card['statusNote'];
    return { ...card, launch: { kind: 'document', style: 'doc' } } as typeof c;
  }) };
});

const empty = servedState({ defs: [], presets: [], entries: [] });
describe('CS5 shared draft selection and gates', () => {
  const options = ['rfp', 'rfi', 'questionnaire', 'condense', 're-audience', 'generalize', 'convert', 'refresh', 'future', null, undefined];
  it.each([
    ['respond', 'interactive-draft-sourced'], ['rework', 'interactive-draft-sourced'],
    ['communicate', 'interactive-draft'], ['document', 'interactive-draft'],
    ['other', 'interactive-draft'], [null, 'interactive-draft'], [undefined, 'interactive-draft'],
  ] as const)('draftPresetFor(%s) covers every option (%s)', (card, expected) => {
    for (const option of options) {
      expect(draftPresetFor(card, option)).toBe(expected);
    }
  });
  it.each([
    ['respond', null, ['fidelity-to-source', 'draft-floor']],
    ['rework', null, ['fidelity-to-source', 'draft-floor']],
    ['communicate', 'narrative', ['draft-floor']], ['document', null, ['draft-floor']],
  ] as const)('%s document launch displays exactly its draft checks', (card, option, expected) => {
    expect(derivedGate({ kind: 'document', style: 'doc' }, [], false, [], false, 'document', card, option)).toEqual(expected);
    // Cover the caller too: dropping card/option here would hide the sourced check.
    expect(resolveOption(card, option, empty)!.resolved.gate).toEqual(expected);
  });
  it('preserves non-document gate derivation even with a sourced card', () => {
    expect(derivedGate({ kind: 'run', workflow: 'x' }, [], false, [], false, 'report', 'respond', 'rfp')).toEqual([]);
    expect(derivedGate({ kind: 'compose' }, [], false, [], false, 'proposals', 'rework', 'convert')).toEqual(['traces-to-requirements']);
  });
});

const scratch: string[] = [];
const subscriptions: InteractiveDraftSubscription[] = [];
afterEach(async () => {
  for (const sub of subscriptions.splice(0)) await sub.stop();
  for (const dir of scratch.splice(0)) removeScratch(dir);
});
async function waitFor(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 8000, interval: 25 });
}

/** Existing draft-events harness: real temporary bus and subscriber, fake engine, real Go dispatcher. */
async function world(presets: 'sourced' | 'missing' | 'unreadable' = 'sourced') {
  const dir = mkdtempSync(join(tmpdir(), 'crew-cs5-'));
  scratch.push(dir);
  const docs = join(dir, 'docs');
  mkdirSync(docs);
  const dbPath = join(dir, 'bus.db');
  const db = bus.openDb({ db_path: dbPath }) as unknown as {
    prepare(sql: string): { all(): Array<{ event_type: string; payload: string }> };
  };
  const bindings = new DocBindingStore(join(dir, 'bindings'));
  const listeners = new Set<(event: CoreEvent) => void>();
  const launches: LaunchRunInput[] = [];
  const listPresets = vi.fn(async () => {
    if (presets === 'unreadable') throw new Error('old engine');
    return (presets === 'sourced' ? [{ name: 'interactive-draft-sourced' }] : [{ name: 'interactive-draft' }]) as Preset[];
  });
  const adapter = {
    listPresets, listRepos: async () => [],
    launchRun: async (input: LaunchRunInput) => { launches.push(input); return input.sessionId; },
    onEvent: (listener: (event: CoreEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as CoreAdapter;
  const sub = await startInteractiveDraftSubscriber(adapter, {
    dbPath, ledgerPath: join(dir, 'ledger.json'), draftDir: join(dir, 'drafts'),
    pollIntervalMs: 25, heartbeatMs: 60_000, bindings,
    draftFloorIo: { gardenRoot: () => null }, log: () => {},
  });
  expect(sub).not.toBeNull();
  subscriptions.push(sub!);
  const launcher = new CreateLauncher({
    bindings, runExists: async () => false, docsRoot: async () => docs,
    createDoc: async (_projectId, body) => {
      const root = join(docs, String(body['name']));
      mkdirSync(root);
      writeFileSync(join(root, 'versions.json'), JSON.stringify({ head: 0, kind: 'doc', versions: [{ version: 0 }] }));
      return { status: 200, body: {} };
    },
    launchBound: (spec) => sub!.launchBound(spec),
    records: () => [], instanceOf: () => 'i1', chatIdOf: (id) => id,
    repos: async () => [], graphFor: async () => null,
    clisJsonFor: () => '[{"key":"claude"},{"key":"codex"}]', styleOf: () => 'doc',
    packetDeps: { runs: async () => [], brief: async () => { throw new Error('no run source'); }, docsRoot: async () => null, attachment: () => null },
  });
  const go = async (card: string | undefined, option: string | null = null) => {
    const resolution: ArtifactProposal = {
      pid: 'c1:t1', chatId: 'c1', turnId: 't1', kind: 'create', seat: 'claude',
      what: { entry: 'document-static', title: 'Response', label: 'Document', outcome: null },
      brief: 'A response from supplied material', reason: null, sources: [], repos: [], repoRefs: [],
      helpers: { seats: ['claude', 'codex'], label: 'Writer and checker' }, time: null, stops: null,
      filedIn: { projectId: null, label: 'This chat' }, blocked: null,
      ...(card !== undefined ? { shape: { card, option, depth: null, by: 'person' as const, source: 'pick' as const } } : {}),
    };
    await launcher.launch({ kind: 'create', pid: resolution.pid, chatId: 'c1', actor: { id: 'person', kind: 'human', trust: 'operator' },
      identity: { artifactRef: '_unfiled/response', runId: 'run-response' }, resolution });
  };
  const events = () => db.prepare('SELECT event_type, payload FROM events ORDER BY event_id').all()
    .map((e) => ({ type: e.event_type, payload: JSON.parse(e.payload) as Record<string, unknown> }));
  return { dir, sub: sub!, launches, listPresets, go, bindings, events,
    fire: (event: CoreEvent) => { for (const listener of listeners) listener(event); },
    outPath: join(dir, 'drafts', 'response', 'attempt-run-response', 'response-v1.html') };
}

describe('CS5 proposal Go through the draft seam', () => {
  it.each([
    ['respond', 'rfp', 'interactive-draft-sourced'], ['rework', 'convert', 'interactive-draft-sourced'],
    ['document', null, 'interactive-draft'], ['communicate', 'narrative', 'interactive-draft'], [undefined, null, 'interactive-draft'],
  ] as const)('%s Go (%s) launches %s', async (card, option, expected) => {
    const w = await world();
    await w.go(card, option);
    expect(w.launches).toHaveLength(1);
    expect(w.launches[0]).toMatchObject({ workflow: expected, sessionId: 'run-response' });
    expect(w.launches[0]!.problem).toContain('A response from supplied material');
    expect(w.launches[0]!.projectId).toBeUndefined();
    expect(w.listPresets).toHaveBeenCalledTimes(expected === 'interactive-draft-sourced' ? 1 : 0);
  });
  it.each(['missing', 'unreadable'] as const)('refuses a sourced Go when the preset is %s', async (presets) => {
    const w = await world(presets);
    await expect(w.go('respond', 'rfp')).rejects.toThrow("this engine has no sourced draft yet; update wicked-crew's engine");
    expect(w.launches).toEqual([]);
    expect(w.sub.ledger.size()).toBe(0);
    expect(w.bindings.get('_unfiled/response')?.attempts[0]?.launchingAt).toBeUndefined();
    expect(w.sub.inFlightDocs()).toEqual([]);
    expect(existsSync(join(w.dir, 'drafts'))).toBe(false);
    expect(w.events().filter((e) => e.type === DRAFT_COMPLETED)).toEqual([]);
  });
  it('a held or rejected source check and sessionFailed never announce a landing, even with a written draft', async () => {
    const w = await world();
    await w.go('respond', 'rfp');
    expect(w.launches[0]!.workflow).toBe('interactive-draft-sourced');
    writeFileSync(w.outPath, '<html><body><h1>Response</h1><p>Supported response.</p></body></html>');
    w.fire({ type: 'unitPlanned', session: 'run-response', ord: 2, description: 'check — fidelity-to-source', role: 'evaluator', executorType: 'agent' } as unknown as CoreEvent);
    w.fire({ type: 'awaitingHuman', session: 'run-response', ord: 2, prompt: 'Source check failed', gateKind: 'human_confirm' } as unknown as CoreEvent);
    await waitFor(() => w.events().some((e) => String(e.payload['message']).includes('Source check failed')));
    expect(w.events().filter((e) => e.type === DRAFT_COMPLETED)).toEqual([]);
    w.fire({ type: 'gateDecided', session: 'run-response', ord: 2, allow: false });
    expect(w.events().filter((e) => e.type === DRAFT_COMPLETED)).toEqual([]);
    w.fire({ type: 'sessionFailed', session: 'run-response', ord: 2 });
    // Wait for terminal bus output so an erroneous asynchronous finalize cannot evade this assertion.
    await waitFor(() => w.events().some((e) => e.type === DRAFT_COMPLETED || String(e.payload['message']).includes('failed (run run-response)')));
    expect(w.events().filter((e) => e.type === DRAFT_COMPLETED)).toEqual([]);
    expect(w.bindings.get('_unfiled/response')?.attempts[0]).toMatchObject({ outcome: { kind: 'failed' } });
    expect(w.bindings.get('_unfiled/response')?.attempts[0]?.emittedAt).toBeUndefined();
  });
  it('a completed sourced run can announce its draft', async () => {
    const w = await world();
    await w.go('respond', 'rfp');
    writeFileSync(w.outPath, '<html><body><h1>Response</h1><p>Supported response.</p></body></html>');
    w.fire({ type: 'sessionCompleted', session: 'run-response' });
    await waitFor(() => w.events().some((e) => e.type === DRAFT_COMPLETED));
    expect(w.events().find((e) => e.type === DRAFT_COMPLETED)!.payload).toMatchObject({ run_id: 'run-response', expect_head: 0 });
  });
});
