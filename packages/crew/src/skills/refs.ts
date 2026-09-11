/**
 * Reference extraction over skill text (design v3 §4/§5) and the PORTABILITY VALIDATOR (F-079,
 * wicked-crew#531): the shapes garden skills use to reach files outside their own directory, and
 * the reasons a skill's text cannot be followed on a non-Claude CLI.
 *
 *   - `${CLAUDE_PLUGIN_ROOT}/<p>` — the plugin-root form: resolved against the SNAPSHOT root at
 *     publish, so a reference into a disabled skill or a file the bundle does not carry is a
 *     finding naming file:line. Only Claude Code substitutes the variable; every other CLI passes
 *     it through literally.
 *   - `../<p>` — sibling links (`repo-learn/SKILL.md` → `../search/refs/hotspots.md`): resolved
 *     from the referencing file's directory, must land inside the snapshot.
 *   - `python3 scripts/…` / `node scripts/x/run.mjs` / `uv run scripts/x.py` — a plugin script
 *     invoked relative to the WORKTREE cwd (`domain-extractor/SKILL.md:44`): a portability marker.
 *
 * `portabilityIssuesOf` reports EVERY reason (not the first) with the 1-based line of each hit —
 * the manifest's `portability {portable, reasons[], evidence[]}` and the per-reason `non-portable`
 * findings are derived from it (design W4 §5.1). The tokens:
 *
 *   plugin-root              text contains `${CLAUDE_PLUGIN_ROOT}`
 *   skill-dir-var            text contains `${CLAUDE_SKILL_DIR}` (a Claude-only substitution)
 *   cwd-script               an interpreter followed by a relative path that EXISTS at the plugin
 *                            root (`scripts/**`) — the worktree-cwd reading — and is not written
 *                            through the `wicked-garden run|python|path` launcher. A relative path
 *                            that exists only inside the skill's OWN directory is the base-directory
 *                            idiom every CLI shares and is portable; one that exists nowhere in the
 *                            bundle (`go test ./...`, `npx @axe-core/cli`, `python3 tests/x.py`) is
 *                            not a plugin file. Matches inside fenced code blocks whose language is
 *                            not a shell (`ts`, `js`, `python`, `yaml`, …) are ignored.
 *   relative-link            a `../` token whose resolved target EXISTS in the bundle (an
 *                            unresolvable `../requirements.md` inside a template is not a link the
 *                            flat layout could break)
 *   cross-skill-path         a plugin-root or resolved `../` target that lands in ANOTHER skill's
 *                            directory — the installer lays skills out flat by name, so a
 *                            filesystem relation between two skills never survives; the portable
 *                            form names the other skill (`wicked-garden-<x>`)
 *   requires-harness:claude  frontmatter `metadata.requires-harness: claude`, declared by the author
 *
 * The rule table (markers, regex sources, fence languages) is exported as `PORTABILITY_RULES` and
 * vendored VERBATIM by wicked-garden's own lint (`tests/portability_rules.json` there,
 * `packages/crew/tests/fixtures/portability_rules.json` here) — `tests/skills-refs.test.ts` fails
 * when the two drift. Every regex is spelled so Python's `re` accepts it too: fixed-width
 * lookbehinds only, no named groups.
 *
 * Path tokens keep every ORDINARY filename character (`+`, `@`, `~`, `%`, `=`, `,`, `:` …): a
 * reference truncated at the first unusual character would validate a PREFIX of the file it names
 * (`scripts/a+b.py` → `scripts/a`), so the token runs until whitespace, a quote/backtick, a
 * bracket/paren/brace, a shell separator (`|;&<>`) or a glob metacharacter (`*`, `?` — `foo*` is a
 * pattern, not a file the snapshot can carry; `PATH_CHARS` is the one stop set) — trailing sentence
 * punctuation is then trimmed.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import type { SkillPortabilityReason } from '../core/types.js';
import { owningSkillDir } from './bundle.js';
import { parseFrontmatter } from './frontmatter.js';

/** The literal every plugin-root reference starts with. */
export const PLUGIN_ROOT_MARKER = '${CLAUDE_PLUGIN_ROOT}';
/** The per-skill directory variable only Claude Code substitutes (W4 §5.1 `skill-dir-var`). */
export const SKILL_DIR_MARKER = '${CLAUDE_SKILL_DIR}';

