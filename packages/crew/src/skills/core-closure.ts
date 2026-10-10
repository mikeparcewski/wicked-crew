/**
 * Core-by-reference = the REGISTERED-REFERENCE CLOSURE (design v3 §5), recomputed at every publish:
 *
 *   seeds     every `skill_ref` of every runtime-registered def (the user's and crew's seams',
 *             `adapter.listRuntimeWorkflows()`), required; and the engine's built-in presets' refs
 *             (`builtinPresetSkillRefs`), core when the catalog holds them (`coreSkillRefs`, X-MIG M11);
 *   closure   plus each referenced skill's mandates, transitively. A skill mandates another in two
 *             ways, and BOTH are read (a mandate that is missed is a phase the engine refuses):
 *
 *             declared   the frontmatter `mandates:` list — consumed from the PARSED YAML
 *                        (`parseFrontmatter().mandates`, frontmatter.ts): each entry's decoded
 *                        scalar names a catalog skill, so `"wicked-garden-gamma"` mandates
 *                        `wicked-garden-gamma` exactly as the parser reads it (codex round 4: the
 *                        closure used to find mandates by a regex over the RAW text, which an
 *                        escaped scalar slipped past). The frontmatter block is never regex-scanned.
 *             prose      the BODY's qualified-name mentions (`repo-learn/SKILL.md:79` "Use the
 *                        **wicked-garden-search** skill", `:113` "`wicked-garden-mem` `recall`") —
 *                        the live catalog declares no `mandates:` today (0/142), so its real
 *                        dependencies live in prose. Scanned over the body only
 *                        (`bodyWithFrontmatterBlanked`): a frontmatter scalar is a parser's
 *                        business, not a prose mention.
 *
 * Two kinds of ABSENCE are reported, and both block a publish (codex review of #480 — the closure
 * used to fail open, warning on a missing registered ref and dropping an absent mandate silently):
 *
 *   missing          a registered ref that names no catalog skill — a run dispatching that phase
 *                    would find no skill in the snapshot;
 *   absentMandates   a name a CORE skill mandates (declared or in prose) that no catalog skill
 *                    answers to — the mandated method is missing, with file:line.
 *
 * What counts as a qualified-name MENTION in prose is deliberately narrow so prose does not
 * masquerade as a mandate: `wicked-garden-<x>` / `wicked-garden:<x>` not glued to a preceding name
 * character; a token ending in `-`/`_` is a glob or prefix (`wicked-garden-qe-acceptance-test-*`),
 * not a name; a token continued by `:` is a Claude subagent type (`wicked-garden:crew:implementer`),
 * not a skill. A DECLARED mandate is taken verbatim (normalized from the Claude colon form) — the
 * operator wrote it as a requirement, so a name the catalog lacks is absent, never ignored.
 */

import type { WorkflowDef } from '../core/types.js';
import { bodyWithFrontmatterBlanked, parseFrontmatter, PLUGIN_NAME, SKILL_NAME_PREFIX } from './frontmatter.js';

/** `wicked-garden-<x>` or the Claude plugin form `wicked-garden:<x>`, not glued to a preceding name char. */
const NAME_TOKEN_RE = new RegExp(`(?<![A-Za-z0-9_-])${PLUGIN_NAME}[:-]([A-Za-z0-9_-]+)(:?)`, 'g');

/** One qualified name a SKILL.md requires: the catalog name it spells and the 1-based line. */
export interface NameMention {
  name: string;
  line: number;
}

/** The non-null `skill_ref`s across a set of workflow defs. */
export function registeredSkillRefs(workflows: ReadonlyArray<WorkflowDef>): Set<string> {
  const out = new Set<string>();
  for (const w of workflows) {
    for (const p of w.phases) {
      if (typeof p.skill_ref === 'string' && p.skill_ref !== '') out.add(p.skill_ref);
    }
  }
  return out;
}

/** The non-empty `skill_ref`s across a set of presets' steps. */
export function presetSkillRefs(presets: ReadonlyArray<{ steps: ReadonlyArray<object> }>): Set<string> {
  const out = new Set<string>();
  for (const p of presets) {
    for (const s of p.steps) {
      const ref = (s as { skill_ref?: unknown }).skill_ref;
      if (typeof ref === 'string' && ref !== '') out.add(ref);
    }
  }
  return out;
}

/**
 * (crew#935, codex r5 on #938) The skill_refs of the engine's BUILT-IN presets, read once at boot:
 * a workflow that became a preset registers no def, so `registeredSkillRefs(listWorkflows())` no
 * longer sees its skills, and a skill a preset ALWAYS requires (`wicked-garden-draft` on the
 * interactive-* presets) could be disabled and published, failing every run that needs it. The
 * built-ins are compiled into the engine, so one read holds until restart. An addon without presets,
 * or a read that fails, answers the empty set (logged): the registered defs still count.
 */
