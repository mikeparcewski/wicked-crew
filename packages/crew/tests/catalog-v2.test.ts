// DES-CATALOG-002 §3, §4, §5.3, §4.6 (Lane C): the v2 catalog — what each card shows is derived from the plan the
// engine serves, commands are unique and never collide with the composer's step commands or the phase catalog, the
// one hidden card is reachable only by its alias, a saved shadow below the built-in's checks turns its option off,
// an unserved preset is `unavailable` (never dropped), and a shape on a launch is judged against the current catalog.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreAdapter } from '../src/core/adapter.js';
import type { CatalogEntry, LaunchShape, Preset, WorkflowDef } from '../src/core/types.js';
import { QE_PRESETS } from '../src/core/qe-acceptance-setting.js';
import {
  buildWorkflowCatalogV2,
  derivedGate,
  optionWordOf,
  parseCommand,
  proposalOnly,
  resolveOption,
  servedState,
} from '../src/workflow-catalog/build-v2.js';
import { CATALOG_V2_CARDS } from '../src/workflow-catalog/catalog-data-v2.js';
import { briefLines, checkLaunchShape, withBriefLines } from '../src/workflow-catalog/shape.js';
import { removeScratch } from './setup/scratch.js';

const dir = mkdtempSync(join(tmpdir(), 'catalog-v2-'));
let adapter: CoreAdapter;
let defs: WorkflowDef[];
let presets: Preset[];
let entries: CatalogEntry[];

beforeAll(async () => {
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => undefined);
  // crew's own defs the daemon registers at boot (the run review and the default evals).
  const crewDef = (name: string): WorkflowDef => JSON.parse(readFileSync(new URL(`../workflows/${name}.json`, import.meta.url), 'utf8')) as WorkflowDef;
  defs = [...adapter.listWorkflows(), crewDef('run-evals'), crewDef('review-recent-work')];
  presets = await adapter.listPresets();
  entries = await adapter.catalog();
});
afterAll(() => {
  adapter.close();
  removeScratch(dir);
});

const build = (extra: Partial<Parameters<typeof buildWorkflowCatalogV2>[0]> = {}) =>
  buildWorkflowCatalogV2({ defs, presets, entries, runs: [], actorId: 'me', projectId: null, ...extra });

/** The composer's step commands (studio `planDraft.ts`): no card command may be one of them. */
const STEP_COMMANDS = ['test', 'review', 'walkthrough', 'research', 'security', 'plan', 'deliver'];

