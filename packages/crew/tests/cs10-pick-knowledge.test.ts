// CS10 source-pick enforcement, slice Y (DES-CATALOG-002 §2.d piece 4, parts 3 and 4):
//   - the estate relay's visible set is narrowed to the run's source pick, so releaseVisible drops a recalled item
//     derived from an unpicked source (src/mcp/estate-relay.ts: narrowVisibleToPick + EstateRelay.visibleFor);
//   - the knowledge package discloses only the picked sources AND trackers when given a pick (src/knowledge/package.ts).
//
// Round-1 fold (codex findings 1–4), each pinned by a test that fails without its fix:
//   1 (P1) PM tracker deps (`source:<trackerId>`) bypassed the pick: an unmapped/unpicked `source:` now FAILS CLOSED.
//   2 (P2) the package disclosed unpicked trackers: `trackers` is filtered by the pick's source names too.
//   3 (P2) a pick store with no `sourceNames` mapping silently disabled enforcement: it now fails closed.
//   4 (P2) a no-pick run gained `sourceNames` as a new failure dependency: the pick is read first; null returns early.
// Every guard here says which line it pins and how reverting it brings the finding back.

import { describe, expect, it } from 'vitest';

import { agentAccessOf, type SourceAgentAccess } from '../src/knowledge/gate/access.js';
import type { GateSource } from '../src/knowledge/gate/sources.js';
import { knowledgePackageFor } from '../src/knowledge/package.js';
import type { TrackerSetEntry } from '../src/knowledge/trackers/set.js';
import {
  EstateRelay,
  narrowVisibleToPick,
  releaseVisible,
  type EstateUnitScope,
} from '../src/mcp/estate-relay.js';
import type { SourcePicks } from '../src/mcp/run-fence.js';

const SUPPORT_ID = '3f0c9a1e-0000-4000-8000-00000000c401';
const BILLING_ID = '3f0c9a1e-0000-4000-8000-00000000c402';
const REGISTERED = [
  { id: SUPPORT_ID, name: 'support-pg' },
  { id: BILLING_ID, name: 'billing-pg' },
];

// PM projections spell a tracker's dep `source:<trackerId>` (a `trk_…` id), not its owner's registry id (finding 1).
// Both trackers below are owned by the PM entry `acme-jira`; a name mapping must carry that ownership for a picked
// owner to keep its trackers. REGISTERED below is a deliberately incomplete mapping (SQL sources only, no tracker
// owners); the daemon's wiring (server.ts sourceOwnerNames) also maps PM entries and their trackers.
const TRK_A = 'trk_jira_PROJA';
const TRK_B = 'trk_jira_PROJB';
const NAME_MAP = [
  ...REGISTERED,
  { id: TRK_A, name: 'acme-jira' },
  { id: TRK_B, name: 'acme-jira' },
];

/** A pick store keyed by run id (the shape RunSourcePicks satisfies). */
function picksOf(byRun: Record<string, string[] | null>): SourcePicks {
  return { get: (runId) => byRun[runId] ?? null };
}

const scopeFor = (runId: string): EstateUnitScope => ({
  unit: { runId, ord: 2, attempt: 1, phase: 'unit-2', seat: 'pi' },
  projectId: 'proj_a',
  repoId: 'repo-core',
  codeGraphDb: null,
});

