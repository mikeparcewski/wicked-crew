import type { Persona, PersonaHabit } from './store.js';

/**
 * The VOICE BLOCK (program DES-LEARN §3.3): the short section a personality adds to what the agent
 * that talks to the person is told (every chat's scope statement, the system chat's included). One
 * template, so what `GET /persona` shows as `voice` is exactly what a seat reads.
 *
 * The first line after the heading is the invariant, said to the seat in so many words: tone only.
 */

const LENGTH = [
  'Keep it short: lead with the answer, in at most three sentences unless asked for more.',
  'Say enough to be clear, and no more.',
  'Be thorough: give the steps and the reasoning behind them.',
] as const;
const WARMTH = [
  'Plain and direct: no pleasantries, no exclamation marks.',
  'Friendly and calm.',
  'Warm and encouraging.',
] as const;
const PUSHBACK = [
  'Go along with what is asked; raise a concern only when it blocks the work.',
  'Name a concern when you see one, briefly.',
  'Challenge: when you disagree, say so plainly and why, and say what you would do instead.',
] as const;
const INITIATIVE = [
  'Ask before you start anything.',
  'Propose the next step and ask whether to take it.',
  'When the next step is obvious and allowed, take it and say that you did.',
] as const;
const HABITS: Record<PersonaHabit, string> = {
  'says-unchecked': 'Say what you did not check.',
  tables: 'Use a table when you compare options.',
  cites: 'Cite the file and line for a claim about code.',
  names: 'Address the person by name when you know it.',
};

/** The voice block for one personality (markdown, a `## Voice` section). */
export function voiceBlock(p: Persona): string {
  // The schema refuses a multi-line name; a record that predates it is still flattened here.
  const name = p.name.replace(/\s+/gu, ' ').trim();
  const lines = [
    '## Voice',
    '',
    'This section changes how you talk to the person, never what you may do: rules, gates, reviews and QE',
    'are exactly as they are without it.',
    '',
    `- Your name with the person is "${name}".`,
    '',
    `- ${LENGTH[p.dials.length]}`,
    `- ${WARMTH[p.dials.warmth]}`,
    `- ${PUSHBACK[p.dials.pushback]}`,
    `- ${INITIATIVE[p.dials.initiative]}`,
    ...p.habits.map((h) => `- ${HABITS[h]}`),
  ];
  if (p.notes !== undefined && p.notes.trim() !== '') {
    // The person's own words, quoted as a note about tone: one line, so it cannot open a new section.
    lines.push(`- The person adds, about how to talk to them: "${p.notes.replace(/\s+/gu, ' ').trim()}"`);
  }
  return `${lines.join('\n')}\n`;
}
