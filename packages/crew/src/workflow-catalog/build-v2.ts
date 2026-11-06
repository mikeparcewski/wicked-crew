/**
 * `GET /workflows/catalog?v=2` (DES-CATALOG-002 §4): the v2 seeds resolved against what this engine serves and with the
 * requesting operator's runs. Pure: the route gathers the inputs, this shapes the answer, and every launcher and the
 * chat proposals resolve a card or option through {@link resolveOption} so what a card shows is what a launch checks.
 *
 * - **What a card shows is derived.** Each option's gate list comes from the plan its launch composes (the steps'
 *   `rubric`, its consent gates and pins), its instruments (QE acceptance) and its launch kind (a document's draft
 *   floor, a compose's trace to requirements, a demo's walkthrough), plus the proposal-only predicate for Improve cards.
 *   The seeds only say which of the plan's always-present mechanisms the card is judged by (`evidence-floor`, `pick`,
 *   `review`): they can name one the plan carries, never add one it lacks.
 * - **A saved shadow** (a preset the operator saved under a built-in's name, project first) is what a launch runs: with
 *   at least the built-in's instruments the option resolves to it ("Your version", `source: 'saved'`, its own gates);
 *   with fewer the option is `unavailable` and the shadow is reachable from `yours` only.
 * - **Never lose a card.** An option whose preset this engine does not serve is `unavailable`, never dropped. A served
 *   non-system def no card launches, and every saved preset, joins `yours`.
 * - **Usage by recorded shape** (`run.launched.shape`); a run from before v2 counts under the card whose default option
 *   launches its workflow.
 */
import { createHash } from 'node:crypto';
import type {
  CatalogCardV2,
  CatalogEntry,
  CatalogGateId,
  CatalogInputKindV2,
  CatalogInputV2,
  CatalogOptionV2,
  CatalogResolved,
  Preset,
  PresetStep,
  WorkflowCatalogLaunch,
  WorkflowCatalogUsage,
  WorkflowCatalogV2Response,
  WorkflowDef,
} from '../core/types.js';
import { phaseOfStep } from '../core/builtin-catalog.js';
import { QE_ACCEPTANCE, QE_PRESETS } from '../core/qe-acceptance-setting.js';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import type { CatalogRun } from './build.js';
import { CATALOG_EXCLUDED, CATALOG_EXCLUDED_DEFS, CATALOG_SEEDS } from './catalog-data.js';
import { CATALOG_V2_CARDS, CATALOG_V2_CATEGORIES } from './catalog-data-v2.js';
import type { CardSeedV2, OptionSeedV2, SeatSeedV2 } from './seeds-v2.js';

/** The built-in QE instrument set (wicked-core `catalog::builtin_preset_instruments`). */
const BUILTIN_QE_INSTRUMENTS: readonly string[] = ['distinct_evaluator', 'judge', QE_ACCEPTANCE];

/** wicked-core's evidence floor pin (`builtin_floors::EVIDENCE_FLOOR_PIN`; `core/deliver.ts` keeps the same constant). */
const EVIDENCE_FLOOR_PIN = 'e2e7af1db9e48454';

/** The rubric ids core serves (`src/rubrics/*.json`): a step naming one is judged by it. */
const RUBRICS: ReadonlySet<CatalogGateId> = new Set(['parity', 'cited-findings', 'fidelity-to-source']);

/** Seeded gates that name a mechanism every plan of that kind already carries: shown only when the plan has it. */
const SEED_NAMED: ReadonlySet<CatalogGateId> = new Set(['evidence-floor', 'pick', 'review']);

/** v2 leaves these out (Q12): Apps starts them. */
const V2_EXCLUDED: ReadonlySet<string> = new Set([...Object.keys(CATALOG_EXCLUDED), ...Object.keys(CATALOG_EXCLUDED_DEFS)]);

export const TOP_MAX_V2 = 6;

