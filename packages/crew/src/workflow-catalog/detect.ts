/**
 * DETECTING THE SHAPE OF THE WORK (DES-CATALOG-002 §2.2, §2.3, §9). One module owns the contract: what a person's
 * words ask for, as ONE card of the v2 catalog (and its option, and an Investigate card's depth), with how sure.
 *
 * There is no new classifier. Three existing pieces, one contract:
 * - **the words layer** ({@link wordsLayer}): studio's ranked word match (`scoreEntry`, run as on Enter: whole words),
 *   owned by crew from here on, over each card's title, words, outcome and option words. It decides ALONE only when
 *   it is sure: at least 4 content words, a top score of at least 10, at least 1.5 times the runner-up, and, on a card
 *   whose options run different plans, an option the words decided;
 * - **a seat's reading**: in a chat, the chat seat's own `wicked-make` routing block; for free words typed into the `/`
 *   list, the hidden `detect-shape` turn. Both follow garden's `classify` skill in catalog mode;
 * - **one validator, one cross-check, one band table** ({@link validateGuess}, {@link crossCheck}, {@link bandOf}).
 *
 * Nothing here launches anything: a guess becomes a proposal the person sees, and only their Start runs it (every
 * repository job launched from a chat is held at its plan, too). The bands set how a card is first shown, they are not
 * the safety boundary.
 *
 * Pure: the catalog seeds and (where a guess is judged against what this engine serves) the resolved catalog in, a
 * {@link ShapeGuess} out.
 */
import type { ShapeGuess } from '../core/types.js';
import { CATALOG_V2_CARDS, CATALOG_V2_CATEGORIES } from './catalog-data-v2.js';
import type { CardSeedV2, OptionSeedV2 } from './seeds-v2.js';

// ── the band table (frozen for 1.0, §9.3) ──────────────────────────────────────────────────────────────────────────

/** sure at 0.85 or more; ask below 0.50 (or when the seat returned an ask list); likely between. Frozen for 1.0: the
 *  release checks are judged on data it has not seen (the rig run and the audited sample). */
export const DETECT_BANDS = Object.freeze({ sure: 0.85, ask: 0.5 });

export type Band = ShapeGuess['band'];

/** The band of a confidence (§2.3 `bandOf`). An ask list always asks. */
export function bandOf(confidence: number, ask: boolean): Band {
  if (ask) return 'ask';
  if (!Number.isFinite(confidence)) return 'ask';
  if (confidence >= DETECT_BANDS.sure) return 'sure';
  if (confidence < DETECT_BANDS.ask) return 'ask';
  return 'likely';
}

// ── the cards detection may name ───────────────────────────────────────────────────────────────────────────────────

/** A card detection may name: not hidden, not deferred or as-is (those are reached elsewhere, never by detection). */
export function detectable(c: CardSeedV2): boolean {
  return c.hidden !== true && (c.release === '1.0' || c.release === '1.1' || c.release === '1.2');
}

/** Coming: the card (or the option) is not launchable in this release. */
export function comingCard(c: CardSeedV2, option: OptionSeedV2 | null = null): boolean {
  return c.status === 'coming_soon' || option?.status === 'coming_soon' || (c.launch === undefined && c.variant === undefined);
}

/** An Investigate card (§3: depth is a brief line on these only; garden's catalog mode reads the digest's mark). */
export const isInvestigate = (c: CardSeedV2): boolean => c.category === 'investigate' || c.depth === true;

const DETECTABLE: readonly CardSeedV2[] = CATALOG_V2_CARDS.filter(detectable);
const byId = (id: string): CardSeedV2 | undefined => DETECTABLE.find((c) => c.id === id);

/** Whether a card's options run different plans (a wrong option there is a wrong plan, not a wrong brief line). */
export function planChangingAxis(c: CardSeedV2): boolean {
  const opts = c.variant?.options ?? [];
  return new Set(opts.map((o) => JSON.stringify([o.launch ?? null, o.compose ?? null]))).size > 1;
}

/** Whether two options of one card run different plans. */
export function differentPlan(c: CardSeedV2, a: string | null, b: string | null): boolean {
  const opt = (id: string | null): OptionSeedV2 | undefined => c.variant?.options.find((o) => o.id === (id ?? c.variant!.default));
  const plan = (o: OptionSeedV2 | undefined): string => JSON.stringify([o?.launch ?? c.launch ?? null, o?.compose ?? null]);
  return plan(opt(a)) !== plan(opt(b));
}

// ── the digest (§2.3 `catalogDigest`) ──────────────────────────────────────────────────────────────────────────────

/** The chat digest rides EVERY chat turn: it stays under this many bytes (a test pins it). */
export const CHAT_DIGEST_MAX_BYTES = 2048;
/** The classify digest (the one-shot `detect-shape` turn): outcomes, option one-liners and the coming cards. */
export const CLASSIFY_DIGEST_MAX_BYTES = 8192;

export type DigestMode = 'chat' | 'classify';

