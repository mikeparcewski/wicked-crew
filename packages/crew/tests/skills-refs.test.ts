// Reference extraction + portability (design v3 §4/§5) — the deterministic text scan behind the
// publish-time "every ref resolves inside the snapshot" rule and the `portable` flag.

import { describe, expect, it } from 'vitest';

import {
  extractPluginRootRefs,
  extractRelativeRefs,
  portabilityIssueOf,
  resolveRelativeRef,
} from '../src/skills/refs.js';
import { skillKindOf } from '../src/skills/frontmatter.js';

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
});

describe('skillKindOf (fork-first)', () => {
  it('context: fork wins over user-invocable; user-invocable → router; else module', () => {
    expect(skillKindOf({ context: 'fork', 'user-invocable': 'true' })).toBe('fork-worker');
    expect(skillKindOf({ 'user-invocable': 'true' })).toBe('router');
    expect(skillKindOf({ description: 'x' })).toBe('module');
  });
});