/**
 * Cards whose crew-side piece is not built yet (DES-CATALOG-002 §3.2 "Truly missing"): listed, not offered, with why.
 * Review a change must never seat the authors of a run that contributed to the change; until crew excludes them, it
 * would launch below its own seat rule.
 */
const CREW_PENDING: Readonly<Record<string, string>> = {
  'review-change': 'Comes once crew excludes the authors of every run that contributed to the change from its reviewers; today, Risk analysis or Security review read a change on a seat that did not build it.',
};

/** The input kinds this daemon's launch routes take (1.1's `documents` and 1.2's `sources` are not yet). */
export const INPUT_KINDS_V2: readonly CatalogInputKindV2[] = ['text', 'repo', 'project', 'url', 'requirements', 'seats'];

export interface CatalogV2Inputs {
  /** `GET /workflows`'s served defs. */
  defs: readonly WorkflowDef[];
  /** `GET /presets` for the scope (built-in rows and the operator's saved ones). */
  presets: readonly Preset[];
  /** The engine's phase catalog (a saved preset's steps are laid over it). */
  entries: readonly CatalogEntry[];
  runs: readonly (CatalogRun & { shape?: { card: string; option: string | null } | undefined })[];
  actorId: string;
  projectId: string | null;
}

/** One option (or a variant-less card) resolved: the wire fields plus what a launch needs that the wire does not say. */
export interface ResolvedOption {
  card: CardSeedV2;
  option: OptionSeedV2 | null;
  resolved: CatalogResolved;
  /** The workflow a `run` launch names, else `null`. */
  workflow: string | null;
  /** The document style a `document` launch makes, else `null`. */
  style: 'web' | 'doc' | 'ppt' | 'brochure' | null;
  /** The effective steps (a saved shadow's, a built-in preset's, a served def's phases as steps), `[]` when none. */
  steps: readonly PresetStep[];
}

// ── inputs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const INPUT_LABELS: Readonly<Record<string, { label: string; kind: CatalogInputKindV2 }>> = {
  intent: { label: 'What should it do?', kind: 'text' },
  repo: { label: 'Repository', kind: 'repo' },
  project: { label: 'Project', kind: 'project' },
  seats: { label: 'Who works on it', kind: 'seats' },
  url: { label: 'The running app', kind: 'url' },
  audience: { label: 'Who it is for', kind: 'text' },
  show: { label: 'What to show', kind: 'text' },
  requirements: { label: 'Requirements', kind: 'requirements' },
};

/** The seeds' input ids (`repo`, `repo?`) as wire inputs; `depth` is a card field, not an input kind. */
export function inputsOf(ids: readonly string[]): CatalogInputV2[] {
  const out: CatalogInputV2[] = [];
  for (const raw of ids) {
    const optional = raw.endsWith('?');
    const id = optional ? raw.slice(0, -1) : raw;
    if (id === 'depth') continue;
    const known = INPUT_LABELS[id];
    if (known === undefined) continue;
    // Who works on it is always the roster's default when unsaid.
    out.push({ id, label: known.label, kind: known.kind, required: !optional && id !== 'seats' });
  }
  return out;
}

// ── gates ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A served def's phases as steps (a crew def, or a built-in without its preset row): enough for the gate reading. */
function stepsOfDef(def: WorkflowDef): PresetStep[] {
  return def.phases.map((p) => {
    const step: PresetStep = { catalog: String(p.kind), id: p.id };
    if (p.rubric !== undefined) step.rubric = p.rubric;
    if (p.validator_pin !== undefined && p.validator_pin !== null) step['validator_pin'] = p.validator_pin;
    if (p.gate !== undefined && p.gate !== null) step['gate'] = p.gate;
    step['role'] = p.role;
    return step;
  });
}

