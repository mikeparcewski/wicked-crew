// Reference extraction + portability (design v3 §4/§5; F-079 per-reason validator) — the
// deterministic text scan behind the publish-time "every ref resolves inside the snapshot" rule and
// the `portable` flag with its `portability.reasons`; the parity fixture wicked-garden vendors; the
// strict frontmatter subset; the qualified-name token rules the core closure reads mandates with.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { owningSkillDir } from '../src/skills/bundle.js';
import { mentionedTokens } from '../src/skills/core-closure.js';
import { parseFrontmatter, skillKindOf } from '../src/skills/frontmatter.js';
import {
  canonicalJson,
  existsIn,
  extractPluginRootRefs,
  extractRelativeRefs,
  PORTABILITY_EVIDENCE_CAP,
  PORTABILITY_REASONS,
  PORTABILITY_RULES,
  PORTABILITY_RULES_IDENTITY,
  PORTABILITY_RULES_SHA256,
  PORTABILITY_RULES_VERSION,
  portabilityEvidenceOf,
  portabilityIssuesOf,
  portabilityReasonsOf,
  resolvePluginRootRef,
  resolveRelativeRef,
  type PortabilityContext,
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

// ── The portability validator (F-079) ──────────────────────────────────────────────────────────

/**
 * The committed parity fixture — the CANONICAL artifact garden vendors verbatim
 * (`tests/portability_rules.json` there): every normative member equals `PORTABILITY_RULES`, a
 * sha256 over them detects drift, and `cases[]` is what BOTH lints must derive.
 */
interface FixtureCase {
  name: string;
  kind: string;
  file: string;
  skill_dir: string;
  text: string;
  exists?: string[];
  expected: string[];
  first_line?: Record<string, number>;
}
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/portability_rules.json', import.meta.url), 'utf8')) as Record<string, unknown> & {
  version: number;
  sha256_covers: string[];
  sha256_of_rules: string;
  bundle: { files: string[]; skill_dirs: string[] };
  cases: FixtureCase[];
};
const skillDirsOfFiles = (files: readonly string[]): Set<string> => new Set(files.filter((f) => f.startsWith('skills/') && f.endsWith('/SKILL.md')).map((f) => f.slice(0, -'/SKILL.md'.length)));
/** A context over the fixture bundle (or a case's own `exists`) for the file at `fileRel`. */
const ctxOver = (fileRel: string, files: readonly string[], skillDir?: string): PortabilityContext => {
  const set = new Set(files);
  const dirs = skillDirsOfFiles(files);
  const own = skillDir ?? owningSkillDir(fileRel, dirs) ?? fileRel.split('/').slice(0, 2).join('/');
  dirs.add(own);
  return { fileRel, skillDir: own, skillDirs: dirs, exists: (p) => existsIn(set, p) };
};
const ctxFor = (fileRel: string): PortabilityContext => ctxOver(fileRel, FIXTURE.bundle.files);
const BUNDLE = new Set(FIXTURE.bundle.files);
const reasons = (text: string, fileRel = 'skills/qe/SKILL.md'): string[] => portabilityReasonsOf(portabilityIssuesOf(text, ctxFor(fileRel)));
const hits = (text: string, fileRel = 'skills/qe/SKILL.md'): Array<[string, number]> => portabilityIssuesOf(text, ctxFor(fileRel)).map((h) => [h.reason, h.line]);

