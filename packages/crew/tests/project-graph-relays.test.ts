// crew#1713, crew#1714: the project graph routes relay estate's freshness, `via` rows and link state for
// CURRENT members only. Every fixture is real `wicked-estate 0.35.10` output (tests/fixtures/estate-0.35.10,
// README there): `gone` was indexed into the project store and is not a member any more, as after a detach
// that has not been refreshed since.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { projectBlastRadius, projectGraphPath, type Queryable } from '../src/projects/graph.js';
import { removeScratch } from './setup/scratch.js';

const dir = mkdtempSync(join(tmpdir(), 'project-graph-relays-'));
afterAll(() => removeScratch(dir));

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture = (name: string): Doc =>
  JSON.parse(readFileSync(new URL(`./fixtures/estate-0.35.10/${name}`, import.meta.url), 'utf8')) as Doc;

/** A fake estate that prints `reply` for any query; an array is pages, `pages[k]` for `--cursor c<k>`. */
function estate(reply: unknown): NodeJS.ProcessEnv {
  const pages = Array.isArray(reply) ? reply : [reply];
  const exe = join(dir, `estate-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(exe, `#!/usr/bin/env node
const argv = process.argv.slice(2);
const at = argv.indexOf('--cursor');
const pages = ${JSON.stringify(pages)};
process.stdout.write(JSON.stringify(pages[at >= 0 ? Number(argv[at + 1].slice(1)) : 0]));
`);
  chmodSync(exe, 0o755);
  return { ...process.env, WICKED_ESTATE_EXE: exe };
}

const q = {
  ok: true,
  dbPath: join(dir, 'graph.db'),
  labels: new Map([['api', 'repo-api'], ['web', 'repo-web']]),
  status: { projectId: 'p1', missingRepos: [] },
} as unknown as Extract<Queryable, { ok: true }>;

describe.skipIf(process.platform === 'win32')('blast-radius freshness names current members only (crew#1713)', () => {
  it('a removed member\'s stale file leaves the sample and the total, and its label leaves `indexing`', async () => {
    const raw = fixture('blast-radius-removed-member.json');
    // Real: estate counts `gone/src/index.ts` (stale_files_total 2). `indexing` lists labels with a
    // run marker (estate freshness.rs indexing_roots); none was mid-index at capture, so set one.
    expect(raw['freshness']['stale_files_total']).toBe(2);
    raw['freshness']['indexing'] = ['gone', 'api'];
    const out = await projectBlastRadius(q, 'charge', estate(raw));
    expect(out.freshness).toMatchObject({
      stale_files: [{ repoId: 'repo-api', repo: 'api', file: 'src/index.ts', status: 'modified' }],
      stale_files_total: 1,
      indexing: ['api'],
    });
    expect(JSON.stringify(out)).not.toContain('gone');
  });

  it('a removed member\'s stale file past the sample still leaves the total (read off its stale-marked rows)', async () => {
    const raw = fixture('blast-radius-removed-member.json');
    // As when estate's 20-file sample is full: the total counts a file the sample does not list.
    raw['freshness']['stale_files'] = raw['freshness']['stale_files'].filter((r: Doc) => !String(r['file']).startsWith('gone/'));
    const out = await projectBlastRadius(q, 'charge', estate(raw));
    expect(out.freshness?.stale_files_total).toBe(1);
  });

  it('a page whose stale evidence estate\'s budget dropped marks its total partial when it has rows outside the members (crew#1797)', async () => {
    // As estate's R4 budget leaves a full page (freshness.rs, the end of FreshnessProbe::annotate): the row marks
    // dropped, then the sample emptied, the count kept. Nothing names which counted file is `gone`'s.
    const stripped = (raw: Doc): Doc => {
      raw['freshness']['stale_files'] = [];
      for (const row of raw['dependents'] as Doc[]) delete row['stale'];
      return raw;
    };
    const out = await projectBlastRadius(q, 'charge', estate(stripped(fixture('blast-radius-removed-member.json'))));
    expect(out.freshness).toMatchObject({ stale_files_total: 2, stale_files_total_partial: true });
    // Across pages: one partial page makes the joined total partial.
    const paged = await projectBlastRadius(q, 'charge', estate([
      { ...fixture('blast-radius-removed-member.json'), next_cursor: 'c1' },
      stripped(fixture('blast-radius-removed-member.json')),
    ]));
    expect(paged.freshness).toMatchObject({ stale_files_total: 3, stale_files_total_partial: true });
    // The same stripped page with only current members' rows is exact: no other repository's file can be in the count.
    const members = stripped(fixture('blast-radius-removed-member.json'));
    members['dependents'] = (members['dependents'] as Doc[]).filter((r) => !String(r['file']).startsWith('gone/'));
    const exact = await projectBlastRadius(q, 'charge', estate(members));
    expect(exact.freshness?.stale_files_total).toBe(2);
    expect(exact.freshness).not.toHaveProperty('stale_files_total_partial');
    // Complete evidence (the marks are there) is exact too.
    const marked = await projectBlastRadius(q, 'charge', estate(fixture('blast-radius-removed-member.json')));
    expect(marked.freshness).not.toHaveProperty('stale_files_total_partial');
  });

  it('a budgeted page whose sample already names every outside file stays exact (review r1)', async () => {
    // Marks dropped, the sample kept (it names `gone`'s file), and more counted than sampled: every file outside the
    // members is accounted for, so what the sample does not name is the members' own.
    const raw = fixture('blast-radius-removed-member.json');
    for (const row of raw['dependents'] as Doc[]) delete row['stale'];
    raw['freshness']['stale_files_total'] = 22;
    const out = await projectBlastRadius(q, 'charge', estate(raw));
    expect(out.freshness?.stale_files_total).toBe(21);
    expect(out.freshness).not.toHaveProperty('stale_files_total_partial');
  });

  it('a name miss counts its suggestions\' files: an outside one with budgeted evidence makes the total partial (review r1)', async () => {
    // estate's name-miss rows (wicked-estate-retrieve suggest.rs `suggestions_json`); the freshness probe counts their
    // files too (freshness.rs `collect_files`). The budget stripped the sample.
    const suggestion = (file: string) => ({ symbol: `ts . ${file}/charge().`, name: 'charge', kind: 'Function', file, line_1based: 3, match_reason: 'fuzzy', distance: 1 });
    const miss = (files: string[]) => {
      const raw = fixture('blast-radius-removed-member.json');
      raw['dependents'] = [];
      raw['resolved'] = false;
      raw['suggestions'] = files.map(suggestion);
      raw['freshness']['stale_files'] = [];
      raw['freshness']['stale_files_total'] = 1;
      return raw;
    };
    const outside = await projectBlastRadius(q, 'charge', estate(miss(['api/src/index.ts', 'gone/src/index.ts'])));
    expect(outside.freshness).toMatchObject({ stale_files_total: 1, stale_files_total_partial: true });
    const inside = await projectBlastRadius(q, 'charge', estate(miss(['api/src/index.ts'])));
    expect(inside.freshness).not.toHaveProperty('stale_files_total_partial');
  });

  it('per page: a removed member\'s file on two pages leaves both pages\' totals (codex r1)', async () => {
    // Each page counts its own files (crew#1556 sums them): `api` and `gone` are stale on both pages.
    const first = { ...fixture('blast-radius-removed-member.json'), next_cursor: 'c1' };
    const second = fixture('blast-radius-removed-member.json');
    const out = await projectBlastRadius(q, 'charge', estate([first, second]));
    // Raw sum 4 (2 + 2); each page drops `gone`: 1 + 1, the `api` file counted once per page as before.
    expect(out.freshness?.stale_files_total).toBe(2);
    expect(JSON.stringify(out.freshness)).not.toContain('gone');
  });
});

describe.skipIf(process.platform === 'win32')('blast-radius rows carry estate\'s via edges (crew#1714)', () => {
  it('each current member\'s row keeps `via` and `via_omitted` as estate wrote them', async () => {
    const out = await projectBlastRadius(q, 'charge', estate(fixture('blast-radius-removed-member.json')));
    const bill = out.dependents.find((d) => d.id === 'ts-typescript . . . api/src/index/bill().');
    expect(bill).toMatchObject({ via: [{ id: 'ts-typescript . . . api/src/index/charge().', kind: 'calls' }], via_omitted: 0 });
    const file = out.dependents.find((d) => d.kind === 'file');
    expect(file).toMatchObject({ via: [{ id: 'ts-typescript . . . api/src/index/charge().', kind: 'contains' }], via_omitted: 0 });
  });

  it('an edge to a row the answer left out is dropped; an `other` kind is kept; a malformed one is never guessed', async () => {
    const raw = fixture('blast-radius-removed-member.json');
    const bill = raw['dependents'].find((d: Doc) => d['id'] === 'ts-typescript . . . api/src/index/bill().');
    bill['via'].push(
      { id: 'ts-typescript . . . gone/src/index/bill().', kind: 'calls' },
      { id: 'ts-typescript . . . api/src/index/charge().', kind: { other: 'reads' } },
      { id: 7, kind: 'calls' },
      { id: 'x', kind: { other: 3 } },
    );
    const out = await projectBlastRadius(q, 'charge', estate(raw));
    expect(out.dependents.find((d) => d.id === bill['id'])?.via).toEqual([
      { id: 'ts-typescript . . . api/src/index/charge().', kind: 'calls' },
      { id: 'ts-typescript . . . api/src/index/charge().', kind: { other: 'reads' } },
    ]);
  });

  it('an edge to a removed member\'s end of a dropped crossing is dropped (it may be a start, not a row; codex r1)', async () => {
    const raw = fixture('blast-radius-removed-member.json');
    const linkEnd = 'file . gone/src/lib.ts:';
    raw['crossings'].push({ ...raw['crossings'][0], id: 'xgone', to: { repo: 'gone', symbol: linkEnd } });
    const bill = raw['dependents'].find((d: Doc) => d['id'] === 'ts-typescript . . . api/src/index/bill().');
    bill['via'].push({ id: linkEnd, kind: 'imports' });
    const out = await projectBlastRadius(q, 'charge', estate(raw));
    expect(out.dependents.find((d) => d.id === bill['id'])?.via).toEqual([
      { id: 'ts-typescript . . . api/src/index/charge().', kind: 'calls' },
    ]);
    expect(out.crossings?.map((c) => c.id)).toEqual(['xd844539cff04463e']);
  });

  it('an older estate (no via) adds none', async () => {
    const raw = fixture('blast-radius-removed-member.json');
    for (const d of raw['dependents']) { delete d['via']; delete d['via_omitted']; }
    const out = await projectBlastRadius(q, 'charge', estate(raw));
    for (const d of out.dependents) {
      expect(d).not.toHaveProperty('via');
      expect(d).not.toHaveProperty('via_omitted');
    }
  });
});

describe.skipIf(process.platform === 'win32')('project path carries this project\'s link state (crew#1714)', () => {
  it('a linked route over a stale link says so, with the moved members and current coverage', async () => {
    const out = await projectGraphPath(q, 'web/src/page.ts', 'api/src/index.ts', undefined, estate(fixture('path-linked-stale.json')));
    expect(out).toMatchObject({
      found: true, linkage: 'linked', link_stale: true, link_stale_labels: ['web'],
      coverage: [
        { repoId: 'repo-api', repo: 'api', links_in: 1, links_out: 0, incomplete: false, package_imports: 0, manifests: 1 },
        { repoId: 'repo-web', repo: 'web', links_in: 0, links_out: 1, incomplete: false, package_imports: 1, manifests: 2 },
      ],
    });
    expect(out.note).toMatch(/^Linked:.*earlier refresh/);
  });

  it('a route not found over a stale link says the link is stale (a crossing it misses may be why)', async () => {
    const out = await projectGraphPath(q, 'page', 'charge', undefined, estate(fixture('path-unlinked-stale.json')));
    expect(out).toMatchObject({ found: false, linkage: 'co-located', link_stale: true, link_stale_labels: ['web'] });
    expect(out.note).toMatch(/^Co-located.*earlier refresh/);
  });

  it('another project\'s link state is not this one\'s', async () => {
    const raw = fixture('path-linked-stale.json');
    raw['link'][0]['project'] = 'other';
    const out = await projectGraphPath(q, 'web/src/page.ts', 'api/src/index.ts', undefined, estate(raw));
    expect(out).not.toHaveProperty('link_stale');
    expect(out).not.toHaveProperty('coverage');
    expect(out.note).not.toMatch(/earlier refresh/);
  });

  it('a removed member is never named as a moved member, and the link still reads stale (codex r1)', async () => {
    for (const [labels, want] of [[['web', 'gone'], ['web']], [['gone'], []]] as const) {
      const path = fixture('path-linked-stale.json');
      path['link'][0]['stale_labels'] = labels;
      const blast = fixture('blast-radius-removed-member.json');
      blast['link'][0]['stale_labels'] = labels;
      for (const out of [
        await projectGraphPath(q, 'web/src/page.ts', 'api/src/index.ts', undefined, estate(path)),
        await projectBlastRadius(q, 'charge', estate(blast)),
      ]) expect(out).toMatchObject({ link_stale: true, link_stale_labels: want });
    }
  });

  it('a malformed coverage is no coverage, never a failed answer (codex r1)', async () => {
    for (const coverage of [{}, [null, 3], 'x']) {
      const raw = fixture('path-linked-stale.json');
      raw['link'] = [null, { ...raw['link'][0], coverage }];
      const out = await projectGraphPath(q, 'web/src/page.ts', 'api/src/index.ts', undefined, estate(raw));
      expect(out).toMatchObject({ found: true, link_stale: true, coverage: [{ repoId: 'repo-api', repo: 'api' }, { repoId: 'repo-web', repo: 'web' }] });
      expect(out.coverage?.[0]).not.toHaveProperty('links_in');
    }
  });

  it('blast-radius reads only this project\'s link state too', async () => {
    const raw = fixture('blast-radius-removed-member.json');
    raw['link'] = [{ ...raw['link'][0], project: 'other' }, { ...raw['link'][0], stale: false, stale_labels: [] }];
    const out = await projectBlastRadius(q, 'charge', estate(raw));
    expect(out).not.toHaveProperty('link_stale');
    expect(out.coverage).toHaveLength(2);
  });
});