/** Whether a step's gate holds for a person whatever the verdict (`human_confirm.unconditional`, or `consent_before`). */
function unconditionalGate(gate: unknown): boolean {
  if (gate === 'consent_before') return true;
  if (gate === null || typeof gate !== 'object') return false;
  const hc = (gate as { human_confirm?: unknown }).human_confirm;
  return hc !== null && typeof hc === 'object' && (hc as { unconditional?: unknown }).unconditional === true;
}

/** Each step laid over its phase-catalog entry (role, pin, gate), the way crew reads a composed plan. */
interface ReadStep {
  id: string;
  catalog: string;
  role: string | null;
  pin: string | null;
  gate: unknown;
  rubric: string | null;
  writes: boolean;
}

function readSteps(steps: readonly PresetStep[], entries: readonly CatalogEntry[]): ReadStep[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  let previous: string | null = null;
  return steps.map((s) => {
    const phase = phaseOfStep(s, byId.get(s.catalog), previous);
    previous = s.id;
    const role = phase?.role ?? (typeof s['role'] === 'string' ? (s['role'] as string) : null);
    const pin = phase?.validator_pin ?? (typeof s['validator_pin'] === 'string' ? (s['validator_pin'] as string) : null);
    const gate = phase?.gate ?? s['gate'] ?? null;
    return {
      id: s.id,
      catalog: s.catalog,
      role: role ?? null,
      pin: pin ?? null,
      gate,
      rubric: typeof s.rubric === 'string' ? s.rubric : null,
      writes: role === 'creator' && s['writes_nothing'] !== true,
    };
  });
}

/**
 * The proposal-only predicate (§5.1): everything the run produces takes effect only through a person. Holds when no
 * step writes, when the run delivers a pull request (crew only opens one; nothing in crew merges), or when every
 * writing step is followed by an UNCONDITIONAL human gate (steering-author's propose). A plan that writes a store
 * directly with no such gate fails.
 */
export function proposalOnly(steps: readonly ReadStep[], delivers: CatalogResolved['delivers']): boolean {
  if (delivers === 'pr') return true;
  const lastWrite = steps.map((s) => s.writes).lastIndexOf(true);
  if (lastWrite === -1) return true;
  // A gate on the writing step itself holds before it lands (the step's output is the proposal), or one after it.
  return steps.slice(lastWrite).some((s) => unconditionalGate(s.gate));
}

/** The gates a plan carries (rubrics, consent, the walkthrough pins), its instruments and its launch kind. */
export function derivedGate(
  launch: WorkflowCatalogLaunch,
  steps: readonly ReadStep[],
  requiresQe: boolean,
  seeded: readonly CatalogGateId[],
  improve: boolean,
  delivers: CatalogResolved['delivers'],
): CatalogGateId[] {
  const out = new Set<CatalogGateId>();
  if (requiresQe) out.add('qe-acceptance');
  for (const s of steps) {
    if (s.rubric !== null && RUBRICS.has(s.rubric as CatalogGateId)) out.add(s.rubric as CatalogGateId);
    if (s.gate === 'consent_before') out.add('install-consent');
  }
  if (launch.kind === 'document') out.add('draft-floor');
  if (launch.kind === 'compose') out.add('traces-to-requirements');
  if (launch.kind === 'demo') out.add('walkthrough');
  if (improve && proposalOnly(steps, delivers)) out.add('proposal-only');
  // The mechanisms the seeds name, only where the plan has them.
  const hasEvaluator = steps.some((s) => s.role === 'evaluator');
  for (const g of seeded) {
    if (!SEED_NAMED.has(g)) continue;
    if (g === 'evidence-floor' && steps.some((s) => s.pin === EVIDENCE_FLOOR_PIN)) out.add(g);
    if ((g === 'pick' || g === 'review') && hasEvaluator) out.add(g);
  }
  // A stable order: the design's.
  const ORDER: readonly CatalogGateId[] = ['qe-acceptance', 'parity', 'cited-findings', 'fidelity-to-source', 'proposal-only', 'evidence-floor', 'install-consent', 'walkthrough', 'pick', 'draft-floor', 'traces-to-requirements', 'review'];
  return ORDER.filter((g) => out.has(g));
}

