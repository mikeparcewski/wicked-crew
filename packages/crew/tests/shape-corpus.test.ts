// DES-CATALOG-002 §9.1, §9.2 (Lane D): the corpus run in CI. The shipped words layer, validator, cross-check and bands
// over `evals/corpora/shape-v1.json` with the recorded seat-answer fixture: deterministic and model-free. The release
// checks must hold here; the targets guide tuning and are asserted too. The live §9.2 checks (the real chat seat on the
// rig) are the integrator's.
import { describe, expect, it } from 'vitest';

import { runDefaultEvals } from '../src/evals/runner.js';
import { defaultReplaySet } from '../src/evals/replay.js';
import {
  auditSample,
  captureShapeCases,
  exactRight,
  loadShapeCorpus,
  loadShapeFixture,
  scoreShapeCorpus,
  shapeCorpusCases,
  shapeCoverage,
  shapeLabelCounts,
  shapeLaunchesOf,
  shapeReport,
  type ShapeLaunch,
} from '../src/evals/shape.js';
import { SUITE_IDS } from '../src/evals/types.js';
import { CATALOG_V2_CARDS } from '../src/workflow-catalog/catalog-data-v2.js';
import * as detectModule from '../src/workflow-catalog/detect.js';

const { detectable } = detectModule;

const corpus = loadShapeCorpus();
const fixture = loadShapeFixture();
const m = scoreShapeCorpus(corpus, fixture);

describe('the shape corpus through the shipped detection (§9.2)', () => {
  it('has a recorded seat answer for every case', () => {
    for (const c of corpus.cases) expect(Object.hasOwn(fixture, c.id), c.id).toBe(true);
  });

  it('release checks: card AND option right on ≥ 95 % of clear cases; 0 wrong at sure; 0 ambiguous decided onto an unacceptable shape', () => {
    console.log(JSON.stringify(shapeReport(m), null, 1));
    expect(m.right / m.clear).toBeGreaterThanOrEqual(0.95);
    expect(m.wrongAtSure).toEqual([]);
    expect(m.ambiguousUnacceptable).toEqual([]);
    // A wrong answer that runs another plan (derived from the catalog for every case) is never sure.
    expect(m.wrongPlanAtSure).toEqual([]);
  });

  it('targets: held as likely ≤ 10 %, asked on a clear case ≤ 5 %, ambiguous asked ≥ 60 %, adversarial 100 %, coming named 100 %, words precision 1.0', () => {
    expect(m.heldLikely / m.clear).toBeLessThanOrEqual(0.1);
    expect(m.askedOnClear / m.clear).toBeLessThanOrEqual(0.05);
    expect(m.ambiguousAsked / m.ambiguous).toBeGreaterThanOrEqual(0.6);
    expect(m.adversarialRight).toBe(m.adversarial);
    expect(m.adversarial).toBeGreaterThanOrEqual(8);
    // Every coming card the digest lists is named (a deferred card is not in the digest by design: `tune`).
    expect(m.comingNamed).toBe(m.comingInDigest);
    expect(m.wordsRight).toBe(m.wordsDecided);
    expect(m.wordsDecided).toBeGreaterThan(30);
    expect(m.depthRight).toBe(m.depth);
  });

  it('an omitted option is the card\'s default, in both scorers (codex r1)', () => {
    const r5 = corpus.cases.find((x) => x.id === 'r5')!;
    expect(r5.expect.option).toBeUndefined();
    expect(scoreShapeCorpus({ cases: [r5] }, { r5: { card: 'refactor', option: 'polish', confidence: 0.95 } }).right).toBe(0);
    expect(shapeCorpusCases({ cases: [r5] }, {})[0]!.expected.label).toBe('refactor:refactor');
  });

  it('scores exactly: a right card with the wrong option is wrong, for every option', () => {
    const m1 = corpus.cases.find((x) => x.id === 'm1')!;
    expect(exactRight(m1, { card: 'migrate', option: 'upgrade' })).toBe(true);
    expect(exactRight(m1, { card: 'migrate', option: 'move' })).toBe(false);
    const c11 = corpus.cases.find((x) => x.id === 'c11')!;
    // A framing option is scored as exactly as a plan-changing one.
    expect(exactRight(c11, { card: 'communicate', option: 'message' })).toBe(false);
  });

  it('a hostile seat naming a wrong card at 1.0 is held as likely unless the words rank that card close (the cross-check)', () => {
    const hostile: Record<string, { card: string; confidence: number }> = {};
    for (const c of corpus.cases) if (c.kind !== 'ambiguous' && c.kind !== 'coming') hostile[c.id] = { card: c.expect.card === 'release' ? 'bug' : 'release', confidence: 1 };
    const h = scoreShapeCorpus(corpus, hostile);
    for (const id of h.wrongAtSure) {
      const r = h.results.find((x) => x.id === id)!;
      expect(r.guess.source, id).toBe('classify');
      expect(detectModule.wordsAgree(detectModule.wordsLayer(corpus.cases.find((c) => c.id === id)!.text), r.guess.card), id).toBe(true);
    }
    expect(h.wrongAtSure.length / h.clear).toBeLessThan(0.05);
  });
});