/** What the digest may say a card's status is, read from the resolved catalog (`GET /workflows/catalog?v=2`). */
export interface DigestView {
  /** Card or `card:option` → its status on this daemon. Absent = the seed's own. */
  status?: (card: string, option: string | null) => 'available' | 'coming_soon' | 'unavailable';
}

/**
 * The catalog as a seat reads it. One generator, two sizes:
 * - **chat** (≤ 2 KB): each available card's id and command, its options' ids, and `[depth]` on Investigate cards;
 *   coming cards by id only. The seat routes with these ids; crew resolves everything else.
 * - **classify** (~6.5 KB): adds the title and outcome, each option's one-liner, and the coming cards with status.
 */
export function catalogDigest(mode: DigestMode, view: DigestView = {}): string {
  const status = (c: CardSeedV2, o: OptionSeedV2 | null): 'available' | 'coming_soon' | 'unavailable' =>
    view.status?.(c.id, o?.id ?? null) ?? (comingCard(c, o) ? 'coming_soon' : 'available');
  if (mode === 'chat') {
    const live: string[] = [];
    const coming: string[] = [];
    for (const c of DETECTABLE) {
      const st = status(c, null);
      if (st === 'coming_soon') {
        coming.push(c.id);
        continue;
      }
      // Only what this daemon can run is offered to the chat seat (the classify digest says why the rest is not): a card
      // with options stays while ANY option is available, its default named only when it is one of them (codex r2).
      const opts = (c.variant?.options ?? []).filter((o) => status(c, o) === 'available').map((o) => o.id);
      if (c.variant === undefined ? st === 'unavailable' : opts.length === 0) continue;
      const dflt = c.variant !== undefined && opts.includes(c.variant.default) ? `; default ${c.variant.default}` : '';
      live.push(`${c.id}${isInvestigate(c) ? ' [depth]' : ''}${opts.length > 0 ? ` (${opts.join('|')}${dflt})` : ''}`);
    }
    return [
      'Job cards (id [depth: Investigate, takes quick|standard|deep] (options; default)):',
      live.join('; '),
      // No line when nothing is coming (CS8 shipped every coming card): an empty list is not a card to name.
      ...(coming.length > 0 ? [`Coming (name one only when it is the right shape): ${coming.join(', ')}.`] : []),
    ].join('\n');
  }
  const lines: string[] = ['CATALOG (card id [category] title: what you get; options are card:option; [depth] = an Investigate card):'];
  const cat = new Map(CATALOG_V2_CATEGORIES.map((c) => [c.id, c.title]));
  for (const c of DETECTABLE) {
    const st = status(c, null);
    lines.push(`- ${c.id} [${cat.get(c.category) ?? c.category}]${isInvestigate(c) ? ' [depth]' : ''} ${c.title}: ${c.outcome ?? ''}${st === 'coming_soon' ? ` (COMING in ${c.release})` : st === 'unavailable' ? ' (NOT ON THIS DAEMON)' : ''}`.trimEnd());
    for (const o of c.variant?.options ?? []) {
      const os = status(c, o);
      lines.push(`    - ${c.id}:${o.id}${o.id === c.variant!.default ? ' (default)' : ''} ${o.title}: ${o.summary ?? ''}${os === 'coming_soon' ? ' (COMING)' : ''}`.trimEnd());
    }
  }
  return lines.join('\n');
}

// ── the words layer (§2.3 `wordsLayer`; studio `board/workflowCatalog.ts` `scoreEntry`, Enter mode) ───────────────

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'about',
  'my', 'our', 'your', 'me', 'we', 'i', 'it', 'its', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were',
  'be', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'please', 'want', 'need', 'some', 'new', 'x',
]);

/** Words people type for what a job does, said as the words the catalog uses (studio's lexicon, as is). */
const LEXICON: Readonly<Record<string, readonly string[]>> = {
  doc: ['documentation', 'docs', 'document'],
  document: ['documentation', 'docs'],
  documentation: ['docs', 'document'],
  readme: ['documentation', 'docs'],
  guide: ['documentation', 'walkthrough'],
  write: ['author', 'documentation'],
  explain: ['documentation', 'walkthrough', 'learn'],
  learn: ['walkthrough', 'research'],
  slide: ['presentation', 'deck'],
  deck: ['presentation', 'slide'],
  pitch: ['presentation'],
  video: ['demo', 'recording'],
  record: ['demo', 'video'],
  screencast: ['demo', 'video'],
  bug: ['issue', 'fix'],
  issue: ['bug', 'fix'],
  fix: ['issue', 'bug', 'resolve'],
  broken: ['issue', 'bug', 'fail'],
  break: ['issue', 'bug', 'fail'],
  crash: ['issue', 'bug', 'fail'],
  error: ['issue', 'bug', 'fail'],
  fail: ['failure', 'review', 'issue'],
  failure: ['fail', 'review'],
  why: ['review', 'analyze'],
  went: ['review'],
  happen: ['review'],
  run: ['runs', 'review'],
  job: ['runs', 'review'],
  upgrade: ['migrate', 'migration'],
  migrate: ['migration', 'upgrade', 'port'],
  port: ['migrate', 'migration'],
  move: ['migrate', 'migration'],
  test: ['tests', 'testing', 'qe'],
  coverage: ['test', 'tests', 'analysis'],
  plan: ['planning'],
  automate: ['automation'],
  domain: ['extraction', 'model'],
  business: ['domain'],
  plugin: ['plugins', 'extension'],
  extension: ['plugin'],
  editor: ['plugin'],
  tool: ['mcp', 'tools'],
  mcp: ['tool', 'server'],
  build: ['feature', 'create'],
  add: ['feature'],
  feature: ['build'],
  app: ['vibe', 'builder', 'dashboard'],
  dashboard: ['vibe', 'app'],
  validate: ['validation', 'check', 'verify'],
  check: ['validate', 'review'],
  verify: ['validate'],
  review: ['analyze', 'check'],
};