/** One reference found in a text: the 1-based `line` it sits on and the path it names. */
export interface TextRef {
  line: number;
  /** For `plugin-root`: plugin-relative (`scripts/_python.sh`; `''` for the bare root). For
   *  `relative`: as written (`../search/refs/hotspots.md`). */
  path: string;
  kind: 'plugin-root' | 'relative';
}

/** A path token: everything up to whitespace, a quote/backtick, a bracket/paren/brace, a shell separator, or a glob metacharacter (`*`, `?`). */
const PATH_CHARS = '[^\\s"\'`()\\[\\]{}<>|;&*?]';
const PLUGIN_ROOT_RE = new RegExp(`\\$\\{CLAUDE_PLUGIN_ROOT\\}(\\/${PATH_CHARS}*)?`, 'g');
// A `../`-prefixed path token not glued to a preceding path character (so `a/../b` inside a
// longer path is not re-read as a reference of its own).
const RELATIVE_RE = new RegExp(`(?<![A-Za-z0-9_./-])((?:\\.\\.\\/)+${PATH_CHARS}*)`, 'g');
// A shell invocation of a plugin script by a cwd-relative path: an interpreter, optional options,
// then a path token that is relative — not absolute, not `$`-expanded, not `~` — and looks like a
// script (carries a `/`, or a script extension). Options come in two shapes (codex round 5): a
// bare flag (`-u`, `--frozen`, `--require=x`), and an option whose VALUE is the NEXT token —
// python `-W ignore` / `-X dev` / `-m mod` / `-c code`, node `--require x` / `-r x` / `--loader x`
// / `--import x` / `-e code`, uv `--python x` / `--with x` / `--directory x`, bash `-c cmd` … —
// which is consumed WITH its value so the script path after it is still seen (`python3 -W ignore
// scripts/foo.py`, `node --require foo scripts/x.js` used to read as portable). A value-taking
// option with no path after it (`python3 -m pytest`, `python3 -c "print(1)"`) is not an invocation.
// The bare `./seg` alternative of the earlier rule is GONE (W4 §5.1): `./dist`, `./out.png`,
// `import x from './y'` are not invocations of a plugin script — a `./`-prefixed path still counts
// when an interpreter precedes it and the file exists at the plugin root.
// The interpreter may be written as a PATH (`/usr/bin/python3`, `.venv/bin/python`,
// `./node_modules/.bin/tsx`, `~/bin/node`) — review of #532, F-4: an optional absolute / dot /
// home prefix and any number of `seg/` before the bare interpreter name.
const INTERPRETER_PREFIX = '(?:\\/|\\.{1,2}\\/)?(?:[A-Za-z0-9_.+@%=,:~-]+\\/)*';
const INTERPRETER = `${INTERPRETER_PREFIX}(?:python3?|uv\\s+run|bash|sh|zsh|node|npx|tsx|deno\\s+run)`;
const VALUED_OPTION =
  '(?:-[WXmcQrepCo]|--(?:require|loader|experimental-loader|import|eval|print|env-file|conditions|input-type|python|with|directory|project|config|import-map))';
