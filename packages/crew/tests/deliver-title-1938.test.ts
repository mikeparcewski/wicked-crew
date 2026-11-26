/**
 * crew#1938: `/refactor polish` delivered a PR titled `chore: Kind: polish`. Crew puts a card's framing line first in
 * the run's brief (`withBriefLines`, routes.ts POST /runs: "Kind: polish. Small, safe quality fixes only; no
 * restructuring." then a blank line, then the person's ask), and the title took that line's first sentence. A framing
 * line is crew's own, like the `Repository:` routing line (crew#1516): it never titles the PR; the ask does.
 */
import { describe, expect, it } from 'vitest';
import { commitSubject, deliverTitle } from '../src/core/deliver-text.js';
import { CATALOG_V2_CARDS } from '../src/workflow-catalog/catalog-data-v2.js';
import { DEPTH_LINES, REPORT_DEPTH_LINES, withBriefLines } from '../src/workflow-catalog/shape.js';

// The train-14 ask (tiny-math-t14), as the person typed it.
const ASK = 'README.md line 3 lists only some helpers. Update that one line to list every helper the module exports.';

const polish = CATALOG_V2_CARDS.flatMap((c) => c.variant?.options ?? []).find((o) => o.id === 'polish');

describe('crew#1938: a card\'s framing line never titles the delivered PR', () => {
  it('/refactor polish: the title and commit subject come from the ask', () => {
    expect(polish?.brief).toBe('Kind: polish. Small, safe quality fixes only; no restructuring.');
    // The run's problem exactly as POST /runs writes it for a shaped launch.
    const problem = withBriefLines(ASK, [polish!.brief!]);
    const title = deliverTitle(problem, 'r-1938', 'refactor');
    expect(title).toBe('chore: README.md line 3 lists only some helpers');
    expect(commitSubject(title)).toBe('chore: README.md line 3 lists only some helpers');
  });

  it('every framing line in the catalog, and every depth line, is skipped', () => {
    const briefs = CATALOG_V2_CARDS.flatMap((c) => [c.brief, ...(c.variant?.options ?? []).map((o) => o.brief)])
      .filter((b): b is string => typeof b === 'string' && b.trim() !== '');
    expect(briefs.length).toBeGreaterThan(20);
    for (const line of [...briefs, ...Object.values(DEPTH_LINES), ...Object.values(REPORT_DEPTH_LINES)]) {
      expect(deliverTitle(withBriefLines(ASK, [line]), 'r', 'refactor'), line).toBe('chore: README.md line 3 lists only some helpers');
    }
    // A framing line and a depth line together, as an Investigate card's option with a depth writes them.
    expect(deliverTitle(withBriefLines(ASK, [briefs[0]!, DEPTH_LINES.deep]), 'r', 'bug')).toBe('fix: README.md line 3 lists only some helpers');
  });

  it('a person\'s own "Kind:" line is theirs, and still titles the PR', () => {
    expect(deliverTitle('Kind: a new helper for the README.\n\nAdd it.', 'r', 'refactor')).toBe('chore: Kind: a new helper for the README');
  });

  it('a run with only the framing line names the run, not the line', () => {
    expect(deliverTitle(withBriefLines('', [polish!.brief!]), 'r-only', 'refactor')).toBe('wicked-crew run r-only');
  });
});