describe('narrowVisibleToPick: an explicit pick narrows the set, fail closed (CS10)', () => {
  const visible = [`source:${SUPPORT_ID}`, `source:${BILLING_ID}`, 'repo:repo-core'];

  it('drops the source:<id> of a registered source the run did not pick, keeping the picked one and repo: entries', () => {
    // GUARD: the filter in narrowVisibleToPick. Replace the body with `return [...visible]` and billing stays in — this fails.
    expect(narrowVisibleToPick(visible, ['support-pg'], REGISTERED)).toEqual([`source:${SUPPORT_ID}`, 'repo:repo-core']);
  });

  it('FAIL CLOSED: a source:<id> that resolves to no known owner is DROPPED under an explicit pick; repo: stays (finding 1)', () => {
    const unknown = ['source:not-in-registry', 'repo:repo-core'];
    // GUARD (finding 1): `name === undefined ? false`. Restore `? true` and the unmapped source rides the pick through — this fails.
    expect(narrowVisibleToPick(unknown, ['support-pg'], REGISTERED)).toEqual(['repo:repo-core']);
  });

  it('PM tracker ownership: a picked owner keeps its trackers, an unpicked owner loses them, an orphan tracker is dropped (finding 1)', () => {
    const withTrackers = [`source:${TRK_A}`, `source:${TRK_B}`, `source:${SUPPORT_ID}`, 'repo:repo-core'];
    // acme-jira picked: both its trackers kept; support-pg not picked: dropped.
    expect(narrowVisibleToPick(withTrackers, ['acme-jira'], NAME_MAP)).toEqual([`source:${TRK_A}`, `source:${TRK_B}`, 'repo:repo-core']);
    // the jira owner NOT picked: both its trackers drop, repo stays.
    expect(narrowVisibleToPick(withTrackers, ['support-pg'], NAME_MAP)).toEqual([`source:${SUPPORT_ID}`, 'repo:repo-core']);
    // a tracker whose owner is not in the mapping (the shipped SQL-only wiring) is unmapped -> dropped (fail closed).
    expect(narrowVisibleToPick([`source:${TRK_A}`, 'repo:repo-core'], ['acme-jira'], REGISTERED)).toEqual(['repo:repo-core']);
  });
});

describe('EstateRelay.visibleFor: the pick narrows what a call may see (CS10)', () => {
  const baseDeps = {
    resolver: () => null,
    visible: async () => [`source:${SUPPORT_ID}`, `source:${BILLING_ID}`, 'repo:repo-core'],
    sourceNames: async () => REGISTERED,
  };

  it('narrows the visible set to the run pick before release', async () => {
    const relay = new EstateRelay({ ...baseDeps, picks: picksOf({ 'run-1': ['support-pg'] }) });
    // GUARD: visibleFor applies narrowVisibleToPick. Drop that call and billing is returned here — this fails.
    expect(await relay.visibleFor(scopeFor('run-1'))).toEqual([`source:${SUPPORT_ID}`, 'repo:repo-core']);
  });

  it('a run with no pick is unchanged (both sources visible)', async () => {
    const relay = new EstateRelay({ ...baseDeps, picks: picksOf({ 'other-run': ['support-pg'] }) });
    expect(await relay.visibleFor(scopeFor('run-1'))).toEqual([`source:${SUPPORT_ID}`, `source:${BILLING_ID}`, 'repo:repo-core']);
  });

  it('with no picks dep wired, the full visible set is returned (the pre-guard shape)', async () => {
    const relay = new EstateRelay(baseDeps);
    expect(await relay.visibleFor(scopeFor('run-1'))).toEqual([`source:${SUPPORT_ID}`, `source:${BILLING_ID}`, 'repo:repo-core']);
  });

  it('a pick store that throws rejects the call (fail closed), like a visible that throws', async () => {
    const throwing: SourcePicks = { get: () => { throw new Error('corrupt run source picks'); } };
    const relay = new EstateRelay({ ...baseDeps, picks: throwing });
    await expect(relay.visibleFor(scopeFor('run-1'))).rejects.toThrow(/corrupt run source picks/);
  });

  it('a no-pick run returns ordinary visibility WITHOUT reading the source mapping (finding 4)', async () => {
    let mapReads = 0;
    const relay = new EstateRelay({
      ...baseDeps,
      picks: picksOf({ 'other-run': ['support-pg'] }), // run-1 -> null
      sourceNames: async () => { mapReads += 1; throw new Error('sourceNames must not run for a no-pick run'); },
    });
    // GUARD (finding 4): visibleFor reads the pick first and returns on null before awaiting sourceNames. Await
    //        sourceNames before the null check and a no-pick run inherits the mapping's failure — this fails.
    expect(await relay.visibleFor(scopeFor('run-1'))).toEqual([`source:${SUPPORT_ID}`, `source:${BILLING_ID}`, 'repo:repo-core']);
    expect(mapReads).toBe(0);
  });

  it('an explicit pick with NO source mapping fails closed: every source: drops, repo: stays (finding 3)', async () => {
    const relay = new EstateRelay({
      resolver: () => null,
      visible: async () => [`source:${SUPPORT_ID}`, `source:${BILLING_ID}`, 'repo:repo-core'],
      picks: picksOf({ 'run-1': ['support-pg'] }), // explicit pick, but no sourceNames dep
    });
    // GUARD (finding 3): the pre-fix branch `if (picks===undefined || sourceNames===undefined) return visible`
    //        released the FULL set here. Restore it and both sources ride through unenforced — this fails.
    expect(await relay.visibleFor(scopeFor('run-1'))).toEqual(['repo:repo-core']);
  });

  it('a throwing pick store with no source mapping STILL refuses the call (the store is consulted) (finding 3)', async () => {
    const throwing: SourcePicks = { get: () => { throw new Error('corrupt run source picks'); } };
    const relay = new EstateRelay({ resolver: () => null, visible: async () => [`source:${SUPPORT_ID}`], picks: throwing });
    // Before the fix, a relay with no sourceNames short-circuited before consulting the store, so a throwing store
    // was never seen. Now the pick is read regardless of the mapping, and the throw refuses the call.
    await expect(relay.visibleFor(scopeFor('run-1'))).rejects.toThrow(/corrupt run source picks/);
  });
});