// ── one option ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the inputs resolve launches against: the engine's served state, as the launch will meet it. */
export interface ServedState {
  defs: ReadonlyMap<string, WorkflowDef>;
  builtins: ReadonlyMap<string, Preset>;
  /** The operator's saved presets by name, a project row winning over a global one (as a launch resolves them). */
  saved: ReadonlyMap<string, Preset>;
  entries: readonly CatalogEntry[];
}

export function servedState(input: Pick<CatalogV2Inputs, 'defs' | 'presets' | 'entries'>): ServedState {
  const saved = new Map<string, Preset>();
  for (const p of input.presets) {
    if (p.created_by === 'builtin' || p.system === true) continue;
    const held = saved.get(p.name);
    if (held === undefined || (held.scope === 'global' && p.scope !== 'global')) saved.set(p.name, p);
  }
  return {
    defs: new Map(input.defs.map((d) => [d.id, d])),
    builtins: new Map(input.presets.filter((p) => p.created_by === 'builtin').map((p) => [p.name, p])),
    saved,
    entries: input.entries,
  };
}

const instrumentsOf = (p: Preset): string[] =>
  Array.isArray(p['required_instruments']) ? (p['required_instruments'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];

const legacyHint = (launch: WorkflowCatalogLaunch): { typicalMinutes: [number, number] | null; cost: 'low' | 'medium' | 'high' | null } => {
  const hit = CATALOG_SEEDS.find((s) =>
    (launch.kind === 'run' && s.launch.kind === 'run' && s.launch.workflow === launch.workflow) ||
    (launch.kind === 'document' && s.launch.kind === 'document' && s.launch.style === launch.style) ||
    (launch.kind !== 'run' && launch.kind !== 'document' && s.launch.kind === launch.kind));
  return { typicalMinutes: hit?.typicalMinutes ?? null, cost: hit?.cost ?? null };
};

function seatsOf(...layers: Array<SeatSeedV2 | undefined>): CatalogResolved['seats'] {
  const pick = (k: keyof SeatSeedV2): boolean => {
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const v = layers[i]?.[k];
      if (v !== undefined) return v === true;
    }
    return false;
  };
  return {
    distinctEvaluator: pick('distinctEvaluator'),
    distinctJudge: pick('distinctJudge'),
    excludeChangeAuthors: pick('excludeChangeAuthors'),
    proposalOnly: pick('proposalOnly'),
    notRunSeat: pick('notRunSeat'),
    council: false,
  };
}

/** A short, stable fingerprint of a JSON-able value. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * One card's option (or the card itself, `option === null` for a card without variants) resolved against what this
 * engine serves. `null` when the card or option does not exist.
 */