describe('portabilityIssuesOf — every reason, with lines (F-079)', () => {
  it('reports ALL reasons of a text, one hit per occurrence with its 1-based line; the reason set is sorted and unique', () => {
    const text = ['Run `python3 scripts/x.py`.', 'Read ${CLAUDE_PLUGIN_ROOT}/skills/qe/refs/plan.md and ${CLAUDE_PLUGIN_ROOT}/scripts/x.py.', 'See ../../docs/examples/campaign.yml.', 'ls ${CLAUDE_SKILL_DIR}'].join('\n');
    expect(hits(text)).toEqual([
      ['cwd-script', 1],
      ['plugin-root', 2],
      ['plugin-root', 2],
      ['relative-link', 3],
      ['skill-dir-var', 4],
    ]);
    expect(reasons(text)).toEqual(['cwd-script', 'plugin-root', 'relative-link', 'skill-dir-var']);
    expect(reasons('plain prose with a [link](refs/a.md)')).toEqual([]);
  });

  it('plugin-root: the marker anywhere — self refs, shared scripts, the bare root, inside a non-shell fence too; the hit carries the reference', () => {
    expect(reasons('Read("${CLAUDE_PLUGIN_ROOT}/skills/qe/refs/plan.md")')).toEqual(['plugin-root']);
    expect(reasons('sh "${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh" "${CLAUDE_PLUGIN_ROOT}/scripts/qe/campaign_dispatch.py" <name>')).toEqual(['plugin-root']);
    expect(reasons('root is ${CLAUDE_PLUGIN_ROOT} itself')).toEqual(['plugin-root']);
    expect(hits('```ts\nconst p = `${CLAUDE_PLUGIN_ROOT}/scripts/x.py`;\n```')).toEqual([['plugin-root', 2]]);
    expect(portabilityIssuesOf('see ${CLAUDE_PLUGIN_ROOT}/scripts/x.py.', ctxFor('skills/qe/SKILL.md'))[0]?.evidence).toBe('${CLAUDE_PLUGIN_ROOT}/scripts/x.py');
  });

  it('skill-dir-var: `${CLAUDE_SKILL_DIR}` is a Claude-only substitution', () => {
    expect(hits('ls ${CLAUDE_SKILL_DIR}/refs')).toEqual([['skill-dir-var', 1]]);
  });

  it('cwd-script: an interpreter + a relative path that EXISTS at the plugin root — flags between, `./`, value-taking options, other root dirs', () => {
    for (const t of [
      'Run `python3 scripts/domain/extract_loop.py --db x`',
      '`node scripts/qe/lib/x.mjs`',
      '`uv run --frozen scripts/x.py`',
      '`python3 -W ignore scripts/foo.py`',
      '`python3 -X dev -u -W error::DeprecationWarning scripts/alpha/run.py`',
      '`bash ./scripts/_python.sh`',
      '`node lib/x.mjs`',
      '`python3 -u scripts/alpha/run.py`',
      '`node --import ./register.mjs --require=foo lib/x.mjs`',
      '`python3 -Wignore scripts/foo.py`',
    ]) {
      expect(reasons(t, 'skills/domain/SKILL.md'), t).toEqual(['cwd-script']);
    }
    // The hit's evidence is the invocation as written.
    expect(portabilityIssuesOf('run `python3 -u scripts/alpha/run.py` now', ctxFor('skills/domain/SKILL.md'))[0]?.evidence).toBe('python3 -u scripts/alpha/run.py');
  });

  it('cwd-script: an interpreter written as a PATH counts too (review of #532, F-4) — absolute, venv, `./node_modules/.bin`, `~/bin`; the script must still be a root-relative plugin file', () => {
    for (const t of ['`/usr/bin/python3 scripts/x.py`', '`.venv/bin/python scripts/x.py`', '`./node_modules/.bin/tsx scripts/x.ts`', '`~/bin/node lib/x.mjs`', '`../tools/bash scripts/_python.sh`']) {
      expect(reasons(t, 'skills/domain/SKILL.md'), t).toEqual(['cwd-script']);
    }
    expect(reasons('`/usr/bin/python3 /abs/x.py`', 'skills/domain/SKILL.md')).toEqual([]);
    expect(reasons('`/usr/bin/python3 -m pytest`', 'skills/domain/SKILL.md')).toEqual([]);
    expect(portabilityIssuesOf('`/usr/bin/python3 scripts/x.py`', ctxFor('skills/domain/SKILL.md'))[0]?.evidence).toBe('/usr/bin/python3 scripts/x.py');
  });

  it('cwd-script is NOT: a target that exists nowhere in the bundle (the §3 false positives), absolute / `~` / `$` paths, a module or inline program, a value-taking option with no path after it, a bare `./seg` without an interpreter', () => {
    for (const t of [
      'Run `go test ./...` before pushing.',
      'Deploy with `aws s3 sync ./dist s3://bucket/site`.',
      'Audit with `npx @axe-core/cli http://localhost:3000`.',
      "```ts\nimport schema from './schemas/evidence.json';\n```",
      'See [CHANGELOG.md](./CHANGELOG.md).',
      'Render with `--output ./out.png`.',
      'Run `python3 tests/test_conformance.py`.',
      'Example: `uv run python script.py`',
      '`python3 -m pytest tests/test_x.py`',
      '`python3 /abs/scripts/x.py`',
      '`node ~/bin/x.js`',
      '`python3 -m pytest`',
      '`python3 -c "print(1)"`',
      '`bash -lc echo`',
      '`python3 -W scripts/foo.py`', // `scripts/foo.py` IS the -W argument
      '`node --require foo`',
      'the file lives at plugin/scripts/x.py',
      'run `./scripts/x` now',
      'use sh to run it',
      '`node -e "require(\'./lib/x.js\')"`',
    ]) {
      expect(reasons(t, 'skills/engineering/architecture/SKILL.md'), t).toEqual([]);
    }
  });

  it('cwd-script: a relative script that exists only INSIDE the skill\'s own directory is the base-directory idiom — portable; one that also exists at the root is ambiguous — flagged', () => {
    expect(reasons('Run `python3 scripts/local.py diagnose` from this skill\'s base directory.')).toEqual([]);
    // Both `skills/qe/scripts/x.py` (own) and `scripts/x.py` (root) would exist here: the worktree reading is possible.
    const ctx = ctxOver('skills/qe/SKILL.md', [...BUNDLE, 'skills/qe/scripts/x.py']);
    expect(portabilityReasonsOf(portabilityIssuesOf('`python3 scripts/x.py`', ctx))).toEqual(['cwd-script']);
  });

  it('cwd-script: the launcher forms are portable — `wicked-garden run|python|path`, `$(…)`, `npx wicked-garden@12 …`, `cd "$WICKED_GARDEN_ROOT" && …`; `cd "${CLAUDE_PLUGIN_ROOT}" && uv run python scripts/x` is both reasons', () => {
    expect(reasons('Run `wicked-garden run scripts/qe/campaign_dispatch.py <name>` first.')).toEqual([]);
    expect(reasons('WT_LIB="$(wicked-garden path scripts/qe/lib)"')).toEqual([]);
    expect(reasons('`wicked-garden python scripts/x.py --check`')).toEqual([]);
    expect(reasons('`npx wicked-garden@12 run scripts/qe/lib/x.mjs --help`')).toEqual([]);
    expect(reasons('cd "$WICKED_GARDEN_ROOT" && wicked-garden run scripts/_run.py --help')).toEqual([]);
    expect(reasons('cd "${CLAUDE_PLUGIN_ROOT}" && uv run python scripts/_run.py --help', 'skills/domain/SKILL.md')).toEqual(['cwd-script', 'plugin-root']);
    // …and masking the launcher does not hide a SECOND, genuine invocation on the same line.
    expect(reasons('`wicked-garden run scripts/x.py` or `python3 scripts/x.py`', 'skills/domain/SKILL.md')).toEqual(['cwd-script']);
  });

  it('cwd-script ignores fenced code whose language is not a shell (ts, js, python, yaml, json …) and scans sh/bash/zsh/shell/console/text and bare fences; an unclosed fence runs to EOF; the language compares case-insensitively', () => {
    expect(reasons('```ts\nnode scripts/qe/lib/x.mjs\n```', 'skills/domain/SKILL.md')).toEqual([]);
    expect(reasons('~~~python\npython3 scripts/x.py\n~~~', 'skills/domain/SKILL.md')).toEqual([]);
    expect(reasons('```js\nnode scripts/qe/lib/x.mjs', 'skills/domain/SKILL.md')).toEqual([]);
    expect(reasons('```yaml\nrun: python3 scripts/x.py\n```', 'skills/domain/SKILL.md')).toEqual([]);
    expect(reasons('```json\n{"cmd": "python3 scripts/x.py"}\n```', 'skills/domain/SKILL.md')).toEqual([]);
    expect(hits('```bash\nnode scripts/qe/lib/x.mjs\n```', 'skills/domain/SKILL.md')).toEqual([['cwd-script', 2]]);
    expect(hits('```Bash\nnode scripts/qe/lib/x.mjs\n```', 'skills/domain/SKILL.md')).toEqual([['cwd-script', 2]]);
    expect(reasons('```\npython3 scripts/x.py\n```', 'skills/domain/SKILL.md')).toEqual(['cwd-script']);
    expect(reasons('```console\n$ python3 -u scripts/alpha/run.py\n```', 'skills/domain/SKILL.md')).toEqual(['cwd-script']);
    expect(reasons('```sh title=run.sh\nnode lib/x.mjs\n```', 'skills/domain/SKILL.md')).toEqual(['cwd-script']);
    // CommonMark: a closing fence is at least as long as the opening one — a SHORTER run inside a
    // four-backtick ts fence does not close it (scanning stays off); a longer run does.
    expect(reasons('````ts\n```\nnode lib/x.mjs\n````', 'skills/domain/SKILL.md')).toEqual([]);
    expect(hits('```ts\n````\nnode lib/x.mjs\n```', 'skills/domain/SKILL.md')).toEqual([['cwd-script', 3]]);
    // A run followed by text is content, not a closer.
    expect(reasons('```ts\n``` not a closer\nnode lib/x.mjs\n```', 'skills/domain/SKILL.md')).toEqual([]);
    // After the fence closes, scanning resumes.
    expect(hits('```ts\nx\n```\nnode lib/x.mjs', 'skills/domain/SKILL.md')).toEqual([['cwd-script', 4]]);
  });

  it('a ONE-LINE ```` ```lang … ``` ```` span is a code span, not a fence opener (review of #532, F-2): the rest of the file is still scanned; a tilde one-liner has no such rule', () => {
    expect(hits('```ts const x = 1 ```\nnode scripts/qe/lib/x.mjs', 'skills/domain/SKILL.md')).toEqual([['cwd-script', 2]]);
    expect(hits('Inline ```js require("x")``` in prose.\n`python3 scripts/x.py`', 'skills/domain/SKILL.md')).toEqual([['cwd-script', 2]]);
    // The opener line itself is scanned when it is a span: an invocation on it counts.
    expect(hits('```sh python3 scripts/x.py ```', 'skills/domain/SKILL.md')).toEqual([['cwd-script', 1]]);
    // A genuine opener with an info string but no second backtick still opens.
    expect(reasons('```ts title="x"\nnode lib/x.mjs\n```', 'skills/domain/SKILL.md')).toEqual([]);
  });

  it('relative-link: a `../` whose resolved target EXISTS in the bundle and lies outside the skill\'s own tree; an unresolvable or escaping one is not a link the flat layout could break', () => {
    expect(hits('Template: [campaign](../../docs/examples/campaign.yml)')).toEqual([['relative-link', 1]]);
    expect(reasons('Template:\n\n```yaml\nrequirements: ../requirements.md\n```', 'skills/engineering/architecture/SKILL.md')).toEqual([]);
    expect(reasons('see ../../../../etc/passwd')).toEqual([]);
    // Inside the skill's own directory the link survives every layout.
    expect(reasons('Back to [the skill](../SKILL.md) and [review](../refs/review.md).', 'skills/qe/refs/plan.md')).toEqual([]);
    // A directory target counts as existing.
    expect(reasons('see ../../docs/examples/')).toEqual(['relative-link']);
  });

  it('cross-skill-path: a plugin-root or `../` target that lands in ANOTHER skill\'s dir — a nested module\'s parent included — reported beside the carrying reason', () => {
    expect(reasons('See ../search/refs/hotspots.md for ranking.', 'skills/domain/SKILL.md')).toEqual(['cross-skill-path', 'relative-link']);
    expect(reasons('Read `${CLAUDE_PLUGIN_ROOT}/skills/domain/refs/x.md`.')).toEqual(['cross-skill-path', 'plugin-root']);
    expect(reasons('Follow the parent contract in [search](../SKILL.md).', 'skills/search/codebase-narrator/SKILL.md')).toEqual(['cross-skill-path', 'relative-link']);
    expect(reasons('See [narrator](../codebase-narrator/SKILL.md).', 'skills/search/refs/hotspots.md')).toEqual(['cross-skill-path', 'relative-link']);
    // A plugin-root ref into the skill's OWN dir, or into a shared dir, is plugin-root alone.
    expect(reasons('Read("${CLAUDE_PLUGIN_ROOT}/skills/qe/refs/plan.md")')).toEqual(['plugin-root']);
    expect(reasons('${CLAUDE_PLUGIN_ROOT}/schemas/evidence.json')).toEqual(['plugin-root']);
    // A cross-skill path to a file the bundle does not carry is not a path the layout breaks (the ref itself still is).
    expect(reasons('${CLAUDE_PLUGIN_ROOT}/skills/domain/refs/missing.md')).toEqual(['plugin-root']);
    expect(reasons('../domain/refs/missing.md')).toEqual([]);
  });

  it('requires-harness:claude: declared in the skill-root SKILL.md frontmatter under `metadata`, value `claude` (trimmed, case-insensitive); a nested skill\'s own SKILL.md is its root; anything else is nothing', () => {
    const declared = '---\nname: wicked-garden-qe\nmetadata:\n  requires-harness: claude\n---\n\n# qe\n';
    expect(hits(declared)).toEqual([['requires-harness:claude', 4]]);
    expect(portabilityIssuesOf(declared, ctxFor('skills/qe/SKILL.md'))[0]?.evidence).toBe('metadata.requires-harness: claude');
    expect(reasons('---\nname: wicked-garden-qe\nmetadata:\n  requires-harness: Claude \n---\n')).toEqual(['requires-harness:claude']);
    expect(reasons(declared.replace('wicked-garden-qe', 'wicked-garden-search-codebase-narrator'), 'skills/search/codebase-narrator/SKILL.md')).toEqual(['requires-harness:claude']);
    expect(reasons('---\nname: wicked-garden-qe\nmetadata:\n  requires-harness: codex\n---\n')).toEqual([]);
    expect(reasons('---\nname: wicked-garden-qe\nrequires-harness: claude\n---\n')).toEqual([]); // not under metadata
    expect(reasons('---\nname: wicked-garden-qe\nmetadata: claude\n---\n')).toEqual([]); // not a mapping
    expect(reasons(declared, 'skills/qe/refs/plan.md')).toEqual([]); // only the skill-root SKILL.md declares it
    expect(reasons('metadata:\n  requires-harness: claude\n')).toEqual([]); // no frontmatter fence — prose
  });

  it('portabilityEvidenceOf: `file:line` anchors sorted by file then line, unique, capped at five', () => {
    const hs = [
      { reason: 'plugin-root' as const, line: 9, evidence: '', fileRel: 'skills/qe/refs/b.md' },
      { reason: 'plugin-root' as const, line: 2, evidence: '', fileRel: 'skills/qe/refs/b.md' },
      { reason: 'cwd-script' as const, line: 2, evidence: '', fileRel: 'skills/qe/refs/b.md' },
      { reason: 'relative-link' as const, line: 40, evidence: '', fileRel: 'skills/qe/SKILL.md' },
      { reason: 'relative-link' as const, line: 3, evidence: '', fileRel: 'skills/qe/SKILL.md' },
      { reason: 'skill-dir-var' as const, line: 1, evidence: '', fileRel: 'skills/qe/refs/c.md' },
      { reason: 'skill-dir-var' as const, line: 7, evidence: '', fileRel: 'skills/qe/refs/c.md' },
    ];
    expect(portabilityEvidenceOf(hs)).toEqual(['skills/qe/SKILL.md:3', 'skills/qe/SKILL.md:40', 'skills/qe/refs/b.md:2', 'skills/qe/refs/b.md:9', 'skills/qe/refs/c.md:1']);
    expect(PORTABILITY_EVIDENCE_CAP).toBe(5);
    expect([...PORTABILITY_REASONS].sort()).toEqual(['cross-skill-path', 'cwd-script', 'plugin-root', 'relative-link', 'requires-harness:claude', 'skill-dir-var']);
  });
});