describe('EstateRelay.visibleFor over PM trackers: a tracker dep is bound by the pick, fail closed (CS10, finding 1)', () => {
  it('with tracker ownership supplied, a picked owner keeps its trackers and an unpicked source loses its own', async () => {
    const relay = new EstateRelay({
      resolver: () => null,
      visible: async () => [`source:${TRK_A}`, `source:${TRK_B}`, `source:${SUPPORT_ID}`, 'repo:repo-core'],
      sourceNames: async () => NAME_MAP,
      picks: picksOf({ 'run-1': ['acme-jira'] }),
    });
    expect(await relay.visibleFor(scopeFor('run-1'))).toEqual([`source:${TRK_A}`, `source:${TRK_B}`, 'repo:repo-core']);
  });

  it('an EMPTY pick drops a PM tracker dep even when the mapping omits trackers (the P1 bypass)', async () => {
    const relay = new EstateRelay({
      resolver: () => null,
      visible: async () => [`source:${TRK_A}`, 'repo:repo-core'],
      sourceNames: async () => REGISTERED, // an incomplete mapping (no tracker owner), to prove the fail-closed drop
      picks: picksOf({ 'run-1': [] }),
    });
    // GUARD (finding 1): fail-closed drop of an unmapped source:. Restore `name===undefined?true` and source:trk_…
    //        rides an empty pick through to release (the reproduced P1 bypass) — this fails.
    expect(await relay.visibleFor(scopeFor('run-1'))).toEqual(['repo:repo-core']);
  });
});

describe('releaseVisible over a pick-narrowed set: a recalled item from an unpicked source is dropped (CS10)', () => {
  const recall = (items: Array<Record<string, unknown>>): Record<string, unknown> => ({
    content: [{ type: 'text', text: JSON.stringify({ items }) }],
    isError: false,
  });
  const items = [
    { id: 'from-support', deps: [`source:${SUPPORT_ID}`] },
    { id: 'from-billing', deps: [`source:${BILLING_ID}`] },
  ];
  const full = [`source:${SUPPORT_ID}`, `source:${BILLING_ID}`, 'repo:repo-core'];

  const released = (visible: string[], payload = recall(items)): { ids: string[]; dropped: number } => {
    const out = releaseVisible('knowledge.recall', payload, new Set(visible));
    if (!out.ok) throw new Error(`withheld: ${out.reason}`);
    const body = JSON.parse((out.result['content'] as Array<{ text: string }>)[0]!.text) as { items: Array<{ id: string }> };
    return { ids: body.items.map((i) => i.id), dropped: out.dropped };
  };

  it('keeps the picked source item and drops the unpicked one once the set is narrowed', () => {
    const narrowed = narrowVisibleToPick(full, ['support-pg'], REGISTERED);
    expect(released(narrowed).ids).toEqual(['from-support']);
  });

  it('a tracker-derived item is dropped once an empty pick narrows the set (it was released with dropped:0) (finding 1)', () => {
    // The reproduced P1: an empty-pick recall released an item dependent on an unpicked Jira tracker, dropped: 0.
    const narrowed = narrowVisibleToPick([`source:${TRK_A}`, 'repo:repo-core'], [], REGISTERED);
    expect(narrowed).toEqual(['repo:repo-core']);
    const out = released(narrowed, recall([{ id: 'from-tracker', deps: [`source:${TRK_A}`] }]));
    expect(out.ids).toEqual([]);
    expect(out.dropped).toBe(1);
  });
});

