/**
 * The `shape` suite (DES-CATALOG-002 §9): detection scored on a labelled corpus, exactly.
 *
 * - **Exact scoring** (§9.2): a clear case is right only when the card AND the option both match (every option, not
 *   only plan-changing ones) and the band is not `ask`. An ambiguous case accepts only its listed shapes (a bare card in
 *   the list accepts any option of it). A coming case is right when the coming card (and option) is named. Depth is
 *   reported apart: it is a brief line, never a plan change.
 * - **The release checks and targets** of §9.2 are computed from one pass ({@link scoreShapeCorpus}); CI asserts them on
 *   the shipped words layer plus the recorded seat fixture. The live numbers are the integrator's (`run-evals` with
 *   the real chat seat on the rig).
 * - **Coverage** ({@link shapeCoverage}): every launchable card has at least 3 cases, every combined card at least one
 *   ambiguous case, and every option at least 2.
 * - **Real cases** carry one of four labels ({@link ShapeLabel}); deployment accuracy is estimated only from an audited,
 *   stratified random sample ({@link auditSample}).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CATALOG_V2_CARDS } from '../workflow-catalog/catalog-data-v2.js';
import { classifyPathSync, detect, detectable, differentPlan, type RawGuess } from '../workflow-catalog/detect.js';
import type { ShapeGuess } from '../core/types.js';
import type { RunLike } from './capture.js';
import type { EvalCase, Observed } from './types.js';

export const SHAPE_CORPUS_FILE = fileURLToPath(new URL('../../evals/corpora/shape-v1.json', import.meta.url));
export const SHAPE_FIXTURE_FILE = fileURLToPath(new URL('../../evals/corpora/shape-v1.seat-fixture.json', import.meta.url));
export const SHAPE_CORRECTIONS_FILE = fileURLToPath(new URL('../../evals/corpora/shape-corrections-v1.json', import.meta.url));
export const SHAPE_CORRECTIONS_FIXTURE_FILE = fileURLToPath(new URL('../../evals/corpora/shape-corrections-v1.seat-fixture.json', import.meta.url));

export type ShapeCaseKind = 'clear' | 'variant' | 'combined' | 'ambiguous' | 'coming' | 'depth' | 'context' | 'adversarial';

export interface ShapeCase {
  id: string;
  kind: ShapeCaseKind;
  text: string;
  planChanging?: boolean;
  expect: {
    card?: string;
    option?: string;
    depth?: 'quick' | 'standard' | 'deep';
    /** Ambiguous: the acceptable shapes (`card` or `card:option`). */
    ask?: string[];
    /** Coming: the coming card (`card` or `card:option`) and the nearest offered today. */
    coming?: string;
    nearest?: string;
  };
}

export interface ShapeCorpus {
  $comment?: string;
  cases: ShapeCase[];
}

export function loadShapeCorpus(file = SHAPE_CORPUS_FILE): ShapeCorpus {
  return JSON.parse(readFileSync(file, 'utf8')) as ShapeCorpus;
}

/** The recorded seat answers, by case id (`null`: the seat gave none, a timeout). */
export function loadShapeFixture(file = SHAPE_FIXTURE_FILE): Record<string, RawGuess | null> {
  return (JSON.parse(readFileSync(file, 'utf8')) as { answers: Record<string, RawGuess | null> }).answers;
}

const key = (card: string, option: string | null | undefined): string => (option !== null && option !== undefined ? `${card}:${option}` : card);

/** Whether a decided shape is one of an ambiguous case's acceptable shapes. */
export function acceptable(card: string, option: string | null, allowed: readonly string[]): boolean {
  return allowed.includes(key(card, option)) || allowed.includes(card);
}

/** The option a case expects: the one it names, else the card's default (a card with options always has one). */
export function expectedOption(card: string | undefined, option: string | undefined): string | null {
  if (option !== undefined) return option;
  const seed = CATALOG_V2_CARDS.find((c) => c.id === card);
  return seed?.variant?.default ?? null;
}

/** A clear case's verdict: the card and the option, exactly (an omitted option is the card's default). */
export function exactRight(c: ShapeCase, g: Pick<ShapeGuess, 'card' | 'option'>): boolean {
  return g.card === c.expect.card && g.option === expectedOption(c.expect.card, c.expect.option);
}

/** Whether a wrong answer runs a different plan than the expected one (another card, or an option of another plan). */
export function wrongPlan(c: ShapeCase, g: Pick<ShapeGuess, 'card' | 'option'>): boolean {
  if (exactRight(c, g)) return false;
  if (g.card !== c.expect.card) return true;
  const seed = CATALOG_V2_CARDS.find((x) => x.id === g.card);
  return seed !== undefined && differentPlan(seed, g.option, expectedOption(c.expect.card, c.expect.option));
}

