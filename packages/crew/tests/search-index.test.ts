// `GET /search`'s index (search-index.ts): parsing, matching, ranking, spans and snippets, the
// per-type text budget, and the scan's three exits — done, budget (`partial`), aborted.

import { describe, expect, it } from 'vitest';

import { SearchIndex, capText, fold, parseQuery, type SearchDoc } from '../src/api/search-index.js';

const DAY = 86_400_000;
const AT = Date.UTC(2026, 9, 18);

function run(id: string, title: string, body = '', over: Partial<SearchDoc> = {}): SearchDoc {
  return {
    type: 'run', id, title, body, updatedAt: AT - DAY, projectId: null, status: 'completed',
    target: { kind: 'run', run_id: id, chat_id: null }, ...over,
  };
}

const ALL = { types: ['run', 'project', 'repo', 'transcript', 'rule', 'memory', 'doc'] as const, limit: 5, budgetMs: 5_000, at: AT };

describe('parseQuery / fold', () => {
  it('splits words, keeps "quoted phrases" whole, folds case and drops repeats', () => {
    expect(parseQuery('  Auth "Rate Limit"  auth ').terms).toEqual(['auth', 'rate limit']);
  });

  it('fold never changes the length, so folded offsets are original offsets', () => {
    const s = 'İstanbul Straße ÉCOLE';
    expect(fold(s)).toHaveLength(s.length);
    expect(fold('ABC')).toBe('abc');
  });
});

describe('matching and ranking', () => {
  it('every word must match (title or body); a missing word drops the entity', async () => {
    const ix = new SearchIndex();
    ix.upsert(run('a', 'add rate limiting', 'to the upload endpoint'));
    ix.upsert(run('b', 'rate the deck'));
    const { groups } = await ix.query(parseQuery('rate upload'), { ...ALL });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hits.map((h) => h.id)).toEqual(['a']);
    expect(groups[0]!.total).toBe(1);
  });

  it('a title match outranks a body-only match; a word-start beats mid-word', async () => {
    const ix = new SearchIndex();
    ix.upsert(run('body', 'refactor middleware', 'the auth tables move'));
    ix.upsert(run('mid', 'oauthless login'));
    ix.upsert(run('title', 'migrate the auth tables'));
    const { groups } = await ix.query(parseQuery('auth'), { ...ALL });
    expect(groups[0]!.hits.map((h) => h.id)).toEqual(['title', 'mid', 'body']);
  });

  it('recency breaks a tie in text; an archived entity (negative boost) ranks after a live one', async () => {
    const ix = new SearchIndex();
    ix.upsert(run('old', 'deploy the site', '', { updatedAt: AT - 60 * DAY }));
    ix.upsert(run('new', 'deploy the site', '', { updatedAt: AT - DAY }));
    ix.upsert(run('arch', 'deploy the site', '', { updatedAt: AT, boost: -3, status: 'archived' }));
    const { groups } = await ix.query(parseQuery('deploy'), { ...ALL });
    expect(groups[0]!.hits.map((h) => h.id)).toEqual(['new', 'old', 'arch']);
  });

  it('a whole-phrase match outranks the same words apart', async () => {
    const ix = new SearchIndex();
    ix.upsert(run('apart', 'limit the rate of uploads'));
    ix.upsert(run('phrase', 'the rate limit of uploads'));
    const { groups } = await ix.query(parseQuery('rate limit'), { ...ALL });
    expect(groups[0]!.hits[0]!.id).toBe('phrase');
  });

  it('groups come in type order, each with its own total and cursor', async () => {
    const ix = new SearchIndex();
    for (let i = 0; i < 7; i += 1) ix.upsert(run(`r${i}`, `upload job ${i}`));
    ix.upsert({ type: 'project', id: 'p1', title: 'upload-endpoint', body: '', updatedAt: null, projectId: 'p1', status: 'active', target: { kind: 'project', project_id: 'p1' } });
    const { groups } = await ix.query(parseQuery('upload'), { ...ALL, limit: 3 });
    expect(groups.map((g) => g.type)).toEqual(['run', 'project']);
    expect(groups[0]!.total).toBe(7);
    expect(groups[0]!.hits).toHaveLength(3);
    expect(groups[0]!.next_cursor).toBe('3');
    const page2 = await ix.query(parseQuery('upload'), { ...ALL, types: ['run'], limit: 3, offset: 6 });
    expect(page2.groups[0]!.hits).toHaveLength(1);
    expect(page2.groups[0]!.next_cursor).toBeNull();
  });
});