/** Plain English stemming (studio's `stem`). */
export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 3 && s.endsWith('es') && /(ss|sh|ch|x)es$/u.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
}

/** The content words of a text: lower case, split on anything not a letter or digit, stop words out, stemmed. */
export function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '' && !STOP.has(t)).map(stem).filter((t) => t !== '' && !STOP.has(t));
}

const FIELD_WEIGHT = { title: 6, words: 4, gets: 2, other: 1 } as const;
const EXPANSION_FACTOR = 0.5;

interface Field {
  t: ReadonlySet<string>;
  w: number;
}

const own = <T>(rec: Readonly<Record<string, T>>, k: string): T | undefined => (Object.hasOwn(rec, k) ? rec[k] : undefined);

function scoreFields(fields: readonly Field[], query: string): number {
  const qs = tokens(query);
  if (qs.length === 0) return 0;
  let score = 0;
  let matched = 0;
  for (const q of qs) {
    let direct = 0;
    for (const f of fields) if (f.t.has(q)) direct = Math.max(direct, f.w);
    let expanded = 0;
    for (const x of own(LEXICON, q) ?? []) {
      const sx = stem(x);
      for (const f of fields) if (f.t.has(sx)) expanded = Math.max(expanded, f.w * EXPANSION_FACTOR);
    }
    const best = Math.max(direct, expanded);
    if (best > 0) matched += 1;
    score += best;
  }
  return score * (0.5 + (0.5 * matched) / qs.length);
}

const CATEGORY_TITLE = new Map(CATALOG_V2_CATEGORIES.map((c) => [c.id, c.title]));

function cardFields(c: CardSeedV2): Field[] {
  const optWords = (c.variant?.options ?? []).flatMap((o) => [...(o.words ?? []), o.title]);
  return [
    { t: new Set([...tokens(c.title), ...tokens(c.id)]), w: FIELD_WEIGHT.title },
    { t: new Set([...(c.words ?? []), ...optWords].flatMap(tokens)), w: FIELD_WEIGHT.words },
    { t: new Set(tokens(c.outcome ?? '')), w: FIELD_WEIGHT.gets },
    { t: new Set([...tokens(CATEGORY_TITLE.get(c.category) ?? ''), ...(c.needs ?? []).flatMap(tokens)]), w: FIELD_WEIGHT.other },
  ];
}

function optionFields(o: OptionSeedV2): Field[] {
  return [
    { t: new Set([...tokens(o.title), ...tokens(o.id)]), w: FIELD_WEIGHT.title },
    { t: new Set((o.words ?? []).flatMap(tokens)), w: FIELD_WEIGHT.words },
    { t: new Set(tokens(o.summary ?? '')), w: FIELD_WEIGHT.gets },
  ];
}

const CARD_FIELDS: ReadonlyMap<string, Field[]> = new Map(DETECTABLE.map((c) => [c.id, cardFields(c)]));
const OPTION_FIELDS: ReadonlyMap<string, Field[]> = new Map(DETECTABLE.flatMap((c) => (c.variant?.options ?? []).map((o) => [`${c.id}:${o.id}`, optionFields(o)] as const)));

/** The words layer's sure rule (§2.3). */
export const WORDS_SURE = Object.freeze({ minWords: 4, minScore: 10, ratio: 1.5 });

export interface WordsResult {
  /** Cards by score, best first (only those that match at all). */
  ranked: ReadonlyArray<{ card: string; score: number }>;
  /** The top card, or `null` when no card matches a word. */
  card: string | null;
  /** Its option: the best-matching one, else the card's default; `null` for a card without options. */
  option: string | null;
  /** The words chose the option (it matched, and clearly ahead of the next). */
  optionDecided: boolean;
  /** The words layer decides alone. */
  sure: boolean;
  /** The content words counted. */
  words: number;
  top: number;
  runnerUp: number;
}