export interface ShapeCaseResult {
  id: string;
  kind: ShapeCaseKind;
  guess: ShapeGuess;
  right: boolean;
  note: string | null;
}

export interface ShapeMetrics {
  clear: number;
  /** Release check: ≥ 0.95. */
  right: number;
  wrongAtSure: string[];
  /** Release check: 0. */
  ambiguousUnacceptable: string[];
  /** Target: ≤ 10 %. */
  heldLikely: number;
  /** Target: ≤ 5 %. */
  askedOnClear: number;
  ambiguous: number;
  /** Target: ≥ 60 %. */
  ambiguousAsked: number;
  adversarial: number;
  adversarialRight: number;
  coming: number;
  /** Target: 100 % (of the coming cards the digest lists; a deferred card is not in it). */
  comingNamed: number;
  comingInDigest: number;
  depth: number;
  depthRight: number;
  /** Target: precision 1.0 when the words decide alone. */
  wordsDecided: number;
  wordsRight: number;
  planChangingWrong: string[];
  /** Wrong answers that run a different plan (derived from the catalog, every case): they must never be sure. */
  wrongPlanAtSure: string[];
  wrongPlan: string[];
  results: ShapeCaseResult[];
}

const rate = (k: number, n: number): number => (n === 0 ? 0 : k / n);

/** Score the corpus through crew's shipped detection with a seat's answers (§9.2). */
export function scoreShapeCorpus(corpus: ShapeCorpus, answers: Record<string, RawGuess | null>, source: 'chat' | 'classify' = 'classify', catalogRev = 'corpus'): ShapeMetrics {
  const m: ShapeMetrics = {
    clear: 0, right: 0, wrongAtSure: [], ambiguousUnacceptable: [], heldLikely: 0, askedOnClear: 0, ambiguous: 0, ambiguousAsked: 0,
    adversarial: 0, adversarialRight: 0, coming: 0, comingNamed: 0, comingInDigest: 0, depth: 0, depthRight: 0, wordsDecided: 0, wordsRight: 0,
    planChangingWrong: [], wrongPlanAtSure: [], wrongPlan: [], results: [],
  };
  const inDigest = new Set(CATALOG_V2_CARDS.filter(detectable).map((c) => c.id));
  for (const c of corpus.cases) {
    // The production orchestration: on the detect-shape path the seat is asked only when the words do not decide.
    const { guess } = source === 'classify'
      ? classifyPathSync({ text: c.text, catalogRev }, answers[c.id] ?? null)
      : detect({ text: c.text, seat: answers[c.id] ?? null, source, catalogRev });
    let right = false;
    let note: string | null = null;
    if (c.kind === 'ambiguous') {
      m.ambiguous += 1;
      if (guess.band === 'ask') {
        m.ambiguousAsked += 1;
        right = true;
      } else if (!acceptable(guess.card, guess.option, c.expect.ask ?? [])) {
        m.ambiguousUnacceptable.push(c.id);
        note = `decided ${guess.band} onto ${key(guess.card, guess.option)}`;
      } else {
        right = true;
        note = `held ${guess.band} on an acceptable shape`;
      }
    } else if (c.kind === 'coming') {
      m.coming += 1;
      const [card, option] = (c.expect.coming ?? '').split(':');
      if (inDigest.has(card!)) m.comingInDigest += 1;
      right = guess.card === card && (option === undefined || guess.option === option);
      if (right) m.comingNamed += 1;
      else note = `named ${key(guess.card, guess.option)}`;
    } else {
      m.clear += 1;
      const exact = exactRight(c, guess);
      right = exact && guess.band !== 'ask';
      if (right) m.right += 1;
      if (guess.source === 'words') {
        m.wordsDecided += guess.band === 'sure' ? 1 : 0;
        m.wordsRight += guess.band === 'sure' && exact ? 1 : 0;
      }
      if (guess.band === 'sure' && !exact) m.wrongAtSure.push(c.id);
      if (guess.band === 'likely') m.heldLikely += 1;
      if (guess.band === 'ask') m.askedOnClear += 1;
      if (c.planChanging === true && !exact) m.planChangingWrong.push(c.id);
      if (wrongPlan(c, guess)) {
        m.wrongPlan.push(c.id);
        if (guess.band === 'sure') m.wrongPlanAtSure.push(c.id);
      }
      if (c.kind === 'adversarial') {
        m.adversarial += 1;
        m.adversarialRight += right ? 1 : 0;
      }
      if (c.expect.depth !== undefined) {
        m.depth += 1;
        m.depthRight += guess.depth === c.expect.depth ? 1 : 0;
      }
      if (!exact) note = `expected ${key(c.expect.card!, expectedOption(c.expect.card, c.expect.option))}, got ${key(guess.card, guess.option)} (${guess.band})`;
      else if (guess.band !== 'sure') note = `right, held ${guess.band}`;
    }
    m.results.push({ id: c.id, kind: c.kind, guess, right, note });
  }
  return m;
}