// The bare-flag alternative must NOT be able to match a value-taking option that has a value (the
// negative lookahead): otherwise backtracking would read `-W` as a bare flag and its value
// `scripts/foo.py` as the script (`python3 -W scripts/foo.py` is NOT an invocation of that file).
const FLAG = `(?:\\s+(?:${VALUED_OPTION}\\s+\\S+|(?!${VALUED_OPTION}\\s)-{1,2}[A-Za-z0-9_-]+(?:=\\S+)?))*`;
const SEG = '[A-Za-z0-9_.+@%=,:~-]+';
const RELATIVE_SCRIPT = `(?:\\.{1,2}\\/)?(?:${SEG}\\/)*${SEG}(?:\\/|\\.(?:py|sh|bash|zsh|mjs|cjs|js|ts))`;
// Group 1 is the relative path token — what the existence check resolves.
const CWD_SCRIPT_RE = new RegExp(
  `(?<![A-Za-z0-9_./-])${INTERPRETER}${FLAG}\\s+(?![/$~])(${RELATIVE_SCRIPT}|(?:${SEG}\\/)+${SEG})(?![A-Za-z0-9_])`,
  'g',
);
// The portable launcher forms (W4 §4.2): `wicked-garden run <p>`, `wicked-garden python <p>`,
// `$(wicked-garden path <dir>)`, optionally `npx wicked-garden@12 run …`. Masked out of a line
// BEFORE the cwd-script rule runs, so `wicked-garden python scripts/x.py` is never read as
// `python scripts/x.py`.
const LAUNCHER_RE = new RegExp(
  `(?<![A-Za-z0-9_./-])wicked-garden(?:@[A-Za-z0-9_.^~<>=-]+)?\\s+(?:run|python|path)\\s+${PATH_CHARS}+`,
  'g',
);
// A fence line (CommonMark §4.5): at line start, three or more backticks or tildes, then the info
// string — its first word is the language. A BACKTICK fence's info string may not contain a
// backtick, so a one-line span like ```` ```ts const x = 1 ``` ```` is a code span, not an opener
// (review of #532, F-2: it used to open a fence that swallowed the rest of the file). Tilde fences
// have no such restriction. Group 1 = the marker run, group 2 = the language word.
const FENCE_RE = /^\s*(?:(`{3,})(?![^`]*`)|(~{3,}))\s*([^\s`{]*)/;
/** The marker run and language word of a fence line, or `null` when `line` is not a fence line. */
function fenceLine(line: string): { marker: string; lang: string } | null {
  const m = FENCE_RE.exec(line);
  if (m === null) return null;
  return { marker: m[1] ?? m[2] ?? '', lang: (m[3] ?? '').toLowerCase() };
}
/** Fence languages the cwd-script rule DOES scan — shells and prose; anything else (`ts`, `js`, `python`, `yaml`, …) is code the rule ignores. */
export const SCANNED_FENCE_LANGUAGES: readonly string[] = ['', 'sh', 'bash', 'zsh', 'shell', 'console', 'text'];

/**
 * The NORMATIVE rule table both lints share (design W4 §5.3; review of #532 addendum): every regex
 * SOURCE string, the markers, the interpreter list, the option-skipping rule, the interpreter
 * path-prefix rule, the fence walk, the existence and `../` resolution semantics and the
 * frontmatter key — spelled once here, vendored BYTE-FOR-BYTE by garden as
 * `tests/portability_rules.json` (crew keeps the canonical copy at
 * `packages/crew/tests/fixtures/portability_rules.json`, which adds `cases[]` and a
 * `sha256_of_rules` over exactly this object). `tests/skills-refs.test.ts` asserts the committed
 * fixture equals this object and re-derives every case — a drift between the two lints is a
 * failing test, not a surprise at publish. Every regex is valid in BOTH ECMAScript and Python
 * `re`: fixed-width lookbehinds only, no named groups, no `\h`.
 */
