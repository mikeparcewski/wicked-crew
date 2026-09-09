// Reference extraction + portability (design v3 §4/§5) — the deterministic text scan behind the
// publish-time "every ref resolves inside the snapshot" rule and the `portable` flag; the strict
// frontmatter subset; the qualified-name token rules the core closure reads mandates with.

import { describe, expect, it } from 'vitest';

import { mentionedTokens } from '../src/skills/core-closure.js';
import { parseFrontmatter, skillKindOf } from '../src/skills/frontmatter.js';
import {
  extractPluginRootRefs,
  extractRelativeRefs,
  portabilityIssueOf,
  resolvePluginRootRef,
  resolveRelativeRef,
} from '../src/skills/refs.js';

describe('extractPluginRootRefs', () => {
  it('finds every `${CLAUDE_PLUGIN_ROOT}/<p>` with its 1-based line, trailing punctuation stripped, the bare root as ""', () => {
    const text = [
      'intro',
      'run `${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh ${CLAUDE_PLUGIN_ROOT}/scripts/qe/lib` now',
      'see ${CLAUDE_PLUGIN_ROOT}/docs/examples/.',
      'root is ${CLAUDE_PLUGIN_ROOT} itself',
    ].join('\n');
    expect(extractPluginRootRefs(text)).toEqual([
      { line: 2, path: 'scripts/_python.sh', kind: 'plugin-root' },
      { line: 2, path: 'scripts/qe/lib', kind: 'plugin-root' },
      { line: 3, path: 'docs/examples/', kind: 'plugin-root' },
      { line: 4, path: '', kind: 'plugin-root' },
    ]);
  });

  it('never strips a dot-dot segment as punctuation — `${CLAUDE_PLUGIN_ROOT}/..` stays `..`', () => {
    expect(extractPluginRootRefs('up: ${CLAUDE_PLUGIN_ROOT}/..')).toEqual([{ line: 1, path: '..', kind: 'plugin-root' }]);
    expect(extractPluginRootRefs('up: ${CLAUDE_PLUGIN_ROOT}/../etc.')).toEqual([{ line: 1, path: '../etc', kind: 'plugin-root' }]);
    expect(extractPluginRootRefs('file: ${CLAUDE_PLUGIN_ROOT}/scripts/x.py.')).toEqual([{ line: 1, path: 'scripts/x.py', kind: 'plugin-root' }]);
  });

  it('keeps every legal filename character — a reference is never truncated into a PREFIX of the file it names (codex round 2)', () => {
    const text = 'run `${CLAUDE_PLUGIN_ROOT}/scripts/a+b@2.py` then ${CLAUDE_PLUGIN_ROOT}/scripts/x%20y=1,z.sh; and (${CLAUDE_PLUGIN_ROOT}/docs/e~f) "${CLAUDE_PLUGIN_ROOT}/q:r".';
    expect(extractPluginRootRefs(text).map((r) => r.path)).toEqual(['scripts/a+b@2.py', 'scripts/x%20y=1,z.sh', 'docs/e~f', 'q:r']);
    expect(extractRelativeRefs('see ../s+p@ce/f,g.md and [x](../a=b/c~d.md), done.').map((r) => r.path)).toEqual(['../s+p@ce/f,g.md', '../a=b/c~d.md']);
  });
});

describe('resolvePluginRootRef', () => {
  it('normalizes directory references and refuses anything that climbs out of the plugin root', () => {
    expect(resolvePluginRootRef('')).toBe('');
    expect(resolvePluginRootRef('.')).toBe('');
    expect(resolvePluginRootRef('docs/examples/')).toBe('docs/examples');
    expect(resolvePluginRootRef('schemas/.')).toBe('schemas');
    expect(resolvePluginRootRef('a/./b')).toBe('a/b');
    expect(resolvePluginRootRef('scripts/../schemas/x.json')).toBe('schemas/x.json');
    expect(resolvePluginRootRef('..')).toBeNull();
    expect(resolvePluginRootRef('../etc')).toBeNull();
    expect(resolvePluginRootRef('scripts/../../outside.md')).toBeNull();
  });
});