describe('the v2 wire', () => {
  it('serves every seed card (coming and hidden ones say so), ten verbs, and a stable rev', () => {
    const v2 = build();
    expect(v2.version).toBe(2);
    expect(v2.cards.filter((c) => c.category !== 'yours').map((c) => c.id)).toEqual(CATALOG_V2_CARDS.map((c) => c.id));
    expect(v2.categories.slice(0, 10).map((c) => c.id)).toEqual(['plan', 'build', 'test', 'investigate', 'analyze', 'judge', 'create', 'estimate', 'organize', 'improve']);
    expect(build().rev).toBe(v2.rev);
    expect(v2.cards.find((c) => c.id === 'test-analysis')).toMatchObject({ hidden: true, command: null });
    // CS8: every card the product showed as coming is live; only the deferred cards (never shown) still wait.
    expect(v2.cards.find((c) => c.id === 'competitive')).toMatchObject({ status: 'available', release: '1.0', launch: { kind: 'run', workflow: 'sourced-report' }, brief: 'Lens: competitive.' });
    expect(v2.cards.filter((c) => c.status === 'coming_soon').map((c) => [c.id, c.release])).toEqual([['setup-project', 'deferred'], ['tune', 'deferred']]);
    expect(v2.cards.flatMap((c) => (c.variant?.options ?? []).filter((o) => o.status === 'coming_soon').map((o) => `${c.id}:${o.id}`))).toEqual([]);
  });

  it('every 1.0 card and option launches on this engine (its preset is served)', () => {
    const off = build().cards
      .filter((c) => c.release === '1.0')
      .flatMap((c) => (c.variant?.options ?? [c]).map((o) => ({ card: c.id, option: 'id' in o && o !== c ? o.id : null, status: o.status, note: o.statusNote })))
      .filter((o) => o.status !== 'available');
    // CS8: Review a change is offered (CS11 excludes the authors of every contributing run); the flipped cards' presets
    // (sourced-report, run-cost, interactive-draft-sourced, editor-plugin's phase kind) are all served by this engine.
    expect(off).toEqual([]);
  });

  it("a card's gate is what its composed plan carries: every check the design names is on the plan", () => {
    const served = servedState({ defs, presets, entries });
    const missing: string[] = [];
    for (const card of CATALOG_V2_CARDS) {
      if (card.status === 'coming_soon' || card.release !== '1.0') continue;
      for (const o of card.variant?.options ?? [null]) {
        if (o?.status === 'coming_soon') continue;
        const r = resolveOption(card.id, o?.id ?? null, served)!;
        // §3.1: Analyze a codebase · Domain is judged by its own coverage judge, not cited findings (its row says so).
        const seeded = (o?.gate ?? card.gate ?? []).filter((g) => !(card.id === 'analyze-codebase' && o?.id === 'domain' && g === 'cited-findings'));
        for (const g of seeded) if (!r.resolved.gate.includes(g)) missing.push(`${card.id}:${o?.id ?? '-'} lacks ${g} (has ${r.resolved.gate.join(',')})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('QE acceptance shows exactly where the engine requires it, the new application-changing presets included', () => {
    const served = servedState({ defs, presets, entries });
    for (const name of ['modernize', 'refactor', 'release', 'scaffold']) expect(QE_PRESETS.has(name)).toBe(true);
    expect(resolveOption('migrate', 'move', served)!.resolved).toMatchObject({ requiresQe: true, gate: expect.arrayContaining(['qe-acceptance', 'parity']) });
    expect(resolveOption('refactor', 'polish', served)!.resolved.gate).toEqual(expect.arrayContaining(['qe-acceptance', 'parity']));
    expect(resolveOption('risk', null, served)!.resolved).toMatchObject({ requiresQe: false, gate: ['cited-findings'] });
  });

  it('Improve cards pass the proposal-only predicate; a plan that writes a store with no gate after it fails it', () => {
    const served = servedState({ defs, presets, entries });
    for (const card of CATALOG_V2_CARDS.filter((c) => c.category === 'improve' && c.release === '1.0')) {
      for (const o of card.variant?.options ?? [null]) {
        expect(resolveOption(card.id, o?.id ?? null, served)!.resolved.gate, `${card.id}:${o?.id}`).toContain('proposal-only');
      }
    }
    const writes = [{ id: 'w', catalog: 'produce', role: 'creator', pin: null, gate: null, rubric: null, writes: true }];
    expect(proposalOnly(writes, 'proposals')).toBe(false);
    expect(proposalOnly([...writes, { ...writes[0]!, id: 'g', writes: false, gate: { human_confirm: { unconditional: true } } }], 'proposals')).toBe(true);
    expect(derivedGate({ kind: 'run', workflow: 'x' }, writes, false, [], true, 'proposals')).not.toContain('proposal-only');
  });

  it('a saved shadow with fewer checks turns the option off and is reachable from Yours; one with the same checks is "Your version"', () => {
    const steps = [{ catalog: 'understand', id: 'look' }, { catalog: 'build', id: 'fix' }];
    const weak = { name: 'bug', steps, created_by: 'me', scope: 'global', required_instruments: [] } as unknown as Preset;
    const v1 = build({ presets: [...presets, weak] });
    expect(v1.cards.find((c) => c.id === 'bug')).toMatchObject({ status: 'unavailable', statusNote: expect.stringMatching(/fewer checks/) });
    expect(v1.cards.find((c) => c.category === 'yours' && c.launch.kind === 'run' && c.launch.workflow === 'bug')).toMatchObject({ source: 'saved', status: 'available' });
    const strong = { ...weak, required_instruments: ['distinct_evaluator', 'judge', 'qe_acceptance'] } as unknown as Preset;
    const v2 = build({ presets: [...presets, strong] });
    expect(v2.cards.find((c) => c.id === 'bug')).toMatchObject({ status: 'available', source: 'saved', gate: ['qe-acceptance'] });
    expect(v2.rev).not.toBe(build().rev);
  });

  it('a card whose preset the engine does not serve is unavailable, never dropped; an unseeded served def joins Yours', () => {
    const lean = presets.filter((p) => p.name !== 'reconstruct');
    const extra: WorkflowDef = { id: 'my-own-flow', phases: [], title: 'Mine' } as unknown as WorkflowDef;
    const v2 = build({ presets: lean, defs: [...defs.filter((d) => d.id !== 'reconstruct'), extra] });
    expect(v2.cards.find((c) => c.id === 'reconstruct')).toMatchObject({ status: 'unavailable', statusNote: expect.stringMatching(/does not serve/) });
    expect(v2.cards.find((c) => c.id === 'my-own-flow')).toMatchObject({ category: 'yours', source: 'crew' });
    // v2 leaves the Apps workflows out (Q12).
    expect(v2.cards.some((c) => c.launch.kind === 'run' && (c.launch.workflow === 'apps-turn' || c.launch.workflow === 'apps-publish'))).toBe(false);
  });

  it('usage counts by recorded shape, a retried lineage once, and an older run by its workflow', () => {
    const runs = [
      { id: 'a', workflow: 'migration', projectId: null, status: 'completed', createdAt: 100, endedAt: 700, principal: 'me', shape: { card: 'migrate', option: 'upgrade' } },
      { id: 'b', workflow: 'migration', projectId: null, status: 'completed', createdAt: 200, endedAt: 800, principal: 'me', shape: { card: 'migrate', option: 'upgrade' }, retryOf: 'a' },
      { id: 'c', workflow: 'bug', projectId: null, status: 'completed', createdAt: 300, endedAt: 400, principal: 'me' },
      { id: 'd', workflow: 'bug', projectId: null, status: 'completed', createdAt: 300, endedAt: 400, principal: 'someone-else' },
    ];
    const v2 = build({ runs });
    expect(v2.cards.find((c) => c.id === 'migrate')!.usage).toMatchObject({ launches: 1, byOption: { upgrade: 1 } });
    expect(v2.cards.find((c) => c.id === 'bug')!.usage.launches).toBe(1);
    expect(v2.top).toEqual(['bug', 'migrate:upgrade']);
  });
});

describe('commands', () => {
  const all = CATALOG_V2_CARDS.flatMap((c) => [
    ...(c.command !== null ? [c.command] : []),
    ...(c.variant?.options ?? []).map((o) => o.command).filter((x): x is string => typeof x === 'string'),
    ...c.aliases.map((a) => a.command),
  ]);

  it('are unique, and no card command is a composer step command or a phase catalog id', async () => {
    expect(new Set(all).size).toBe(all.length);
    const ids = new Set(entries.map((e) => e.id));
    for (const c of CATALOG_V2_CARDS) {
      if (c.command === null) continue;
      const word = c.command.slice(1);
      expect(STEP_COMMANDS, c.command).not.toContain(word);
      expect(ids.has(word) || ids.has(word.replace(/-/g, '_')), c.command).toBe(false);
    }
  });

  it('every option command is its card command plus its option word, and every alias names a real option', () => {
    for (const c of CATALOG_V2_CARDS) {
      for (const o of c.variant?.options ?? []) {
        if (o.command === undefined || o.command === null) continue;
        expect(o.command.startsWith(`${c.command} `), o.command).toBe(true);
        expect(parseCommand(`${o.command} make it so`)).toEqual({ card: c.id, option: o.id, words: 'make it so' });
        expect(optionWordOf(o.command)).toBe(o.command.split(' ')[1]);
      }
      for (const a of c.aliases) {
        if (a.option !== null) expect(c.variant?.options.some((o) => o.id === a.option), a.command).toBe(true);
        expect(parseCommand(`${a.command} words`)).toEqual({ card: c.id, option: a.option, words: 'words' });
      }
    }
  });

  it('a card command alone leaves the option open; the hidden card answers only to its alias', () => {
    expect(parseCommand('/migrate to node 22')).toEqual({ card: 'migrate', option: undefined, words: 'to node 22' });
    expect(parseCommand('/workflow-test-analysis the gaps')).toEqual({ card: 'test-analysis', option: null, words: 'the gaps' });
    expect(parseCommand('/test-analysis')).toBeNull();
    expect(parseCommand('migrate')).toBeNull();
  });
});

describe('the shape on a launch', () => {
  const served = () => ({ ...servedState({ defs, presets, entries }), rev: build().rev });
  const shape = (s: Partial<LaunchShape>): LaunchShape => ({ card: 'migrate', option: 'upgrade', depth: null, by: 'person', catalogRev: build().rev, ...s });

  it('a framing option gets exactly its brief, put first once; depth adds its line on an Investigate card only', () => {
    const v = checkLaunchShape(shape({}), { kind: 'run', workflow: 'migration' }, served());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.lines).toEqual([CATALOG_V2_CARDS.find((c) => c.id === 'migrate')!.variant!.options.find((o) => o.id === 'upgrade')!.brief]);
    const once = withBriefLines('bump node to 22', v.lines);
    expect(withBriefLines(once, v.lines)).toBe(once);
    const inc = checkLaunchShape(shape({ card: 'incident', option: null, depth: 'deep' }), { kind: 'run', workflow: 'investigate-incident' }, served());
    expect(inc.ok && inc.lines[0]).toMatch(/^Depth: deep/);
    expect(briefLines(resolveOption('migrate', 'in-place', served())!, null)).toEqual([]);
  });

  it('refuses a shape that runs something else (400), a changed catalog (409), a detected ask (409) and a coming card (409)', () => {
    const mismatch = checkLaunchShape(shape({}), { kind: 'run', workflow: 'feature' }, served());
    expect(mismatch).toMatchObject({ ok: false, code: 400, body: { code: 'shape_mismatch' } });
    expect(checkLaunchShape(shape({ option: 'nope' }), { kind: 'run', workflow: 'migration' }, served())).toMatchObject({ ok: false, code: 400 });
    expect(checkLaunchShape(shape({ depth: 'quick' }), { kind: 'run', workflow: 'migration' }, served())).toMatchObject({ ok: false, code: 400 });
    expect(checkLaunchShape(shape({ catalogRev: 'old' }), { kind: 'run', workflow: 'migration' }, served())).toMatchObject({ ok: false, code: 409, body: { code: 'catalog_changed' } });
    expect(checkLaunchShape(shape({ by: 'detected', guess: { confidence: 0.3, band: 'ask', source: 'chat', reason: 'unsure', detectionRunId: null } }), { kind: 'run', workflow: 'migration' }, served()))
      .toMatchObject({ ok: false, code: 409, body: { code: 'shape_ask' } });
    expect(checkLaunchShape(shape({ card: 'competitive', option: null }), { kind: 'run', workflow: undefined }, served())).toMatchObject({ ok: false, code: 400 });
    // A coming card (only the deferred ones remain) still never launches.
    expect(checkLaunchShape(shape({ card: 'tune', option: null }), { kind: 'none' } as never, served())).toMatchObject({ ok: false, code: 409, body: { code: 'card_not_available' } });
    expect(checkLaunchShape(shape({ card: 'document', option: 'presentation' }), { kind: 'document', style: 'doc' }, served())).toMatchObject({ ok: false, code: 400 });
    expect(checkLaunchShape(shape({ card: 'demo-video', option: null }), { kind: 'demo' }, served())).toMatchObject({ ok: true });
    expect(checkLaunchShape(shape({ card: 'backlog', option: 'tasks' }), { kind: 'compose' }, served())).toMatchObject({ ok: true });
  });
});

// CS8 (DES-CATALOG-002 rev 8): the catalog flip. Every card the product showed as coming launches what shipped.
describe('the flipped cards (CS8)', () => {
  const REPORTS: ReadonlyArray<[string, string]> = [
    ['research', 'research'], ['competitive', 'competitive'], ['due-diligence', 'due-diligence'],
    ['analyze-documents', 'analyze'], ['critique', 'critique'], ['estimate-price', 'estimate'],
  ];

  it('the six sourced reports run sourced-report with their lens line, judged at the source by a seat that did not gather', () => {
    const served = servedState({ defs, presets, entries });
    for (const [card, lens] of REPORTS) {
      const r = resolveOption(card, null, served)!;
      expect(r.resolved, card).toMatchObject({ status: 'available', release: '1.0', launch: { kind: 'run', workflow: 'sourced-report' }, brief: `Lens: ${lens}.`, delivers: 'report' });
      expect(r.resolved.gate, card).toContain('fidelity-to-source');
      expect(r.resolved.seats.distinctEvaluator, card).toBe(true);
    }
    // Documents are required where the design says, optional on the others; Research and Competitive take the pick.
    const inputs = (card: string): string[] => resolveOption(card, null, served)!.resolved.inputs.map((i) => `${i.id}${i.required ? '' : '?'}`);
    expect(inputs('due-diligence')).toContain('documents');
    expect(inputs('analyze-documents')).toContain('documents');
    expect(inputs('critique')).toContain('documents?');
    expect(inputs('estimate-price')).toContain('documents?');
    expect(inputs('run-cost')).toContain('documents?');
    expect(inputs('research')).toContain('sources');
    expect(inputs('incident')).toContain('sources?');
  });

  it('a card framing a shared preset reads as itself: six reports never share one summary', () => {
    const cards = build().cards.filter((c) => REPORTS.some(([id]) => id === c.id));
    expect(new Set(cards.map((c) => c.summary)).size).toBe(REPORTS.length);
    for (const c of cards) expect(c.summary, c.id).toBe(CATALOG_V2_CARDS.find((s) => s.id === c.id)!.outcome);
    // A kind-framed card reads as the card, not as its default kind; an unframed variant card keeps its default's line.
    const v2 = build();
    for (const id of ['respond', 'rework', 'communicate']) expect(v2.cards.find((c) => c.id === id)!.summary, id).toBe(CATALOG_V2_CARDS.find((s) => s.id === id)!.outcome);
    const migrate = CATALOG_V2_CARDS.find((s) => s.id === 'migrate')!;
    expect(v2.cards.find((c) => c.id === 'migrate')!.summary).toBe(migrate.variant!.options.find((o) => o.id === migrate.variant!.default)!.summary);
  });

  it('a sourced report gets a neutral depth line; Incident keeps its cause lines', () => {
    const served = { ...servedState({ defs, presets, entries }), rev: build().rev };
    const r = resolveOption('research', null, served)!;
    expect(briefLines(r, 'deep')).toEqual(['Lens: research.', expect.stringMatching(/^Depth: deep\. /u)]);
    expect(briefLines(r, 'deep').join('\n')).not.toMatch(/cause/u);
    expect(briefLines(resolveOption('incident', null, served)!, 'deep')[0]).toMatch(/cause/u);
  });

  it('the sourced draft is never a Yours card (only Respond and Rework start it, with their documents)', () => {
    expect(build().cards.filter((c) => c.category === 'yours').map((c) => c.id)).not.toContain('interactive-draft-sourced');
  });

  it('Model run cost runs the run-cost preset; Review a change is offered', () => {
    const served = servedState({ defs, presets, entries });
    expect(resolveOption('run-cost', null, served)!.resolved).toMatchObject({ status: 'available', launch: { kind: 'run', workflow: 'run-cost' } });
    expect(resolveOption('review-change', null, served)!.resolved).toMatchObject({ status: 'available', statusNote: null });
  });

  it('Respond and Rework options draft a document on the sourced preset with their kind line', () => {
    const served = servedState({ defs, presets, entries });
    const kinds: Record<string, string[]> = { respond: ['rfp', 'rfi', 'questionnaire'], rework: ['condense', 're-audience', 'generalize', 'convert', 'refresh'] };
    for (const [card, opts] of Object.entries(kinds)) {
      expect(CATALOG_V2_CARDS.find((c) => c.id === card)!.variant!.options.map((o) => o.id)).toEqual(opts);
      for (const o of opts) {
        const r = resolveOption(card, o, served)!;
        // Convert makes slides; every other kind keeps the source's prose form.
        const style = card === 'rework' && o === 'convert' ? 'ppt' : 'doc';
        expect(r.resolved, `${card}:${o}`).toMatchObject({ status: 'available', launch: { kind: 'document', style }, brief: `Kind: ${card}-${o}.` });
        expect(r.resolved.gate, `${card}:${o}`).toEqual(expect.arrayContaining(['fidelity-to-source', 'draft-floor']));
      }
    }
  });

  it('on an engine without interactive-draft-sourced, Respond and Rework are off with why (no dead Start); Document is unchanged', () => {
    const older = servedState({ defs, presets: presets.filter((p) => p.name !== 'interactive-draft-sourced'), entries });
    for (const [card, opt] of [['respond', 'rfp'], ['rework', 'convert']] as const) {
      const r = resolveOption(card, opt, older)!;
      expect(r.resolved.status, card).toBe('unavailable');
      expect(r.resolved.statusNote, card).toMatch(/interactive-draft-sourced/u);
    }
    expect(resolveOption('document', 'document', older)!.resolved.status).toBe('available');
  });

  it('Studio plugin · Phase builds a Job details section through editor-plugin, with QE acceptance and install consent', () => {
    const served = servedState({ defs, presets, entries });
    const r = resolveOption('studio-plugin', 'phase', served)!;
    expect(r.resolved).toMatchObject({ status: 'available', launch: { kind: 'run', workflow: 'editor-plugin' }, brief: 'Kind: phase plugin.', requiresQe: true });
    expect(r.resolved.gate).toEqual(expect.arrayContaining(['qe-acceptance', 'install-consent']));
    expect(r.option!.summary).toMatch(/details/u);
    expect(parseCommand('/plugin phase a section with each phase\'s elapsed time')).toMatchObject({ card: 'studio-plugin', option: 'phase' });
  });
});