export const PORTABILITY_RULES = {
  markers: { 'plugin-root': PLUGIN_ROOT_MARKER, 'skill-dir-var': SKILL_DIR_MARKER },
  path_chars: PATH_CHARS,
  regex: {
    plugin_root_ref: PLUGIN_ROOT_RE.source,
    relative_ref: RELATIVE_RE.source,
    cwd_script: CWD_SCRIPT_RE.source,
    launcher_call: LAUNCHER_RE.source,
    fence_line: FENCE_RE.source,
  },
  /** The rules, one per token: what fires it and which regex source(s) it uses. */
  rules: [
    {
      token: 'plugin-root',
      description: 'the text contains the marker `${CLAUDE_PLUGIN_ROOT}` (only Claude Code substitutes it); every occurrence is a hit — fences included; regex.plugin_root_ref extracts the path after it',
      regex: [PLUGIN_ROOT_RE.source],
    },
    {
      token: 'skill-dir-var',
      description: 'the text contains `${CLAUDE_SKILL_DIR}` (a Claude-only substitution); every occurrence is a hit — fences included',
      regex: [],
    },
    {
      token: 'cwd-script',
      description:
        'an interpreter (bare, or written as a path — see interpreters + interpreter_path_prefix), then options per the option rule, then a relative path token (regex.cwd_script group 1) that, normalized against the PLUGIN ROOT (the worktree cwd), names a file or directory the bundle carries. NOT a hit: a target that exists nowhere in the bundle; a target that exists only inside the skill\'s own directory (base-directory relative — portable); any span matched by regex.launcher_call (masked first); a line inside a fenced code block whose language is not in fences.shell_langs',
      regex: [LAUNCHER_RE.source, CWD_SCRIPT_RE.source],
    },
    {
      token: 'relative-link',
      description:
        'a `../` token (regex.relative_ref) resolved from the referencing file\'s directory that lands INSIDE the plugin root on a path the bundle carries AND whose deepest owning skill directory is not the referencing skill\'s own (a link that stays inside the skill\'s tree survives every layout). An escaping or non-existent target is not a hit',
      regex: [RELATIVE_RE.source],
    },
    {
      token: 'cross-skill-path',
      description:
        'a plugin-root target (regex.plugin_root_ref, resolved against the plugin root) or a resolved `../` target (regex.relative_ref) that exists in the bundle and whose deepest owning skill directory is ANOTHER skill (a nested module\'s parent counts). Reported in addition to plugin-root / relative-link',
      regex: [PLUGIN_ROOT_RE.source, RELATIVE_RE.source],
    },
    {
      token: 'requires-harness:claude',
      description:
        'the skill-root SKILL.md (file == skill_dir + "/SKILL.md") has YAML frontmatter with `metadata.requires-harness` whose value, trimmed and lowercased, is `claude`. Only the skill-root SKILL.md counts (a nested skill\'s own SKILL.md is its skill root)',
      regex: [],
    },
  ],
  interpreters: ['python', 'python3', 'uv run', 'bash', 'sh', 'zsh', 'node', 'npx', 'tsx', 'deno run'],
  interpreter_path_prefix: {
    regex: INTERPRETER_PREFIX,
    rule: 'the interpreter may be written as a path: an optional leading `/`, `./` or `../`, then any number of `segment/`; the whole token must not be glued to a preceding path character (regex.cwd_script starts with the fixed-width lookbehind)',
  },
  options: {
    valued: ['-W', '-X', '-m', '-c', '-Q', '-r', '-e', '-p', '-C', '-o', '--require', '--loader', '--experimental-loader', '--import', '--eval', '--print', '--env-file', '--conditions', '--input-type', '--python', '--with', '--directory', '--project', '--config', '--import-map'],
    rule: 'between the interpreter and the path token any number of options is skipped: a bare flag (`-u`, `--frozen`, `--require=x`), or a VALUED option consumed together with its next token (`-W ignore`, `--loader ts-node/esm`); a valued option with no path after it is not an invocation, and its value is never read as the path',
  },
  fences: {
    open: FENCE_RE.source,
    open_rule: 'a fence opens only at a line start matching fences.open: >= 3 backticks or tildes; the language is the trimmed, lowercased first word of the info string (group 3)',
    inline_span_is_not_fence: true,
    inline_span_rule: 'a backtick opener whose remainder contains another backtick (```` ```ts x = 1 ``` ````) is a one-line code span, not a fence — fences.open refuses it with a lookahead; tilde fences have no such restriction',
    close_rule: 'the fence closes at the next line-start fence of the SAME character whose run is at least as long as the opener and is followed by nothing but whitespace; a shorter run, or a run followed by text, is content',
    shell_langs: [...SCANNED_FENCE_LANGUAGES],
    skip_non_shell: true,
    boundary_lines_scanned: true,
    unclosed_runs_to_eof: true,
    applies_to: ['cwd-script'],
  },
  existence: {
    exists: 'a normalized plugin-relative path exists when it is a file the bundle carries, or a directory some carried file sits under; the empty path (the bare root) exists',
    bundle_universe: 'the files the next publish carries: support files inside the bundle closure OUTSIDE skills/ (`.claude-plugin/**`, `scripts/**` minus ci/ and wg/, `schemas/**`, `docs/examples/**`, `pyproject.toml`, `uv.lock`) plus ENABLED skills\' own files; an owner-less file under skills/ (a `skills/README.md`) is never in it; the judged skill\'s own files are always visible to it',
    cwd_script_target: 'the path token normalized as if the cwd were the plugin root (`./scripts/x.py` → `scripts/x.py`); one that climbs out (`../x`) is not a plugin file. It is a hit only when it exists AT THE PLUGIN ROOT; existing only inside the skill directory (`<skill_dir>/<token>`) is the base-directory idiom and portable; existing at both is ambiguous and a hit',
    skill_dirs: 'every directory holding a SKILL.md under skills/; a path\'s owner is the DEEPEST such directory that prefixes it (or none)',
  },
  relative_resolution: {
    plugin_root_ref: 'the path after `${CLAUDE_PLUGIN_ROOT}/`, trailing sentence punctuation (`.`, `,`, `:`) trimmed, posix-normalized, trailing `/` dropped; `..` at the top escapes (never the root); the bare marker is the root',
    relative_ref: 'the `../…` token, trailing sentence punctuation trimmed, joined onto the referencing file\'s directory and posix-normalized; a result that climbs out of the plugin root escapes (not a link the bundle can carry)',
  },
  frontmatter: { requires_harness_key: 'metadata.requires-harness', requires_harness_value: 'claude' },
  evidence: { reasons_sorted_unique: true, anchor_format: '<plugin-relative file>:<line>', cap: 5, portable: 'reasons.length === 0' },
} as const;

