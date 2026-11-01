/**
 * `GET /workflows/catalog` (lane wf-catalog): join the catalog seeds with what the engine serves and
 * with the requesting operator's runs. Pure: the route gathers the inputs, this shapes the answer.
 *
 * Usage is derived, never stored: a run counts for an entry when its resolved workflow
 * (`run_identity.name`) is the entry's, its `run.launched` trail entry names THIS principal (the system
 * of record for who launched a run), and it is not a retry. Runs the daemon or a schedule launched
 * (actor kind `system`) are not the operator's use.
 */
import type {
  Preset,
  WorkflowCatalogEntry,
  WorkflowCatalogInput,
  WorkflowCatalogResponse,
  WorkflowCatalogUsage,
  WorkflowDef,
} from '../core/types.js';
import { CATALOG_CATEGORIES, CATALOG_EXCLUDED, CATALOG_SEEDS, CATEGORY_ORDER, type CatalogSeed } from './catalog-data.js';

/** One run as the catalog reads it. Times are unix SECONDS (the served run's `created_at`/`ended_at`). */
export interface CatalogRun {
  id: string;
  /** The resolved workflow/preset name (`run_identity.name`), null for a user plan or free text. */
  workflow: string | null;
  projectId: string | null;
  status: string;
  createdAt?: number | undefined;
  endedAt?: number | undefined;
  retryOf?: string | undefined;
  /** The `run.launched` entry's principal (`Actor.id`), absent when the daemon holds no launch record. */
  principal?: string | undefined;
}

export interface CatalogInputs {
  /** `GET /workflows`'s served defs (built-ins carry their C2 descriptor). */
  defs: readonly WorkflowDef[];
  /** `GET /presets` for the scope (built-in rows and the operator's saved ones). */
  presets: readonly Preset[];
  runs: readonly CatalogRun[];
  actorId: string;
  projectId: string | null;
}

export const TOP_MAX = 6;

/** The workflow name whose runs count as an entry's use (`null` = its launches are not runs we can attribute). */
function usageKey(seed: Pick<CatalogSeed, 'launch'>): string | null {
  if (seed.launch.kind === 'run') return seed.launch.workflow;
  if (seed.launch.kind === 'demo') return 'demo';
  return null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const v = s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  return Math.round(v * 10) / 10;
}

function usageOf(key: string | null, mine: readonly CatalogRun[]): WorkflowCatalogUsage {
  if (key === null) return { launches: 0, lastUsedAt: null, medianMinutes: null };
  const runs = mine.filter((r) => r.workflow === key);
  const newest = runs.reduce<number | null>((acc, r) => (r.createdAt !== undefined && (acc === null || r.createdAt > acc) ? r.createdAt : acc), null);
  const took = runs
    .filter((r) => r.status === 'completed' && r.createdAt !== undefined && r.endedAt !== undefined && r.endedAt >= r.createdAt)
    .map((r) => (r.endedAt! - r.createdAt!) / 60);
  return {
    launches: runs.length,
    lastUsedAt: newest === null ? null : new Date(newest * 1000).toISOString(),
    medianMinutes: median(took),
  };
}

const GENERIC_INPUTS: WorkflowCatalogInput[] = [
  { id: 'intent', label: 'What should it do?', kind: 'text', required: true },
  { id: 'repo', label: 'Repository', kind: 'repo', required: false },
  { id: 'project', label: 'Project', kind: 'project', required: false },
  { id: 'seats', label: 'Who works on it', kind: 'seats', required: false },
];

const requiresQe = (def: WorkflowDef | undefined): boolean => (def?.required_instruments ?? []).includes('qe_acceptance');
const presetRequiresQe = (p: Preset): boolean =>
  Array.isArray(p['required_instruments']) && (p['required_instruments'] as unknown[]).includes('qe_acceptance');
const presetDelivers = (p: Preset): WorkflowCatalogEntry['delivers'] => (p.steps.some((s) => s.catalog === 'build') ? 'pr' : 'report');
const savedSummary = (p: Preset): string => `Your saved steps: ${p.steps.map((s) => s.id || s.catalog).join(', ')}.`;
const isExcluded = (name: string): boolean => Object.hasOwn(CATALOG_EXCLUDED, name);

