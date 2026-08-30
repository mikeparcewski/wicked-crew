// The governance wiki management surface (wiki-mgmt) — route behavior over a stubbed adapter.
//
// The scoreboard itself is computed by wicked-core's governance layer (exercised by that repo's
// own tests); THIS file pins the HTTP contract the routes owe regardless of the installed engine:
//
//  - GET /governance/wiki/scoreboard — presence-gated on the core-ts `governanceScoreboard`
//    binding: 501 ("upgrade the engine") on an addon that predates it, never 400; 200 with the
//    parsed scoreboard when present; `?docsRoot=` passed through trimmed.
//  - GET /governance/wiki/meta — the honest empty state: `ruleset_count: null` (cannot count) is
//    distinct from 0 (counted, none), `seeded` false on an empty store, and `doc` points at the
//    seed runbook so the UI's empty state can link the operator to it.
//  - GET /governance/rules — the browse facets (severity/layer/rule_type/status): exact matches,
//    closed vocabularies reject with 400 naming the valid set, and retired rows stay visible
//    (with their `retired` flag) so the AW-24 kill switch is observable.
//  - DELETE /governance/rules/:id — the retire route this surface REUSES (nothing new wired):
//    pinned here so its 200/404 contract can't silently vanish out from under the wiki UI.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CoreAdapter,
  GovernanceScoreboardUnsupportedError,
} from '../src/core/adapter.js';
import { WIKI_AUTHORING_DOC } from '../src/api/governance-wiki.js';
import { createServer } from '../src/api/server.js';
import type { ConformanceRule, GovernanceScoreboard } from '../src/core/types.js';

const SCOREBOARD: GovernanceScoreboard = {
  rules_total: 4,
  rules_active: 3,
  rules_retired: 1,
  typing: {
    available: false,
    reason: 'no docs root supplied',
    docs_scanned: 0,
    statements_total: 0,
    statements_typed: 0,
    by_class: {},
    docs_untyped: [],
  },
  connection: {
    rules_with_ref: 2,
    refs_resolving: 1,
    refs_unresolvable: 1,
    percent: 50,
    rules_linked: 1,
  },
  evidence: {
    denial_claims: 2,
    rules_evidenced: 1,
    evidenced_by_edges: 2,
    governs_evidence_total: 3,
    per_rule: [{ rule_id: 'POL-001', denial_claims: 2, governs_evidence: 3 }],
  },
  recall_volume: { available: false, reason: 'no recall telemetry writer' },
};

const rule = (over: Partial<ConformanceRule> & { id: string }): ConformanceRule => ({
  rule_type: 'pattern',
  statement: `statement for ${over.id}`,
  severity: 'warn',
  confidence: 0.9,
  targets: {},
  provenance: { source: 'markdown', source_kinds: ['doc'] },
  ...over,
});

/** A browse fixture wide enough to distinguish every facet: severities, layers, types, retired. */
const RULES: ConformanceRule[] = [
  rule({ id: 'PAT-001', severity: 'critical', targets: { layer: 'api' } }),
  rule({ id: 'PAT-002', severity: 'warn', targets: { layer: 'storage' } }),
  rule({ id: 'POL-001', rule_type: 'policy', severity: 'error', targets: {} }),
  rule({ id: 'POL-002', rule_type: 'policy', severity: 'critical', targets: { layer: 'api' }, retired: true }),
];

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

/** Behavior toggles, reassigned per case (the campaign-routes pattern). */
let scoreboardSupported = false;
/** What the stubbed scoreboard captured as its docsRoot argument. */
let scoreboardDocsRoot: string | undefined = 'UNCALLED';
let rulesetCount: number | null = null;
let listedRules: ConformanceRule[] = [];
/** Rule ids the stubbed retire seam treats as existing. */
let retirable = new Set<string>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'governance-wiki-routes-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

  // Stub the governance seams INSTANCE-LEVEL (the campaign-routes pattern): these tests pin the
  // routes' mapping, and must answer the same whether the installed addon carries the wiki
  // bindings or not.
  adapter.governanceScoreboard = async (docsRoot?: string) => {
    if (!scoreboardSupported) {
      throw new GovernanceScoreboardUnsupportedError('Reading the governance wiki scoreboard');
    }
    scoreboardDocsRoot = docsRoot;
    return SCOREBOARD;
  };
  adapter.wikiScoreboardSupported = () => scoreboardSupported;
  adapter.countRuleSets = async () => rulesetCount;
  adapter.listConformanceRules = async () => listedRules;
  adapter.retireConformanceRule = async (id: string) => retirable.has(id);

  app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/v1/governance/wiki/scoreboard', () => {
  it('answers 501 — upgrade the engine, not fix the request — when the binding is absent', async () => {
    scoreboardSupported = false;
    const { status, body } = await get('/api/v1/governance/wiki/scoreboard');
    expect(status).toBe(501);
    expect(body['error']).toMatch(/governanceScoreboard/);
    expect(body['error']).toMatch(/upgrade/i);
  });

  it('serves the scoreboard when the binding is present', async () => {
    scoreboardSupported = true;
    scoreboardDocsRoot = 'UNCALLED';
    const { status, body } = await get('/api/v1/governance/wiki/scoreboard');
    expect(status).toBe(200);
    expect(body['scoreboard']).toEqual(SCOREBOARD);
    // No ?docsRoot= → the adapter is asked without one (typing reports unavailable in-band).
    expect(scoreboardDocsRoot).toBeUndefined();
  });

  it('passes ?docsRoot= through trimmed, and treats a blank value as absent', async () => {
    scoreboardSupported = true;
    await get(`/api/v1/governance/wiki/scoreboard?docsRoot=${encodeURIComponent(' /tmp/wiki-docs ')}`);
    expect(scoreboardDocsRoot).toBe('/tmp/wiki-docs');
    await get(`/api/v1/governance/wiki/scoreboard?docsRoot=${encodeURIComponent('   ')}`);
    expect(scoreboardDocsRoot).toBeUndefined();
  });
});

