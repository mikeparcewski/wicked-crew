/**
 * SKILL.md frontmatter — the reader the skills store keys on, parsed by a REAL YAML grammar.
 *
 * A skill's identity in the manifest is its frontmatter `name` (verified against the live garden
 * plugin: all 142 SKILL.md files carry `name: wicked-garden-<dir path joined by '-'>`, unique).
 * Everything the store derives is a flat scalar — `name`, `context: fork`, `user-invocable: true`.
 *
 * Earlier passes hand-rolled a bracket-depth heuristic; it accepted invalid YAML a real parser
 * rejects (`[a, {b: c]]`, `"bad\q"`, `"hello" "world"` — codex round 3). We now parse the block
 * with the `yaml` library (the same grammar Claude Code loads a skill with) and refuse ANYTHING it
 * rejects, then enforce a STRICT SUBSET on top:
 *
 *   - a single YAML document that is a top-level MAPPING (`key: value` pairs) — not a sequence,
 *     not a bare scalar, not multiple documents;
 *   - `name`, if present, is a SCALAR (a mapping/sequence is refused — the manifest is keyed by it);
 *   - `mandates`, if present, is a LIST (a scalar/mapping is refused).
 *
 * `fields` flattens the top-level scalars to strings (`user-invocable: true` → `"true"`,
 * `name: "x"` → `"x"`) — the only shapes the store reads. A non-scalar value (a nested mapping the
 * strict checks above do not forbid for that key) is serialized to JSON so `fields` stays a flat
 * `Record<string, string>`; the store never reads those.
 */

import { parseDocument } from 'yaml';

import type { SkillKind } from '../core/types.js';

export type FrontmatterResult =
  | { ok: true; fields: Record<string, string> }
  | { ok: false; reason: string };

const OPEN_FENCE = '---\n';

/** Find the closing fence: a `---` line by itself after the opening fence, or -1. */
function closingFence(src: string): number {
  let from = OPEN_FENCE.length;
  for (;;) {
    const i = src.indexOf('\n---', from);
    if (i < 0) return -1;
    const after = src.charAt(i + 4);
    if (after === '' || after === '\n') return i;
    from = i + 4;
  }
}

/** Flatten one top-level YAML value to the string `fields` carries (only scalars are ever read). */
function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

/**
 * Parse the frontmatter block at the top of `text` with a real YAML parser and enforce the strict
 * subset (single-document mapping, scalar `name`, list `mandates`). Anything the parser rejects is
 * a parse failure carrying the parser's own reason; a well-formed block yields the flat scalar
 * `fields` the store keys on.
 */
export function parseFrontmatter(text: string): FrontmatterResult {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith(OPEN_FENCE)) {
    return { ok: false, reason: 'missing opening `---` fence on line 1' };
  }
  const close = closingFence(src);
  if (close < 0) return { ok: false, reason: 'missing closing `---` fence' };
  const block = src.slice(OPEN_FENCE.length, close);

  let doc: ReturnType<typeof parseDocument>;
  try {
    // `uniqueKeys` (default true) rejects duplicate keys; the block carries no internal `---`, so
    // a single document is parsed. Any grammar error lands in `doc.errors` (parseDocument does not throw).
    doc = parseDocument(block, { prettyErrors: false });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (doc.errors.length > 0) {
    return { ok: false, reason: doc.errors[0]?.message ?? 'invalid YAML' };
  }

  let js: unknown;
  try {
    js = doc.toJS();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  // An empty block (only comments / blank lines) is a valid, name-less frontmatter — the caller's
  // `name` guard reports the missing name; here it is simply an empty mapping.
  if (js === null || js === undefined) return { ok: true, fields: {} };
  if (typeof js !== 'object' || Array.isArray(js)) {
    return { ok: false, reason: 'frontmatter must be a single YAML mapping (`key: value` pairs), not a sequence or a bare scalar' };
  }
  const obj = js as Record<string, unknown>;
  if (Object.hasOwn(obj, 'name')) {
    const name = obj['name'];
    if (name !== null && typeof name === 'object') {
      return { ok: false, reason: '`name` must be a scalar — the manifest is keyed by it' };
    }
  }
  if (Object.hasOwn(obj, 'mandates') && !Array.isArray(obj['mandates'])) {
    return { ok: false, reason: '`mandates` must be a YAML list' };
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) fields[key] = fieldValue(value);
  return { ok: true, fields };
}

/**
 * The skill kind the frontmatter declares (design v3 §5, fork-first): `context: fork` is a fork
 * worker (a subagent body) even when it is also user-invocable (`archetype`, `smaht`);
 * `user-invocable: true` a router (an operator-facing entry point); everything else a module (a
 * nested reference skill routers/workers pull in).
 */
export function skillKindOf(fields: Readonly<Record<string, string>>): SkillKind {
  if (fields['context'] === 'fork') return 'fork-worker';
  if (fields['user-invocable'] === 'true') return 'router';
  return 'module';
}

/** The plugin the effective root impersonates — the identity workers already invoke skills under. */
export const PLUGIN_NAME = 'wicked-garden';

/** Every manifest key carries this prefix: `wicked-garden-<dir segments joined by '-'>`. */
export const SKILL_NAME_PREFIX = `${PLUGIN_NAME}-`;

/**
 * The frontmatter name a skill at `skills/<relDir>` must declare — `relDir` is POSIX-relative to
 * the plugin's `skills/` directory (`engineering/frontend` → `wicked-garden-engineering-frontend`).
 */
export function derivedSkillName(relDir: string): string {
  return SKILL_NAME_PREFIX + relDir.split('/').join('-');
}
