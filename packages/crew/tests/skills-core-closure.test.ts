// Core-by-reference = the registered-reference closure (design v3 §5): the skill_refs of every
// workflow the daemon knows, plus each referenced skill's SKILL.md mandates, transitively. Pinned
// against the workflows crew ships AND against wicked-core's own drop-ins TWICE (codex round 6 on
// #480): ALWAYS against the vendored contract `tests/fixtures/core-workflow-skill-refs.json` — the
// skill_refs of wicked-core's `workflows/*.json` at the core-ts version crew pins — and, as the
// local extra, against a sibling checkout when one is available (the same sibling-checkout policy
// as builtin-overlay-shadow.test.ts). The runtime source of the closure stays
// `adapter.listWorkflows()`: the engine has NO separate catalog at runtime (core's JSON files are
// drop-ins; core-ts exposes only `registerWorkflow`; crew registers the built-ins and reads the
// overlay dir), so the daemon's registry IS the canonical set of workflows it can launch — what
// this suite guards is that the registry never drifts from core's shipped set.
//
// Regenerate the fixture with every core-ts bump (from a wicked-core checkout at that version):
//   node -e 'const fs=require("node:fs");const [d,v]=process.argv.slice(1);const refs=new Set();
//     for(const f of fs.readdirSync(d).filter(f=>f.endsWith(".json")))for(const p of JSON.parse(fs.readFileSync(`${d}/${f}`,"utf8")).phases??[])
//       if(typeof p.skill_ref==="string"&&p.skill_ref)refs.add(p.skill_ref);
//     console.log(JSON.stringify({"wicked-core-ts":v,refs:[...refs].sort()},null,2))' <wicked-core>/workflows <version> \
//     > tests/fixtures/core-workflow-skill-refs.json

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { coreClosure, mandateMentions, mentionedSkillNames, registeredSkillRefs } from '../src/skills/core-closure.js';
import { parseFrontmatter } from '../src/skills/frontmatter.js';
import { CORE_DIR, SKIP_CORE_CHECKS, coreDirMissingMessage } from './support/core-checkout.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The vendored contract: wicked-core's `workflows/*.json` skill_refs at the pinned core-ts version. */
const FIXTURE = join(HERE, 'fixtures', 'core-workflow-skill-refs.json');

interface CoreSkillRefsFixture {
  'wicked-core-ts': string;
  refs: string[];
}

const readFixture = (): CoreSkillRefsFixture => JSON.parse(readFileSync(FIXTURE, 'utf8')) as CoreSkillRefsFixture;

/** The `wicked-core-ts` version `packages/crew/package.json` pins, range prefix stripped (`^0.7.16` → `0.7.16`). */
const pinnedCoreTs = (): string => {
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  return (pkg.dependencies['wicked-core-ts'] ?? '').replace(/^[\^~=]/, '');
};

describe('registeredSkillRefs', () => {
  it('collects the non-null skill_refs of the workflows crew serves (capture-learnings, domain-extraction, qe-author-tests)', () => {
    const refs = registeredSkillRefs(BUILTIN_WORKFLOWS);
    expect([...refs].sort()).toEqual([
      'wicked-garden-domain',
      'wicked-garden-domain-coverage',
      'wicked-garden-domain-extractor',
      // Wave 6: the governed test-authoring workflow routes recon/author/review through the QE skill.
      'wicked-garden-qe',
      'wicked-garden-repo-learn',
    ]);
  });

  it('ALWAYS: the vendored core-workflow skill_refs fixture is at the pinned wicked-core-ts version, sorted, and every ref it names is registered in BUILTIN_WORKFLOWS (codex round 6 — no sibling checkout needed)', () => {
    const fixture = readFixture();
    const pinned = pinnedCoreTs();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+/);
    expect(
      fixture['wicked-core-ts'],
      `tests/fixtures/core-workflow-skill-refs.json was generated against wicked-core-ts ${fixture['wicked-core-ts']} but packages/crew/package.json pins ${pinned} — refresh the fixture with the core-ts bump (regeneration recipe at the top of this file)`,
    ).toBe(pinned);
    expect(fixture.refs.length).toBeGreaterThan(0);
    expect(fixture.refs).toEqual([...new Set(fixture.refs)].sort()); // sorted and unique, so a regeneration diff is reviewable
    const crewRefs = registeredSkillRefs(BUILTIN_WORKFLOWS);
    for (const ref of fixture.refs) {
      expect(crewRefs.has(ref), `wicked-core ${pinned} names ${ref} as a skill_ref but crew's BUILTIN_WORKFLOWS do not — the core closure would miss it`).toBe(true);
    }
  });

  it.skipIf(SKIP_CORE_CHECKS)('local extra: covers every skill_ref in a sibling wicked-core checkout\'s workflows/*.json, and agrees with the vendored fixture when the checkout is at the pinned version', () => {
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
    // The vendored fixture IS this catalog at the pinned version: a checkout at that version must agree exactly.
    const siblingVersion = (JSON.parse(readFileSync(join(CORE_DIR, 'crates', 'wicked-core-ts', 'package.json'), 'utf8')) as { version: string }).version;
    const fixture = readFixture();
    if (siblingVersion === fixture['wicked-core-ts']) {
      expect([...coreRefs].sort(), `the sibling checkout is at core-ts ${siblingVersion} (the pinned version) but its workflows name different skill_refs than the vendored fixture — regenerate the fixture`).toEqual(fixture.refs);
    }
  });
});