describe('the CANONICAL parity fixture (tests/fixtures/portability_rules.json) — what garden vendors verbatim', () => {
  it('every normative member equals the live rule table, the covered set is exactly PORTABILITY_RULES, and sha256_of_rules re-derives — a drift between the two lints fails here, not at publish', () => {
    // Regenerate when a rule changes (then re-vendor in garden): dump PORTABILITY_RULES with
    //   npx tsx -e "import {PORTABILITY_RULES} from './src/skills/refs.ts'; process.stdout.write(JSON.stringify(PORTABILITY_RULES))"
    // and rebuild the fixture from it (the sha256 below is over the canonical JSON of the covered members).
    expect(FIXTURE.version).toBe(2);
    expect([...FIXTURE.sha256_covers].sort()).toEqual(Object.keys(PORTABILITY_RULES).sort());
    const normative: Record<string, unknown> = {};
    for (const k of FIXTURE.sha256_covers) normative[k] = FIXTURE[k];
    expect(normative).toEqual(JSON.parse(JSON.stringify(PORTABILITY_RULES)));
    expect(createHash('sha256').update(canonicalJson(normative), 'utf8').digest('hex')).toBe(FIXTURE.sha256_of_rules);
    expect(FIXTURE.sha256_of_rules).toMatch(/^[0-9a-f]{64}$/);
    // The identity the RUNTIME records in every snapshot.json (F-083) IS this fixture's: the version
    // by hand, the digest from the live table — so the daemon never reads a test fixture, and a rule
    // change that forgets to regenerate the fixture (or bump its version) fails here.
    expect(PORTABILITY_RULES_VERSION).toBe(FIXTURE.version);
    expect(PORTABILITY_RULES_SHA256).toBe(FIXTURE.sha256_of_rules);
    expect(PORTABILITY_RULES_IDENTITY).toEqual({ version: FIXTURE.version, sha256: FIXTURE.sha256_of_rules });
  });

  it('every regex source (the named table, each rule\'s list, the fence opener, the interpreter prefix) is a valid pattern under the constraints Python\'s `re` shares — fixed-width lookbehinds only, no named groups, no \\h', () => {
    const sources: Array<[string, string]> = [
      ...Object.entries(PORTABILITY_RULES.regex),
      ...PORTABILITY_RULES.rules.flatMap((r) => r.regex.map((src, i): [string, string] => [`${r.token}[${i}]`, src])),
      ['fences.open', PORTABILITY_RULES.fences.open],
      ['interpreter_path_prefix', PORTABILITY_RULES.interpreter_path_prefix.regex],
    ];
    for (const [name, source] of sources) {
      expect(() => new RegExp(source), name).not.toThrow();
      for (const m of source.matchAll(/\(\?<[=!]([^)]*)\)/g)) {
        expect(m[1], `${name}: lookbehind ${m[0]} must be fixed-width`).toMatch(/^(\[[^\]]+\]|\\?.)$/);
      }
      expect(source, `${name}: no named groups`).not.toMatch(/\(\?<[A-Za-z]/);
      expect(source, `${name}: no \\h`).not.toMatch(/\\h/);
    }
    // The rule entries name the same sources the table holds — no third spelling.
    const table = new Set(Object.values(PORTABILITY_RULES.regex));
    for (const r of PORTABILITY_RULES.rules) for (const src of r.regex) expect(table.has(src), `${r.token} uses a regex not in the table`).toBe(true);
    expect(PORTABILITY_RULES.fences.open).toBe(PORTABILITY_RULES.regex.fence_line);
    expect(PORTABILITY_RULES.rules.map((r) => r.token)).toEqual([...PORTABILITY_REASONS]);
  });

  it('every case derives EXACTLY its expected reasons (and first lines) through refs.ts — the contract both lints must meet', () => {
    expect(FIXTURE.cases.length).toBeGreaterThan(80);
    expect(new Set(FIXTURE.cases.map((c) => c.name)).size).toBe(FIXTURE.cases.length);
    for (const c of FIXTURE.cases) {
      const got = portabilityIssuesOf(c.text, ctxOver(c.file, c.exists ?? FIXTURE.bundle.files, c.skill_dir));
      expect(portabilityReasonsOf(got), c.name).toEqual(c.expected);
      expect([...c.expected], `${c.name}: expected is sorted+unique`).toEqual([...new Set(c.expected)].sort());
      for (const [reason, line] of Object.entries(c.first_line ?? {})) {
        expect(got.find((h) => h.reason === reason)?.line, `${c.name}: first line of ${reason}`).toBe(line);
      }
    }
    // The coordinator's required categories are all present.
    const kinds = new Set(FIXTURE.cases.map((c) => c.kind));
    for (const k of ['false-positive', 'launcher', 'base-dir', 'fence', 'path-prefix', 'plugin-root', 'skill-dir-var', 'cwd-script', 'relative-link', 'cross-skill-path', 'requires-harness', 'mixed']) expect(kinds.has(k), k).toBe(true);
  });
});