export async function builtinPresetSkillRefs(
  adapter: { presetsSupported(): boolean; listPresets(): Promise<ReadonlyArray<{ created_by: string; steps: ReadonlyArray<object> }>> },
  warn: (msg: string) => void,
): Promise<Set<string>> {
  try {
    // A partial adapter (a directly-driven route set, a test double) may carry neither method.
    if (typeof adapter.presetsSupported !== 'function' || !adapter.presetsSupported()) return new Set();
    return presetSkillRefs((await adapter.listPresets()).filter((p) => p.created_by === 'builtin'));
  } catch (err) {
    warn(`[skills] could not read the built-in presets' skill_refs: ${err instanceof Error ? err.message : String(err)}`);
    return new Set();
  }
}

/**
 * (crew#935) The core reference set: the registered defs' refs plus the built-in presets' refs the
 * catalog HOLDS. A held preset skill cannot be disabled out from under its preset; one the catalog
 * lacks is not a publish blocker (an older garden still publishes for every other workflow, and a run
 * of that preset fails at admission naming the skill).
 */
export function coreSkillRefs(defRefs: ReadonlySet<string>, presetRefs: ReadonlySet<string>, held: ReadonlySet<string>): Set<string> {
  const out = new Set(defRefs);
  for (const r of presetRefs) if (held.has(r)) out.add(r);
  return out;
}

/**
 * Every well-formed qualified-name token in `text` with its line — catalog-agnostic, PROSE only.
 * Glob/prefix tokens (trailing `-`/`_`) and `:`-continued subagent types are not names and are not
 * returned. Callers hand this the body (`bodyWithFrontmatterBlanked`), never the frontmatter.
 */
export function mentionedTokens(text: string): NameMention[] {
  const out: NameMention[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of (lines[i] ?? '').matchAll(NAME_TOKEN_RE)) {
      const raw = m[1] ?? '';
      if (m[2] === ':' || raw.endsWith('-') || raw.endsWith('_')) continue;
      out.push({ name: SKILL_NAME_PREFIX + raw, line: i + 1 });
    }
  }
  return out;
}

/**
 * Everything a SKILL.md mandates, in file order: the DECLARED `mandates:` entries as the YAML parser
 * decoded them (positioned by node range), then the body's prose mentions (positioned by line). A
 * frontmatter that does not parse declares nothing here — the frontmatter guard blocks it on its own.
 */
export function mandateMentions(skillMd: string): NameMention[] {
  const parsed = parseFrontmatter(skillMd);
  const declared: NameMention[] = parsed.ok ? parsed.mandates.map((m) => ({ name: m.name, line: m.line })) : [];
  return [...declared, ...mentionedTokens(bodyWithFrontmatterBlanked(skillMd))];
}

/** Catalog names `skillMd` mandates (declared + prose), excluding `self`. */
export function mentionedSkillNames(skillMd: string, catalogNames: ReadonlySet<string>, self: string): Set<string> {
  const out = new Set<string>();
  for (const { name } of mandateMentions(skillMd)) {
    if (name !== self && catalogNames.has(name)) out.add(name);
  }
  return out;
}

export interface AbsentMandate {
  /** The core skill whose SKILL.md names the absent skill. */
  from: string;
  /** The qualified name no catalog skill answers to. */
  name: string;
  /** 1-based line in `from`'s SKILL.md. */
  line: number;
}

export interface CoreClosure {
  core: Set<string>;
  /** Registered refs that name no catalog skill. */
  missing: string[];
  /** Names core skills mandate (declared or in prose) that no catalog skill answers to, with file:line. */
  absentMandates: AbsentMandate[];
}

/**
 * BFS from `refs` over "SKILL.md mandates" (`mandateMentions`). `catalog` maps every catalog name
 * (disabled skills included — disabling does not remove a skill from the catalog) to its SKILL.md
 * text.
 */
export function coreClosure(refs: Iterable<string>, catalog: ReadonlyMap<string, string>): CoreClosure {
  const names = new Set(catalog.keys());
  const core = new Set<string>();
  const missing: string[] = [];
  const absentMandates: AbsentMandate[] = [];
  const queue: string[] = [];
  for (const ref of refs) {
    if (!names.has(ref)) {
      missing.push(ref);
      continue;
    }
    if (!core.has(ref)) {
      core.add(ref);
      queue.push(ref);
    }
  }
  while (queue.length > 0) {
    const name = queue.shift() as string;
    for (const mention of mandateMentions(catalog.get(name) ?? '')) {
      if (mention.name === name) continue;
      if (!names.has(mention.name)) {
        absentMandates.push({ from: name, name: mention.name, line: mention.line });
        continue;
      }
      if (!core.has(mention.name)) {
        core.add(mention.name);
        queue.push(mention.name);
      }
    }
  }
  absentMandates.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line));
  return { core, missing: [...new Set(missing)].sort(), absentMandates };
}
