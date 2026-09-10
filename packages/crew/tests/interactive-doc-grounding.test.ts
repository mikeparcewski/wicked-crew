// Doc → subject-repo grounding (acceptance findings F-046 + follow-up), the pure half.
//
// What these pin:
//  - the CREATE GRAMMAR: `repo_ref` / `repo_refs` parse, dedupe, cap, and refuse junk; `style`
//    inference is conservative (format words only) and the style contract names the print rule;
//  - the RESOLUTION RULE, in order: named refs › brief-named members › sole member › none —
//    never the project's first member (the defect);
//  - the DURABLE BINDING: a `crew-grounding.json` sidecar beside the doc (never under the state
//    home — core's fence refuses unregistered entries), readable by a fresh store, removable, and
//    `waitFor` closes the bus-beats-create window without ever hanging.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREW_GROUNDING_FILE,
  DocGroundingStore,
  REPO_REFS_MAX,
  groundingNarration,
  inferDocStyle,
  isDocStyle,
  matchRepoRef,
  parseRepoRefs,
  projectRepoCandidates,
  reposNamedInBrief,
  resolveGroundingRepos,
  snapshotDirName,
  styleContract,
  type GroundingRepo,
} from '../src/interactive/doc-grounding.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

describe('parseRepoRefs (the create grammar)', () => {
  it('reads repo_ref, repo_refs, or both — de-duplicated in order', () => {
    expect(parseRepoRefs({})).toEqual({ ok: true, refs: [] });
    expect(parseRepoRefs({ repo_ref: 'wicked-studio' })).toEqual({ ok: true, refs: ['wicked-studio'] });
    expect(parseRepoRefs({ repo_refs: ['a', 'b'] })).toEqual({ ok: true, refs: ['a', 'b'] });
    expect(parseRepoRefs({ repo_ref: ' a ', repo_refs: ['b', 'a', ''] })).toEqual({ ok: true, refs: ['a', 'b'] });
    expect(parseRepoRefs({ repo_ref: null, repo_refs: undefined })).toEqual({ ok: true, refs: [] });
  });

  it('refuses non-string entries, a non-array repo_refs, junk spellings, and more than the cap', () => {
    expect(parseRepoRefs({ repo_refs: 'x' }).ok).toBe(false);
    expect(parseRepoRefs({ repo_refs: [1] }).ok).toBe(false);
    expect(parseRepoRefs({ repo_ref: 'has space' }).ok).toBe(false);
    expect(parseRepoRefs({ repo_ref: '../escape' }).ok).toBe(false);
    const many = parseRepoRefs({ repo_refs: Array.from({ length: REPO_REFS_MAX + 1 }, (_, i) => `r${i}`) });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toContain(`at most ${REPO_REFS_MAX}`);
  });
});

describe('style: inference + the format contract (F-046, F-050/F-053)', () => {
  it('infers the bridge style from format words — print/A4 → brochure, slides → ppt, memo → doc', () => {
    expect(inferDocStyle('A high-end product brochure. Print-ready A4, two pages.')).toBe('brochure');
    expect(inferDocStyle('a printable one-pager for the sales team')).toBe('brochure');
    expect(inferDocStyle('a 12-slide deck for the board')).toBe('ppt');
    expect(inferDocStyle('an internal memo about the rollout')).toBe('doc');
  });

  it('is CONSERVATIVE: a brief with no format words infers nothing (the bridge keeps its web default)', () => {
    expect(inferDocStyle('a one-page overview of the wicked ecosystem')).toBeUndefined();
    expect(inferDocStyle('')).toBeUndefined();
  });

  it('explicit slide words beat print words — a deck to print is still a deck', () => {
    expect(inferDocStyle('a slide deck we will also print on A4')).toBe('ppt');
  });

  it('isDocStyle accepts exactly the bridge set', () => {
    for (const s of ['web', 'ppt', 'brochure', 'doc']) expect(isDocStyle(s)).toBe(true);
    expect(isDocStyle('pdf')).toBe(false);
    expect(isDocStyle(undefined)).toBe(false);
  });

  it('the brochure contract forbids the F-050 shape: fixed slide pages + overflow:hidden', () => {
    const c = styleContract('brochure');
    expect(c).toContain('PRINT pages');
    expect(c).toContain('page breaks');
    expect(c).toContain('never a fixed slide-size viewport');
    expect(styleContract('ppt')).toContain('landscape slides');
    expect(styleContract('web')).toContain('scrollable');
    expect(styleContract('doc')).toContain('prose');
    expect(styleContract('odd')).toContain('"odd"');
    for (const s of ['web', 'ppt', 'brochure', 'doc']) expect(styleContract(s)).not.toMatch(/[\n\r\t]/);
  });
});