describe('extractRelativeRefs + resolveRelativeRef', () => {
  it('finds `../` link targets (markdown links and bare tokens), not `..` inside longer paths', () => {
    const text = 'Read [hotspots](../search/refs/hotspots.md) and ../../../docs/examples/x.yml; ignore a/../b.';
    expect(extractRelativeRefs(text)).toEqual([
      { line: 1, path: '../search/refs/hotspots.md', kind: 'relative' },
      { line: 1, path: '../../../docs/examples/x.yml', kind: 'relative' },
    ]);
  });

  it('resolves against the referencing file\'s dir inside the plugin, null when it climbs out', () => {
    expect(resolveRelativeRef('skills/repo-learn/SKILL.md', '../search/refs/hotspots.md')).toBe('skills/search/refs/hotspots.md');
    expect(resolveRelativeRef('skills/qe/refs/campaign-ci.md', '../../../docs/examples/x.yml')).toBe('docs/examples/x.yml');
    expect(resolveRelativeRef('skills/alpha/nested/SKILL.md', '../SKILL.md')).toBe('skills/alpha/SKILL.md');
    expect(resolveRelativeRef('skills/alpha/SKILL.md', '../../../etc/passwd')).toBeNull();
    expect(resolveRelativeRef('skills/alpha/SKILL.md', '../')).toBe('skills');
  });
});

describe('portabilityIssueOf', () => {
  it('names the first reason a text is Claude-only, null when portable', () => {
    expect(portabilityIssueOf('plain prose with a [link](refs/a.md)')).toBeNull();
    expect(portabilityIssueOf('run ${CLAUDE_PLUGIN_ROOT}/scripts/x.py')).toBe('plugin-root');
    expect(portabilityIssueOf('run `python3 scripts/domain/extract_loop.py`')).toBe('cwd-script');
    expect(portabilityIssueOf('run `uv run scripts/x.py`')).toBe('cwd-script');
    expect(portabilityIssueOf('see [x](../search/refs/hotspots.md)')).toBe('relative-link');
    // A path that merely CONTAINS `scripts/` after a slash is not an invocation.
    expect(portabilityIssueOf('the file lives at plugin/scripts/x.py')).toBeNull();
  });

  it('treats ANY cwd-relative script invocation as non-portable — flags between, `./`, other dirs — not only `<cmd> scripts/` (codex round 2)', () => {
    expect(portabilityIssueOf('run `python3 -u scripts/alpha/run.py`')).toBe('cwd-script');
    expect(portabilityIssueOf('run `./scripts/x` now')).toBe('cwd-script');
    expect(portabilityIssueOf('run `bash scripts/x` now')).toBe('cwd-script');
    expect(portabilityIssueOf('run `uv run --frozen scripts/x.py`')).toBe('cwd-script');
    expect(portabilityIssueOf('run `python3 tool.py`')).toBe('cwd-script');
    expect(portabilityIssueOf('run `node lib/x`')).toBe('cwd-script');
    // Not cwd-relative: absolute, `$`-expanded, home-relative, a module, an inline program, a bare word.
    expect(portabilityIssueOf('run `python3 /abs/scripts/x.py`')).toBeNull();
    expect(portabilityIssueOf('run `node ~/bin/x.js`')).toBeNull();
    expect(portabilityIssueOf('run `python3 -m pytest`')).toBeNull();
    expect(portabilityIssueOf('run `python3 -c "print(1)"`')).toBeNull();
    expect(portabilityIssueOf('run `bash -lc echo`')).toBeNull();
    expect(portabilityIssueOf('use sh to run it')).toBeNull();
  });
});

