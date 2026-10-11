// Core-by-reference = the registered-reference closure (design v3 §5): the skill_refs of every
// workflow the daemon knows, plus each referenced skill's SKILL.md mandates, transitively.
//
// X-MIG M11: crew keeps no mirror of wicked-core's built-in workflows any more — every built-in is
// an engine preset, and production reads the built-in refs from the engine
// (`builtinPresetSkillRefs`). So the guard is pinned against the INSTALLED engine (below), and the
// vendored fixture of core's retired `workflows/*.json` and the sibling-checkout comparison are gone.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { builtinPresetSkillRefs, coreClosure, coreSkillRefs, mandateMentions, mentionedSkillNames, presetSkillRefs, registeredSkillRefs } from '../src/skills/core-closure.js';
import { parseFrontmatter } from '../src/skills/frontmatter.js';

describe('the built-in presets\' skill_refs are required too (crew#935, codex r5 on #938)', () => {
  const presets = [
    { name: 'interactive-draft', created_by: 'builtin', steps: [{ catalog: 'produce', id: 'draft', skill_ref: 'wicked-garden-draft' }] },
    { name: 'feature', created_by: 'builtin', steps: [{ catalog: 'build', id: 'build' }] },
    { name: 'mine', created_by: 'studio', steps: [{ catalog: 'produce', id: 'p', skill_ref: 'wicked-garden-user-only' }] },
  ];
  it('presetSkillRefs collects the non-empty skill_refs', () => {
    expect([...presetSkillRefs(presets)].sort()).toEqual(['wicked-garden-draft', 'wicked-garden-user-only']);
  });
  it('builtinPresetSkillRefs reads only the built-ins, and degrades to the empty set (logged)', async () => {
    const warn: string[] = [];
    expect([...(await builtinPresetSkillRefs({ presetsSupported: () => true, listPresets: async () => presets }, (m) => warn.push(m)))]).toEqual(['wicked-garden-draft']);
    expect((await builtinPresetSkillRefs({ presetsSupported: () => false, listPresets: async () => presets }, (m) => warn.push(m))).size).toBe(0);
    // A partial adapter with no preset methods at all (test doubles of createServer).
    expect((await builtinPresetSkillRefs({} as never, (m) => warn.push(m))).size).toBe(0);
    const failing = { presetsSupported: () => true, listPresets: async () => { throw new Error('engine down'); } };
    expect((await builtinPresetSkillRefs(failing, (m) => warn.push(m))).size).toBe(0);
    expect(warn.some((w) => w.includes('engine down'))).toBe(true);
  });
  it('coreSkillRefs: a preset skill the catalog holds is core; one it lacks blocks nothing', () => {
    const defs = new Set(['wicked-garden-mcp-scaffold']);
    const fromPresets = new Set(['wicked-garden-draft']);
    expect([...coreSkillRefs(defs, fromPresets, new Set(['wicked-garden-draft', 'wicked-garden-mcp-scaffold']))].sort()).toEqual([
      'wicked-garden-draft',
      'wicked-garden-mcp-scaffold',
    ]);
    expect([...coreSkillRefs(defs, fromPresets, new Set(['wicked-garden-mcp-scaffold']))]).toEqual(['wicked-garden-mcp-scaffold']);
  });
  it('the published 0.8.0 engine\'s interactive presets name wicked-garden-draft, so it stays core (cannot be disabled)', async () => {
    const { CoreAdapter } = await import('../src/core/adapter.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const a = new CoreAdapter({ dbPath: join(mkdtempSync(join(tmpdir(), 'crew935-')), 'core.db'), stub: true });
    try {
      const refs = await builtinPresetSkillRefs(a, () => {});
      expect(refs.has('wicked-garden-draft')).toBe(true);
    } finally {
      a.close();
    }
  });
});

describe('registeredSkillRefs', () => {
  it('collects the non-null skill_refs of the workflows crew serves (capture-learnings, domain-extraction, qe-author-tests, mcp-server)', () => {
    const refs = registeredSkillRefs(BUILTIN_WORKFLOWS);
    expect([...refs].sort()).toEqual([
      'wicked-garden-domain',
      'wicked-garden-domain-coverage',
      'wicked-garden-domain-extractor',
      // The mcp-server drop-in (DES-mcp-server-workflow): scaffold, then the three reviewers.
      'wicked-garden-mcp-scaffold',
      'wicked-garden-platform-security-engineer',
      // Wave 6: the governed test-authoring workflow routes recon/author/review through the QE skill.
      'wicked-garden-qe',
      'wicked-garden-qe-contract-testing-engineer',
      'wicked-garden-qe-observability-test-engineer',
      'wicked-garden-repo-learn',
    ]);
  });

  it('the ENGINE\'s built-in presets name every skill crew must keep core — the set production reads (X-MIG M11: no crew mirror, no vendored copy of core\'s retired workflows/)', async () => {
    const { CoreAdapter } = await import('../src/core/adapter.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const a = new CoreAdapter({ dbPath: join(mkdtempSync(join(tmpdir(), 'crew-m11-refs-')), 'core.db'), stub: true });
    try {
      const engineRefs = await builtinPresetSkillRefs(a, () => {});
      // Pinned against the installed core-ts: a release that drops one of these is a loud diff.
      for (const ref of [
        'wicked-garden-domain',
        'wicked-garden-domain-coverage',
        'wicked-garden-domain-extractor',
        'wicked-garden-draft',
        'wicked-garden-mcp-scaffold',
        'wicked-garden-platform-security-engineer',
        'wicked-garden-qe',
        'wicked-garden-qe-contract-testing-engineer',
        'wicked-garden-qe-observability-test-engineer',
        'wicked-garden-repo-learn',
      ]) {
        expect(engineRefs.has(ref), `the installed engine's built-in presets do not name ${ref}`).toBe(true);
      }
    } finally {
      a.close();
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