/**
 * Canonical JSON — keys sorted recursively, no whitespace, non-ASCII unescaped — what the parity
 * fixture's `sha256_algorithm` prescribes (Python: `json.dumps(obj, sort_keys=True,
 * separators=(',',':'), ensure_ascii=False)`). ONE implementation: the rules identity below and
 * `tests/skills-refs.test.ts` (which re-derives the fixture's `sha256_of_rules`) both use it.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The portability rules IDENTITY — which rule table judged a set of rows (F-083).
 * A publish records it in `snapshot.json` (`rulesVersion` / `rulesSha256`); `current` verification
 * compares it with the identity the running daemon carries. `version` is the canonical fixture's
 * `version` (bumped by hand when the rules change — `tests/skills-refs.test.ts` asserts the two
 * agree); `sha256` is the digest over the canonical JSON of `PORTABILITY_RULES` — computed from the
 * LIVE table, so the runtime never reads a test fixture, and asserted equal to the fixture's
 * `sha256_of_rules` by the same test. A generation whose recorded identity differs from the running
 * one was published under OTHER rules: its rows may derive differently today without a byte having
 * changed. A rule change is not tampering — the store accepts such a generation and the runtime
 * raises a `skills.stale-rules` warning instead of refusing the root (an upgrade must never leave
 * every seat without skills).
 *
 * WHAT THE DIGEST COVERS (review of #535, L1): the rule TABLE — regex sources, markers, interpreter
 * and option lists, fence languages, the spelled-out semantics — NOT the detector code that applies
 * it (`portabilityIssuesOf`, `portabilityReasonsOf`, `looksBinary`, bundle.ts `owningSkillDir`,
 * frontmatter.ts `skillKindOf`). A code-only change of detector semantics leaves the digest equal,
 * and a generation whose rows now derive differently would be refused as tampering on the next
 * upgrade — F-083 again. So: **bump `PORTABILITY_RULES_VERSION` whenever a row could derive
 * differently**, table change or not, and regenerate the parity fixture (its `cases[]` fail on such a
 * change and force the regeneration; the version bump is the author's duty — `skills-refs.test.ts`
 * pins version and digest to the fixture, so both move together).
 */
export interface PortabilityRulesIdentity {
  version: number;
  sha256: string;
}
export const PORTABILITY_RULES_VERSION = 2;
export const PORTABILITY_RULES_SHA256: string = createHash('sha256').update(canonicalJson(PORTABILITY_RULES), 'utf8').digest('hex');
export const PORTABILITY_RULES_IDENTITY: Readonly<PortabilityRulesIdentity> = Object.freeze({ version: PORTABILITY_RULES_VERSION, sha256: PORTABILITY_RULES_SHA256 });