const STUDIO: GroundingRepo = { repoRef: 'repo-studio', name: 'wicked-studio', rootPath: '/src/wicked-studio' };
const CORE: GroundingRepo = { repoRef: 'repo-core', name: 'wicked-engine', rootPath: '/src/wicked-engine' };
const ARCHIVED: GroundingRepo = { repoRef: 'repo-arch', name: 'wicked-studio-archived', rootPath: '/src/wicked-studio-archived' };

function adapterWith(
  members: Record<string, Array<{ member_kind: string; member_ref: string }>>,
  repos: Array<{ id: string; name?: string; root_path: string }>,
): CoreAdapter {
  return {
    projectMembers: async (projectId: string) => members[projectId] ?? [],
    listRepos: async () => repos,
  } as unknown as CoreAdapter;
}

describe('matchRepoRef / reposNamedInBrief', () => {
  it('matches a ref by registry id (exact), by name, or by root basename (case-insensitive)', () => {
    expect(matchRepoRef('repo-studio', STUDIO)).toBe(true);
    expect(matchRepoRef('Wicked-Studio', STUDIO)).toBe(true);
    expect(matchRepoRef('REPO-STUDIO', STUDIO)).toBe(false); // ids are exact
    expect(matchRepoRef('wicked-engine', STUDIO)).toBe(false);
  });

  it('finds the member repos a brief names OUTRIGHT — whole tokens only, so a longer sibling name never matches', () => {
    const brief = 'Use the real product (the wicked-studio repo in this project) for features.';
    expect(reposNamedInBrief(brief, [CORE, STUDIO, ARCHIVED])).toEqual([STUDIO]);
    expect(reposNamedInBrief('about Wicked Studio the product', [CORE, STUDIO])).toEqual([]); // no hyphenated name present
    expect(reposNamedInBrief('archive: wicked-studio-archived', [STUDIO, ARCHIVED])).toEqual([ARCHIVED]);
    expect(reposNamedInBrief('', [STUDIO])).toEqual([]);
  });
});

