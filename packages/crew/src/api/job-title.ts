/**
 * A run's SHORT JOB TITLE (`AgentSession.title`; api-types 0.113.0, operator ruling 2026-10-12: crew
 * derives the title, every skin shows the same one). Pure and deterministic, derived at DTO assembly
 * from what the run already records (`problem`), so it costs nothing on `GET /runs`, survives a
 * restart and never needs a model call.
 *
 * The rules, in order:
 *  1. Only the operator's words: an attached studio context pack (`---` + `[studio context pack …]`)
 *     and the engine's ` ||| ` step scaffold are cut off.
 *  2. Runs crew words itself: an onboarding run reads "Set up <repo>"; a chat's ask run (its problem
 *     is the chat-scope statement) reads "A conversation about <repos>".
 *  3. The first sentence or clause (a stop is `.`/`!`/`?`/`;` followed by a space, a line break, or a
 *     `:` after more than one word: "Recon: survey …" keeps its label).
 *  4. Still longer than {@link JOB_TITLE_MAX}: cut at the first aside (" — ", ", meaning", " when ",
 *     " because ", " (" …) that leaves a real headline (a clause end: no ellipsis); then, if still too
 *     long, at a word boundary with an ellipsis, the ellipsis inside the budget.
 *  5. A lowercase first word is capitalised unless it looks like an identifier (`repo-learn`).
 *
 * The full problem stays on the run (`problem`); a skin shows it on hover.
 */

/** The longest title, in characters (a headline that fits one or two lines of a list row). */
export const JOB_TITLE_MAX = 60;

/** The shortest headline an aside cut may leave (shorter, and the cut is not worth it). */
const MIN_HEAD = 16;

const CONTEXT_PACK = /\n\s*-{3,}\s*\n\s*\[studio context pack\b[\s\S]*$/i;
const CHAT_SCOPE = /^#\s*Chat scope\s*\n\s*This directory is the scratch root of wicked-crew chat\b/i;
const ONBOARD = /^Onboard repository:\s+(\S+)/;

/** Asides that end a headline, earliest first. */
const ASIDES = [' — ', ' – ', ' - ', ', meaning ', ', so that ', ', so ', ', which ', ', because ', ' because ', ' so that ', ' when ', ' (', ', '];

export function jobTitle(problem: string | null | undefined): string {
  const raw = (problem ?? '').replace(CONTEXT_PACK, '');
  const bar = raw.indexOf(' ||| ');
  const text = (bar === -1 ? raw : raw.slice(0, bar)).trim();
  if (text === '') return 'Untitled job';

  const onboard = ONBOARD.exec(text);
  if (onboard !== null) return clip(`Set up ${onboard[1]}`);
  if (CHAT_SCOPE.test(text)) return clip(conversationTitle(text));

  const firstLine = text.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '');
  let clause = firstClause(firstLine).trim();
  if (clause === '') clause = firstLine.trim();
  if (clause.length > JOB_TITLE_MAX) clause = beforeAside(clause);
  return capitalise(clip(clause.replace(/[\s,;:·—–-]+$/, '')));
}

function conversationTitle(statement: string): string {
  const repos = [...statement.matchAll(/^- \*\*([^*\n]+)\*\*/gm)].map((m) => m[1]!.trim()).filter((r) => r !== '');
  if (repos.length > 0) {
    const about = repos.length <= 2 ? repos.join(' and ') : `${repos.slice(0, 2).join(', ')} and ${repos.length - 2} more`;
    return `A conversation about ${about}`;
  }
  if (/^## Scope: system\b/m.test(statement)) return 'A conversation about the wicked platform';
  return 'A conversation';
}

/** Where the first clause ends: `.`/`!`/`?`/`;` before whitespace, a line break, or a `:` after
 *  more than one word (a one-word label like "Recon:" belongs to its headline). */
function firstClause(text: string): string {
  const stops = /[.!?:;](?=\s)|\n/g;
  for (let m = stops.exec(text); m !== null; m = stops.exec(text)) {
    if (m[0] === ':' && !/\s/.test(text.slice(0, m.index).trim())) continue;
    return text.slice(0, m.index);
  }
  return text;
}

function beforeAside(clause: string): string {
  let best = -1;
  for (const a of ASIDES) {
    const at = clause.indexOf(a, MIN_HEAD);
    if (at >= MIN_HEAD && (best === -1 || at < best)) best = at;
  }
  return best === -1 ? clause : clause.slice(0, best);
}

function clip(s: string): string {
  if (s.length <= JOB_TITLE_MAX) return s;
  // The ellipsis counts against the budget: the head is at most MAX - 1 characters.
  const room = JOB_TITLE_MAX - 1;
  const cut = s.slice(0, room);
  // A cut that lands exactly on a word's end keeps that word.
  const atWord = s.charAt(room) === ' ' ? room : cut.lastIndexOf(' ');
  const head = (atWord >= MIN_HEAD ? cut.slice(0, atWord) : cut).replace(/[\s,;:·—–-]+$/, '');
  return `${head}…`;
}

function capitalise(s: string): string {
  const first = s.split(/\s/, 1)[0] ?? '';
  // An identifier keeps its spelling: `repo-learn`, `capture_learnings`, `src/api`, `v2`.
  if (/[-_/.\d]/.test(first) || !/^[a-z]/.test(first)) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
