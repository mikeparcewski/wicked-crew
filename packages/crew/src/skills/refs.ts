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
const INTERPRETER = '(?:python3?|uv\\s+run|bash|sh|zsh|node|npx|tsx|deno\\s+run)';
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
// A fence line: three or more backticks or tildes, then the info string's first word (the language).
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`{]*)/;
/** Fence languages the cwd-script rule DOES scan — shells and prose; anything else (`ts`, `js`, `python`, `yaml`, …) is code the rule ignores. */
export const SCANNED_FENCE_LANGUAGES: readonly string[] = ['', 'sh', 'bash', 'zsh', 'shell', 'console', 'text'];

/**
 * The rule table both lints share (design W4 §5.3): regex SOURCE strings and markers, spelled once
 * here, vendored as data by garden. `tests/skills-refs.test.ts` asserts the committed fixture equals
 * this object — a drift between the two lints is a failing test, not a surprise at publish.
 */
export const PORTABILITY_RULES = {
  version: 1,
  markers: { 'plugin-root': PLUGIN_ROOT_MARKER, 'skill-dir-var': SKILL_DIR_MARKER },
  regex: {
    path_chars: PATH_CHARS,
    plugin_root_ref: PLUGIN_ROOT_RE.source,
    relative_ref: RELATIVE_RE.source,
    cwd_script: CWD_SCRIPT_RE.source,
    launcher_call: LAUNCHER_RE.source,
    fence_line: FENCE_RE.source,
  },
  fence_scanned_languages: [...SCANNED_FENCE_LANGUAGES],
  frontmatter: { requires_harness_key: 'metadata.requires-harness', requires_harness_value: 'claude' },
} as const;

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
 * rule does NOT scan. The opening fence line itself and the closing one are not inside.
 */
function skippedFenceMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open: { marker: string; skipped: boolean } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const m = FENCE_RE.exec(line);
    if (open === null) {
      if (m !== null) open = { marker: m[1] ?? '', skipped: !SCANNED_FENCE_LANGUAGES.includes((m[2] ?? '').toLowerCase()) };
      continue;
    }
    // A closing fence: the same character, at least as long, nothing but whitespace after it.
    if (m !== null && (m[1] ?? '').charAt(0) === open.marker.charAt(0) && (m[1] ?? '').length >= open.marker.length && (m[2] ?? '') === '' && /^\s*(`{3,}|~{3,})\s*$/.test(line)) {
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