describe('coverage (§9.1)', () => {
  it('every launchable card has ≥ 3 cases, every combined card an ambiguous case, every option ≥ 2 cases', () => {
    expect(shapeCoverage(corpus)).toEqual({ cardsShort: [], combinedWithoutAmbiguous: [], optionsShort: [] });
  });

  it('names only cards and options the catalog has', () => {
    const ids = new Map(CATALOG_V2_CARDS.map((c) => [c.id, c]));
    for (const c of corpus.cases) {
      const shapes = c.kind === 'ambiguous' ? (c.expect.ask ?? []) : c.kind === 'coming' ? [c.expect.coming!, c.expect.nearest!] : [`${c.expect.card}${c.expect.option !== undefined ? `:${c.expect.option}` : ''}`];
      for (const s of shapes) {
        const [card, option] = s.split(':');
        const seed = ids.get(card!);
        if (card === 'tune' || card === 'rework' || card === 'critique') {
          expect(seed, s).toBeDefined();
          continue;
        }
        expect(seed, `${c.id}: ${s}`).toBeDefined();
        if (option !== undefined) expect(seed!.variant?.options.some((o) => o.id === option), `${c.id}: ${s}`).toBe(true);
      }
    }
  });

  it('carries the new adversarial cases: an option substituted within a card, and an instruction inside quoted chat or a document', () => {
    for (const id of ['z5', 'z6', 'z7', 'z8']) expect(corpus.cases.find((c) => c.id === id)?.kind, id).toBe('adversarial');
  });
});

