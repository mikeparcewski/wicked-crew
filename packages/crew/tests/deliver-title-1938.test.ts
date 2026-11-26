/**
 * crew#1938: `/refactor polish` delivered a PR titled `chore: Kind: polish`. Crew puts a card's framing line first in
 * the run's brief (`withBriefLines`, routes.ts POST /runs: "Kind: polish. Small, safe quality fixes only; no
 * restructuring." then a blank line, then the person's ask), and the title took that line's first sentence. A framing
 * line is crew's own, like the `Repository:` routing line (crew#1516): it never titles the PR; the ask does.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreAdapter } from '../src/core/adapter.js';
import { commitSubject, deliverTitle } from '../src/core/deliver-text.js';
import { buildWorkflowCatalogV2, resolveOption, servedState, type ServedState } from '../src/workflow-catalog/build-v2.js';
import { CATALOG_V2_CARDS } from '../src/workflow-catalog/catalog-data-v2.js';
import { briefLines, checkLaunchShape, launchShapeOf, withBriefLines } from '../src/workflow-catalog/shape.js';
import { removeScratch } from './setup/scratch.js';

// The train-14 ask (tiny-math-t14), as the person typed it.
const ASK = 'README.md line 3 lists only some helpers. Update that one line to list every helper the module exports.';

const refactor = CATALOG_V2_CARDS.find((c) => (c.variant?.options ?? []).some((o) => o.id === 'polish'))!;

// The catalog the daemon serves, through the engine's own built-in catalog (as tests/shape-corrections.test.ts reads it).
const dir = mkdtempSync(join(tmpdir(), 'deliver-title-1938-'));
let served: ServedState & { rev: string };
beforeAll(async () => {
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => undefined);
  const defs = adapter.listWorkflows();
  const presets = await adapter.listPresets();
  const entries = await adapter.catalog();
  served = { ...servedState({ defs, presets, entries }), rev: buildWorkflowCatalogV2({ defs, presets, entries, runs: [], actorId: '', projectId: null }).rev };
  adapter.close();
});
afterAll(() => removeScratch(dir));

describe('crew#1938: a card\'s framing line never titles the delivered PR', () => {
  it('/refactor polish: the title and commit subject come from the ask', () => {
    // The run's problem exactly as POST /runs writes it for a shaped launch (routes.ts: checkLaunchShape, then
    // `b.problem = withBriefLines(b.problem, verdict.lines)`).
    const verdict = checkLaunchShape(launchShapeOf({ card: refactor.id, option: 'polish', depth: null, by: 'person', catalogRev: served.rev }), { kind: 'run', workflow: 'refactor' }, served);
    if (!verdict.ok) throw new Error(JSON.stringify(verdict.body));
    expect(verdict.lines).toEqual(['Kind: polish. Small, safe quality fixes only; no restructuring.']);
    const problem = withBriefLines(ASK, verdict.lines);
    const title = deliverTitle(problem, 'r-1938', 'refactor');
    expect(title).toBe('chore: README.md line 3 lists only some helpers');
    expect(commitSubject(title)).toBe('chore: README.md line 3 lists only some helpers');
  });

  it('whatever lines crew writes for any card, option and depth, the ask titles the PR', () => {
    let framed = 0;
    for (const card of CATALOG_V2_CARDS) {
      const options = card.variant?.options.map((o) => o.id) ?? [null];
      const depths = card.depth === true ? (['quick', 'standard', 'deep'] as const) : [null];
      for (const option of options) {
        const r = resolveOption(card.id, option, served);
        if (r === null) continue;
        for (const depth of depths) {
          const lines = briefLines(r, depth);
          if (lines.length === 0) continue;
          framed += 1;
          expect(deliverTitle(withBriefLines(ASK, lines), 'r', 'refactor'), `${card.id} ${option ?? ''} ${depth ?? ''}`)
            .toBe('chore: README.md line 3 lists only some helpers');
        }
      }
    }
    expect(framed).toBeGreaterThan(30);
  });

  it('only crew\'s exact lines are skipped: a person\'s own "Kind:" line, or one near a framing line, titles the PR', () => {
    expect(deliverTitle('Kind: a new helper for the README.\n\nAdd it.', 'r', 'refactor')).toBe('chore: Kind: a new helper for the README');
    expect(deliverTitle('Kind: polish. Small, safe quality fixes only; and rename the helper.\n\nAdd it.', 'r', 'refactor')).toBe('chore: Kind: polish');
  });

  it('a run with only the framing line names the run, not the line', () => {
    expect(deliverTitle(withBriefLines('', ['Kind: polish. Small, safe quality fixes only; no restructuring.']), 'r-only', 'refactor')).toBe('wicked-crew run r-only');
  });
});