function access(agents: Partial<SourceAgentAccess>): SourceAgentAccess {
  return agentAccessOf({ agents });
}

function source(name: string, id: string): GateSource {
  return {
    id,
    name,
    enabled: true,
    access: access({ projects: ['proj_a'] }),
    descriptorHash: 'h',
    description: null,
    viewsAllowed: [],
    tools: [{ name: 'list_tables', disclosure: 'structure', description: 'structure' }],
    address: { allow: ['127.0.0.0/8'], plaintext: false },
    runtime: 'native',
    dialect: 'postgres',
    config: { name, kind: 'sql', command: null, args: [], url: null, auth: null },
    queryable: true,
  } as GateSource;
}

/** One tracker of a unit's set, owned by PM source `src` (the name the pick speaks of). */
function tracker(src: string, key: string): TrackerSetEntry {
  return {
    sourceId: `${src}-id`,
    source: src,
    system: 'jira',
    trackerId: `trk_${src}_${key}`,
    tenant: 'c1',
    tenantLabel: 'acme',
    siteHost: null,
    key,
    label: `${key} project`,
    via: [{ kind: 'project' }],
  };
}

describe('knowledgePackageFor: a pick discloses only its sources (CS10)', () => {
  const gate = { sources: async () => [source('support-pg', SUPPORT_ID), source('billing-pg', BILLING_ID)] };

  it('lists only the picked sources when ctx.pick is an array', async () => {
    const pkg = await knowledgePackageFor({ projectId: 'proj_a', pick: ['support-pg'] }, gate);
    // GUARD: the `if (pick !== null && !pick.has(s.name)) continue` filter. Remove it and billing-pg appears — this fails.
    expect(pkg.sources.map((s) => s.name)).toEqual(['support-pg']);
  });

  it('lists both sources when no pick is given (null and absent are unchanged)', async () => {
    expect((await knowledgePackageFor({ projectId: 'proj_a' }, gate)).sources.map((s) => s.name)).toEqual(['billing-pg', 'support-pg']);
    expect((await knowledgePackageFor({ projectId: 'proj_a', pick: null }, gate)).sources.map((s) => s.name)).toEqual(['billing-pg', 'support-pg']);
  });
});

describe('knowledgePackageFor: a pick discloses only its TRACKERS too (CS10, finding 2)', () => {
  const gate = {
    sources: async () => [source('support-pg', SUPPORT_ID), source('billing-pg', BILLING_ID)],
    trackers: async () => [tracker('support-jira', 'SUP'), tracker('billing-jira', 'BILL')],
  };

  it('an EMPTY pick discloses no trackers (not just no sources)', async () => {
    const pkg = await knowledgePackageFor({ projectId: 'proj_a', pick: [] }, gate);
    expect(pkg.sources).toEqual([]);
    // GUARD (finding 2): `set.filter((t) => pick.has(t.source))`. Drop it (keep only the sources filter) and the
    //        Jira trackers — their source names, keys, labels and links — ride an empty pick through — this fails.
    expect(pkg.trackers).toBeUndefined();
  });

  it('a partial pick discloses only the picked source AND the picked tracker source', async () => {
    const pkg = await knowledgePackageFor({ projectId: 'proj_a', pick: ['support-pg', 'support-jira'] }, gate);
    expect(pkg.sources.map((s) => s.name)).toEqual(['support-pg']);
    expect(pkg.trackers?.map((t) => t.source)).toEqual(['support-jira']);
  });

  it('null and absent picks disclose every tracker, as before', async () => {
    expect((await knowledgePackageFor({ projectId: 'proj_a' }, gate)).trackers?.map((t) => t.source)).toEqual(['support-jira', 'billing-jira']);
    expect((await knowledgePackageFor({ projectId: 'proj_a', pick: null }, gate)).trackers?.map((t) => t.source)).toEqual(['support-jira', 'billing-jira']);
  });
});
