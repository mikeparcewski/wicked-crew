/**
 * The run's WORKING DOCUMENT (program DES-POWER-MODE §8.3, §9; spike 3): its sections, the HTML a new one starts as,
 * and the reading of a version back into section texts. Pure.
 *
 * The document is a wicked-interactive document of kind `phase-report` (see `store.ts` for the binding). Each section
 * is ONE element with a `data-wid` anchor and no anchored element inside it, so a section is rewritten with ONE
 * deterministic `content-edit` (interactive's text-not-markup edit, regenerate.js #247) and never needs a model.
 */

export const SECTION_IDS = ['goal', 'approach', 'decisions', 'constraints', 'questions', 'next'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  goal: 'Goal',
  approach: 'Approach',
  decisions: 'Decisions',
  constraints: 'Constraints and steering',
  questions: 'Open questions',
  next: 'Next and trailing work',
};

/** What an edit of a section does to the run (§9): `next` = one steering note for the next step, `standing` = a
 *  standing steer re-sent before every later step, `record` = kept in the document only. */
export type SteerKind = 'next' | 'standing' | 'record';
export const SECTION_STEER: Readonly<Record<SectionId, SteerKind>> = {
  goal: 'next',
  approach: 'next',
  next: 'next',
  constraints: 'standing',
  decisions: 'record',
  questions: 'record',
};

/** The sections a PLUGIN may write (its own generated lines). Everything else is a person's. */
export const PLUGIN_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>(['decisions']);

/** Most characters one section holds. */
export const SECTION_MAX_CHARS = 4_000;

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v);
}

export function anchorOf(id: SectionId): string {
  return `wd-${id}`;
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The first version of a run's working document. */
export function initialHtml(title: string, texts: Partial<Record<SectionId, string>>): string {
  const sections = SECTION_IDS.map((id) => (
    `<section class="wd-section"><h2>${escapeHtml(SECTION_LABELS[id])}</h2>`
    + `<div class="wd-text" data-wid="${anchorOf(id)}">${escapeHtml((texts[id] ?? '').replace(/\r\n?/g, '\n'))}</div></section>`
  )).join('\n');
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>'
    + escapeHtml(`Working document: ${title}`)
    + '</title><style>body{font:15px/1.55 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px}'
    + 'h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin:22px 0 6px}'
    + '.wd-text{white-space:pre-wrap;min-height:1.4em}</style></head>\n<body>\n<h1>'
    + escapeHtml(`Working document: ${title}`) + '</h1>\n' + sections + '\n</body></html>\n';
}

/** A numeric reference's character, or the reference as written when it names no character. */
const codePoint = (cp: number, raw: string): string => (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : raw);

const decodeEntities = (s: string): string => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => codePoint(parseInt(n, 16), m))
  .replace(/&#(\d+);/g, (m, n: string) => codePoint(Number(n), m))
  .replace(/&amp;/g, '&');

/**
 * A section's text as one content-edit value. interactive's feedback file is line-based (`- value: …`, trimmed, and
 * read as inline YAML when it starts with `[` or `{`), so a line break travels as U+2028 LINE SEPARATOR (a mandatory
 * line break when the document is rendered) and a leading bracket behind a zero-width space. {@link sectionsOf}
 * undoes both.
 */
export function encodeSectionText(text: string): string {
  const one = text.replace(/\r\n?/g, '\n').replace(/\n/g, '\u2028');
  return /^[[{]/u.test(one) ? `\u200b${one}` : one;
}

function decodeSectionText(text: string): string {
  return text.replace(/^\u200b/u, '').replace(/\u2028/g, '\n');
}

/** The text of each section in a version's HTML (a section the version lacks is absent). Only the anchored element's
 *  own text: the content edit writes text, so there is no markup inside to keep. */
export function sectionsOf(html: string): Partial<Record<SectionId, string>> {
  const out: Partial<Record<SectionId, string>> = {};
  for (const id of SECTION_IDS) {
    const re = new RegExp(`<div\\b[^>]*\\bdata-wid="${anchorOf(id)}"[^>]*>([\\s\\S]*?)</div>`, 'u');
    const m = re.exec(html);
    if (m !== null) out[id] = decodeSectionText(decodeEntities((m[1] ?? '').replace(/<[^>]*>/g, '')));
  }
  return out;
}

/** The sections whose text differs between two versions. */
export function changedSections(before: Partial<Record<SectionId, string>>, after: Partial<Record<SectionId, string>>): SectionId[] {
  return SECTION_IDS.filter((id) => after[id] !== undefined && (before[id] ?? '') !== after[id]);
}