describe('the shape suite in the default evals', () => {
  it('is one of the suites, replays the corpus with today\'s detection, and reports by surface', async () => {
    expect(SUITE_IDS).toContain('shape');
    const cases = shapeCorpusCases(corpus, fixture);
    const { report } = await runDefaultEvals({ id: 'r1', now: new Date(0), project: null, cases, replay: defaultReplaySet({ gardenRoot: null }), previous: {}, suites: ['shape'] });
    const s = report.suites.find((x) => x.suite === 'shape')!;
    expect(s.synthetic.unscored).toBe(0);
    expect(s.synthetic.cases).toBe(corpus.cases.length);
    expect(s.synthetic.agreement.value!).toBeGreaterThanOrEqual(0.95);
    expect(s.notes.join(' ')).toMatch(/exact scoring/u);
  });

  it('captures a detected launch the person started again as another job as a corrected (diagnostic) case', () => {
    const runs = [
      { session: { id: 'r1', title: 'move the service to node 22', shape: { card: 'migrate', option: 'move', by: 'detected' }, project_id: 'p1' }, units: [] },
      { session: { id: 'r2', title: 'move the service to node 22', retry_of: 'r1', shape: { card: 'migrate', option: 'upgrade', by: 'person' }, project_id: 'p1' }, units: [] },
      // An ordinary retry of the same job is not a correction.
      { session: { id: 'r5', title: 'add dark mode', shape: { card: 'feature', option: null, by: 'detected' } }, units: [] },
      { session: { id: 'r6', title: 'add dark mode', retry_of: 'r5', shape: { card: 'feature', option: null, by: 'detected' } }, units: [] },
      { session: { id: 'r3', title: 'fix the login bug', shape: { card: 'bug', option: null, by: 'detected' } }, units: [] },
      { session: { id: 'r4', title: 'review it', shape: { card: 'risk', option: null, by: 'person' } }, units: [] },
    ];
    const cases = captureShapeCases(runs);
    expect(cases).toEqual([expect.objectContaining({ id: 'shape:corrected:r1', source: 'real', surface: 'corrected', observed: { label: 'migrate:move', by: 'recorded' }, expected: expect.objectContaining({ label: 'migrate:upgrade', by: 'operator' }) })]);
    expect(shapeLabelCounts(runs)).toEqual({ 'suggested-accepted': 3, selected: 2, corrected: 1 });
    // The audit reads the words the job was asked in (its brief), never a title two requests can share.
    const twin = [
      { session: { id: 'a', title: 'Focus: flaky tests', problem: 'Focus: flaky tests\n\nthe checkout e2e suite fails one run in five', shape: { card: 'suite-health', option: 'flaky', by: 'detected' } }, units: [] },
      { session: { id: 'b', title: 'Focus: flaky tests', problem: 'Focus: flaky tests\n\nthe search tests time out at random', shape: { card: 'suite-health', option: 'flaky', by: 'detected' } }, units: [] },
    ];
    expect(auditSample(shapeLaunchesOf(twin), 50, 1).denominator).toBe(2);
    // Two long requests that differ only after the display cut, or only in case, are two requests (codex r2).
    const shared = 'x'.repeat(2500);
    const longTwins = [
      { session: { id: 'c', problem: `${shared} then fix ParseDate`, shape: { card: 'bug', option: null, by: 'detected' } }, units: [] },
      { session: { id: 'd', problem: `${shared} then fix parsedate`, shape: { card: 'bug', option: null, by: 'detected' } }, units: [] },
    ];
    expect(auditSample(shapeLaunchesOf(longTwins), 50, 1).denominator).toBe(2);
    // And a corrected case keeps the whole request, keyed by it (codex r3).
    const corrected = captureShapeCases([
      { session: { id: 'e', problem: `${shared} then fix ParseDate`, shape: { card: 'migrate', option: 'move', by: 'detected' } }, units: [] },
      { session: { id: 'f', retry_of: 'e', problem: `${shared} then fix ParseDate`, shape: { card: 'bug', option: null, by: 'person' } }, units: [] },
    ]);
    expect(corrected[0]!.input['text']).toBe(`${shared} then fix ParseDate`);
    expect(corrected[0]!.inputKey).not.toContain(shared);
  });
});

describe('the audited sample (§9.1)', () => {
  const launches: ShapeLaunch[] = [];
  const cards = CATALOG_V2_CARDS.filter((c) => detectable(c) && c.status !== 'coming_soon').map((c) => c.id);
  for (let i = 0; i < 300; i += 1) launches.push({ runId: `r${i}`, place: `p${i % 2}`, card: cards[i % 7 === 0 ? 0 : i % cards.length]!, option: null, by: 'detected', words: `ask number ${i % 250}`, corrected: false });

  it('draws n launches stratified by card, counting the same words in the same place once, with the denominator', () => {
    const s = auditSample(launches, 50, 7);
    expect(s.size).toBe(50);
    expect(s.denominator).toBe(new Set(launches.map((l) => `${l.place}\u0000${l.words}`)).size);
    expect(s.denominator).toBeLessThan(launches.length);
    const k = new Set(s.sample.map((l) => `${l.place}\u0000${l.words}`));
    expect(k.size).toBe(50);
    // Every card that has a launch is in the sample (at least one each while room remains).
    expect(new Set(s.sample.map((l) => l.card)).size).toBe(new Set(launches.map((l) => l.card)).size);
    // Deterministic for its seed; another seed draws another sample.
    expect(auditSample(launches, 50, 7).sample.map((l) => l.runId)).toEqual(s.sample.map((l) => l.runId));
    expect(auditSample(launches, 50, 8).sample.map((l) => l.runId)).not.toEqual(s.sample.map((l) => l.runId));
  });

  it('a sample smaller than the number of cards draws its cards at random (seeded)', () => {
    const picks = new Set<string>();
    for (let seed = 1; seed <= 20; seed += 1) for (const l of auditSample(launches, 3, seed).sample) picks.add(l.card);
    expect(picks.size).toBeGreaterThan(3);
  });

  it('a pool smaller than n is sampled whole', () => {
    expect(auditSample(launches.slice(0, 5), 50, 1).size).toBe(5);
  });
});
