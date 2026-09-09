/**
 * Core-by-reference = the REGISTERED-REFERENCE CLOSURE (design v3 §5), recomputed at every publish:
 *
 *   seeds     every `skill_ref` of every workflow the daemon knows — core's drop-ins as mirrored in
 *             `BUILTIN_WORKFLOWS` (asserted field-for-field against wicked-core's `workflows/*.json`
 *             by tests/builtin-overlay-shadow.test.ts), crew's TS-generated workflows
 *             (capture-learnings → repo-learn, domain-extraction → domain/extractor/coverage) and
 *             any user-registered def — `adapter.listWorkflows()` is that one list;
 *   closure   plus each referenced skill's declared mandates: the catalog skills its SKILL.md names
 *             by qualified name (`repo-learn/SKILL.md:79` "Use the **wicked-garden-search** skill",
 *             `:113` "`wicked-garden-mem` `recall`"), transitively.
 *
 * A registered ref that names no catalog skill is reported (`missing`) — a run dispatching that
 * phase would find no skill in the snapshot, which is the engine's launch refusal (v3 §3) and the
 * operator's warning here.
 */

import type { WorkflowDef } from '../core/types.js';
import { PLUGIN_NAME, SKILL_NAME_PREFIX } from './frontmatter.js';

/** `wicked-garden-<x>` or the Claude plugin form `wicked-garden:<x>`, not glued to a preceding name char. */
const NAME_TOKEN_RE = new RegExp(`(?<![A-Za-z0-9_-])${PLUGIN_NAME}[:-]([A-Za-z0-9_-]+)`, 'g');

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

/** Catalog names `text` mentions by qualified name, excluding `self`. */
export function mentionedSkillNames(text: string, catalogNames: ReadonlySet<string>, self: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NAME_TOKEN_RE)) {
    const name = SKILL_NAME_PREFIX + (m[1] ?? '');
    if (name !== self && catalogNames.has(name)) out.add(name);
  }
  return out;
}

export interface CoreClosure {
  core: Set<string>;
  /** Registered refs that name no catalog skill. */
  missing: string[];
}

/**
 * BFS from `refs` over "SKILL.md mentions". `catalog` maps every catalog name (disabled skills
 * included — disabling does not remove a skill from the catalog) to its SKILL.md text.
 */
export function coreClosure(refs: Iterable<string>, catalog: ReadonlyMap<string, string>): CoreClosure {
  const names = new Set(catalog.keys());
  const core = new Set<string>();
  const missing: string[] = [];
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
    for (const dep of mentionedSkillNames(catalog.get(name) ?? '', names, name)) {
      if (!core.has(dep)) {
        core.add(dep);
        queue.push(dep);
      }
    }
  }
  return { core, missing: missing.sort() };
}