describe('GET /api/v1/governance/wiki/meta', () => {
  it('reports the honest empty state: unseeded, ruleset_count null (cannot count), doc = the seed runbook', async () => {
    scoreboardSupported = false;
    rulesetCount = null;
    listedRules = [];
    const { status, body } = await get('/api/v1/governance/wiki/meta');
    expect(status).toBe(200);
    expect(body).toEqual({
      meta: {
        seeded: false,
        ruleset_count: null,
        rule_count: 0,
        scoreboard_available: false,
        doc: WIKI_AUTHORING_DOC,
      },
    });
    expect(body['meta']['doc']).toMatch(/seed\/README\.md$/);
  });

  it('reports a seeded store with counted rulesets and scoreboard availability', async () => {
    scoreboardSupported = true;
    rulesetCount = 3;
    listedRules = RULES;
    const { body } = await get('/api/v1/governance/wiki/meta');
    expect(body).toEqual({
      meta: {
        seeded: true,
        ruleset_count: 3,
        rule_count: RULES.length,
        scoreboard_available: true,
        doc: WIKI_AUTHORING_DOC,
      },
    });
  });

  it('counts rulesets as seeded even when no rules are listable (e.g. all retired on a recall-funnel addon)', async () => {
    rulesetCount = 2;
    listedRules = [];
    const { body } = await get('/api/v1/governance/wiki/meta');
    expect(body['meta']['seeded']).toBe(true);
    expect(body['meta']['rule_count']).toBe(0);
    expect(body['meta']['ruleset_count']).toBe(2);
  });
});

describe('GET /api/v1/governance/rules — browse facets', () => {
  const ids = (body: Record<string, unknown>) =>
    (body['rules'] as ConformanceRule[]).map((r) => r.id);

  beforeAll(() => {
    listedRules = RULES;
  });

  it('lists every row unfiltered, retired ones flagged (the kill switch stays visible)', async () => {
    const { status, body } = await get('/api/v1/governance/rules');
    expect(status).toBe(200);
    expect(ids(body)).toEqual(['PAT-001', 'PAT-002', 'POL-001', 'POL-002']);
    const retired = (body['rules'] as ConformanceRule[]).find((r) => r.id === 'POL-002');
    expect(retired?.retired).toBe(true);
  });

  it('filters by severity exactly', async () => {
    const { body } = await get('/api/v1/governance/rules?severity=critical');
    expect(ids(body)).toEqual(['PAT-001', 'POL-002']);
  });

  it('filters by layer exactly — wildcard (untagged) rules do NOT flood the filter', async () => {
    const { body } = await get('/api/v1/governance/rules?layer=api');
    expect(ids(body)).toEqual(['PAT-001', 'POL-002']); // POL-001 has no layer → excluded
  });

  it('filters by rule_type and combines facets conjunctively', async () => {
    const { body } = await get('/api/v1/governance/rules?rule_type=policy');
    expect(ids(body)).toEqual(['POL-001', 'POL-002']);
    const combined = await get('/api/v1/governance/rules?rule_type=policy&severity=critical&status=retired');
    expect(ids(combined.body)).toEqual(['POL-002']);
  });

  it('narrows by status: active excludes retired, retired excludes active', async () => {
    const active = await get('/api/v1/governance/rules?status=active');
    expect(ids(active.body)).toEqual(['PAT-001', 'PAT-002', 'POL-001']);
    const retired = await get('/api/v1/governance/rules?status=retired');
    expect(ids(retired.body)).toEqual(['POL-002']);
  });

  it('rejects an unknown facet value with 400 naming the valid set — never an empty non-answer', async () => {
    const sev = await get('/api/v1/governance/rules?severity=hihg');
    expect(sev.status).toBe(400);
    expect(sev.body['error']).toMatch(/info\|warn\|error\|critical/);
    const status = await get('/api/v1/governance/rules?status=withdrawn');
    expect(status.status).toBe(400);
    expect(status.body['error']).toMatch(/active\|retired\|all/);
    const type = await get('/api/v1/governance/rules?rule_type=nope');
    expect(type.status).toBe(400);
    expect(type.body['error']).toMatch(/pattern\|policy/);
  });

  it('treats an empty facet value as "not given", not as a filter matching nothing', async () => {
    const { status, body } = await get('/api/v1/governance/rules?severity=&layer=&status=');
    expect(status).toBe(200);
    expect(ids(body)).toHaveLength(RULES.length);
  });
});

describe('DELETE /api/v1/governance/rules/:id — the retire route the wiki REUSES', () => {
  it('retires an existing rule (200) and answers 404 for an unknown id', async () => {
    retirable = new Set(['POL-002']);
    const okRes = await fetch(`${baseUrl}/api/v1/governance/rules/POL-002`, { method: 'DELETE' });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ status: 'retired', id: 'POL-002' });
    const missing = await fetch(`${baseUrl}/api/v1/governance/rules/NOPE-1`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });
});