describe('parseFrontmatter — a real YAML grammar with a strict subset (codex round 3)', () => {
  const fm = (body: string): ReturnType<typeof parseFrontmatter> => parseFrontmatter(`---\n${body}\n---\n\nbody\n`);
  const reasonOf = (r: ReturnType<typeof parseFrontmatter>): string => (r.ok ? '' : r.reason);

  it('accepts well-formed YAML and flattens the top-level scalars the store reads', () => {
    const parsed = fm('name: x\ncontext: fork\nuser-invocable: true');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.fields).toMatchObject({ name: 'x', context: 'fork', 'user-invocable': 'true' });
    expect(fm('name: "quoted name"')).toMatchObject({ ok: true, fields: { name: 'quoted name' } });
    expect(fm('name: x\ntags: [a, b]').ok).toBe(true);
    expect(fm('name: x\nmeta: {k: v}').ok).toBe(true);
    expect(fm('name: x\nnested: [a, [b, c]]').ok).toBe(true);
    expect(fm('description: |\n  [not a flow sequence\n  just prose').ok).toBe(true);
    expect(fm("description: 'a: b'").ok).toBe(true);
    expect(fm('description: "hello: world"')).toMatchObject({ ok: true, fields: { description: 'hello: world' } });
    expect(fm('description: a URL http://x/y is fine').ok).toBe(true); // `:` without a following space is not a mapping
    expect(fm('meta:\n  k: v\n  j: w').ok).toBe(true); // a nested mapping UNDER a key is fine
    expect(fm('items:\n  - a\n  - b').ok).toBe(true);
    expect(fm('description:\n  first line\n  second line').ok).toBe(true);
  });

  it('refuses ANYTHING the YAML parser rejects — including the cases the old bracket-depth heuristic accepted', () => {
    for (const bad of [
      'name: x\ntags: [a, {b: c]]', // codex: unbalanced flow — the heuristic missed it
      'name: x\ntags: "bad\\q"', // codex: an invalid escape
      'name: x\ntags: "hello" "world"', // codex: two scalars at one node
      'name: x\ntags: [a, b', // unterminated flow sequence
      'meta: {k: v', // unterminated flow mapping
      'name: "open', // unterminated double quote
      "name: 'open", // unterminated single quote
      'tags: [a, b]]', // unbalanced
      'name: x\ndescription: hello: world', // a plain scalar YAML reads as a nested mapping
      'description: trailing:',
      'description: - not a list',
      'tags:\n  [a, b', // an indented flow collection left open
      'quote:\n  "open',
      'name: a\nname: b', // duplicate key
    ]) {
      expect(fm(bad).ok, bad).toBe(false);
    }
  });

  it('enforces the strict subset on top: single-document mapping, scalar `name`, list `mandates`', () => {
    // Top-level must be a MAPPING, not a sequence or a bare scalar.
    expect(fm('- a\n- b').ok).toBe(false);
    expect(fm('just a bare scalar').ok).toBe(false);
    // `name`, if present, must be a scalar.
    const badName = fm('name:\n  a: 1');
    expect(badName.ok).toBe(false);
    expect(reasonOf(badName)).toContain('scalar');
    // `mandates`, if present, must be a LIST.
    const badMandates = fm('mandates: not-a-list');
    expect(badMandates.ok).toBe(false);
    expect(reasonOf(badMandates)).toContain('list');
    expect(fm('mandates:\n  - a\n  - b').ok).toBe(true);
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
