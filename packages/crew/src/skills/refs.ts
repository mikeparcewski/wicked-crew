/**
 * Reference extraction over skill text (design v3 §4/§5): the two link shapes garden skills use
 * to reach files outside their own directory, plus the cwd-relative script invocation that makes a
 * skill Claude-only.
 *
 *   - `${CLAUDE_PLUGIN_ROOT}/<p>` — the plugin-root form (461 literals across 102 files in the
 *     live 12.32.0 plugin): resolved against the SNAPSHOT root at publish, so a reference into a
 *     disabled skill or a file the bundle does not carry is a blocking finding naming file:line.
 *   - `../<p>` — sibling links (`repo-learn/SKILL.md` → `../search/refs/hotspots.md`): resolved
 *     from the referencing file's directory, must land inside the snapshot.
 *   - `python3 scripts/…` / `python3 -u scripts/x/run.py` / `bash scripts/x` / `./scripts/x` — a
 *     script invoked relative to the WORKTREE cwd (`domain-extractor/SKILL.md:42`): not a reference
 *     to resolve, but a portability marker. ANY interpreter followed by a cwd-relative path (after
 *     optional flags) counts, not only one literally followed by `scripts/` (codex round 2).
 *
 * `portable` (v3 §5) is `false` when a skill's files carry any of the three: non-Claude CLIs have
 * no plugin root, no snapshot cwd, and only a flat `<name>/SKILL.md` layout — a skill that needs
 * any of them is Claude-only: excluded from every non-Claude delivery view the snapshot carries
 * (`views/copilot/`, design v3.2 §4) and from the per-launch `--skill` lists core builds.
 *
 * Path tokens keep EVERY legal filename character (`+`, `@`, `~`, `%`, `=`, `,`, `:` …): a
 * reference truncated at the first unusual character would validate a PREFIX of the file it names
 * (`scripts/a+b.py` → `scripts/a`), so the token runs until whitespace, a quote/backtick, a
 * bracket/paren, or a shell separator (`|;&<>`) — trailing sentence punctuation is then trimmed.
 */

import { posix } from 'node:path';

/** The literal every plugin-root reference starts with. */
export const PLUGIN_ROOT_MARKER = '${CLAUDE_PLUGIN_ROOT}';

/** One reference found in a text: the 1-based `line` it sits on and the path it names. */
export interface TextRef {
  line: number;
  /** For `plugin-root`: plugin-relative (`scripts/_python.sh`; `''` for the bare root). For
   *  `relative`: as written (`../search/refs/hotspots.md`). */
  path: string;
  kind: 'plugin-root' | 'relative';
}

/** A path token: everything up to whitespace, a quote/backtick, a bracket/paren/brace, or a shell separator. */
const PATH_CHARS = '[^\\s"\'`()\\[\\]{}<>|;&*?]';
const PLUGIN_ROOT_RE = new RegExp(`\\$\\{CLAUDE_PLUGIN_ROOT\\}(\\/${PATH_CHARS}*)?`, 'g');
// A `../`-prefixed path token not glued to a preceding path character (so `a/../b` inside a
// longer path is not re-read as a reference of its own).
const RELATIVE_RE = new RegExp(`(?<![A-Za-z0-9_./-])((?:\\.\\.\\/)+${PATH_CHARS}*)`, 'g');
// A shell invocation of a plugin script by a cwd-relative path: an interpreter, optional flags
// (`-u`, `--frozen`, `-m mod` is NOT a path), then a path token that is relative — not absolute,
// not `$`-expanded, not `~` — and looks like a script (carries a `/`, or a script extension).
const INTERPRETER = '(?:python3?|uv\\s+run|bash|sh|zsh|node|npx|tsx|deno\\s+run)';
const FLAG = '(?:\\s+-{1,2}[A-Za-z0-9_-]+(?:=\\S+)?)*';
const SEG = '[A-Za-z0-9_.+@%=,:~-]+';
const RELATIVE_SCRIPT = `(?:\\.{1,2}\\/)?(?:${SEG}\\/)*${SEG}(?:\\/|\\.(?:py|sh|bash|zsh|mjs|cjs|js|ts))`;
const CWD_SCRIPT_RE = new RegExp(
  `(?<![A-Za-z0-9_./-])${INTERPRETER}${FLAG}\\s+(?![/$~])(?:${RELATIVE_SCRIPT}|(?:${SEG}\\/)+${SEG})(?![A-Za-z0-9_])` +
    `|(?<![A-Za-z0-9_./$-])\\.\\/${SEG}(?:\\/${SEG})*`,
);

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

export type PortabilityIssue = 'plugin-root' | 'relative-link' | 'cwd-script';

/** The first reason `text` is not portable to a non-Claude CLI, or `null` when it is. */
export function portabilityIssueOf(text: string): PortabilityIssue | null {
  if (text.includes(PLUGIN_ROOT_MARKER)) return 'plugin-root';
  if (CWD_SCRIPT_RE.test(text)) return 'cwd-script';
  if (extractRelativeRefs(text).length > 0) return 'relative-link';
  return null;
}

/** Binary sniff for reference scanning: a NUL in the first 8 KB means "not text, do not scan". */
const SNIFF_BYTES = 8 * 1024;
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(buf.length, SNIFF_BYTES)).includes(0);
}
