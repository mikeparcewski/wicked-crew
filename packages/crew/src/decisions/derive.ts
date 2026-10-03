/**
 * Deterministic derivation (DES-decision-capture §4.4) — PURE: no I/O, no model, golden-tested.
 *
 * Words → exclusions → template → D·G·C·R → key → route. Auto is decided here and ONLY here, from
 * facts the model cannot set: a human actor, `auth=required`, typed words, a T1/T2 template that
 * passes D and G, a known project, no redaction, not an approval of a proposal, not a restatement
 * or a conflict. Model labels can add an offer, or turn an auto into a question (`same_as` →
 * `maybe-restated`); they can never promote and never swallow a rule silently (review N6).
 *
 * The rev-1 template table is not carried in the rev-2 spec text; the six templates below are its
 * reconstruction from §3/§4.4/§8 (T1 always and T2 never auto-eligible; T3 "X before Y" is the
 * spec's own offer example), recorded in the PR as an assumption.
 */

import type { DecisionModelLabels, DecisionRoute, DecisionTemplateId } from './types.js';
import type { SteeringType } from 'wicked-crew-api-types';

/** One in-force rule the derivation compares against (from `considerRules`). */
export interface InForceRule {
  id: string;
  statement: string;
  project?: string;
}

export interface DeriveInput {
  words: string;
  actorKind: 'human' | 'agent' | 'system';
  authMode: 'off' | 'required';
  wordsSource: 'typed' | 'operator-files' | 'cli-transcript';
  projectId: string | null;
  inForce: ReadonlyArray<InForceRule>;
  /** Prior records with the same key (the ledger index); absent = none. */
  recurrence?: (key: string) => { count: number; first_at: number; projects: string[] } | null;
  labels?: DecisionModelLabels;
  now?: number;
}

export interface Derivation {
  words: string;
  redacted: boolean;
  template: DecisionTemplateId | null;
  exclusions: string[];
  dgc: { durable: boolean; general: boolean; checkable: boolean };
  recurrence: { count: number; first_at: number; projects: string[] };
  statement: string | null;
  polarity: 'do' | 'dont' | null;
  key: string | null;
  scope: 'project' | 'everywhere';
  steering_type: SteeringType;
  route: DecisionRoute;
  /** The in-force rule a restated / maybe-restated decision names, or a conflict contradicts. */
  rule_ref?: string;
}

// ── Privacy (§4.9): a hit masks the stored copy, sets `redacted`, and blocks auto ──────────────────

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
];

/** Mask secrets and email addresses. Returns the stored copy and whether anything was masked. */
export function scrubWords(words: string): { words: string; redacted: boolean } {
  let out = words;
  let redacted = false;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redacted = true;
      return '[redacted]';
    });
  }
  return { words: out, redacted };
}

// ── Normalisation and content words ─────────────────────────────────────────────────────────────

const STANDING_OPENER =
  /^(?:from now on|going forward|from here on(?: out)?|in (?:the )?future|as a rule|by default|in general|moving forward)\b[,:;]?\s*/i;
const POLITE_LEAD = /^(?:please|ok(?:ay)?|so|and|also|but|hey)\b[,:;]?\s*/i;

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'with', 'at', 'by', 'from', 'into', 'onto',
  'it', 'its', "it's", 'this', 'that', 'these', 'those', 'is', 'are', 'be', 'been', 'being', 'was', 'were', 'am',
  'we', 'you', 'i', 'our', 'your', 'my', 'me', 'us', 'they', 'them', 'their', 'he', 'she', 'his', 'her',
  'please', 'always', 'never', 'now', 'going', 'forward', 'future', 'every', 'time', 'any', 'all', 'each',
  'do', 'does', 'did', "don't", 'dont', 'not', 'no', 'should', 'must', 'has', 'have', 'had', 'need', 'needs',
  'before', 'after', 'only', 'prefer', 'instead', 'rather', 'than', 'over', 'just', 'also', 'then', 'so', 'as',
  'if', 'when', 'whenever', 'unless', 'ever', 'again', 'here', 'there', 'out', 'up', 'can', 'could', 'would',
  'will', "let's", 'lets', 'let', 'ok', 'okay', 'yes', 'yeah', 'stop', 'make', 'sure', 'one', 'thing', 'things',
  'via', 'per', 'own', 'more', 'less', 'very', 'really', 'still', 'some', 'what', 'which', 'who', 'how',
]);