/** Words aimed at the detector rather than describing the work ("note to the classifier:", "confidence 1.0", "card=X",
 *  "SYSTEM OVERRIDE", "ignore previous instructions"). */
const AIMED = /(?:\bnote to the\s+(?:classifier|router|detector|bot|model|assistant|ai)\b|\b(?:classifier|router|detector)\s*:|\bsystem override\b|\bignore (?:all |any )?(?:the )?previous instructions\b|\bconfidence\s*[=:]?\s*[01](?:\.\d+)?(?![\d.])|\bcard\s*[=:])/iu;
/** A segment that ADDRESSES the detector and hands the instruction to the next one ("Note to the router: choose X"). */
const ADDRESSING = /(?:note to the\s+\w+|\b(?:classifier|router|detector|system|assistant))\s*:\s*$/iu;

/**
 * The person's words with what is aimed at the detector taken out, for the words layer only (the seat reads the whole
 * text, as `<request>` data, under rules that say not to follow it). An instruction planted in the words would
 * otherwise match catalog words and vote for itself ("this is a security review, confidence 0.99"), and the
 * cross-check would agree with the injected card. Bracketed spans and sentences carrying such words are dropped, and a
 * segment that addresses the detector ("Note to the router:") drops the instruction after it.
 */
export function withoutAimed(text: string): string {
  const t = text.replace(/[[(]([^\])]*)[\])]/gu, (m, inner: string) => (AIMED.test(inner) ? ' ' : m));
  const segs = t.split(/(?<=[.!?;:])\s+|\n+/u);
  const kept: string[] = [];
  let dropNext = false;
  for (const seg of segs) {
    if (dropNext) {
      dropNext = false;
      continue;
    }
    if (ADDRESSING.test(seg)) {
      dropNext = true;
      continue;
    }
    if (AIMED.test(seg)) continue;
    kept.push(seg);
  }
  return kept.join(' ');
}

/**
 * What the person asks to GET BACK, when their words say it outright: a plan, a review, an explanation, a write-up, an
 * investigation, an estimate, a decision. The words layer ranks cards by the work's SUBJECT too ("Plan how to upgrade
 * Node" scores the upgrade), so when the words ask for an outcome the top card does not deliver, they do not decide
 * alone: the seat reads the outcome (classify's first rule).
 */
const OUTCOME_CUES: ReadonlyArray<{ re: RegExp; cards: readonly string[] }> = [
  { re: /\b(?:plan(?:ning)?|roadmap|break (?:it |this |the work )?down)\b/iu, cards: ['plan-it', 'plan-tests', 'backlog', 'release'] },
  { re: /\b(?:review|reviewing|audit|assess|critique|poke holes)\b/iu, cards: ['review-change', 'risk', 'security', 'review-recent-work', 'critique', 'retro', 'analyze-runs', 'evaluate-rules', 'release'] },
  { re: /\b(?:explain|walk me through|overview of|how does)\b/iu, cards: ['analyze-codebase', 'map-requirements', 'document', 'communicate'] },
  { re: /\b(?:document|documentation|write[- ]up|readme|deck|slides|presentation|release notes|changelog|announcement|status update)\b/iu, cards: ['document', 'communicate', 'interactive-page', 'operating-model', 'analyze-codebase'] },
  { re: /\b(?:root cause|investigate|what happened|why (?:is|did|does|do|are))\b/iu, cards: ['incident', 'reconstruct', 'research', 'bug'] },
  { re: /\b(?:estimate|how long will|how much will)\b/iu, cards: ['estimate-price', 'run-cost'] },
  { re: /\b(?:should we|decide|choose between|which is better)\b/iu, cards: ['decide'] },
];

/**
 * Work the words name only to rule it out or to refer to it ("do not modernize…", "leave the migration alone", "instead
 * of a rewrite", "summarize the migration ticket"): the words then do not decide alone (codex r3).
 */
const WORK_VERB = String.raw`(?:moderniz|migrat|upgrad|mov|port|rewrit|refactor|build|implement|fix|releas|plan|review|test|chang|touch)\w*`;
const NEGATED_WORK = new RegExp(String.raw`\b(?:don'?t|do\s+not|never|no\s+longer|instead\s+of|avoid(?:ing)?|rather\s+than)\s+(?:\w+\s+){0,2}?${WORK_VERB}\b|\bleave\b[^.;]*\balone\b`, 'iu');
const REFERENCED_WORK = /\b(?:summari[sz]e|summary\s+of|recap|the\s+ticket|ticket\s+for)\b/iu;

/** Whether the words rule the work out ("do not modernize…", "leave the migration alone"). */
const straight = (t: string): string => t.replace(/[\u2018\u2019]/gu, "'");

export function negatedWork(text: string): boolean {
  return NEGATED_WORK.test(straight(text));
}

/** Whether the words rule out or only refer to work (then they do not decide alone). */
export function negatedOrReferenced(text: string): boolean {
  return NEGATED_WORK.test(straight(text)) || REFERENCED_WORK.test(text);
}