describe('parseFrontmatter — a STRICT subset', () => {
  const fm = (body: string): ReturnType<typeof parseFrontmatter> => parseFrontmatter(`---\n${body}\n---\n\nbody\n`);

  it('accepts terminated flow collections, quoted scalars and block scalars', () => {
    expect(fm('name: x\ntags: [a, b]')).toEqual({ ok: true, fields: { name: 'x', tags: '[a, b]' } });
    expect(fm('name: x\nmeta: {k: v}').ok).toBe(true);
    expect(fm('name: x\nnested: [a, [b, c]]').ok).toBe(true);
    expect(fm('name: "quoted name"')).toEqual({ ok: true, fields: { name: 'quoted name' } });
    expect(fm('description: |\n  [not a flow sequence\n  just prose').ok).toBe(true);
  });

  it('refuses unterminated flow sequences / mappings / quotes, naming the line and key', () => {
    const seq = fm('name: x\ntags: [a, b');
    expect(seq.ok).toBe(false);
    if (!seq.ok) expect(seq.reason).toMatch(/line 3: `tags`: unterminated flow sequence/);
    const map = fm('meta: {k: v');
    if (!map.ok) expect(map.reason).toContain('unterminated flow mapping');
    const quote = fm('name: "open');
    expect(quote.ok).toBe(false);
    if (!quote.ok) expect(quote.reason).toContain('unterminated quoted scalar');
    const single = fm("name: 'open");
    expect(single.ok).toBe(false);
    const unbalanced = fm('tags: [a, b]]');
    expect(unbalanced.ok).toBe(false);
    if (!unbalanced.ok) expect(unbalanced.reason).toContain('unbalanced');
  });

  it('refuses a plain scalar that YAML would read as a nested mapping or a sequence entry (codex round 2); quoted / block forms are fine', () => {
    const nested = fm('name: x\ndescription: hello: world');
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.reason).toMatch(/line 3: `description`: a plain scalar cannot contain `: `/);
    expect(fm('description: trailing:').ok).toBe(false);
    expect(fm('description: - not a list').ok).toBe(false);
    expect(fm('description: "hello: world"')).toEqual({ ok: true, fields: { description: 'hello: world' } });
    expect(fm("description: 'a: b'").ok).toBe(true);
    expect(fm('description: |\n  hello: world\n  - item').ok).toBe(true);
    expect(fm('description: a URL http://x/y is fine').ok).toBe(true); // `:` without a following space is not a mapping
  });

  it('checks an indented flow collection / quote continued on the next lines — joined, never folded unchecked (codex round 2)', () => {
    const open = fm('name: x\ntags:\n  [a, b');
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.reason).toMatch(/line 3: `tags`: unterminated flow sequence/);
    expect(fm('tags:\n  [a, b]').ok).toBe(true);
    expect(fm('tags:\n  [a,\n  b]').ok).toBe(true);
    expect(fm('tags:\n  {k: v').ok).toBe(false);
    expect(fm('quote:\n  "open').ok).toBe(false);
    // Nested mappings / lists / multi-line plain text under a key stay accepted (folded, not interpreted).
    expect(fm('meta:\n  k: v\n  j: w').ok).toBe(true);
    expect(fm('items:\n  - a\n  - b').ok).toBe(true);
    expect(fm('description:\n  first line\n  second line').ok).toBe(true);
  });
});

describe('mentionedTokens (the mandate vocabulary)', () => {
  it('reads dash and Claude colon forms with lines; ignores glob prefixes and `:`-continued subagent types', () => {
    const text = [
      'Use the **wicked-garden-search** skill; then `wicked-garden:mem` recall.',
      'Family: wicked-garden-qe-acceptance-test-* and wicked-garden-qe_',
      'Task(subagent_type="wicked-garden:crew:implementer") is not a skill; xwicked-garden-mem is glued.',
    ].join('\n');
    expect(mentionedTokens(text)).toEqual([
      { name: 'wicked-garden-search', line: 1 },
      { name: 'wicked-garden-mem', line: 1 },
    ]);
  });
});

describe('skillKindOf (fork-first)', () => {
  it('context: fork wins over user-invocable; user-invocable → router; else module', () => {
    expect(skillKindOf({ context: 'fork', 'user-invocable': 'true' })).toBe('fork-worker');
    expect(skillKindOf({ 'user-invocable': 'true' })).toBe('router');
    expect(skillKindOf({ description: 'x' })).toBe('module');
  });
});
