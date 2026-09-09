// Core-by-reference = the registered-reference closure (design v3 §5): the skill_refs of every
// workflow the daemon knows, plus each referenced skill's SKILL.md mandates, transitively. Pinned
// against the workflows crew ships AND against wicked-core's own drop-ins where the checkout is
// available (the same sibling-checkout policy as builtin-overlay-shadow.test.ts).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { coreClosure, mentionedSkillNames, registeredSkillRefs } from '../src/skills/core-closure.js';
import { CORE_DIR, SKIP_CORE_CHECKS, coreDirMissingMessage } from './support/core-checkout.js';

describe('registeredSkillRefs', () => {
  it('collects the non-null skill_refs of the workflows crew serves (capture-learnings, domain-extraction)', () => {
    const refs = registeredSkillRefs(BUILTIN_WORKFLOWS);
    expect([...refs].sort()).toEqual([
      'wicked-garden-domain',
      'wicked-garden-domain-coverage',
      'wicked-garden-domain-extractor',
      'wicked-garden-repo-learn',
    ]);
  });

  it.skipIf(SKIP_CORE_CHECKS)('covers every skill_ref in wicked-core workflows/*.json (the drop-ins crew mirrors)', () => {
    if (CORE_DIR === null) throw new Error(coreDirMissingMessage());
    const dir = join(CORE_DIR, 'workflows');
    const coreDefs = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as WorkflowDef);
    const coreRefs = registeredSkillRefs(coreDefs);
    const crewRefs = registeredSkillRefs(BUILTIN_WORKFLOWS);
    for (const ref of coreRefs) {
      expect(crewRefs.has(ref), `wicked-core names ${ref} as a skill_ref but crew's BUILTIN_WORKFLOWS do not — the core closure would miss it`).toBe(true);
    }
  });
});

describe('mentionedSkillNames + coreClosure', () => {
  const catalog = new Map<string, string>([
    ['wicked-garden-repo-learn', 'Use the **wicked-garden-search** skill; then `wicked-garden-mem` recall. Not wicked-garden-repo-learn itself.'],
    ['wicked-garden-search', 'NOT for concept search — use the wicked-garden-mem skill. Claude form: wicked-garden:mem-capture.'],
    ['wicked-garden-mem', 'standalone'],
    ['wicked-garden-mem-capture', 'standalone'],
    ['wicked-garden-qe', 'unrelated; mentions xwicked-garden-mem which is not a token'],
  ]);

  it('reads qualified-name mentions (dash and Claude colon form), longest token, never itself or a glued prefix', () => {
    const names = new Set(catalog.keys());
    expect([...mentionedSkillNames(catalog.get('wicked-garden-repo-learn') ?? '', names, 'wicked-garden-repo-learn')].sort()).toEqual([
      'wicked-garden-mem',
      'wicked-garden-search',
    ]);
    expect([...mentionedSkillNames(catalog.get('wicked-garden-search') ?? '', names, 'wicked-garden-search')].sort()).toEqual([
      'wicked-garden-mem',
      'wicked-garden-mem-capture',
    ]);
    expect([...mentionedSkillNames(catalog.get('wicked-garden-qe') ?? '', names, 'wicked-garden-qe')]).toEqual([]);
  });

  it('closes transitively from the registered refs and reports refs no catalog skill answers to', () => {
    const { core, missing, absentMandates } = coreClosure(['wicked-garden-repo-learn', 'wicked-garden-ghost'], catalog);
    expect([...core].sort()).toEqual([
      'wicked-garden-mem',
      'wicked-garden-mem-capture',
      'wicked-garden-repo-learn',
      'wicked-garden-search',
    ]);
    expect(missing).toEqual(['wicked-garden-ghost']);
    expect(absentMandates).toEqual([]);
  });

  it('reports an ABSENT transitive mandate — a core skill naming a skill the catalog lacks — with file line', () => {
    const withPhantom = new Map(catalog);
    withPhantom.set(
      'wicked-garden-search',
      'NOT for concept search — use the wicked-garden-mem skill.\nHand structural work to wicked-garden-phantom.\nFamily glob: wicked-garden-qe-* is fine; wicked-garden:crew:implementer is a subagent type.',
    );
    const { core, absentMandates } = coreClosure(['wicked-garden-repo-learn'], withPhantom);
    expect(core.has('wicked-garden-search')).toBe(true);
    expect(absentMandates).toEqual([{ from: 'wicked-garden-search', name: 'wicked-garden-phantom', line: 2 }]);
    // A NON-core skill mentioning a phantom is not a mandate — only the closure's members mandate.
    const unrelated = new Map(catalog);
    unrelated.set('wicked-garden-qe', 'see wicked-garden-phantom');
    expect(coreClosure(['wicked-garden-repo-learn'], unrelated).absentMandates).toEqual([]);
  });
});