export function resolveOption(cardId: string, optionId: string | null, served: ServedState): ResolvedOption | null {
  const card = CATALOG_V2_CARDS.find((c) => c.id === cardId);
  if (card === undefined) return null;
  const options = card.variant?.options ?? [];
  let option: OptionSeedV2 | null = null;
  if (options.length > 0) {
    const want = optionId ?? card.variant!.default;
    option = options.find((o) => o.id === want) ?? null;
    if (option === null) return null;
  } else if (optionId !== null) {
    return null;
  }
  const launch: WorkflowCatalogLaunch = option?.launch ?? card.launch ?? { kind: 'none' };
  const delivers = option?.delivers ?? card.delivers ?? 'none';
  const needs = option?.needs ?? card.needs ?? [];
  const inputs = inputsOf(option?.inputs ?? card.inputs ?? []);
  const seededGate = option?.gate ?? card.gate ?? [];
  const brief = option?.brief ?? card.brief ?? null;
  const compose = option?.compose ?? null;
  const writes = option?.writes ?? (delivers === 'pr' ? 'repo' : delivers === 'document' || delivers === 'video' ? 'documents' : delivers === 'proposals' ? 'proposals' : 'nothing');
  const coming = card.status === 'coming_soon' || option?.status === 'coming_soon' || launch.kind === 'none';
  let status: CatalogResolved['status'] = coming ? 'coming_soon' : 'available';
  let statusNote: string | null = coming ? (option?.statusNote ?? card.statusNote ?? null) : null;
  let source: CatalogResolved['source'] = launch.kind === 'none' ? 'none' : launch.kind === 'run' ? 'builtin' : 'studio';
  let steps: readonly PresetStep[] = [];
  let requiresQe = false;
  let workflow: string | null = null;
  let style: ResolvedOption['style'] = null;
  if (launch.kind === 'run') {
    workflow = launch.workflow;
    const builtin = served.builtins.get(workflow);
    const def = served.defs.get(workflow);
    const shadow = served.saved.get(workflow);
    const builtinInstruments = builtin !== undefined && QE_PRESETS.has(workflow) ? BUILTIN_QE_INSTRUMENTS : (def?.required_instruments ?? []);
    if (shadow !== undefined && !coming) {
      const mine = instrumentsOf(shadow);
      const missing = builtinInstruments.filter((i) => !mine.includes(i));
      if (missing.length === 0) {
        source = 'saved';
        steps = shadow.steps;
        requiresQe = mine.includes(QE_ACCEPTANCE);
      } else {
        // A standard card never launches below its built-in assurance (Q16): the shadow runs from Yours only.
        status = 'unavailable';
        statusNote = `Your saved \`${workflow}\` has fewer checks than the built-in (it lacks ${missing.join(', ')}), so this option is off; start yours from Yours.`;
        steps = builtin?.steps ?? (def !== undefined ? stepsOfDef(def) : []);
        requiresQe = builtinInstruments.includes(QE_ACCEPTANCE);
      }
    } else if (builtin !== undefined) {
      steps = builtin.steps;
      requiresQe = QE_PRESETS.has(workflow);
    } else if (def !== undefined) {
      source = 'crew';
      steps = stepsOfDef(def);
      requiresQe = (def.required_instruments ?? []).includes(QE_ACCEPTANCE);
    } else if (!coming) {
      status = 'unavailable';
      statusNote = `This daemon's engine does not serve the \`${workflow}\` workflow; update wicked-crew to get it.`;
    }
  } else if (launch.kind === 'document') {
    style = launch.style;
  }
  if (!coming && status === 'available' && Object.hasOwn(CREW_PENDING, card.id)) {
    status = 'unavailable';
    statusNote = CREW_PENDING[card.id]!;
  }
  if (launch.kind === 'demo') {
    const demo = served.builtins.get('demo');
    if (demo !== undefined) steps = demo.steps;
  }
  const read = readSteps(steps, served.entries);
  const gate = status === 'coming_soon' ? [...seededGate] : derivedGate(launch, read, requiresQe, seededGate, card.category === 'improve', delivers);
  const hint = legacyHint(launch);
  const defaultOption = options.length > 0 ? options.find((o) => o.id === card.variant!.default) ?? null : null;
  const defaultLaunch = defaultOption?.launch ?? card.launch ?? { kind: 'none' };
  const changesPlan = option === null ? false : option.changesPlan ?? (JSON.stringify(launch) !== JSON.stringify(defaultLaunch) || JSON.stringify(compose) !== JSON.stringify(defaultOption?.compose ?? null));
  const base = {
    launch,
    brief,
    compose,
    changesPlan,
    inputs,
    needs,
    delivers,
    writes,
    gate,
    requiresQe,
    // The review preparer does not yet exclude the seats that ran the reviewed work (wicked-crew#1375): the R≠ rule is
    // not claimed until it does.
    seats: { ...seatsOf(card.seats, option?.seats), ...(workflow === 'review-recent-work' ? { notRunSeat: false } : {}) },
    archetype: option?.archetype ?? card.archetype ?? null,
    typicalMinutes: hint.typicalMinutes,
    cost: hint.cost,
    status,
    statusNote,
    release: card.release,
    source,
  } satisfies Omit<CatalogResolved, 'resolution'>;
  // What a launch checks: the effective steps (with their rubrics), the instruments, the gate and the needs.
  // The served def is the effective one (its composed phases, instructions and executors), not only the preset rows.
  const def = workflow === null ? null : served.defs.get(workflow) ?? null;
  const resolution = fingerprint({ launch, steps, def, requiresQe, gate, needs, brief, compose, inputs: inputs.map((i) => [i.id, i.required]), status, seats: base.seats });
  return { card, option, resolved: { ...base, resolution }, workflow, style, steps };
}

