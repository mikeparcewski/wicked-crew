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
 * Two kinds of ABSENCE are reported, and both block a publish (codex review of #480 — the closure
 * used to fail open, warning on a missing registered ref and dropping an absent mandate silently):
 *
 *   missing          a registered ref that names no catalog skill — a run dispatching that phase
 *                    would find no skill in the snapshot;
 *   absentMandates   a qualified name a CORE skill's SKILL.md mentions that no catalog skill
 *                    answers to — the mandated method is missing, with file:line.
 *
 * What counts as a qualified-name MENTION is deliberately narrow so prose does not masquerade as a
 * mandate: `wicked-garden-<x>` / `wicked-garden:<x>` not glued to a preceding name character; a
 * token ending in `-`/`_` is a glob or prefix (`wicked-garden-qe-acceptance-test-*`), not a name;
 * a token continued by `:` is a Claude subagent type (`wicked-garden:crew:implementer`), not a
 * skill. Verified against the live 12.32.0 catalog: the real closure (8 skills) has no absent
 * mandate under these rules.
 */

import type { WorkflowDef } from '../core/types.js';
import { PLUGIN_NAME, SKILL_NAME_PREFIX } from './frontmatter.js';

/** `wicked-garden-<x>` or the Claude plugin form `wicked-garden:<x>`, not glued to a preceding name char. */
const NAME_TOKEN_RE = new RegExp(`(?<![A-Za-z0-9_-])${PLUGIN_NAME}[:-]([A-Za-z0-9_-]+)(:?)`, 'g');

/** One qualified-name token in a text: the catalog name it spells and the 1-based line. */
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

/**
 * Every well-formed qualified-name token in `text` with its line — catalog-agnostic. Glob/prefix
 * tokens (trailing `-`/`_`) and `:`-continued subagent types are not names and are not returned.
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

/** Catalog names `text` mentions by qualified name, excluding `self`. */
export function mentionedSkillNames(text: string, catalogNames: ReadonlySet<string>, self: string): Set<string> {
  const out = new Set<string>();
  for (const { name } of mentionedTokens(text)) {
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
  /** Qualified names core skills mention that no catalog skill answers to, with file:line. */
  absentMandates: AbsentMandate[];
}

/**
 * BFS from `refs` over "SKILL.md mentions". `catalog` maps every catalog name (disabled skills
 * included — disabling does not remove a skill from the catalog) to its SKILL.md text.
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
    for (const mention of mentionedTokens(catalog.get(name) ?? '')) {
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