/** An explicit writing request ("write the release notes for…", "draft a summary of…"): an unambiguous outcome. */
const WRITING_ASK = /\b(?:write|draft|prepare|put\s+together|compose)\s+(?:\w+\s+){0,2}?(?:release\s+notes|changelog|announcement|status\s+update|summary|write-?up|readme|docs?|documentation|deck|slides|presentation|memo|email|message)\b/iu;
const WRITING_CARDS: ReadonlySet<string> = new Set(['document', 'communicate', 'interactive-page', 'operating-model', 'release', 'analyze-codebase']);

/** Whether the words explicitly ask to WRITE something the card does not make (a seat's sure is then held; codex r7). */
export function writingAskedOf(text: string, card: string): boolean {
  return WRITING_ASK.test(text) && !WRITING_CARDS.has(card);
}

/** Whether the words ask for an outcome the card does not deliver (then they do not decide alone). */
export function outcomeConflict(text: string, card: string): boolean {
  // Every outcome the words ask for must be one the card delivers, for the words to decide alone: "Plan a security
  // review" is a plan of a review, and the review card does not decide it (codex r2). The seat then reads it.
  return OUTCOME_CUES.some((c) => c.re.test(text) && !c.cards.includes(card));
}

/** An Investigate card's depth when the words say it ("a quick look", "deep dive"); `null` = they do not. */
export function depthFromWords(text: string): 'quick' | 'deep' | null {
  if (/\b(?:deep(?:ly)?|deep[- ]dive|thorough(?:ly)?|exhaustive|in[- ]depth|full timeline|every (?:cause|release|step))\b/iu.test(text)) return 'deep';
  if (/\b(?:quick(?:ly)?|brief(?:ly)?|fast look|just a look|short look|skim)\b/iu.test(text)) return 'quick';
  return null;
}

