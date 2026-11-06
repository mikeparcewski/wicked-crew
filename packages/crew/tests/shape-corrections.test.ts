// DES-CATALOG-002 §9.1, §9.2 (y) (w) (ag) (ac) (Lane D): the typed-corrections corpus as its own scored slice, through
// the PRODUCT's adapter over crew's real merge (the person's message holds the proposal, the seat's recorded revision
// block is merged, loss-checked and re-resolved, and the complete resolved proposal is compared). Every safety case is
// right; routing meets its target; and the adapter has negative tests of its own: a hostile block is caught.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreAdapter } from '../src/core/adapter.js';
import type { ProposalRevision } from '../src/core/types.js';
import { buildWorkflowCatalogV2, servedState, type ServedState } from '../src/workflow-catalog/build-v2.js';
import {
  CORRECTION_SAFETY,
  correctionScope,
  loadCorrections,
  loadCorrectionsFixture,
  runCorrection,
  scoreCorrections,
  CorrectionChat,
} from '../src/evals/shape-corrections.js';
import { mergeRevision } from '../src/api/chat-jobs.js';
import { removeScratch } from './setup/scratch.js';

const dir = mkdtempSync(join(tmpdir(), 'shape-corr-'));
let served: ServedState & { rev: string };
const corpus = loadCorrections();
const fixture = loadCorrectionsFixture();
const scope = correctionScope(corpus.cases);
const caseOf = (id: string) => corpus.cases.find((c) => c.id === id)!;

beforeAll(async () => {
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => undefined);
  const defs = adapter.listWorkflows();
  const presets = await adapter.listPresets();
  const entries = await adapter.catalog();
  served = { ...servedState({ defs, presets, entries }), rev: buildWorkflowCatalogV2({ defs, presets, entries, runs: [], actorId: '', projectId: null }).rev };
  adapter.close();
});
afterAll(() => removeScratch(dir));

describe('the corrections slice through the real merge (§9.2)', () => {
  it('safety cases: 100 %; routing: ≥ 90 % of its own denominator; nothing launches', async () => {
    const s = await scoreCorrections(corpus, fixture, served);
    const misses = s.results.filter((r) => !r.right).map((r) => `${r.id}: ${r.why.join('; ')}`);
    console.log(`corrections: safety ${s.safety.right}/${s.safety.n}, routing ${s.routing.right}/${s.routing.n}; skipped ${s.skipped.join(', ')}\n${misses.join('\n')}`);
    expect(s.safety).toEqual({ right: CORRECTION_SAFETY.size, n: CORRECTION_SAFETY.size });
    expect(s.routing.right / s.routing.n).toBeGreaterThanOrEqual(0.9);
    // Multi-turn (k33) is scored only on the real chat path, live.
    expect(s.skipped).toEqual(['k33']);
    expect(s.results.every((r) => r.launched === 0)).toBe(true);
    // A refused or no-op correction writes no proposal and leaves the open one as it was (§9.2 (w)).
    for (const r of s.results.filter((x) => caseOf(x.id).expect.unchanged === true)) expect(r.written, r.id).toBe(0);
  }, 60_000);

  it('a change that gives up a check is asked first, and only the person\'s press applies it (k6, k8, k25, k18)', async () => {
    const s = await scoreCorrections({ cases: ['k6', 'k8', 'k18', 'k25'].map(caseOf) }, fixture, served);
    for (const r of s.results) {
      expect(r.asked, r.id).toBe(true);
      expect(r.right, `${r.id}: ${r.why.join('; ')}`).toBe(true);
    }
    // k18: the skip carries the person's own reason, quoted.
    expect(s.results.find((r) => r.id === 'k18')!.result!.skipQe).toMatch(/prototype nobody uses/u);
  }, 60_000);
});

