/**
 * The built-in workflows crew serves, DERIVED from the engine (X-MIG M11, DES-W7-M11 on wicked-core#649).
 *
 * Every built-in workflow is a wicked-core built-in preset now (feature, bug, migration, mcp-server, chat,
 * onboarding, capture-learnings, steering-author, domain-extraction, qe-author-tests, demo, the
 * interactive-* documents). Crew used to keep hand-written mirrors of their defs and drift guards against
 * core's `workflows/*.json`. Those mirrors are gone. The catalog crew serves is read from the engine once at
 * boot instead: the built-in presets (`listPresets`, `created_by: "builtin"`) laid over the phase catalog
 * (`catalog`). One source, so nothing can drift.
 *
 * The derived def is for READING — the work-mode selector, the deliver text, the delivery candidacy,
 * the acceptance fold. A launch never runs it: a launch naming a preset is resolved and composed by the
 * engine. So this applies only the step fields a reader looks at, as the engine's compose sets them: a
 * step's own value where it states one, else its catalog entry's.
 */
import type { CatalogEntry, Preset, PresetStep } from 'wicked-crew-api-types';
import type { PhaseDef, WorkflowDef } from './types.js';
import { QE_PRESETS } from './qe-acceptance-setting.js';
import { isSystemWorkflow } from './run-identity.js';

/** What the engine's built-in QE presets require (wicked-core `catalog::builtin_preset_instruments`). */
const BUILTIN_QE_INSTRUMENTS: readonly string[] = ['distinct_evaluator', 'judge', 'qe_acceptance'];

/** A step field the step states, else `fallback`. */
function own<T>(step: PresetStep, key: string, fallback: T): T {
  return Object.hasOwn(step, key) && step[key] !== undefined ? (step[key] as T) : fallback;
}

/** One preset step laid over its catalog entry; `null` when the entry is unknown to this engine. */
export function phaseOfStep(step: PresetStep, entry: CatalogEntry | undefined, previous: string | null): PhaseDef | null {
  if (entry === undefined) return null;
  const executor = own<PhaseDef['executor'] | undefined>(step, 'executor', undefined);
  return {
    id: step.id,
    kind: own(step, 'kind', entry.kind),
    instructions: own<string | null>(step, 'instructions', null),
    gate_type: own(step, 'gate_type', entry.gate_type),
    gate: own(step, 'gate', entry.gate),
    executes_code: own(step, 'executes_code', entry.executes_code),
    verified_evidence: own(step, 'verified_evidence', entry.verified_evidence === true),
    required_deliverables: own<string[]>(step, 'required_deliverables', []),
    depends_on: own<string[]>(step, 'depends_on', previous === null ? [] : [previous]),
    role: entry.role,
    skill_ref: own(step, 'skill_ref', entry.skill_ref),
    allowed_skills: own<string[]>(step, 'allowed_skills', []),
    validator_pin: own(step, 'validator_pin', entry.validator_pin),
    ...(executor !== undefined ? { executor } : {}),
  };
}

/**
 * (DES-CHAT-FIRST-001 C2) The preset's operator-facing descriptor — `title`, `summary`, `use_when` — as
 * the served def carries it. Only a workflow an operator picks gets one: a SYSTEM workflow (chat,
 * onboarding, the interactive seams, …) has its own entry points and is offered nowhere, so its def
 * carries none (the same `isSystemWorkflow` rule as `is_system` and studio's `/` menu). Each field is
 * copied only when the engine sent a usable value, so an older engine's preset (no fields) serves the
 * def by id alone. Display data: crew never sends it to the engine ({@link engineDefOf}).
 */
export function descriptorOf(preset: Pick<Preset, 'name' | 'title' | 'summary' | 'use_when'>): Pick<WorkflowDef, 'title' | 'summary' | 'use_when'> {
  if (isSystemWorkflow(preset.name)) return {};
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  const title = text(preset.title);
  const summary = text(preset.summary);
  const useWhen = Array.isArray(preset.use_when) ? preset.use_when.filter((x): x is string => text(x) !== undefined) : [];
  return {
    ...(title !== undefined ? { title } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(useWhen.length > 0 ? { use_when: useWhen } : {}),
  };
}

/** The keys the served def carries for display only; the engine's strict def parser refuses each. */
const DISPLAY_ONLY_KEYS = ['is_system', 'title', 'summary', 'use_when'] as const;

/** A def as the ENGINE may receive it: the served def without its display-only keys (C2, finding 29). */
export function engineDefOf(def: WorkflowDef): WorkflowDef {
  if (!DISPLAY_ONLY_KEYS.some((k) => k in def)) return def;
  const out = { ...def } as WorkflowDef & Record<string, unknown>;
  for (const k of DISPLAY_ONLY_KEYS) delete out[k];
  return out;
}

/** A preset's def as crew serves it, or `null` when a step names an entry this engine lacks. */
export function presetDef(
  preset: Pick<Preset, 'name' | 'steps'> & Partial<Pick<Preset, 'title' | 'summary' | 'use_when'>>,
  entries: readonly CatalogEntry[],
): WorkflowDef | null {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const phases: PhaseDef[] = [];
  let previous: string | null = null;
  for (const step of preset.steps) {
    const phase = phaseOfStep(step, byId.get(step.catalog), previous);
    if (phase === null) return null;
    phases.push(phase);
    previous = step.id;
  }
  return { id: preset.name, phases, ...descriptorOf(preset) };
}

/** The built-in presets' defs, in name order; a preset that does not compose here is left out (logged). */
export function builtinDefs(presets: readonly Preset[], entries: readonly CatalogEntry[], warn: (m: string) => void): WorkflowDef[] {
  const out: WorkflowDef[] = [];
  for (const p of [...presets].filter((x) => x.created_by === 'builtin').sort((a, b) => a.name.localeCompare(b.name))) {
    const def = presetDef(p, entries);
    if (def === null) {
      warn(`wicked-crew: built-in preset '${p.name}' names a catalog entry this engine does not define — not served`);
      continue;
    }
    // A built-in preset carries no `required_instruments` on the wire (the engine reads its own table),
    // so the served def says it: readers (the composer's QE choice, the deliver checks) see what runs.
    out.push(QE_PRESETS.has(p.name) ? { ...def, required_instruments: [...BUILTIN_QE_INSTRUMENTS] } : def);
  }
  return out;
}
