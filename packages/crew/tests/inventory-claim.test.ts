// wicked-crew#721: an enumerating step's completeness claim, parsed off its reply.
import { describe, expect, it } from 'vitest';
import { inventoryComplete, parseInventoryClaims } from '../src/core/inventory-claim.js';

const block = (o: unknown) => '```wicked-inventory\n' + (typeof o === 'string' ? o : JSON.stringify(o)) + '\n```';

describe('parseInventoryClaims', () => {
  it('reads the codebook example (the #648 shape) as partial with the missing item named', () => {
    const text = `Found 9 issues.\n\n${block({ source: 'gh issue list -R o/r --state all', answered: 'partial', listed: 9, expected: 10, unread: ['issue #936: not in the API page'] })}`;
    expect(parseInventoryClaims(text)).toEqual([
      { source: 'gh issue list -R o/r --state all', answered: 'partial', listed: 9, expected: 10, unread: ['issue #936: not in the API page'] },
    ]);
  });

  it('keeps an honest full', () => {
    const [c] = parseInventoryClaims(block({ source: 's', answered: 'full', listed: 58, expected: 58, unread: [] }));
    expect(c?.answered).toBe('full');
    const [paged] = parseInventoryClaims(block({ source: 's', answered: 'full', listed: 3, expected: null, unread: [] }));
    expect(paged?.answered).toBe('full');
  });

  it('a full its own numbers contradict reads partial, and says why', () => {
    const [short] = parseInventoryClaims(block({ source: 's', answered: 'full', listed: 4, expected: 9, unread: [] }));
    expect(short?.answered).toBe('partial');
    expect(short?.unread.at(-1)).toMatch(/claimed full, but it lists 4 of the source's 9/);
    const [hole] = parseInventoryClaims(block({ source: 's', answered: 'full', listed: 9, expected: 9, unread: ['PRs: 403'] }));
    expect(hole?.answered).toBe('partial');
    const [nocount] = parseInventoryClaims(block({ source: 's', answered: 'full', expected: 9, unread: [] }));
    expect(nocount?.answered).toBe('partial');
  });

  it('a block that does not parse, or answers outside the vocabulary, reads unknown, never full', () => {
    expect(parseInventoryClaims(block('{not json'))[0]?.answered).toBe('unknown');
    expect(parseInventoryClaims(block('[1,2]'))[0]?.answered).toBe('unknown');
    const [odd] = parseInventoryClaims(block({ source: 's', answered: 'complete', listed: 1, expected: 1, unread: [] }));
    expect(odd?.answered).toBe('unknown');
  });

  it('reads one claim per block, in order, and nothing from a reply without one', () => {
    const two = `${block({ source: 'a', answered: 'full', listed: 1, expected: 1, unread: [] })}\n${block({ source: 'b', answered: 'none', listed: 0, expected: null, unread: ['gh: exit 4'] })}`;
    expect(parseInventoryClaims(two).map((c) => [c.source, c.answered])).toEqual([['a', 'full'], ['b', 'none']]);
    expect(parseInventoryClaims('no inventory here')).toEqual([]);
  });

  it('inventoryComplete: at least one claim, all full', () => {
    expect(inventoryComplete([])).toBe(false);
    expect(inventoryComplete(parseInventoryClaims(block({ source: 's', answered: 'full', listed: 1, expected: 1, unread: [] })))).toBe(true);
    expect(inventoryComplete(parseInventoryClaims(block({ source: 's', answered: 'none', listed: 0, expected: null, unread: [] })))).toBe(false);
  });
});