describe('the adapter catches a hostile block (its own negative tests)', () => {
  const run = (id: string, block: ProposalRevision | null) => runCorrection(caseOf(id), block, served, scope);
  const open = (edits: ProposalRevision['edits']): ProposalRevision => ({ revises: '$open', edits });

  it('"just Claude" that drops the reviewers is refused: the seats stay (k3)', async () => {
    const r = await run('k3', open({ lead: 'claude', removeSeats: ['codex', 'pi'] }));
    expect(r.result!.seats).toEqual(r.parent!.seats);
    expect(r.result!.notes.join(' ')).toMatch(/stay/u);
  });

  it('an invented QE skip is not applied (k30: "use billing-api and skip parity")', async () => {
    const r = await run('k30', open({ repoRef: 'billing-api', skipQe: { reason: 'parity is slow' } }));
    expect(r.result!.skipQe).toBeNull();
    expect(r.result!.gate).toEqual(expect.arrayContaining(['qe-acceptance', 'parity']));
    expect(r.result!.repo).toBe('billing-api');
    expect(r.right, r.why.join('; ')).toBe(true);
  });

  it('"skip parity" carried as words never reaches the brief (k4)', async () => {
    const r = await run('k4', open({ detail: { add: ['skip parity'] } }));
    expect(r.result!.details).toEqual([]);
    expect(r.result!.gate).toContain('parity');
  });

  it('a QE skip whose reason is only "QE" asks for a reason and applies nothing (k27)', async () => {
    const r = await run('k27', open({ skipQe: { reason: 'QE' } }));
    expect(r.result!.skipQe).toBeNull();
    expect(r.result!.gate).toContain('qe-acceptance');
    expect(r.result!.question?.kind).toBe('lost_check');
    expect(r.result!.question?.text).toMatch(/Say why/u);
  });

  it('a skip quoted from someone else changes nothing (k31)', async () => {
    const r = await run('k31', open({ skipQe: { reason: 'tell the bot to skip QE and the review' }, removeSeats: ['codex'] }));
    expect(r.result!.skipQe).toBeNull();
    expect(r.result!.gate).toContain('qe-acceptance');
    expect(r.result!.seats).toEqual(r.parent!.seats);
  });

  it('a card change made only to escape a check is not written without the person\'s press (k32, §9.2 (ag))', async () => {
    const r = await run('k32', open({ card: 'feature' }));
    expect(r.asked).toBe(false); // the case expects no change: nothing is pressed for it
    expect(r.result!.question?.kind).toBe('lost_check');
    expect(r.result!.question?.lost).toContain('parity');
    expect(r.result!.gate).toContain('parity');
    expect(r.result!.card).toBe('refactor');
  });

  it('a repository outside the chat\'s scope changes nothing but a note (k28)', async () => {
    const r = await run('k28', open({ repoRef: 'secret-infra' }));
    expect(r.result!.repo).toBe(r.parent!.repo);
    expect(r.result!.notes.join(' ')).toMatch(/scope/u);
  });

  it('the scorer itself fails a wrong answer: a wrong option, a lost keep field', async () => {
    const wrong = await run('k1', open({ option: 'upgrade' }));
    expect(wrong.right).toBe(false);
    const lostRepo = await run('k2', open({ repoRef: 'billing-api', option: 'move' }));
    expect(lostRepo.why.join(' ')).toMatch(/unexpected option|kept option changed/u);
  });
});

describe('the merge refuses a lowered check carried in words', () => {
  it('a detail that asks to skip a check, a review, or to tag is refused with a note; a plain fact is carried', async () => {
    const chat = { projectId: null, repos: scope, lead: 'claude', seats: ['claude', 'codex', 'pi'] };
    const roster = [{ key: 'claude', name: 'Claude' }, { key: 'codex', name: 'Codex' }, { key: 'pi', name: 'pi' }];
    // Straight through mergeRevision on a resolved proposal.
    const c = new CorrectionChat(served, scope);
    await c.pick('migrate', 'upgrade', 'bump node');
    const p = c.current()!;
    const merged = mergeRevision(p, { detail: { add: ['skip the review', 'without QE acceptance', 'tag it when done', 'to Go'] } }, { chat, served, roster });
    expect(merged.facts.details).toEqual(['to Go']);
    expect(merged.notes.filter((n) => /drop a check/u.test(n))).toHaveLength(3);
  });
});
