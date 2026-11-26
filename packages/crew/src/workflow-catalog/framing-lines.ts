/**
 * The lines crew puts first in a shaped launch's brief (DES-CATALOG-002 §4.4): a card's or option's framing line
 * ("Kind: polish. …", "Focus: …", "Lens: …") and an Investigate card's depth line. They are crew's words, never the
 * person's ask, so a delivered PR is never titled by one (crew#1938).
 */
import { CATALOG_V2_CARDS } from './catalog-data-v2.js';

export const DEPTH_LINES: Readonly<Record<'quick' | 'standard' | 'deep', string>> = {
  quick: 'Depth: quick. Find the likeliest cause and stop there, each claim cited.',
  standard: 'Depth: standard. Find the cause and what led to it, each claim cited.',
  deep: 'Depth: deep. Trace every contributing cause and the timeline, each claim cited.',
};

/** A sourced report's depth (Research, Competitive, Due diligence): neutral lines, since there is no cause to find. */
export const REPORT_DEPTH_LINES: Readonly<Record<'quick' | 'standard' | 'deep', string>> = {
  quick: 'Depth: quick. Answer from the strongest sources and stop there, each claim cited.',
  standard: 'Depth: standard. Cover the main sources and where they disagree, each claim cited.',
  deep: 'Depth: deep. Read every source in reach and reconcile each conflict, each claim cited.',
};

/** Every framing and depth line crew can put first in a brief, trimmed, as `briefLines` writes them. */
export const FRAMING_LINES: ReadonlySet<string> = new Set(
  [
    ...CATALOG_V2_CARDS.flatMap((c) => [c.brief, ...(c.variant?.options ?? []).map((o) => o.brief)]),
    ...Object.values(DEPTH_LINES),
    ...Object.values(REPORT_DEPTH_LINES),
  ]
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.trim())
    .filter((line) => line !== ''),
);