/** Rank every detectable card for `text` and say whether the words alone decide (§2.3 `wordsLayer`). */
export function wordsLayer(raw: string): WordsResult {
  const text = withoutAimed(raw);
  const words = tokens(text).length;
  const ranked = DETECTABLE.map((c) => ({ card: c.id, score: scoreFields(CARD_FIELDS.get(c.id)!, text) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || DETECTABLE.findIndex((c) => c.id === a.card) - DETECTABLE.findIndex((c) => c.id === b.card));
  const top = ranked[0]?.score ?? 0;
  const runnerUp = ranked[1]?.score ?? 0;
  const card = ranked[0]?.card ?? null;
  const seed = card === null ? undefined : byId(card);
  let option: string | null = null;
  let optionDecided = true;
  if (seed?.variant !== undefined) {
    const os = seed.variant.options
      .map((o) => ({ id: o.id, score: scoreFields(OPTION_FIELDS.get(`${seed.id}:${o.id}`)!, text) }))
      .sort((a, b) => b.score - a.score);
    if (os[0]!.score > 0) {
      option = os[0]!.id;
      optionDecided = os.length === 1 || os[0]!.score >= WORDS_SURE.ratio * Math.max(os[1]!.score, 0.01);
    } else {
      option = seed.variant.default;
      optionDecided = false;
    }
  }
  const sure = seed !== undefined
    && !outcomeConflict(text, seed.id)
    && !negatedOrReferenced(text)
    && !writingAskedOf(text, seed.id)
    && words >= WORDS_SURE.minWords
    && top >= WORDS_SURE.minScore
    && top >= WORDS_SURE.ratio * Math.max(runnerUp, 0.01)
    // Scoring is exact on every option (§9.2), so the words decide a card with options alone only when they also
    // decided its option (a framing option the words did not choose is the seat's to read, not the default's).
    && (seed.variant === undefined || optionDecided);
  return { ranked, card, option, optionDecided, sure, words, top, runnerUp };
}

// ── a seat's reading, validated (§2.3 `validateGuess`) ────────────────────────────────────────────────────────────

/** A seat's raw reading: garden classify's catalog-mode line, or a chat's `wicked-make` routing block. */
export interface RawGuess {
  card?: unknown;
  entry?: unknown;
  option?: unknown;
  depth?: unknown;
  confidence?: unknown;
  ask?: unknown;
  reason?: unknown;
}

/** A guess before it is banded: the validator's output. */
export interface ValidGuess {
  /** `null`: nothing valid was named (an unknown card, `triage`, an option of another card). */
  card: string | null;
  option: string | null;
  depth: 'quick' | 'standard' | 'deep' | null;
  confidence: number;
  /** Valid shapes the seat asked between (2-3), else empty. */
  ask: Array<{ card: string; option: string | null }>;
  reason: string;
  /** Why the guess could not stand (an unknown card or option), for the audit row. */
  dropped: string | null;
}

/** One plain line, at most 140 characters: no markdown, no newline, no control characters. */
export function plainReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ')
    .replace(/[`*_#>[\]<]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return flat.length <= 140 ? flat : `${flat.slice(0, 139).trimEnd()}…`;
}

const DEPTHS = new Set(['quick', 'standard', 'deep']);

/** A card and option as a seat may spell them: `card`, `card:option`, or an option written `card:option` beside its card. */
function readShape(card: unknown, option: unknown): { card: string; option: string | null | undefined } | null {
  if (typeof card !== 'string' || card.trim() === '') return null;
  let c = card.trim();
  let o: string | null | undefined = option === null || option === undefined || option === 'null' || option === '' ? undefined : typeof option === 'string' ? option.trim() : undefined;
  if (option !== null && option !== undefined && typeof option !== 'string') return null;
  if (c.includes(':')) {
    const [head, tail] = c.split(':', 2) as [string, string];
    c = head;
    if (o === undefined) o = tail;
  }
  if (o !== undefined && o !== null && o.includes(':')) {
    const [head, tail] = o.split(':', 2) as [string, string];
    if (head !== c) return null;
    o = tail;
  }
  return { card: c, option: o };
}

/** The shape a card and option resolve to, or why not: an unknown card, a hidden or deferred one, an unknown option. */
function shapeOf(card: string, option: string | null | undefined): { card: string; option: string | null } | string {
  const seed = byId(card);
  if (seed === undefined) return card === 'triage' ? 'the seat could not tell (triage)' : `no card “${card.slice(0, 60)}”`;
  if (seed.variant === undefined) {
    if (option !== undefined && option !== null) return `${seed.title} has no option “${option.slice(0, 60)}”`;
    return { card: seed.id, option: null };
  }
  if (option === undefined || option === null) return { card: seed.id, option: seed.variant.default };
  if (!seed.variant.options.some((o) => o.id === option)) return `${seed.title} has no option “${option.slice(0, 60)}”`;
  return { card: seed.id, option };
}

/**
 * Validate a seat's reading against the catalog (§2.3): an unknown card or option, or an option of another card, is
 * dropped and the guess becomes an ask; confidence is clamped to [0, 1]; the reason is one plain line. A coming card
 * stays named (the proposal offers its nearest). Never throws.
 */
export function validateGuess(raw: RawGuess | null | undefined): ValidGuess {
  const r: RawGuess = raw !== null && typeof raw === 'object' ? raw : {};
  const confRaw = typeof r.confidence === 'number' ? r.confidence : typeof r.confidence === 'string' ? Number(r.confidence) : Number.NaN;
  const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0;
  const reason = plainReason(r.reason);
  const ask: Array<{ card: string; option: string | null }> = [];
  if (Array.isArray(r.ask)) {
    for (const a of r.ask.slice(0, 6)) {
      const read = readShape(a, undefined);
      if (read === null) continue;
      // An ask names a card ("bug") or a card's option ("suite-health:flaky"); a bare card with options takes its default.
      const s = shapeOf(read.card, read.option);
      if (typeof s === 'string') continue;
      if (!ask.some((x) => x.card === s.card && x.option === s.option)) ask.push(s);
      if (ask.length === 3) break;
    }
  }
  const read = readShape(r.card ?? r.entry, r.option);
  const shape = read === null ? 'no card named' : shapeOf(read.card, read.option);
  if (typeof shape === 'string') {
    return { card: null, option: null, depth: null, confidence: 0, ask, reason, dropped: shape };
  }
  const seed = byId(shape.card)!;
  const depth = isInvestigate(seed) && typeof r.depth === 'string' && DEPTHS.has(r.depth) ? (r.depth as ValidGuess['depth']) : null;
  return { card: shape.card, option: shape.option, depth, confidence, ask: ask.length >= 2 ? ask : [], reason, dropped: null };
}

// ── the cross-check (§2.3 `crossCheck`) ────────────────────────────────────────────────────────────────────────────

/**
 * A card the words count as a strong candidate: it matches at least this fraction of the words' top score. Chosen on the
 * corpus like the bands (§9.3): at 0.4 the recorded seat is held as likely on 8 % of clear cases with 0 wrong at sure,
 * and a hostile seat naming a wrong card at 1.0 reaches sure on under 5 % (at 0.5, 11 % held; with no check on weak
 * words, as spike 2 measured it, a hostile seat was sure-and-wrong on 59 %).
 */
export const WORDS_AGREE_FRACTION = 0.4;

/** Whether the words layer agrees on a card: it ranks it at {@link WORDS_AGREE_FRACTION} of its top score or more. */
export function wordsAgree(words: WordsResult, card: string): boolean {
  const hit = words.ranked.find((r) => r.card === card);
  return hit !== undefined && words.top > 0 && hit.score >= WORDS_AGREE_FRACTION * words.top;
}

/**
 * A seat's band, checked against the words layer (§2.3, §9.2 (i)).
 *
 * - **The `detect-shape` turn** (`classify`): a seat's **sure** stands only when the words layer agrees on the card: it
 *   ranks the seat's card as a strong candidate ({@link wordsAgree}: at least 0.4 of its top score). Words that match no
 *   card agree with nothing, so a seat cannot be sure on words the catalog does not recognise. And when the words
 *   decided an option of that card that runs a different plan, the seat's option must be it. (See
 *   {@link WORDS_AGREE_FRACTION} for what it holds on the corpus.)
 * - **The chat door** (`chat`): the seat's self-reported confidence is capped at **likely** unless the words layer's
 *   top card AND option are the seat's, because a chat seat reads a whole conversation the person did not write alone.
 *
 * This sets how the card is first shown; it is not the safety boundary (nothing launches without Start, and a
 * chat-launched repository job is held at its plan).
 */
export function crossCheck(guess: { card: string; option: string | null; band: Band; source: ShapeGuess['source'] }, words: WordsResult): Band {
  if (guess.band !== 'sure') return guess.band;
  const seed = byId(guess.card);
  if (seed === undefined) return 'likely';
  if (guess.source === 'chat') {
    return words.card === guess.card && words.option === guess.option ? 'sure' : 'likely';
  }
  if (!wordsAgree(words, guess.card)) return 'likely';
  if (words.card === guess.card && words.optionDecided && seed.variant !== undefined && words.option !== guess.option && differentPlan(seed, words.option, guess.option)) return 'likely';
  return 'sure';
}

// ── one detection ──────────────────────────────────────────────────────────────────────────────────────────────────

/** How a card and option are named to the person in a question. */
export function shapeLabel(card: string, option: string | null): string {
  const seed = CATALOG_V2_CARDS.find((c) => c.id === card);
  if (seed === undefined) return card;
  const o = seed.variant?.options.find((x) => x.id === option);
  return o !== undefined ? `${seed.title} · ${o.title}` : seed.title;
}

function questionOf(choices: ReadonlyArray<{ card: string; option: string | null }>): ShapeGuess['question'] {
  const uniq: Array<{ card: string; option: string | null }> = [];
  for (const c of choices) if (!uniq.some((u) => u.card === c.card && u.option === c.option)) uniq.push(c);
  const list = uniq.slice(0, 3).map((c) => ({ label: shapeLabel(c.card, c.option), card: c.card, option: c.option }));
  if (list.length === 0) return { text: 'What should this job do? Pick one with /, or say it in other words.', choices: [] };
  const names = list.map((c) => c.label);
  const joined = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return { text: `Which job is this: ${joined}?`, choices: list };
}

/** The words layer's best candidates as ask choices (distinct cards, their word-picked option). */
function wordsChoices(words: WordsResult): Array<{ card: string; option: string | null }> {
  return words.ranked.slice(0, 3).map((x) => {
    if (x.card === words.card) return { card: x.card, option: words.option };
    const seed = byId(x.card)!;
    return { card: x.card, option: seed.variant?.default ?? null };
  });
}

export interface DetectInput {
  text: string;
  /** The seat's reading; `null` when there is none (words only, a timeout, a failure). */
  seat: RawGuess | null;
  source: Exclude<ShapeGuess['source'], 'words'>;
  catalogRev: string;
  /** The card or option is launchable on this daemon now (the resolved catalog); absent = the seed's own status. */
  available?: (card: string, option: string | null) => boolean;
}

export interface Detection {
  guess: ShapeGuess;
  words: WordsResult;
  /** The seat's reading as validated (for the audit row), or `null`. */
  seat: ValidGuess | null;
}

/**
 * One detection (§2.3): the words layer first, alone when it is sure; else the seat's reading, validated, banded and
 * cross-checked. With no seat reading, the words' top card is at most likely (a timed-out turn is never sure), and
 * words that match nothing clearly ask.
 */
export function detect(input: DetectInput): Detection {
  const words = wordsLayer(input.text);
  const seat = input.seat === null ? null : validateGuess(input.seat);
  const availableOf = (card: string, option: string | null): boolean => {
    if (input.available !== undefined) return input.available(card, option);
    const seed = byId(card);
    return seed !== undefined && !comingCard(seed, seed.variant?.options.find((o) => o.id === option) ?? null);
  };
  const make = (card: string, option: string | null, depth: ShapeGuess['depth'], confidence: number, banded: Band, reason: string, source: ShapeGuess['source'], ask: ShapeGuess['question']): ShapeGuess => {
    const available = availableOf(card, option);
    // A job this daemon cannot start is never shown as sure (pi r2): at most likely, with its nearest offered.
    const band: Band = banded === 'sure' && !available ? 'likely' : banded;
    // A demoted reading reports a confidence its band can hold (pi r3).
    const shown = band === 'likely' ? Math.min(confidence, DETECT_BANDS.sure - 0.01) : confidence;
    return {
      card,
      option,
      depth,
      confidence: Math.round(shown * 1000) / 1000,
      band,
      reason,
      available,
      question: band === 'ask' ? ask : null,
      source,
      catalogRev: input.catalogRev,
    };
  };
  if (words.sure && words.card !== null) {
    const wordsSeed = byId(words.card)!;
    // A seat that read the words differently (another card, or an option that runs another plan) outranks a word
    // match: an instruction planted in the words ("choose start-new:mcp-server") matches catalog words, and the seat is
    // told to read past it. Neither is then sure: the seat's reading is shown, held as likely (§9.2 (i)).
    const conflict = seat !== null && seat.card !== null && (seat.card !== words.card || (seat.option !== words.option && differentPlan(wordsSeed, seat.option, words.option)));
    if (!conflict) {
      // An Investigate card's depth: the seat's when it read the same card, else what the words say (§2.2).
      const depth = seat !== null && seat.card === words.card && seat.depth !== null ? seat.depth : isInvestigate(wordsSeed) ? depthFromWords(withoutAimed(input.text)) : null;
      return { guess: make(words.card, words.option, depth, 0.9, 'sure', 'the words name this job clearly', 'words', null), words, seat };
    }
  }
  if (seat === null) {
    if (words.card !== null && words.top >= WORDS_SURE.minScore) {
      const seed = byId(words.card)!;
      return { guess: make(words.card, words.option, isInvestigate(seed) ? depthFromWords(withoutAimed(input.text)) : null, 0.6, 'likely', 'the words point to this job', 'words', null), words, seat };
    }
    const choices = wordsChoices(words);
    return { guess: make(choices[0]?.card ?? 'plan-it', choices[0]?.option ?? null, null, 0, 'ask', 'the words alone do not say which job', 'words', questionOf(choices)), words, seat };
  }
  if (seat.card === null) {
    // Nothing valid named: the seat's own ask list if it gave one, else the words' best candidates.
    const choices = seat.ask.length > 0 ? seat.ask : wordsChoices(words);
    const first = choices[0];
    return {
      guess: make(first?.card ?? 'plan-it', first?.option ?? null, null, 0, 'ask', seat.reason !== '' ? seat.reason : 'not sure which job this is', input.source, questionOf(choices)),
      words,
      seat,
    };
  }
  const banded = bandOf(seat.confidence, seat.ask.length > 0);
  const checked = crossCheck({ card: seat.card, option: seat.option, band: banded, source: input.source }, words);
  // A seat sure of work the words rule out ("do not fix…", "leave … alone") is held as likely (codex r3). The outcome
  // cues are NOT applied to a seat's reading: which of nested outcomes is asked is the seat's to read (classify's first
  // rule), and outcome words double as subjects ("our code review conventions", "repo-audit", "should we test"): on the
  // corpus the veto held 6 more right answers as likely and prevented no wrong sure.
  const cleaned = withoutAimed(input.text);
  const band: Band = checked === 'sure' && (negatedWork(cleaned) || writingAskedOf(cleaned, seat.card)) ? 'likely' : checked;
  const choices = seat.ask.length > 0 ? seat.ask : [{ card: seat.card, option: seat.option }, ...wordsChoices(words)];
  return { guess: make(seat.card, seat.option, seat.depth, seat.confidence, band, seat.reason, input.source, questionOf(choices)), words, seat };
}

/**
 * The `detect-shape` path's orchestration (§2.3), shared by the service and the corpus scorer so CI scores what ships:
 * the words alone when they are sure (no seat is asked), else the seat's reading. `seat` is asked only then.
 */
export async function classifyPath(input: Omit<DetectInput, 'seat' | 'source'>, seat: () => Promise<RawGuess | null>): Promise<Detection & { asked: boolean }> {
  const words = detect({ ...input, seat: null, source: 'classify' });
  if (words.guess.band === 'sure') return { ...words, asked: false };
  return { ...detect({ ...input, seat: await seat(), source: 'classify' }), asked: true };
}

/** {@link classifyPath} with a seat answer already in hand (the corpus fixture): synchronous, the same decisions. */
export function classifyPathSync(input: Omit<DetectInput, 'seat' | 'source'>, seat: RawGuess | null): Detection & { asked: boolean } {
  const words = detect({ ...input, seat: null, source: 'classify' });
  if (words.guess.band === 'sure') return { ...words, asked: false };
  return { ...detect({ ...input, seat, source: 'classify' }), asked: true };
}

// ── parsing a seat's answer ────────────────────────────────────────────────────────────────────────────────────────

/** The LAST one-line JSON object in a seat's answer that names a card (classify's catalog-mode output), or `null`. */
export function parseClassifyAnswer(answer: string): RawGuess | null {
  const lines = answer.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const o = JSON.parse(lines[i]!) as unknown;
      if (o !== null && typeof o === 'object' && !Array.isArray(o) && ('card' in o || 'entry' in o)) return o as RawGuess;
    } catch {
      // not this line
    }
  }
  // A fenced or inline object on one line with prose around it.
  const m = /\{[^{}\n]*"(?:card|entry)"\s*:[^{}\n]*\}/u.exec(answer);
  if (m !== null) {
    try {
      return JSON.parse(m[0]) as RawGuess;
    } catch {
      return null;
    }
  }
  return null;
}