/** Strip ids, URLs, SHAs, paths and versions before counting content words (G). */
function stripTokens(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/gi, ' ')
    .replace(/\bv?\d+(?:\.\d+){1,3}\b/g, ' ')
    .replace(/(?:^|\s)(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+/g, ' ')
    .replace(/\b[\w-]*\d[\w-]*\b/g, ' ')
    .replace(/#\d+/g, ' ');
}

/** The content words of a text: lowercase tokens that are not stopwords, ids, paths or versions. */
export function contentWords(text: string): string[] {
  const tokens = stripTokens(text.toLowerCase()).match(/[a-z][a-z'-]*/g) ?? [];
  const out: string[] = [];
  for (const raw of tokens) {
    const t = raw.replace(/^'+|'+$/g, '').replace(/'s$/, '');
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function sentence(text: string): string {
  const t = text.trim().replace(/[\s.!;,]+$/u, '');
  if (t === '') return t;
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}

// ── Exclusions (§4.4 step 1) ────────────────────────────────────────────────────────────────────

const QUESTION_LEAD =
  /^(?:(?:does|do|did|don't|doesn't|didn't|is|are|was|were|isn't|aren't|can|could|should|would|will|shouldn't|have|has)\s+(?:we|you|i|they|it|this|that|these|those|the|there|he|she|anyone|someone)\b|(?:why|what|how|when|where|who|which)\b)/i;
const ONE_OFF =
  /\b(?:never ?mind|skip (?:that|this|it)|for now|this time|this once|just once|today|tonight|in this (?:session|chat|run)|for this one|for this (?:run|pr|change|task)|right now)\b/i;

export function exclusionsOf(words: string, hasOpener: boolean, contentCount: number): string[] {
  const out: string[] = [];
  const trimmed = words.trim();
  if (trimmed.endsWith('?') || QUESTION_LEAD.test(trimmed)) out.push('question');
  if (ONE_OFF.test(trimmed)) out.push('one-off');
  if (hasOpener && contentCount < 3) out.push('short-opener');
  return out;
}

// ── Templates (§4.4 step 2) ─────────────────────────────────────────────────────────────────────

interface TemplateHit {
  template: DecisionTemplateId;
  polarity: 'do' | 'dont';
  statement: string;
  /** The text the key's content words come from (the rule body, without the template words). */
  body: string;
}

const SUBJECT = /^(?:we|you|i|they|the team|everyone|agents?|seats?|workers?)\s+/i;

function matchTemplate(body: string, hasOpener: boolean): TemplateHit | null {
  const b = body.replace(SUBJECT, '');
  let m: RegExpExecArray | null;
  // T1 — always X / X every time.
  if ((m = /^(?:should\s+|must\s+)?(?:always|every\s+time,?)\s+(.+)$/i.exec(b)) !== null) {
    const rest = (m[1] ?? '').trim();
    return { template: 'T1-always', polarity: 'do', statement: sentence(`Always ${rest}`), body: rest };
  }
  if ((m = /^(.+?),?\s+(?:always|every\s+(?:single\s+)?time)$/i.exec(b.replace(/[.!]+$/, ''))) !== null) {
    const rest = (m[1] ?? '').trim();
    return { template: 'T1-always', polarity: 'do', statement: sentence(`Always ${rest}`), body: rest };
  }
  // T2 — never X / don't ever X / (with a standing opener) don't X.
  if ((m = /^(?:should\s+|must\s+)?(?:never|do\s+not\s+ever|don'?t\s+ever)\s+(.+)$/i.exec(b)) !== null) {
    const rest = (m[1] ?? '').trim();
    return { template: 'T2-never', polarity: 'dont', statement: sentence(`Never ${rest}`), body: rest };
  }
  if (hasOpener && (m = /^(?:do\s+not|don'?t)\s+(.+)$/i.exec(b)) !== null) {
    const rest = (m[1] ?? '').trim();
    return { template: 'T2-never', polarity: 'dont', statement: sentence(`Never ${rest}`), body: rest };
  }
  if (hasOpener && (m = /^stop\s+(.+)$/i.exec(b)) !== null) {
    const rest = (m[1] ?? '').trim();
    return { template: 'T2-never', polarity: 'dont', statement: sentence(`Stop ${rest}`), body: rest };
  }
  // T6 — only X.
  if ((m = /^only\s+(.+)$/i.exec(b)) !== null) {
    const rest = (m[1] ?? '').trim();
    return { template: 'T6-only', polarity: 'do', statement: sentence(`Only ${rest}`), body: rest };
  }
  // T4 — prefer X (over Y) / use X instead of Y.
  if ((m = /^(?:prefer|favou?r)\s+(.+)$/i.exec(b)) !== null) {
    const rest = (m[1] ?? '').trim();
    return { template: 'T4-prefer', polarity: 'do', statement: sentence(`Prefer ${rest}`), body: rest };
  }
  if ((m = /^(?:use|pick|choose)\s+(.+?)\s+(?:instead of|rather than|over)\s+(.+)$/i.exec(b)) !== null) {
    const rest = `${(m[1] ?? '').trim()} over ${(m[2] ?? '').trim()}`;
    return { template: 'T4-prefer', polarity: 'do', statement: sentence(`Prefer ${rest}`), body: rest };
  }
  // T3 — X before Y (an order).
  if ((m = /^(.+?)\s+before\s+(.+)$/i.exec(b)) !== null && contentWords(m[1] ?? '').length > 0) {
    return { template: 'T3-before', polarity: 'do', statement: sentence(b), body: b };
  }
  // T5 — X must / should / has to Y; do not X (no opener).
  if ((m = /^(?:do\s+not|don'?t)\s+(.+)$/i.exec(b)) !== null) {
    const rest = (m[1] ?? '').trim();
    return { template: 'T5-must', polarity: 'dont', statement: sentence(`Do not ${rest}`), body: rest };
  }
  if (/\b(?:must|should|has to|have to|needs to|need to|ought to|mustn't|shouldn't)\b/i.test(b) && !/\b(?:must|should)\s+(?:we|i|you)\b/i.test(b)) {
    const dont = /\b(?:must not|mustn't|should not|shouldn't)\b/i.test(b);
    return { template: 'T5-must', polarity: dont ? 'dont' : 'do', statement: sentence(b), body: b };
  }
  return null;
}

const CHECKABLE_VERB =
  /\b(?:run|check|test|use|add|write|fix|review|ask|merge|push|deploy|keep|put|show|avoid|include|wait|open|close|delete|remove|call|read|record|verify|build|ship|cite|name|mark|commit|rebase|document|lint|format|log|skip|pin|label|tag|link|attach|scan|grep|reply|answer|confirm|block|require|land|release|publish|record|start|finish|stop)\b/i;

// ── Steering type (deterministic; the operator can edit it at Remember) ─────────────────────────

const STEERING_KEYWORDS: ReadonlyArray<[SteeringType, RegExp]> = [
  ['security', /\b(?:secur\w*|secrets?|tokens?|credentials?|passwords?|auth\w*|permissions?|leak\w*|vulnerab\w*|encrypt\w*)\b/i],
  ['compliance', /\b(?:complian\w*|gdpr|pci|hipaa|soc ?2|audit\w*|licen[cs]\w*|legal|regulat\w*|privacy|pii)\b/i],
  ['testing', /\b(?:tests?|testing|tested|checks?|walkthroughs?|e2e|qa|coverage|assert\w*|verif\w*|lint\w*|ci)\b/i],
  ['operations', /\b(?:deploy\w*|releases?|release|publish\w*|rollback|incidents?|monitor\w*|disk|daemons?|ops|merge|merging|tags?|tagging|on-?call)\b/i],
  ['design-ux', /\b(?:design|ux|ui|copy|wording|layout|colou?rs?|fonts?|accessib\w*|a11y|screens?|pages?|buttons?|calm\w*)\b/i],
  ['architecture', /\b(?:architect\w*|modules?|services?|schemas?|apis?|interfaces?|layers?|dependenc\w*|database|seams?)\b/i],
];

export function steeringTypeOf(text: string): SteeringType {
  for (const [type, re] of STEERING_KEYWORDS) if (re.test(text)) return type;
  return 'development';
}

// ── The key (§4.4 step 5) and the in-force comparison ───────────────────────────────────────────

export function keyOf(template: DecisionTemplateId, polarity: 'do' | 'dont', body: string): string {
  const words = [...new Set(contentWords(body))].sort();
  return `${template}|${polarity}|${words.join(' ')}`;
}

/** The key a stored rule's statement derives to, so a restatement is an exact key match. */
export function ruleKey(statement: string): { key: string; polarity: 'do' | 'dont'; subject: string } | null {
  const body = statement.trim().replace(/[.!]+$/, '');
  const hit = matchTemplate(body, false);
  if (hit === null) return null;
  const subject = [...new Set(contentWords(hit.body))].sort().join(' ');
  return { key: keyOf(hit.template, hit.polarity, hit.body), polarity: hit.polarity, subject };
}

// ── The derivation ──────────────────────────────────────────────────────────────────────────────

export function deriveDecision(input: DeriveInput): Derivation {
  const scrub = scrubWords(input.words);
  const words = scrub.words.trim();
  const opener = STANDING_OPENER.exec(words.replace(POLITE_LEAD, ''));
  const hasOpener = opener !== null;
  let body = words.replace(POLITE_LEAD, '');
  if (opener !== null) body = body.slice(opener[0].length);
  body = body.replace(POLITE_LEAD, '').trim().replace(/[.!]+$/, '');

  const content = contentWords(body);
  const exclusions = exclusionsOf(words, hasOpener, content.length);
  // An excluded utterance is never shaped into a rule (a question, a one-off, a bare opener).
  const hit = exclusions.length > 0 ? null : matchTemplate(body, hasOpener);

  let template: DecisionTemplateId | null = hit?.template ?? null;
  let polarity: 'do' | 'dont' | null = hit?.polarity ?? null;
  let statement: string | null = hit?.statement ?? null;
  let keyBody = hit?.body ?? body;
  if (hit === null && hasOpener && exclusions.length === 0 && content.length >= 3) {
    // The "in your words" row: a standing opener over a body no template shapes — offered as typed.
    template = 'in-your-words';
    polarity = /^(?:do\s+not|don'?t|no)\b/i.test(body) ? 'dont' : 'do';
    statement = sentence(body);
    keyBody = body;
  }

  const ruleContent = contentWords(keyBody);
  const general = ruleContent.length >= 3;
  const durable = exclusions.length === 0 && template !== null;
  const checkable =
    template !== null && (template !== 'in-your-words' || CHECKABLE_VERB.test(keyBody));
  const key = template !== null && polarity !== null ? keyOf(template, polarity, keyBody) : null;
  const recurrenceHit = key !== null ? input.recurrence?.(key) ?? null : null;
  const recurrence = recurrenceHit ?? { count: 0, first_at: input.now ?? Date.now(), projects: [] };
  const scope: 'project' | 'everywhere' = input.projectId !== null ? 'project' : 'everywhere';
  const steering_type = input.labels?.steering_type ?? steeringTypeOf(statement ?? body);

  const base: Omit<Derivation, 'route'> = {
    words,
    redacted: scrub.redacted,
    template,
    exclusions,
    dgc: { durable, general, checkable },
    recurrence,
    statement,
    polarity,
    key,
    scope,
    steering_type,
  };

  if (exclusions.length > 0 || key === null || polarity === null) {
    return { ...base, route: modelOffers(input.labels, durable, general, checkable, recurrence.count) ? 'offer' : 'ledger' };
  }

  // Compare with the in-force rules that apply here (this project's, or global).
  const subject = [...new Set(ruleContent)].sort().join(' ');
  for (const rule of input.inForce) {
    if (rule.project !== undefined && rule.project !== input.projectId) continue;
    const rk = ruleKey(rule.statement);
    if (rk === null) continue;
    if (rk.key === key) return { ...base, route: 'restated', rule_ref: rule.id };
  }
  for (const rule of input.inForce) {
    if (rule.project !== undefined && rule.project !== input.projectId) continue;
    const rk = ruleKey(rule.statement);
    if (rk === null) continue;
    if (rk.subject === subject && subject !== '' && rk.polarity !== polarity) {
      return { ...base, route: 'conflict', rule_ref: rule.id };
    }
  }
  // The model may name an in-force rule this restates: a question, never a silent swallow.
  const sameAs = input.labels?.same_as;
  if (typeof sameAs === 'string' && input.inForce.some((r) => r.id === sameAs)) {
    return { ...base, route: 'maybe-restated', rule_ref: sameAs };
  }

  const autoEligible =
    input.actorKind === 'human' &&
    input.authMode === 'required' &&
    input.wordsSource === 'typed' &&
    (template === 'T1-always' || template === 'T2-never') &&
    durable &&
    general &&
    input.projectId !== null &&
    input.labels?.approves_proposal !== true &&
    !scrub.redacted;
  if (autoEligible) return { ...base, route: 'auto' };

  if (durable && general) return { ...base, route: 'offer' };
  if (modelOffers(input.labels, durable, general, checkable, recurrence.count)) return { ...base, route: 'offer' };
  return { ...base, route: 'ledger' };
}

/** The model's offer arm: type ∈ {rule, correction, scope} ∧ codify ∧ D ∧ G ∧ (C ∨ R). */
function modelOffers(
  labels: DecisionModelLabels | undefined,
  durable: boolean,
  general: boolean,
  checkable: boolean,
  recurrences: number,
): boolean {
  if (labels === undefined) return false;
  return (
    (labels.type === 'rule' || labels.type === 'correction' || labels.type === 'scope') &&
    labels.codify &&
    durable &&
    general &&
    (checkable || recurrences > 0)
  );
}