// ── the catalog ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The option word of a command (`/migrate upgrade` → `upgrade`). */
export const optionWordOf = (command: string | null | undefined): string | null => {
  if (command === null || command === undefined) return null;
  const parts = command.trim().split(/\s+/u);
  return parts.length >= 2 ? parts[1]! : null;
};

/** The card whose default option launches `workflow` (the legacy usage fallback), or `null`. */
function legacyCardOf(workflow: string): { card: string; option: string | null } | null {
  for (const c of CATALOG_V2_CARDS) {
    if (c.hidden === true) continue;
    const def = c.variant?.options.find((o) => o.id === c.variant!.default);
    const launch = def?.launch ?? c.launch;
    if (launch?.kind === 'run' && launch.workflow === workflow) return { card: c.id, option: def?.id ?? null };
  }
  return null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const v = s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  return Math.round(v * 10) / 10;
}

function usageOfRuns(runs: readonly CatalogRun[]): WorkflowCatalogUsage {
  const newest = runs.reduce<number | null>((acc, r) => (r.createdAt !== undefined && (acc === null || r.createdAt > acc) ? r.createdAt : acc), null);
  const took = runs
    .filter((r) => r.status === 'completed' && r.createdAt !== undefined && r.endedAt !== undefined && r.endedAt >= r.createdAt)
    .map((r) => (r.endedAt! - r.createdAt!) / 60);
  return { launches: runs.length, lastUsedAt: newest === null ? null : new Date(newest * 1000).toISOString(), medianMinutes: median(took) };
}

const GENERIC_INPUTS: CatalogInputV2[] = inputsOf(['intent', 'repo?', 'project?', 'seats']);