/** The §9.2 rows as plain figures (for the report and the CI test). */
export function shapeReport(m: ShapeMetrics): Record<string, number | string> {
  return {
    'card and option right, clear cases': `${m.right}/${m.clear} (${rate(m.right, m.clear).toFixed(3)})`,
    'wrong at sure': m.wrongAtSure.length,
    'ambiguous decided onto an unacceptable shape': m.ambiguousUnacceptable.length,
    'clear cases held as likely': `${m.heldLikely}/${m.clear} (${rate(m.heldLikely, m.clear).toFixed(3)})`,
    'asked on a clear case': `${m.askedOnClear}/${m.clear}`,
    'ambiguous asked': `${m.ambiguousAsked}/${m.ambiguous} (${rate(m.ambiguousAsked, m.ambiguous).toFixed(3)})`,
    'adversarial placed right': `${m.adversarialRight}/${m.adversarial}`,
    'coming card named': `${m.comingNamed}/${m.comingInDigest} in the digest (${m.coming} coming cases)`,
    'words layer precision when it decides alone': `${m.wordsRight}/${m.wordsDecided}`,
    'depth right (apart)': `${m.depthRight}/${m.depth}`,
  };
}

// ── coverage (§9.1) ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ShapeCoverage {
  /** Launchable cards with fewer than 3 cases. */
  cardsShort: string[];
  /** Combined cards (options that run different plans) with no ambiguous case naming them. */
  combinedWithoutAmbiguous: string[];
  /** Options with fewer than 2 cases (`card:option`). */
  optionsShort: string[];
}

/** The corpus's coverage of the launchable 1.0 cards (§9.1). */
export function shapeCoverage(corpus: ShapeCorpus): ShapeCoverage {
  const launchable = CATALOG_V2_CARDS.filter((c) => detectable(c) && c.release === '1.0' && c.status !== 'coming_soon');
  const cardCount = new Map<string, number>();
  const optCount = new Map<string, number>();
  const ambiguousNames = new Set<string>();
  for (const c of corpus.cases) {
    if (c.kind === 'ambiguous') {
      for (const a of c.expect.ask ?? []) ambiguousNames.add(a.split(':')[0]!);
      continue;
    }
    if (c.kind === 'coming' || c.expect.card === undefined) continue;
    cardCount.set(c.expect.card, (cardCount.get(c.expect.card) ?? 0) + 1);
    const seed = CATALOG_V2_CARDS.find((x) => x.id === c.expect.card);
    const opt = c.expect.option ?? seed?.variant?.default;
    if (opt !== undefined) optCount.set(`${c.expect.card}:${opt}`, (optCount.get(`${c.expect.card}:${opt}`) ?? 0) + 1);
  }
  // A combined card: more than one option it can launch today (Studio plugin's second option is coming).
  const combined = launchable.filter((c) => (c.variant?.options.filter((o) => o.status !== 'coming_soon').length ?? 0) > 1);
  return {
    cardsShort: launchable.filter((c) => (cardCount.get(c.id) ?? 0) < 3).map((c) => c.id),
    combinedWithoutAmbiguous: combined.filter((c) => !ambiguousNames.has(c.id)).map((c) => c.id),
    optionsShort: launchable.flatMap((c) => (c.variant?.options ?? []).filter((o) => o.status !== 'coming_soon').map((o) => `${c.id}:${o.id}`)).filter((k) => (optCount.get(k) ?? 0) < 2),
  };
}

// ── real cases: labels and the audited sample (§9.1) ──────────────────────────────────────────────────────────────

/**
 * How a real case is labelled: `suggested-accepted` (detected and launched unchanged), `selected` (the person picked
 * the card), `corrected` (changed at launch or at the plan gate: a diagnostic slice, selected because something was
 * off), `audited` (labelled afterwards by a person; the only label deployment accuracy is estimated from).
 */
export type ShapeLabel = 'suggested-accepted' | 'selected' | 'corrected' | 'audited';