describe('projectRepoCandidates + resolveGroundingRepos (the rule, in order)', () => {
  const world = {
    'proj-multi': [
      { member_kind: 'crew.repo', member_ref: 'repo-core' }, // FIRST member — the old wrong default
      { member_kind: 'crew.repo', member_ref: 'repo-studio' },
      { member_kind: 'crew.run', member_ref: 'run-1' },
      { member_kind: 'crew.repo', member_ref: 'repo-stale' }, // not in the registry any more
    ],
    'proj-solo': [{ member_kind: 'crew.repo', member_ref: 'repo-core' }],
    'proj-bare': [{ member_kind: 'crew.run', member_ref: 'run-2' }],
  };
  const registry = [
    { id: 'repo-core', name: 'wicked-engine', root_path: '/src/wicked-engine' },
    { id: 'repo-studio', root_path: '/src/wicked-studio' }, // no name column → basename
  ];
  const adapter = adapterWith(world, registry);

  it('lists the crew.repo members the registry vouches for, naming each by registry name or root basename', async () => {
    const logged: string[] = [];
    const repos = await projectRepoCandidates(adapter, 'proj-multi', (m) => logged.push(m));
    expect(repos.map((r) => `${r.repoRef}:${r.name}`)).toEqual(['repo-core:wicked-engine', 'repo-studio:wicked-studio']);
    expect(logged.some((m) => m.includes('repo-stale'))).toBe(true);
    expect(await projectRepoCandidates(adapter, 'proj-bare')).toEqual([]);
    expect(await projectRepoCandidates({} as CoreAdapter, 'proj-multi')).toEqual([]); // an adapter that cannot answer
  });

  it('NAMED refs win — resolved to member repos in request order, misses reported, never substituted', async () => {
    const d = await resolveGroundingRepos(adapter, 'proj-multi', 'brief names wicked-engine', ['wicked-studio', 'repo-gone']);
    expect(d.source).toBe('named');
    expect(d.repos.map((r) => r.repoRef)).toEqual(['repo-studio']);
    expect(d.missing).toEqual(['repo-gone']);
    expect(d.memberCount).toBe(2);
  });

  it('else the BRIEF-named members', async () => {
    const d = await resolveGroundingRepos(adapter, 'proj-multi', 'the wicked-studio repo in this project', undefined);
    expect(d.source).toBe('brief');
    expect(d.repos.map((r) => r.repoRef)).toEqual(['repo-studio']);
  });

  it('else the SOLE member', async () => {
    const d = await resolveGroundingRepos(adapter, 'proj-solo', 'anything', []);
    expect(d.source).toBe('sole-member');
    expect(d.repos.map((r) => r.repoRef)).toEqual(['repo-core']);
  });

  it('else NONE — a multi-repo project with nothing named is NOT grounded on its first member (the F-046 defect)', async () => {
    const d = await resolveGroundingRepos(adapter, 'proj-multi', 'a brochure for the product', undefined);
    expect(d.source).toBe('none');
    expect(d.repos).toEqual([]);
    expect(d.memberCount).toBe(2);
    const bare = await resolveGroundingRepos(adapter, 'proj-bare', 'anything', undefined);
    expect(bare).toEqual({ repos: [], source: 'none', missing: [], memberCount: 0 });
  });
});

describe('groundingNarration (the thread line — F-046 follow-up) + snapshotDirName', () => {
  it('says WHERE and WHY, reports missing named repos, and explains a none-of-N project', () => {
    expect(groundingNarration({ repos: [STUDIO], source: 'named', missing: [], memberCount: 2 }, [STUDIO], 'draft')).toMatch(
      /^Grounded on wicked-studio \(named in your request\)/,
    );
    expect(groundingNarration({ repos: [STUDIO], source: 'brief', missing: [], memberCount: 2 }, [STUDIO], 'draft')).toContain(
      'named in your brief',
    );
    expect(groundingNarration({ repos: [CORE], source: 'sole-member', missing: [], memberCount: 1 }, [CORE], 'demo')).toContain(
      "the project's only repository",
    );
    expect(groundingNarration({ repos: [], source: 'named', missing: ['repo-gone'], memberCount: 2 }, [], 'draft')).toBe(
      'Requested repository "repo-gone" is not a member of this project — skipped.',
    );
    expect(groundingNarration({ repos: [], source: 'none', missing: [], memberCount: 3 }, [], 'draft')).toContain(
      'This project has 3 repositories and none was named for this draft',
    );
    // Nothing to say: a repo-less project.
    expect(groundingNarration({ repos: [], source: 'none', missing: [], memberCount: 0 }, [], 'draft')).toBeNull();
    // A named repo whose snapshot failed: no "Grounded on" claim, nothing false said.
    expect(groundingNarration({ repos: [STUDIO], source: 'named', missing: [], memberCount: 2 }, [], 'draft')).toBeNull();
  });

  it('derives a slug-safe snapshot directory from the repo NAME, never from free bus text', () => {
    expect(snapshotDirName(STUDIO)).toBe('wicked-studio');
    expect(snapshotDirName({ repoRef: 'r1', name: 'My Repo (v2)!', rootPath: '/x' })).toBe('my-repo-v2');
    expect(snapshotDirName({ repoRef: 'r1', name: '///', rootPath: '/x' })).toBe('r1');
  });
});