/**
 * Trailing sentence punctuation a prose reference picks up (`…/foo.` at the end of a sentence,
 * `…/foo,` before a clause). A dot-DOT segment is never punctuation: `${CLAUDE_PLUGIN_ROOT}/..`
 * must survive as `..` so the resolver refuses it — stripping it would turn a plugin-root ESCAPE
 * into the plugin root itself (codex review of #480). A lone trailing `.` after a slash (`dir/.`)
 * is the sentence's full stop. Only TRAILING punctuation is trimmed — `a,b.py` keeps its comma.
 */
function trimPunctuation(p: string): string {
  const noSeparators = p.replace(/[,:]+$/, '');
  if (/(^|\/)\.\.$/.test(noSeparators)) return noSeparators;
  return noSeparators.replace(/\.+$/, '');
}

/**
 * Resolve a `${CLAUDE_PLUGIN_ROOT}/<p>` reference to a normalized plugin-relative path: a trailing
 * `/` (a directory reference) is dropped, `.` segments folded, and any path that climbs OUT of the
 * plugin root (`..`, `scripts/../../x`) answers `null` — never the root, never a sibling of it.
 * `''` is the bare root.
 */
export function resolvePluginRootRef(p: string): string | null {
  if (p === '' || p === '.') return '';
  const normalized = posix.normalize(p).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? '' : normalized;
}

