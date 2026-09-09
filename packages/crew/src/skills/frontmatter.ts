/**
 * SKILL.md frontmatter — the minimal, deterministic reader the skills store keys on.
 *
 * A skill's identity in the manifest is its frontmatter `name` (verified against the live garden
 * plugin: all 142 SKILL.md files carry `name: wicked-garden-<dir path joined by '-'>`, unique).
 * Everything the store derives is a flat scalar — `name`, `context: fork`, `user-invocable: true` —
 * so this reads top-level `key: value` lines (a block scalar `|`/`>` or an indented continuation
 * consumes its indented lines) and deliberately does NOT pull in a YAML library: the guard
 * "frontmatter parses" must answer the same on every platform and every daemon, and a full YAML
 * grammar admits shapes (anchors, flow mappings, multi-documents) no SKILL.md uses and no reviewer
 * expects a skill editor to accept.
 *
 * It is a STRICT subset, not a lenient one (codex review of #480): a scalar that opens a flow
 * sequence `[`, a flow mapping `{`, or a quote must close it on the same line — `tags: [a, b` is a
 * parse failure naming the line, not a string value of `[a, b`. The live catalog's 231 flow values
 * are all single-line and terminated, so nothing shipped is refused.
 */

import type { SkillKind } from '../core/types.js';

export type FrontmatterResult =
  | { ok: true; fields: Record<string, string> }
  | { ok: false; reason: string };

const OPEN_FENCE = '---\n';
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;

/** Strip one layer of matching single/double quotes — `name: "x"` and `name: x` are the same name. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/**
 * A single-line scalar must be well-formed: an opened flow sequence / flow mapping / quoted scalar
 * closes on the line. Returns the reason it is malformed, or `null`.
 */
function malformedScalar(value: string): string | null {
  const first = value[0];
  const last = value[value.length - 1];
  if (first === '[' && last !== ']') return 'unterminated flow sequence (`[` without `]`)';
  if (first === '{' && last !== '}') return 'unterminated flow mapping (`{` without `}`)';
  if ((first === '"' || first === "'") && (value.length < 2 || last !== first)) {
    return `unterminated quoted scalar (opening ${first} without a closing one)`;
  }
  if (first === '[' || first === '{') {
    // Balanced brackets inside the flow collection — `[a, [b]` closes the outer with the inner's.
    let depth = 0;
    let quote: string | null = null;
    for (const ch of value) {
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') depth -= 1;
      if (depth < 0) return 'unbalanced flow collection (a closing bracket before its opening one)';
    }
    if (depth !== 0) return 'unbalanced flow collection (brackets do not pair up)';
    if (quote !== null) return 'unterminated quoted scalar inside a flow collection';
  }
  return null;
}

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

/**
 * Parse the frontmatter block at the top of `text`. Top-level keys only; a block scalar or an
 * indented continuation (a nested mapping, a list) is folded into the key's string value — the
 * store never interprets those, it only needs the flat scalars and the fact that the block is
 * well-formed. Duplicate keys and non-`key: value` lines are parse failures with a line number.
 */
export function parseFrontmatter(text: string): FrontmatterResult {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith(OPEN_FENCE)) {
    return { ok: false, reason: 'missing opening `---` fence on line 1' };
  }
  const close = closingFence(src);
  if (close < 0) return { ok: false, reason: 'missing closing `---` fence' };
  const lines = src.slice(OPEN_FENCE.length, close).split('\n');
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    const m = KEY_LINE.exec(line);
    if (m === null) {
      // +2: line 1 is the fence, and `lines` is 0-based.
      return { ok: false, reason: `line ${i + 2}: expected \`key: value\`, got ${JSON.stringify(line)}` };
    }
    const key = m[1] ?? '';
    if (Object.hasOwn(fields, key)) return { ok: false, reason: `duplicate key \`${key}\`` };
    let value = (m[2] ?? '').trim();
    const keyLine = i + 2;
    i += 1;
    const isBlock = value === '' || /^[|>][+-]?$/.test(value);
    if (!isBlock) {
      const malformed = malformedScalar(value);
      if (malformed !== null) return { ok: false, reason: `line ${keyLine}: \`${key}\`: ${malformed}` };
    }
    if (isBlock) {
      const block: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (!(next.startsWith(' ') || next.startsWith('\t') || next.trim() === '')) break;
        block.push(next.trim());
        i += 1;
      }
      while (block.length > 0 && block[block.length - 1] === '') block.pop();
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    }
    fields[key] = unquote(value);
  }
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