export interface ShapeLaunch {
  runId: string;
  /** The launch's place (project, else repo). */
  place: string | null;
  card: string;
  option: string | null;
  by: 'person' | 'detected';
  /** The words the shape was detected from (shortened for display). */
  words: string;
  /** The whole input, as one key (its hash): what makes two launches the same request. */
  inputKey?: string;
  /** A later run reshaped it (`retryOf` names this run), or its proposal was revised before Start. */
  corrected: boolean;
}

export function labelOf(l: ShapeLaunch): Exclude<ShapeLabel, 'audited'> {
  if (l.corrected) return 'corrected';
  return l.by === 'detected' ? 'suggested-accepted' : 'selected';
}

/** A small deterministic PRNG (mulberry32), so a release window's sample is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AuditSample {
  /** The sampled launches, to be labelled by a person. */
  sample: ShapeLaunch[];
  /** Launches the sample was drawn from (repeats of the same text in the same place counted once). */
  denominator: number;
  size: number;
}

/**
 * The audited random sample (§9.1): `n` launches (default 50) stratified by card, with repeats of the same text in the
 * same place counted once, and the denominator reported. Deterministic for a seed.
 */
export function auditSample(launches: readonly ShapeLaunch[], n = 50, seed = 1): AuditSample {
  const seen = new Set<string>();
  const pool: ShapeLaunch[] = [];
  for (const l of launches) {
    // The same request in the same place counts once: keyed on the WHOLE input (case kept), never the display text.
    const k = `${l.place ?? ''}\u0000${l.inputKey ?? l.words.trim()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pool.push(l);
  }
  const rand = prng(seed);
  const byCard = new Map<string, ShapeLaunch[]>();
  for (const l of pool) byCard.set(l.card, [...(byCard.get(l.card) ?? []), l]);
  for (const list of byCard.values()) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
  }
  // Proportional allocation, at least one per card while room remains, largest remainders first.
  const size = Math.min(n, pool.length);
  // The strata in a seeded random order: when the sample cannot hold one of each, which cards it holds is random too.
  const cards = [...byCard.keys()].sort();
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }
  const quota = new Map<string, number>(cards.map((c) => [c, 0]));
  let left = size;
  for (const c of cards) {
    if (left === 0) break;
    quota.set(c, 1);
    left -= 1;
  }
  const want = cards.map((c) => ({ c, exact: (byCard.get(c)!.length / pool.length) * size }));
  while (left > 0) {
    const next = want
      .filter((w) => quota.get(w.c)! < byCard.get(w.c)!.length)
      .sort((a, b) => (b.exact - quota.get(b.c)!) - (a.exact - quota.get(a.c)!) || cards.indexOf(a.c) - cards.indexOf(b.c))[0];
    if (next === undefined) break;
    quota.set(next.c, quota.get(next.c)! + 1);
    left -= 1;
  }
  const sample = cards.flatMap((c) => byCard.get(c)!.slice(0, quota.get(c)!));
  return { sample, denominator: pool.length, size: sample.length };
}

// ── the suite's cases (DES-DEFAULT-EVALS-001's one case shape) ─────────────────────────────────────────────────────


/** The label a detection is scored on: `card:option` (or `card`), `ask` when it asked. */
export function shapeKey(card: string, option: string | null | undefined): string {
  return key(card, option);
}

/** What a clear, coming or ambiguous corpus case expects, as one label. */
function expectedLabel(c: ShapeCase): string {
  // An ambiguous case is right when it asks or lands on one of its listed shapes (§9.2).
  if (c.kind === 'ambiguous') return 'acceptable';
  if (c.kind === 'coming') return c.expect.coming ?? '';
  return key(c.expect.card ?? '', expectedOption(c.expect.card, c.expect.option));
}

/** The corpus as suite cases (synthetic, labelled by the corpus): the replay runs today's detection on each. */
export function shapeCorpusCases(corpus: ShapeCorpus = loadShapeCorpus(), answers: Record<string, RawGuess | null> = loadShapeFixture()): EvalCase[] {
  return corpus.cases.map((c) => ({
    id: `shape:${c.id}`,
    suite: 'shape',
    source: 'synthetic',
    project: null,
    surface: 'detection',
    inputKey: `shape:${c.text.toLowerCase()}`,
    input: { text: c.text, kind: c.kind, seat: answers[c.id] ?? null, ...(c.kind === 'ambiguous' ? { acceptable: c.expect.ask ?? [] } : {}) },
    observed: null,
    expected: { label: expectedLabel(c), by: 'fixture', why: `the corpus (${c.kind})` },
    evidence: { file: 'packages/crew/evals/corpora/shape-v1.json' },
  }));
}

/** The label of one detection, as the suite scores it: `ask`, or the shape it would propose. */
export function observedOf(text: string, seat: RawGuess | null, acceptableShapes?: readonly string[]): Observed {
  const { guess } = classifyPathSync({ text, catalogRev: 'replay' }, seat);
  const label = guess.band === 'ask' ? 'ask' : key(guess.card, guess.option);
  if (acceptableShapes !== undefined && (guess.band === 'ask' || acceptable(guess.card, guess.option, acceptableShapes))) return { label: 'acceptable', by: 'replay' };
  return { label, confidence: guess.confidence, by: 'replay' };
}

/** A launch's shape, read off a served run (`GET /runs` decorates it with `shape`, `retry_of` and its title). */
export function shapeLaunchesOf(runs: readonly RunLike[]): ShapeLaunch[] {
  // Corrected = started again as ANOTHER job (a reshape): an ordinary retry of the same card and option is not one.
  const shapeKeyOf = (r: RunLike): string | null => {
    const sh = r.session['shape'] as { card?: unknown; option?: unknown } | undefined;
    return sh !== undefined && typeof sh.card === 'string' ? key(sh.card, typeof sh.option === 'string' ? sh.option : null) : null;
  };
  const byRun = new Map(runs.map((r) => [String(r.session['id']), r]));
  const retried = new Map<string, string>();
  for (const r of runs) {
    const of = r.session['retry_of'];
    if (typeof of !== 'string') continue;
    const parent = byRun.get(of);
    const a = parent === undefined ? null : shapeKeyOf(parent);
    const b = shapeKeyOf(r);
    if (a !== null && b !== null && a !== b) retried.set(of, String(r.session['id']));
  }
  const out: ShapeLaunch[] = [];
  for (const r of runs) {
    const shape = r.session['shape'] as { card?: unknown; option?: unknown; by?: unknown } | undefined;
    if (shape === undefined || typeof shape.card !== 'string') continue;
    const id = String(r.session['id']);
    // The words the job was asked in: the run's brief (`problem`, the person's words after crew's framing line), never
    // its derived title (two requests can share one title; codex r1). Shortened for display only.
    const problem = r.session['problem'];
    const title = typeof problem === 'string' && problem.trim() !== '' ? problem.trim() : r.session['title'];
    out.push({
      runId: id,
      place: (typeof r.session['project_id'] === 'string' ? r.session['project_id'] : null) ?? (typeof r.session['repo_ref'] === 'string' ? r.session['repo_ref'] : null),
      card: shape.card,
      option: typeof shape.option === 'string' ? shape.option : null,
      by: shape.by === 'detected' ? 'detected' : 'person',
      words: typeof title === 'string' ? title.slice(0, 2000) : '',
      inputKey: createHash('sha256').update(typeof title === 'string' ? title : id).digest('hex').slice(0, 32),
      corrected: retried.has(id),
    });
  }
  return out;
}

/**
 * Real cases (§9.1): a detected launch the person corrected at its plan (started again as another job). Its label is
 * the shape the person chose; the observation is what detection proposed. A diagnostic slice (`surface: 'corrected'`),
 * selected because something was off: never the headline. Launches accepted unchanged or picked by the person are
 * counted apart ({@link shapeLabelCounts}), never as agreement (a label that repeats the observation would inflate it).
 */
export function captureShapeCases(runs: readonly RunLike[]): EvalCase[] {
  const launches = shapeLaunchesOf(runs);
  const byId = new Map(launches.map((l) => [l.runId, l]));
  const out: EvalCase[] = [];
  for (const r of runs) {
    const of = r.session['retry_of'];
    if (typeof of !== 'string') continue;
    const before = byId.get(of);
    const after = byId.get(String(r.session['id']));
    if (before === undefined || after === undefined || before.by !== 'detected') continue;
    // A retry of the same job is not a correction.
    if (key(before.card, before.option) === key(after.card, after.option)) continue;
    out.push({
      id: `shape:corrected:${before.runId}`,
      suite: 'shape',
      source: 'real',
      project: before.place,
      surface: 'corrected',
      inputKey: `shape:${before.words.toLowerCase()}`,
      input: { text: before.words },
      observed: { label: key(before.card, before.option), by: 'recorded' },
      expected: { label: key(after.card, after.option), by: 'operator', why: 'the person started it again as another job' },
      evidence: { runId: before.runId },
    });
  }
  return out;
}

/** The label taxonomy's counts over this daemon's launches (reported on their own, §9.1). */
export function shapeLabelCounts(runs: readonly RunLike[]): Record<Exclude<ShapeLabel, 'audited'>, number> {
  const out = { 'suggested-accepted': 0, selected: 0, corrected: 0 };
  for (const l of shapeLaunchesOf(runs)) out[labelOf(l)] += 1;
  return out;
}