describe('spans and snippets', () => {
  it('title spans cover every occurrence of every word, merged', async () => {
    const ix = new SearchIndex();
    ix.upsert(run('a', 'Auth: auth tables'));
    const { groups } = await ix.query(parseQuery('auth tab'), { ...ALL });
    const hit = groups[0]!.hits[0]!;
    expect(hit.title_spans).toEqual([[0, 4], [6, 10], [11, 14]]);
    expect(hit.title_spans.map(([s, e]) => hit.title.slice(s, e))).toEqual(['Auth', 'auth', 'tab']);
  });

  it('the snippet is a window around the match, whitespace collapsed, cut with …, spans on the snippet', async () => {
    const ix = new SearchIndex();
    const body = `${'lorem ipsum '.repeat(30)}the  Gate\n\nrefused the deliver step ${'dolor sit '.repeat(30)}`;
    ix.upsert(run('a', 'a run', body));
    const { groups } = await ix.query(parseQuery('gate refused'), { ...ALL });
    const hit = groups[0]!.hits[0]!;
    expect(hit.snippet!.startsWith('…')).toBe(true);
    expect(hit.snippet!.endsWith('…')).toBe(true);
    expect(hit.snippet).toContain('the Gate refused the deliver step');
    expect(hit.snippet_spans.map(([s, e]) => hit.snippet!.slice(s, e))).toEqual(['Gate', 'refused']);
  });

  it('a hit with an empty body has no snippet', async () => {
    const ix = new SearchIndex();
    ix.upsert(run('a', 'upload'));
    const { groups } = await ix.query(parseQuery('upload'), { ...ALL });
    expect(groups[0]!.hits[0]!.snippet).toBeNull();
  });
});

describe('bounds', () => {
  it('a body past maxBodyChars keeps its head and tail, so a word at either end still matches', async () => {
    const ix = new SearchIndex({ maxBodyChars: 1000 });
    const big = `HEADWORD ${'x'.repeat(5 * 1024 * 1024)} TAILWORD`;
    ix.upsert(run('big', 'a big transcript', big));
    expect(ix.chars('run')).toBeLessThanOrEqual(1010);
    for (const w of ['headword', 'tailword']) {
      const { groups } = await ix.query(parseQuery(w), { ...ALL });
      expect(groups[0]?.hits[0]?.id).toBe('big');
    }
    expect(capText('abcdef', 10)).toBe('abcdef');
  });

  it('past maxCharsPerType the least recently updated entities leave first', () => {
    const ix = new SearchIndex({ maxCharsPerType: 250 });
    ix.upsert(run('old', 't', 'o'.repeat(100), { updatedAt: AT - 9 * DAY }));
    ix.upsert(run('mid', 't', 'm'.repeat(100), { updatedAt: AT - 5 * DAY }));
    ix.upsert(run('new', 't', 'n'.repeat(100), { updatedAt: AT }));
    expect(ix.ids('run').sort()).toEqual(['mid', 'new']);
    expect(ix.chars('run')).toBe(200);
  });

  it('replaceType drops what the source no longer holds; an unchanged text keeps its fold but takes new facts', async () => {
    const ix = new SearchIndex();
    ix.replaceType('run', [run('a', 'alpha'), run('b', 'beta')]);
    ix.replaceType('run', [run('b', 'beta', '', { status: 'failed' })]);
    expect(ix.ids('run')).toEqual(['b']);
    const { groups } = await ix.query(parseQuery('beta'), { ...ALL });
    expect(groups[0]!.hits[0]!.status).toBe('failed');
  });
});

describe('the scan never holds the loop', () => {
  function bigIndex(n: number): SearchIndex {
    const ix = new SearchIndex({ maxCharsPerType: 1 << 30 });
    const filler = 'the quick brown fox jumps over the lazy dog '.repeat(200); // ~9 KB
    for (let i = 0; i < n; i += 1) ix.upsert(run(`r${i}`, `job ${i}`, `${filler} needle${i % 50}`));
    return ix;
  }

  it('stops at the budget with partial: true', async () => {
    const ix = bigIndex(3_000);
    let t = 0;
    // A clock that moves 1 ms per read: the budget of 20 reads ends the scan long before 3,000 docs.
    const res = await ix.query(parseQuery('needle7'), { ...ALL, budgetMs: 20, now: () => (t += 1) });
    expect(res.partial).toBe(true);
    expect(res.groups[0]?.total ?? 0).toBeLessThan(60);
  });

  it('yields while it scans: the loop gets a turn at least every few ms of scanning', async () => {
    const ix = bigIndex(6_000); // ~54 MB of text
    // A self-rescheduling immediate counts the loop turns the scan gives away.
    let turns = 0;
    let on = true;
    const spin = (): void => { turns += 1; if (on) setImmediate(spin); };
    setImmediate(spin);
    const started = performance.now();
    const res = await ix.query(parseQuery('needle7 lazy'), { ...ALL, budgetMs: 10_000 });
    const took = performance.now() - started;
    on = false;
    expect(res.partial).toBe(false);
    expect(res.groups[0]!.total).toBe(120);
    // One turn per ~4 ms slice (SLICE_MS); allow generous slack for a loaded CI runner.
    expect(turns).toBeGreaterThanOrEqual(Math.floor(took / 16));
    expect(turns).toBeGreaterThan(1);
  });

  it('an aborted signal stops the scan with its reason', async () => {
    const ix = bigIndex(2_000);
    const ac = new AbortController();
    const p = ix.query(parseQuery('needle7'), { ...ALL, signal: ac.signal });
    ac.abort(new Error('superseded'));
    await expect(p).rejects.toThrow('superseded');
  });
});