describe('DocGroundingStore (the sidecar beside the doc; the bus-beats-create window)', () => {
  let dir: string;
  let root: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-dgs-'));
    root = join(dir, 'docs');
  });
  afterEach(() => {
    removeScratch(dir);
  });

  it('records the binding as <docsRoot>/<doc>/crew-grounding.json beside versions.json — a fresh store reads it; remove drops exactly that doc', () => {
    const store = new DocGroundingStore();
    // The bridge created the doc dir before answering the create.
    mkdirSync(join(root, 'brochure'), { recursive: true });
    writeFileSync(join(root, 'brochure', 'versions.json'), '{"head":0}', 'utf8');
    expect(store.get(root, 'brochure')).toBeUndefined();
    store.record(root, 'brochure', { project_id: 'proj-1', repo_refs: ['repo-studio'], style: 'brochure' });
    store.record(root, 'other', { project_id: 'proj-1', repo_refs: ['repo-core'] }); // dir not yet there → created
    expect(existsSync(join(root, 'brochure', CREW_GROUNDING_FILE))).toBe(true);
    expect(DocGroundingStore.sidecarPath(root, 'brochure')).toBe(join(root, 'brochure', CREW_GROUNDING_FILE));
    const fresh = new DocGroundingStore();
    expect(fresh.get(root, 'brochure')).toMatchObject({ project_id: 'proj-1', repo_refs: ['repo-studio'], style: 'brochure' });
    expect(fresh.get(root, 'other')?.repo_refs).toEqual(['repo-core']);
    expect(fresh.remove(root, 'brochure')).toBe(true);
    expect(fresh.remove(root, 'brochure')).toBe(false);
    expect(fresh.get(root, 'brochure')).toBeUndefined();
    expect(fresh.get(root, 'other')).toBeDefined();
    // Nothing else appeared in the doc dir: the bridge's own files are untouched.
    expect(readFileSync(join(root, 'brochure', 'versions.json'), 'utf8')).toBe('{"head":0}');
  });

  it('never names a path for an id outside the doc grammar, and reads a malformed sidecar as "nothing named"', () => {
    const store = new DocGroundingStore();
    expect(DocGroundingStore.sidecarPath(root, '../escape')).toBeNull();
    expect(store.get(root, '../escape')).toBeUndefined();
    expect(() => store.record(root, 'Nope Caps', { project_id: 'p', repo_refs: [] })).toThrow(/cannot name/);
    mkdirSync(join(root, 'bad'), { recursive: true });
    writeFileSync(join(root, 'bad', CREW_GROUNDING_FILE), '{not json', 'utf8');
    expect(store.get(root, 'bad')).toBeUndefined();
    writeFileSync(join(root, 'bad', CREW_GROUNDING_FILE), JSON.stringify({ repo_refs: ['x'] }), 'utf8'); // no project
    expect(store.get(root, 'bad')).toBeUndefined();
  });

  it('waitFor: immediate when the binding exists or nothing is pending; waits for an in-flight create; never past the timeout', async () => {
    const store = new DocGroundingStore();
    expect(await store.waitFor(root, 'doc-a', 'proj-1', 1000)).toBeUndefined(); // nothing pending → immediate
    store.record(root, 'doc-b', { project_id: 'proj-1', repo_refs: ['r'] });
    expect((await store.waitFor(root, 'doc-b', 'proj-1', 1000))?.repo_refs).toEqual(['r']);

    // An in-flight create for the SAME project holds the wait until it settles.
    const token = store.beginCreate('proj-1');
    expect(store.pendingCount('proj-1')).toBe(1);
    const t0 = Date.now();
    setTimeout(() => {
      store.record(root, 'doc-c', { project_id: 'proj-1', repo_refs: ['r2'] });
      store.settleCreate(token);
    }, 150);
    const got = await store.waitFor(root, 'doc-c', 'proj-1', 5000);
    expect(got?.repo_refs).toEqual(['r2']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(store.pendingCount('proj-1')).toBe(0);

    // A pending create for ANOTHER project does not hold this one.
    const other = store.beginCreate('proj-2');
    expect(await store.waitFor(root, 'doc-d', 'proj-1', 1000)).toBeUndefined();
    store.settleCreate(other);

    // A create that never settles is bounded by the timeout.
    store.beginCreate('proj-1');
    const t1 = Date.now();
    expect(await store.waitFor(root, 'doc-e', 'proj-1', 120)).toBeUndefined();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(100);
    expect(Date.now() - t1).toBeLessThan(2000);
    store.settleCreate(999); // unknown token — a no-op
  });
});