/** The whole v2 catalog. `rev` changes whenever any card, option, status or effective preset does. */
export function buildWorkflowCatalogV2(input: CatalogV2Inputs): WorkflowCatalogV2Response {
  const served = servedState(input);
  const inScope = (r: CatalogRun): boolean =>
    input.projectId === null ||
    (input.projectId === DEFAULT_PROJECT_ID ? r.projectId === null || r.projectId === DEFAULT_PROJECT_ID : r.projectId === input.projectId);
  // A retry or reshape lineage counts once, under its last run: runs that a later run retried are left out.
  const retried = new Set(input.runs.map((r) => r.retryOf).filter((x): x is string => x !== undefined));
  const mine = input.runs.filter((r) => r.principal === input.actorId && !retried.has(r.id) && inScope(r));
  const shapeOf = (r: (typeof mine)[number]): { card: string; option: string | null } | null =>
    r.shape ?? (r.workflow !== null ? legacyCardOf(r.workflow) : null);
  const runsOfCard = new Map<string, Array<{ run: CatalogRun; option: string | null }>>();
  for (const r of mine) {
    const s = shapeOf(r);
    if (s === null) continue;
    runsOfCard.set(s.card, [...(runsOfCard.get(s.card) ?? []), { run: r, option: s.option }]);
  }
  const claimed = new Set<string>();
  const cards: CatalogCardV2[] = [];
  for (const card of CATALOG_V2_CARDS) {
    const own = resolveOption(card.id, null, served)!;
    const options: CatalogOptionV2[] = (card.variant?.options ?? []).map((o) => {
      const r = resolveOption(card.id, o.id, served)!;
      if (r.workflow !== null) claimed.add(r.workflow);
      return { ...r.resolved, id: o.id, title: o.title, summary: o.summary ?? '', words: o.words ?? [], command: o.command ?? null, optionWord: optionWordOf(o.command) };
    });
    if (own.workflow !== null) claimed.add(own.workflow);
    const used = runsOfCard.get(card.id) ?? [];
    const byOption: Record<string, number> = {};
    for (const u of used) if (u.option !== null) byOption[u.option] = (byOption[u.option] ?? 0) + 1;
    const defOpt = card.variant?.options.find((o) => o.id === card.variant!.default);
    const summary = defOpt?.summary ?? (own.workflow !== null ? served.defs.get(own.workflow)?.summary : undefined) ?? card.outcome ?? '';
    cards.push({
      ...own.resolved,
      id: card.id,
      category: card.category,
      title: card.title,
      summary,
      outcome: card.outcome ?? '',
      useWhen: own.workflow !== null ? served.defs.get(own.workflow)?.use_when ?? [] : [],
      tags: [],
      words: card.words ?? [],
      depth: card.depth === true,
      variant: card.variant === undefined ? null : { axis: card.variant.axis, label: card.variant.label, default: card.variant.default, options },
      handoff: card.handoff ?? null,
      nearest: card.nearest ?? null,
      later: card.later ?? [],
      command: card.command,
      aliases: card.aliases,
      hidden: card.hidden === true,
      usage: { ...usageOfRuns(used.map((u) => u.run)), byOption },
    });
  }
  // `yours`: every saved preset, and every served non-system def no card launches (v1's never-lose rule, v2's list).
  const ids = new Set(cards.map((c) => c.id));
  const cardIdFor = (name: string): string => {
    let id = name;
    while (ids.has(id)) id = `run:${id}`;
    ids.add(id);
    return id;
  };
  const yours = (name: string, steps: readonly PresetStep[], instruments: readonly string[], title: string, summary: string, source: CatalogResolved['source']): CatalogCardV2 => {
    const launch: WorkflowCatalogLaunch = { kind: 'run', workflow: name };
    const read = readSteps(steps, served.entries);
    const requiresQe = instruments.includes(QE_ACCEPTANCE);
    const delivers: CatalogResolved['delivers'] = read.some((s) => s.catalog === 'build') ? 'pr' : 'report';
    const gate = derivedGate(launch, read, requiresQe, [], false, delivers);
    const runs = mine.filter((r) => r.workflow === name && r.shape === undefined);
    const resolution = fingerprint({ launch, steps, requiresQe, gate });
    return {
      launch, brief: null, compose: null, changesPlan: false, inputs: GENERIC_INPUTS, needs: [], delivers,
      writes: delivers === 'pr' ? 'repo' : 'nothing', gate, requiresQe,
      seats: { distinctEvaluator: false, distinctJudge: false, excludeChangeAuthors: false, proposalOnly: false, notRunSeat: false, council: false },
      archetype: null, typicalMinutes: null, cost: null, status: 'available', statusNote: null, release: 'as-is', source, resolution,
      id: cardIdFor(name), category: 'yours', title, summary, outcome: source === 'saved' ? 'What your saved steps produce.' : summary,
      useWhen: [], tags: source === 'saved' ? ['saved'] : [], words: [], depth: false, variant: null, handoff: null, nearest: null,
      later: [], command: null, aliases: [], hidden: false, usage: { ...usageOfRuns(runs), byOption: {} },
    };
  };
  const savedRows = [...served.saved.values()].filter((p) => !V2_EXCLUDED.has(p.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const p of savedRows) {
    cards.push(yours(p.name, p.steps, instrumentsOf(p), p.title ?? p.name, p.summary ?? `Your saved steps: ${p.steps.map((s) => s.id || s.catalog).join(', ')}.`, 'saved'));
  }
  for (const def of input.defs) {
    if (def.is_system === true || claimed.has(def.id) || V2_EXCLUDED.has(def.id) || served.saved.has(def.id)) continue;
    claimed.add(def.id);
    const builtin = served.builtins.get(def.id);
    cards.push(yours(def.id, builtin?.steps ?? stepsOfDef(def), builtin !== undefined && QE_PRESETS.has(def.id) ? BUILTIN_QE_INSTRUMENTS : (def.required_instruments ?? []), def.title ?? def.id, def.summary ?? '', builtin !== undefined ? 'builtin' : 'crew'));
  }
  const keyed: Array<{ key: string; launches: number; last: string }> = [];
  for (const c of cards) {
    if (c.status !== 'available' || c.hidden) continue;
    const options = Object.entries(c.usage.byOption);
    if (options.length > 0) {
      for (const [opt, n] of options) {
        if (c.variant?.options.find((o) => o.id === opt)?.status === 'available') keyed.push({ key: `${c.id}:${opt}`, launches: n, last: c.usage.lastUsedAt ?? '' });
      }
    } else if (c.usage.launches > 0) {
      keyed.push({ key: c.id, launches: c.usage.launches, last: c.usage.lastUsedAt ?? '' });
    }
  }
  const top = keyed
    .sort((a, b) => b.launches - a.launches || b.last.localeCompare(a.last) || a.key.localeCompare(b.key))
    .slice(0, TOP_MAX_V2)
    .map((k) => k.key);
  const hasYours = cards.some((c) => c.category === 'yours');
  const rev = fingerprint(cards.map((c) => [c.id, c.status, c.resolution, c.hidden, c.command, c.variant?.options.map((o) => [o.id, o.status, o.resolution, o.command]) ?? null]));
  return {
    version: 2,
    rev,
    categories: [...CATALOG_V2_CATEGORIES.map((c) => ({ ...c })), ...(hasYours ? [{ id: 'yours' as const, title: 'Yours', summary: 'Your saved steps, and workflows no card offers yet.' }] : [])],
    cards,
    top,
    inputKinds: [...INPUT_KINDS_V2],
    usage: {
      scope: input.projectId === null ? 'operator' : 'project',
      projectId: input.projectId,
      actorId: input.actorId,
      launches: mine.filter((r) => shapeOf(r) !== null).length,
    },
  };
}

// ── commands ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a typed command names: a card and an exact option (an alias), or a card whose option a second word may pick. */
export interface CommandHit {
  card: string;
  /** The alias's or option command's own option; `undefined` when the card command alone was typed (no option yet). */
  option: string | null | undefined;
  /** The words after the command (and after the option word, when one matched). */
  words: string;
}

/**
 * Parse `/<card> [<option word>] [words…]`, or an alias, or an option command. `null` when no card command matches.
 * A hidden card is reached only by its alias.
 */
export function parseCommand(text: string): CommandHit | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const [head, ...rest] = t.split(/\s+/u);
  const first = head!.toLowerCase();
  for (const c of CATALOG_V2_CARDS) {
    for (const a of c.aliases) if (a.command.toLowerCase() === first) return { card: c.id, option: a.option, words: rest.join(' ') };
  }
  for (const c of CATALOG_V2_CARDS) {
    if (c.hidden === true || c.command === null || c.command.toLowerCase() !== first) continue;
    const word = rest[0]?.toLowerCase();
    const opt = word === undefined ? undefined : c.variant?.options.find((o) => optionWordOf(o.command)?.toLowerCase() === word);
    if (opt !== undefined) return { card: c.id, option: opt.id, words: rest.slice(1).join(' ') };
    return { card: c.id, option: undefined, words: rest.join(' ') };
  }
  return null;
}