export function buildWorkflowCatalog(input: CatalogInputs): WorkflowCatalogResponse {
  const defs = new Map(input.defs.map((d) => [d.id, d]));
  const builtinNames = new Set(input.presets.filter((p) => p.created_by === 'builtin').map((p) => p.name));
  // The operator's saved presets by name, as a launch resolves them: a project row wins over a global one.
  const savedByName = new Map<string, Preset>();
  for (const p of input.presets) {
    if (p.created_by === 'builtin' || p.system === true) continue;
    const held = savedByName.get(p.name);
    if (held === undefined || (held.scope === 'global' && p.scope !== 'global')) savedByName.set(p.name, p);
  }
  const mine = input.runs.filter(
    (r) => r.principal === input.actorId && r.retryOf === undefined && (input.projectId === null || r.projectId === input.projectId),
  );
  const entries: WorkflowCatalogEntry[] = [];
  /** Workflow names a card already launches. */
  const claimed = new Set<string>();
  /** Card ids in use: a run card whose name a studio card holds is `run:<name>` (ids stay unique). */
  const ids = new Set<string>(CATALOG_SEEDS.filter((s) => s.launch.kind !== 'run').map((s) => s.id));
  const runCardId = (name: string): string => (ids.has(name) ? `run:${name}` : name);

  for (const seed of CATALOG_SEEDS) {
    const { title, summary, useWhen, status, statusNote, ...rest } = seed;
    const key = usageKey(seed);
    if (seed.launch.kind === 'run') {
      const name = seed.launch.workflow;
      claimed.add(name);
      ids.add(seed.id);
      const def = defs.get(name);
      // A saved preset of this name is what a launch runs (codex r1): describe IT, not the shadowed def.
      const saved = savedByName.get(name);
      if (saved !== undefined) {
        entries.push({
          ...rest,
          title: saved.title ?? def?.title ?? name,
          summary: saved.summary ?? savedSummary(saved),
          outcome: 'What your saved steps produce.',
          useWhen: saved.use_when ?? [],
          status: 'available',
          statusNote: null,
          requiresQe: presetRequiresQe(saved),
          delivers: presetDelivers(saved),
          source: 'saved',
          usage: usageOf(key, mine),
        });
        continue;
      }
      entries.push({
        ...rest,
        title: def?.title ?? name,
        summary: def?.summary ?? '',
        useWhen: def?.use_when ?? [],
        status: def === undefined ? 'unavailable' : 'available',
        statusNote: def === undefined ? `This daemon's engine does not serve the \`${name}\` workflow; update wicked-crew to get it.` : null,
        requiresQe: requiresQe(def),
        source: builtinNames.has(name) ? 'builtin' : 'crew',
        usage: usageOf(key, mine),
      });
      continue;
    }
    if (key !== null) claimed.add(key);
    entries.push({
      ...rest,
      title: title ?? seed.id,
      summary: summary ?? '',
      useWhen: useWhen ?? [],
      status: status ?? 'available',
      statusNote: statusNote ?? null,
      requiresQe: false,
      source: seed.launch.kind === 'none' ? 'none' : 'studio',
      usage: usageOf(key, mine),
    });
  }

  // Never lose a launchable workflow: a served non-system def nobody seeded joins `more`, unless a saved
  // preset of its name shadows it (that one joins `yours` below, as what a launch runs).
  for (const def of input.defs) {
    if (def.is_system === true || claimed.has(def.id) || isExcluded(def.id) || savedByName.has(def.id)) continue;
    claimed.add(def.id);
    const id = runCardId(def.id);
    ids.add(id);
    entries.push({
      id,
      category: 'more',
      subcategory: null,
      title: def.title ?? def.id,
      summary: def.summary ?? '',
      outcome: def.summary ?? '',
      useWhen: def.use_when ?? [],
      needs: [],
      inputs: GENERIC_INPUTS,
      typicalMinutes: null,
      cost: null,
      tags: [],
      synonyms: [],
      status: 'available',
      statusNote: null,
      launch: { kind: 'run', workflow: def.id },
      requiresQe: requiresQe(def),
      delivers: def.phases.some((p) => p.executes_code) ? 'pr' : 'report',
      source: builtinNames.has(def.id) ? 'builtin' : 'crew',
      usage: usageOf(def.id, mine),
    });
  }

  // The operator's saved presets that no card launches yet.
  const saved = [...savedByName.values()]
    .filter((p) => !claimed.has(p.name) && !isExcluded(p.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const p of saved) {
    claimed.add(p.name);
    const id = runCardId(p.name);
    ids.add(id);
    entries.push({
      id,
      category: 'yours',
      subcategory: null,
      title: p.title ?? p.name,
      summary: p.summary ?? savedSummary(p),
      outcome: 'What your saved steps produce.',
      useWhen: p.use_when ?? [],
      needs: [],
      inputs: GENERIC_INPUTS,
      typicalMinutes: null,
      cost: null,
      tags: ['saved'],
      synonyms: [],
      status: 'available',
      statusNote: null,
      launch: { kind: 'run', workflow: p.name },
      requiresQe: presetRequiresQe(p),
      delivers: presetDelivers(p),
      source: 'saved',
      usage: usageOf(p.name, mine),
    });
  }

  const subOrder = (e: WorkflowCatalogEntry): number => {
    const cat = CATALOG_CATEGORIES.find((c) => c.id === e.category);
    const i = cat?.subcategories.findIndex((s) => s.id === e.subcategory) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      CATEGORY_ORDER.indexOf(a.e.category) - CATEGORY_ORDER.indexOf(b.e.category) ||
      subOrder(a.e) - subOrder(b.e) ||
      a.i - b.i)
    .map(({ e }) => e);

  const top = ordered
    .filter((e) => e.status === 'available' && e.usage.launches > 0)
    .sort((a, b) =>
      b.usage.launches - a.usage.launches ||
      (b.usage.lastUsedAt ?? '').localeCompare(a.usage.lastUsedAt ?? '') ||
      a.id.localeCompare(b.id))
    .slice(0, TOP_MAX)
    .map((e) => e.id);

  const counted = new Set(ordered.map((e) => usageKey(e)).filter((k): k is string => k !== null));
  return {
    categories: CATALOG_CATEGORIES.filter((c) => c.id !== 'yours' || ordered.some((e) => e.category === 'yours')).map((c) => ({
      ...c,
      subcategories: [...c.subcategories],
    })),
    entries: ordered,
    top,
    usage: {
      scope: input.projectId === null ? 'operator' : 'project',
      projectId: input.projectId,
      actorId: input.actorId,
      launches: mine.filter((r) => r.workflow !== null && counted.has(r.workflow)).length,
    },
  };
}