/** Every `${CLAUDE_PLUGIN_ROOT}/<p>` reference in `text`, in order. */
export function extractPluginRootRefs(text: string): TextRef[] {
  const out: TextRef[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const m of line.matchAll(PLUGIN_ROOT_RE)) {
      const tail = m[1] ?? '';
      out.push({ line: i + 1, path: trimPunctuation(tail.replace(/^\//, '')), kind: 'plugin-root' });
    }
  }
  return out;
}

/** Every `../<p>` reference in `text`, in order (as written; the caller resolves it). */
export function extractRelativeRefs(text: string): TextRef[] {
  const out: TextRef[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const m of line.matchAll(RELATIVE_RE)) {
      out.push({ line: i + 1, path: trimPunctuation(m[1] ?? ''), kind: 'relative' });
    }
  }
  return out;
}

/**
 * Resolve a `../<p>` reference written in the file at plugin-relative `fileRel` to a
 * plugin-relative path, or `null` when it climbs out of the plugin root.
 */
export function resolveRelativeRef(fileRel: string, ref: string): string | null {
  const resolved = posix.normalize(posix.join(posix.dirname(fileRel), ref));
  if (resolved === '..' || resolved.startsWith('../')) return null;
  return resolved === '.' ? '' : resolved.replace(/\/$/, '');
}

/** The reason tokens — the wire enum (`SkillPortabilityReason`, api-types 0.34.0) is the same set. */
export type PortabilityIssue = SkillPortabilityReason;

/** Every reason token, for validating persisted `portability.reasons` (a manifest or snapshot row). */
export const PORTABILITY_REASONS: ReadonlySet<string> = new Set<PortabilityIssue>([
  'plugin-root',
  'skill-dir-var',
  'cwd-script',
  'relative-link',
  'cross-skill-path',
  'requires-harness:claude',
]);

/** The cap on `portability.evidence` anchors a row carries (design W4 §5.2). */
export const PORTABILITY_EVIDENCE_CAP = 5;

/**
 * `file:line` anchors for a skill's hits — sorted by file then line, unique, capped — the
 * `portability.evidence` of its manifest entry and snapshot row.
 */
export function portabilityEvidenceOf(hits: ReadonlyArray<PortabilityHit & { fileRel: string }>): string[] {
  const sorted = [...hits].sort((a, b) => (a.fileRel < b.fileRel ? -1 : a.fileRel > b.fileRel ? 1 : a.line - b.line));
  const out: string[] = [];
  for (const h of sorted) {
    const anchor = `${h.fileRel}:${h.line}`;
    if (out.includes(anchor)) continue;
    out.push(anchor);
    if (out.length >= PORTABILITY_EVIDENCE_CAP) break;
  }
  return out;
}

/** One hit: the reason, the 1-based line, and the token as written (the finding's evidence). */
export interface PortabilityHit {
  reason: PortabilityIssue;
  line: number;
  evidence: string;
}

/**
 * What the validator needs to know about the file beyond its text: where it sits, which skill
 * owns it, which directories are skills, and whether a plugin-relative path exists in the bundle.
 * `exists` answers for FILES and for DIRECTORIES (a prefix of some file) alike.
 */
export interface PortabilityContext {
  /** Plugin-relative path of the text being judged (`skills/qe/SKILL.md`). */
  fileRel: string;
  /** The skill dir that owns `fileRel` (`skills/qe`). */
  skillDir: string;
  /** Every skill dir of the catalog (nested ones included) — classifies a target's owner. */
  skillDirs: ReadonlySet<string>;
  /** Whether the bundle carries this normalized plugin-relative path (file or directory). */
  exists: (pluginRel: string) => boolean;
}

/** A context for text judged WITHOUT a bundle (unit tests, ad-hoc checks): nothing exists, one skill. */
export function bareContext(fileRel = 'skills/x/SKILL.md', existing: Iterable<string> = []): PortabilityContext {
  const set = new Set(existing);
  const skillDir = fileRel.split('/').slice(0, 2).join('/');
  return { fileRel, skillDir, skillDirs: new Set([skillDir]), exists: (p) => existsIn(set, p) };
}

/** `exists` over a plain set of file paths: the path itself, or a directory some file sits under. */
export function existsIn(files: ReadonlySet<string>, pluginRel: string): boolean {
  if (pluginRel === '') return true;
  if (files.has(pluginRel)) return true;
  const prefix = `${pluginRel}/`;
  for (const f of files) if (f.startsWith(prefix)) return true;
  return false;
}

/**
 * Per line: `true` when the line sits inside a fenced code block whose language the cwd-script
 * rule does NOT scan. The fence algorithm is spelled as DATA in the parity fixture's `fences`
 * block (`PORTABILITY_RULES.fences` → `tests/fixtures/portability_rules.json`, vendored by
 * garden's lint so both walk the same way) — this is the prose of that block:
 *
 *   - `open` / `open_rule`: a fence OPENS only at a line start (`FENCE_RE`): ≥ 3 backticks or
 *     tildes, the language is the trimmed, lowercased first word of the info string;
 *   - `inline_span_rule`: a backtick opener whose remainder contains another backtick is a
 *     one-line code span, not a fence (tilde fences have no such restriction);
 *   - `close_rule`: it CLOSES at the next line-start fence of the SAME character, at least as
 *     long, with nothing but whitespace after the run; a shorter run, or one with text after it,
 *     is content;
 *   - `shell_langs` / `skip_non_shell`: only a fence whose language is outside the shell set is
 *     skipped (`applies_to: cwd-script` — the marker rules scan fences too);
 *   - `boundary_lines_scanned`: the opening and closing lines themselves are scanned;
 *   - `unclosed_runs_to_eof`: an unclosed fence runs to the end of the text.
 */
function skippedFenceMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open: { marker: string; skipped: boolean } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = fenceLine(line);
    if (open === null) {
      if (fence !== null) open = { marker: fence.marker, skipped: !SCANNED_FENCE_LANGUAGES.includes(fence.lang) };
      continue;
    }
    if (fence !== null && fence.marker.charAt(0) === open.marker.charAt(0) && fence.marker.length >= open.marker.length && /^\s*(`{3,}|~{3,})\s*$/.test(line)) {
      open = null;
      continue;
    }
    mask[i] = open.skipped;
  }
  return mask;
}

/** The plugin-relative path a cwd-relative script token names when the cwd is the plugin root, or `null` when it climbs out. */
function rootRelativeTarget(token: string): string | null {
  const normalized = posix.normalize(token).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/** `metadata.requires-harness: claude` in a SKILL.md frontmatter → the hit at the key's line, else `null`. */
function requiresHarnessHit(text: string): PortabilityHit | null {
  const fm = parseFrontmatter(text);
  if (!fm.ok) return null;
  const raw = fm.fields['metadata'];
  if (raw === undefined) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)['requires-harness'];
  if (typeof value !== 'string' || value.trim().toLowerCase() !== PORTABILITY_RULES.frontmatter.requires_harness_value) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let line = 1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') break;
    if (/^\s*["']?requires-harness["']?\s*:/.test(lines[i] ?? '')) {
      line = i + 1;
      break;
    }
  }
  return { reason: 'requires-harness:claude', line, evidence: `metadata.requires-harness: ${value.trim()}` };
}

/**
 * EVERY reason `text` (the file at `ctx.fileRel`) is not portable to a non-Claude CLI, in file
 * order — empty when it is portable. One hit per token occurrence; the caller folds them into the
 * sorted-unique `reasons` and the `file:line` evidence.
 */
export function portabilityIssuesOf(text: string, ctx: PortabilityContext): PortabilityHit[] {
  const hits: PortabilityHit[] = [];
  const lines = text.split('\n');
  const skipped = skippedFenceMask(lines);
  const otherSkill = (target: string): boolean => {
    if (!ctx.exists(target)) return false;
    const owner = owningSkillDir(target, ctx.skillDirs);
    return owner !== null && owner !== ctx.skillDir;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (line.includes(SKILL_DIR_MARKER)) hits.push({ reason: 'skill-dir-var', line: lineNo, evidence: SKILL_DIR_MARKER });
    for (const m of line.matchAll(PLUGIN_ROOT_RE)) {
      const path = trimPunctuation((m[1] ?? '').replace(/^\//, ''));
      hits.push({ reason: 'plugin-root', line: lineNo, evidence: `${PLUGIN_ROOT_MARKER}${path === '' ? '' : `/${path}`}` });
      const target = resolvePluginRootRef(path);
      if (target !== null && target !== '' && otherSkill(target)) {
        hits.push({ reason: 'cross-skill-path', line: lineNo, evidence: `${PLUGIN_ROOT_MARKER}/${path} → ${target}` });
      }
    }
    for (const m of line.matchAll(RELATIVE_RE)) {
      const ref = trimPunctuation(m[1] ?? '');
      const target = resolveRelativeRef(ctx.fileRel, ref);
      if (target === null || !ctx.exists(target)) continue;
      // A link that stays inside the skill's OWN tree (`refs/a.md` → `../SKILL.md`) survives every
      // layout — the skill is copied whole. Only a link that leaves it is one the flat layout breaks.
      const owner = owningSkillDir(target, ctx.skillDirs);
      if (owner === ctx.skillDir) continue;
      hits.push({ reason: 'relative-link', line: lineNo, evidence: `${ref} → ${target}` });
      if (owner !== null) hits.push({ reason: 'cross-skill-path', line: lineNo, evidence: `${ref} → ${target}` });
    }
    if (skipped[i] === true) continue;
    const masked = line.replace(LAUNCHER_RE, (s) => ' '.repeat(s.length));
    for (const m of masked.matchAll(CWD_SCRIPT_RE)) {
      const token = m[1] ?? '';
      const target = rootRelativeTarget(token);
      if (target === null || !ctx.exists(target)) continue;
      hits.push({ reason: 'cwd-script', line: lineNo, evidence: m[0].trim() });
    }
  }
  if (ctx.fileRel === `${ctx.skillDir}/SKILL.md`) {
    const rh = requiresHarnessHit(text);
    if (rh !== null) hits.push(rh);
  }
  return hits;
}

/** The sorted, unique reason set of a list of hits (the manifest's `portability.reasons`). */
export function portabilityReasonsOf(hits: ReadonlyArray<PortabilityHit>): PortabilityIssue[] {
  return [...new Set(hits.map((h) => h.reason))].sort();
}

/** Binary sniff for reference scanning: a NUL in the first 8 KB means "not text, do not scan". */
const SNIFF_BYTES = 8 * 1024;
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(buf.length, SNIFF_BYTES)).includes(0);
}
