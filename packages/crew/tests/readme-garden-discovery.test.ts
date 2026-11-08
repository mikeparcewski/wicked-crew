// first-run-2 N7: the README's garden-discovery list names every tier crew searches, in
// plugin-source.ts's resolution order (it once listed only Claude Code's two locations).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const source = readFileSync(join(root, 'packages', 'crew', 'src', 'skills', 'plugin-source.ts'), 'utf8');

describe('README garden discovery (first-run-2 N7)', () => {
  it('lists the five tiers in the order plugin-source.ts resolves them', () => {
    const head = source.slice(0, source.indexOf('*/'));
    // The code's own order, from its doc comment: 1. explicit, 2. Claude cache, 3. installer copy, 4. npm-global, 5. Codex cache.
    expect(head).toMatch(/1\. WICKED_CREW_SKILLS_SOURCE[\s\S]*2\. Claude marketplace cache[\s\S]*3\. Claude installer copy[\s\S]*4\. npm-global[\s\S]*5\. Codex plugin cache/);
    const start = readme.indexOf('crew uses the first garden it finds');
    expect(start).toBeGreaterThan(-1);
    const list = readme.slice(start, readme.indexOf('`<config dir>` is', start));
    const at = (needle: string): number => {
      const i = list.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('1. `WICKED_CREW_SKILLS_SOURCE`'),
      at('2. Claude Code\'s plugin cache (`<config dir>/plugins/cache/wicked-garden/wicked-garden/<version>`)'),
      at('3. The installer\'s copy for Claude Code (`<config dir>/plugins/wicked-garden`)'),
      at('4. The npm-global package'),
      at('5. Codex\'s plugin cache (`<CODEX_HOME or ~/.codex>/plugins/cache/<marketplace>/wicked-garden/'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Within tier 4: the launcher on PATH, then beside crew's package. Config dirs: every one, then ~/.claude.
    expect(list.indexOf('command on PATH')).toBeLessThan(list.indexOf('beside crew'));
    expect(readme).toContain('`<config dir>` is each directory in `$CLAUDE_CONFIG_DIR`, in order, then `~/.claude`; every config dir\'s cache\nis searched before any installer copy.');
  });
});