/** A prose-only catalog (no frontmatter): every mention is body text. Shared by the closure suites below. */
const catalog = new Map<string, string>([
  ['wicked-garden-repo-learn', 'Use the **wicked-garden-search** skill; then `wicked-garden-mem` recall. Not wicked-garden-repo-learn itself.'],
  ['wicked-garden-search', 'NOT for concept search — use the wicked-garden-mem skill. Claude form: wicked-garden:mem-capture.'],
  ['wicked-garden-mem', 'standalone'],
  ['wicked-garden-mem-capture', 'standalone'],
  ['wicked-garden-qe', 'unrelated; mentions xwicked-garden-mem which is not a token'],
]);

describe('mentionedSkillNames + coreClosure', () => {
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

describe('declared mandates come from the PARSED YAML, never a raw-text regex (codex round 4)', () => {
  // The codex probe: the parser decodes the escape to `wicked-garden-gamma`; the raw text never spells it.
  const escaped = '---\nname: wicked-garden-search\nmandates: ["wicked-garden-\\u0067amma"]\n---\n\nbody without any mention\n';

  it('parseFrontmatter hands the decoded mandates out structurally, with the entry line and the Claude colon form normalized', () => {
    const parsed = parseFrontmatter(escaped);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.mandates).toEqual([{ name: 'wicked-garden-gamma', line: 3 }]);
    const block = parseFrontmatter('---\nname: x\nmandates:\n  - wicked-garden:mem\n  - "wicked-garden-search"\n---\n');
    if (!block.ok) throw new Error(block.reason);
    expect(block.mandates).toEqual([
      { name: 'wicked-garden-mem', line: 4 },
      { name: 'wicked-garden-search', line: 5 },
    ]);
    // Strict subset: entries must be non-empty strings.
    expect(parseFrontmatter('---\nmandates: [123]\n---\n')).toMatchObject({ ok: false, reason: expect.stringContaining('non-empty strings') });
    expect(parseFrontmatter('---\nmandates: [""]\n---\n')).toMatchObject({ ok: false });
    expect(parseFrontmatter('---\nmandates: [{a: b}]\n---\n')).toMatchObject({ ok: false });
    expect(parseFrontmatter('---\nmandates: {a: b}\n---\n')).toMatchObject({ ok: false, reason: expect.stringContaining('YAML list') });
  });

  it('the closure REQUIRES an escaped declared mandate — present ⇒ core; absent ⇒ reported at its frontmatter line', () => {
    const withGamma = new Map(catalog);
    withGamma.set('wicked-garden-search', escaped);
    withGamma.set('wicked-garden-gamma', 'standalone');
    const present = coreClosure(['wicked-garden-repo-learn'], withGamma);
    expect(present.core.has('wicked-garden-gamma')).toBe(true);
    expect(present.absentMandates).toEqual([]);
    const without = new Map(catalog);
    without.set('wicked-garden-search', escaped);
    const absent = coreClosure(['wicked-garden-repo-learn'], without);
    expect(absent.core.has('wicked-garden-gamma')).toBe(false);
    expect(absent.absentMandates).toEqual([{ from: 'wicked-garden-search', name: 'wicked-garden-gamma', line: 3 }]);
    // mandateMentions lists the declared entries first, then the body's prose mentions, each with its line.
    expect(mandateMentions('---\nname: a\nmandates: [wicked-garden-mem]\n---\n\nUse wicked-garden-search.\n')).toEqual([
      { name: 'wicked-garden-mem', line: 3 },
      { name: 'wicked-garden-search', line: 6 },
    ]);
  });

  it('the frontmatter block is never regex-scanned: a scalar naming a skill (a description) is not a mandate; the body still is prose', () => {
    const text = '---\nname: wicked-garden-search\ndescription: NOT for concept search — use the wicked-garden-phantom skill\n---\n\nHand off to wicked-garden-mem.\n';
    expect(mandateMentions(text)).toEqual([{ name: 'wicked-garden-mem', line: 6 }]);
    const withDesc = new Map(catalog);
    withDesc.set('wicked-garden-search', text);
    const { core, absentMandates } = coreClosure(['wicked-garden-repo-learn'], withDesc);
    expect(core.has('wicked-garden-mem')).toBe(true);
    expect(absentMandates).toEqual([]);
  });
});
