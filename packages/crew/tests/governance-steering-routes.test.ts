// The Steering management surface (STEERING program) — route behavior over a stubbed adapter.
//
// The unified steering-rule model itself (steering_type/applies_to/excludes/weight/effect on
// ConformanceRule, policy-row migration, decide()/select() over the unified store) is the
// ENGINE's, exercised by wicked-core's own tests; THIS file pins the HTTP contract the crew
// routes owe regardless of the installed engine:
//
//  - GET /governance/rules ?type= — the steering facet: closed vocabulary (400 names the valid
//    set), presence-gated on the steering engine (501 "upgrade the engine" — a pre-0.7.5 addon's
//    rows carry no steering_type, so an empty answer would impersonate "no rules of that type"),
//    and rows without the field read as the serde default `architecture`.
//  - GET /governance/rules ?include_retired= — the boolean spelling of the retire filter,
//    mutually exclusive with ?status= (two spellings of one filter can contradict → 400).
//  - POST /governance/rules — a write carrying steering fields on a pre-steering engine answers
//    501 NAMING the fields (the engine would silently drop them — ConformanceRule has no
//    deny_unknown_fields); a legacy write passes through on any engine.
//  - POST/DELETE /governance/policies — the old policy WRITE surface, folded: 410 Gone with a
//    pointer at the rules CRUD on a steering engine; untouched legacy behavior before the merge.
//    GET /governance/policies stays on every engine (decision-audit resolvability).
//  - POST /governance/steering/import — batch import through the engine's ingest
//    normalize/validate path: fail-closed PER ENTRY (200 with per-entry results, rejections
//    included), 501 on a pre-steering engine, byte/entry caps named in the 400.
//  - POST /governance/steering/author — "add with chat" as a governed run: launches the
//    steering-author drop-in workflow (TH-12 propose-as-gate), inline documents land in the
//    per-run steering inbox, paths are validated absolute-and-existing on the daemon host.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, SteeringUnsupportedError, humanGatePhaseIds } from '../src/core/adapter.js';
import { steeringInboxDir } from '../src/api/governance-steering.js';
import { createServer } from '../src/api/server.js';
import type {
  ConformanceRule,
  LaunchRunInput,
  SteeringImportEntry,
  SteeringImportResult,
} from '../src/core/types.js';

const rule = (over: Partial<ConformanceRule> & { id: string }): ConformanceRule => ({
  rule_type: 'pattern',
  statement: `statement for ${over.id}`,
  severity: 'warn',
  confidence: 0.9,
  targets: {},
  provenance: { source: 'markdown', source_kinds: ['doc'] },
  ...over,
});

/** Mixed-era browse fixture: typed rows, an untyped (pre-steering) row, and a retired row. */
const RULES: ConformanceRule[] = [
  rule({ id: 'PAT-001', steering_type: 'security' }),
  rule({ id: 'PAT-002' }), // no steering_type → reads as the serde default `architecture`
  rule({ id: 'POL-001', rule_type: 'policy', steering_type: 'architecture' }),
  rule({ id: 'POL-002', rule_type: 'policy', steering_type: 'security', retired: true }),
];

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;
let priorInboxDir: string | undefined;

/** Behavior toggles, reassigned per case (the governance-wiki-routes pattern). */
let steeringSupported = false;
let listedRules: ConformanceRule[] = [];
/** What the stubbed import seam captured, and what it answers. */
let importCaptured: { entries: SteeringImportEntry[]; defaultType: string | undefined } | null =
  null;
/** Reset via a helper so TS's control-flow narrowing can't pin the variable to `null` in a test body. */
function resetImportCapture(): void {
  importCaptured = null;
}
let importResults: SteeringImportResult[] = [];
let importThrows: Error | null = null;
/** What the stubbed rule/policy write seams captured. */
let upsertedRules: ConformanceRule[] = [];
let upsertedPolicies: unknown[] = [];
let retirablePolicies = new Set<string>();
/** What the stubbed launch seam captured, and whether it refuses. */
let launches: LaunchRunInput[] = [];
let launchThrows: Error | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'governance-steering-routes-'));
  // Keep the author route's inline-document writes out of the operator's real ~/.wicked.
  priorInboxDir = process.env['WICKED_STEERING_INBOX_DIR'];
  process.env['WICKED_STEERING_INBOX_DIR'] = join(dir, 'inbox');
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

  // Stub the steering seams INSTANCE-LEVEL (the campaign-routes pattern): these tests pin the
  // routes' mapping, and must answer the same whether the installed addon carries the steering
  // bindings or not.
  adapter.steeringSupported = () => steeringSupported;
  adapter.importSteeringRules = async (entries, defaultType) => {
    if (importThrows) throw importThrows;
    if (!steeringSupported) throw new SteeringUnsupportedError('Importing steering rules');
    importCaptured = { entries, defaultType };
    return importResults;
  };
  adapter.listConformanceRules = async () => listedRules;
  adapter.upsertConformanceRule = async (r: ConformanceRule) => {
    upsertedRules.push(r);
  };
  adapter.upsertPolicy = async (p) => {
    upsertedPolicies.push(p);
  };
  adapter.retirePolicy = async (id: string) => retirablePolicies.has(id);
  adapter.launchRun = async (input: LaunchRunInput) => {
    if (launchThrows) throw launchThrows;
    launches.push(input);
    return input.sessionId;
  };

  app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  if (priorInboxDir === undefined) delete process.env['WICKED_STEERING_INBOX_DIR'];
  else process.env['WICKED_STEERING_INBOX_DIR'] = priorInboxDir;
  await app.close();
  adapter.close();
  // close() returns before the actor thread finishes flushing SQLite's WAL sidecars, and
  // `force` does not cover the ENOTEMPTY that races with it — retries do (the repo pattern).
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/v1/governance/rules — the ?type= steering facet', () => {
  const ids = (body: Record<string, unknown>) =>
    (body['rules'] as ConformanceRule[]).map((r) => r.id);

  beforeAll(() => {
    listedRules = RULES;
  });

  it('rejects an unknown steering type with 400 naming the whole vocabulary', async () => {
    const { status, body } = await get('/api/v1/governance/rules?type=archi');
    expect(status).toBe(400);
    expect(body['error']).toMatch(
      /architecture\|development\|security\|testing\|operations\|compliance\|design-ux/,
    );
  });

  it('answers 501 — upgrade the engine, not an empty non-answer — on a pre-steering engine', async () => {
    steeringSupported = false;
    const { status, body } = await get('/api/v1/governance/rules?type=security');
    expect(status).toBe(501);
    expect(body['error']).toMatch(/steeringImport/);
    expect(body['error']).toMatch(/>= 0\.7\.5/);
  });

  it('filters by steering type on a steering engine; an untyped row reads as `architecture`', async () => {
    steeringSupported = true;
    const security = await get('/api/v1/governance/rules?type=security');
    expect(security.status).toBe(200);
    expect(ids(security.body)).toEqual(['PAT-001', 'POL-002']);
    // PAT-002 has no steering_type → serde default `architecture`, so it shows on that page.
    const architecture = await get('/api/v1/governance/rules?type=architecture');
    expect(ids(architecture.body)).toEqual(['PAT-002', 'POL-001']);
  });

  it('combines ?type= with the other facets conjunctively', async () => {
    steeringSupported = true;
    const { body } = await get('/api/v1/governance/rules?type=security&status=retired');
    expect(ids(body)).toEqual(['POL-002']);
  });
});

describe('GET /api/v1/governance/rules — ?include_retired=', () => {
  const ids = (body: Record<string, unknown>) =>
    (body['rules'] as ConformanceRule[]).map((r) => r.id);

  beforeAll(() => {
    listedRules = RULES;
  });

  it('true keeps retired rows, false narrows to active', async () => {
    const all = await get('/api/v1/governance/rules?include_retired=true');
    expect(ids(all.body)).toHaveLength(RULES.length);
    const active = await get('/api/v1/governance/rules?include_retired=false');
    expect(ids(active.body)).toEqual(['PAT-001', 'PAT-002', 'POL-001']);
  });

  it('rejects a non-boolean value with 400 naming the valid set', async () => {
    const { status, body } = await get('/api/v1/governance/rules?include_retired=yes');
    expect(status).toBe(400);
    expect(body['error']).toMatch(/true\|false/);
  });

  it('rejects ?status= alongside ?include_retired= — two spellings of one filter can contradict', async () => {
    const { status, body } = await get(
      '/api/v1/governance/rules?include_retired=true&status=active',
    );
    expect(status).toBe(400);
    expect(body['error']).toMatch(/not both/);
  });
});

describe('POST /api/v1/governance/rules — steering-field writes', () => {
  it('passes a legacy write (no steering fields) through on a pre-steering engine', async () => {
    steeringSupported = false;
    upsertedRules = [];
    const { status } = await send('POST', '/api/v1/governance/rules', rule({ id: 'PAT-100' }));
    expect(status).toBe(200);
    expect(upsertedRules.map((r) => r.id)).toEqual(['PAT-100']);
  });

  it('refuses a steering-field write on a pre-steering engine with 501 NAMING the fields', async () => {
    steeringSupported = false;
    upsertedRules = [];
    const { status, body } = await send('POST', '/api/v1/governance/rules', {
      ...rule({ id: 'PAT-101' }),
      steering_type: 'security',
      weight: 2.5,
      effect: 'deny',
    });
    expect(status).toBe(501);
    expect(body['error']).toMatch(/`steering_type`/);
    expect(body['error']).toMatch(/`weight`/);
    expect(body['error']).toMatch(/`effect`/);
    expect(body['error']).toMatch(/silently drop/);
    // Fail CLOSED: nothing reached the engine.
    expect(upsertedRules).toEqual([]);
  });

  it('passes a steering-field write through on a steering engine, fields intact', async () => {
    steeringSupported = true;
    upsertedRules = [];
    const steering = {
      ...rule({ id: 'POL-100', rule_type: 'policy' as const }),
      steering_type: 'operations' as const,
      applies_to: ['build'],
      excludes: ['recon'],
      weight: 2,
      effect: 'deny' as const,
      obligations: ['record evidence'],
      criteria: 'no unreviewed deploy',
      provenance: { source: 'ui', source_kinds: [] },
    };
    const { status } = await send('POST', '/api/v1/governance/rules', steering);
    expect(status).toBe(200);
    expect(upsertedRules).toEqual([steering]);
  });
});

describe('the old policy WRITE surface, folded (STEERING)', () => {
  it('keeps the legacy write behavior on a pre-steering engine', async () => {
    steeringSupported = false;
    upsertedPolicies = [];
    retirablePolicies = new Set(['POL-OLD']);
    const post = await send('POST', '/api/v1/governance/policies', {
      id: 'POL-OLD',
      kind: 'gate',
    });
    expect(post.status).toBe(200);
    expect(upsertedPolicies).toHaveLength(1);
    const del = await send('DELETE', '/api/v1/governance/policies/POL-OLD');
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ status: 'retired', id: 'POL-OLD' });
    const missing = await send('DELETE', '/api/v1/governance/policies/NOPE');
    expect(missing.status).toBe(404);
  });

  it('answers 410 Gone with a pointer at the rules CRUD on a steering engine', async () => {
    steeringSupported = true;
    upsertedPolicies = [];
    const post = await send('POST', '/api/v1/governance/policies', { id: 'POL-NEW', kind: 'gate' });
    expect(post.status).toBe(410);
    expect(post.body['error']).toMatch(/merged into steering rules/);
    expect(post.body['see']).toBe('POST /api/v1/governance/rules');
    expect(upsertedPolicies).toEqual([]);
    const del = await send('DELETE', '/api/v1/governance/policies/POL-OLD');
    expect(del.status).toBe(410);
    expect(del.body['see']).toBe('DELETE /api/v1/governance/rules/POL-OLD');
  });

  it('keeps the READ on every engine — decision-audit resolvability', async () => {
    steeringSupported = true;
    const { status, body } = await get('/api/v1/governance/policies');
    expect(status).toBe(200);
    expect(Array.isArray(body['policies'])).toBe(true);
  });
});

describe('POST /api/v1/governance/steering/import', () => {
  it('answers 501 — upgrade the engine, not fix the request — on a pre-steering engine', async () => {
    steeringSupported = false;
    const { status, body } = await send('POST', '/api/v1/governance/steering/import', {
      entries: [{ kind: 'doc', content: '# doc' }],
    });
    expect(status).toBe(501);
    expect(body['error']).toMatch(/steeringImport/);
  });

  it('rejects a malformed batch with 400 naming unknown fields (FINDING-031 doctrine)', async () => {
    const empty = await send('POST', '/api/v1/governance/steering/import', { entries: [] });
    expect(empty.status).toBe(400);
    const unknown = await send('POST', '/api/v1/governance/steering/import', {
      entries: [{ kind: 'doc', content: 'x' }],
      steeringType: 'security',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body['error']).toMatch(/`steeringType`/);
    const badType = await send('POST', '/api/v1/governance/steering/import', {
      type: 'archi',
      entries: [{ kind: 'doc', content: 'x' }],
    });
    expect(badType.status).toBe(400);
  });

  it('rejects an over-cap entry with 400 naming the byte limit', async () => {
    const { status, body } = await send('POST', '/api/v1/governance/steering/import', {
      entries: [{ kind: 'doc', content: 'x'.repeat(512 * 1024 + 1) }],
    });
    expect(status).toBe(400);
    expect(body['error']).toMatch(/entries\[0\]/);
    expect(body['error']).toMatch(/524288-byte/);
  });

  it('imports a mixed batch through the engine seam — fail-closed PER ENTRY, 200 with the per-entry results', async () => {
    steeringSupported = true;
    importThrows = null;
    resetImportCapture();
    importResults = [
      { index: 0, name: 'arch.md', status: 'imported', ids: ['PAT-201', 'PAT-202'] },
      { index: 1, status: 'rejected', error: 'INV-C1: rule id "nope" must match `PAT<3-6 digits>`' },
      { index: 2, status: 'imported', ids: ['POL-201'] },
    ];
    const entries = [
      { kind: 'doc', name: 'arch.md', content: '---\nlayer: api\n---\n# Doctrine' },
      { kind: 'rule', rule: { id: 'nope' } },
      { kind: 'rule', rule: rule({ id: 'POL-201', rule_type: 'policy' }) },
    ];
    const { status, body } = await send('POST', '/api/v1/governance/steering/import', {
      type: 'security',
      entries,
    });
    expect(status).toBe(200);
    expect(body['results']).toEqual(importResults);
    expect(body['imported']).toBe(2);
    expect(body['rejected']).toBe(1);
    // The page's inferred type rides through as the engine-side default steering_type.
    expect(importCaptured?.defaultType).toBe('security');
    expect(importCaptured?.entries).toEqual(entries);
  });

  it('maps an engine failure to 500 — ours, never the caller’s 400', async () => {
    steeringSupported = true;
    importThrows = new Error('store handle poisoned');
    const { status, body } = await send('POST', '/api/v1/governance/steering/import', {
      entries: [{ kind: 'doc', content: '# doc' }],
    });
    expect(status).toBe(500);
    expect(body['error']).toMatch(/store handle poisoned/);
    importThrows = null;
  });
});

describe('POST /api/v1/governance/steering/author — "add with chat" as a governed run', () => {
  it('answers 501 on a pre-steering engine — proposals that cannot land are a trap', async () => {
    steeringSupported = false;
    const { status } = await send('POST', '/api/v1/governance/steering/author', {
      instructions: 'codify our review rules',
    });
    expect(status).toBe(501);
  });

  it('validates paths loudly: absolute-only, and existing on the daemon host', async () => {
    steeringSupported = true;
    const relative = await send('POST', '/api/v1/governance/steering/author', {
      instructions: 'x',
      paths: ['docs/steering.md'],
    });
    expect(relative.status).toBe(400);
    expect(relative.body['error']).toMatch(/must be absolute/);
    const missing = await send('POST', '/api/v1/governance/steering/author', {
      instructions: 'x',
      paths: [join(dir, 'no-such-file.md')],
    });
    expect(missing.status).toBe(400);
    expect(missing.body['error']).toMatch(/does not exist on the daemon host/);
  });

  it('launches the steering-author workflow with the intent, type, and sources in the problem', async () => {
    steeringSupported = true;
    launches = [];
    const { status, body } = await send('POST', '/api/v1/governance/steering/author', {
      instructions: 'Codify the deploy-freeze rules from the ops handbook.',
      type: 'operations',
      sessionId: 'steer-run-1',
      paths: [dir], // exists — the test scratch dir
      repoRef: 'repo-1',
    });
    expect(status).toBe(201);
    expect(body).toEqual({ runId: 'steer-run-1' });
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(launch.workflow).toBe('steering-author');
    expect(launch.sessionId).toBe('steer-run-1');
    expect(launch.repoRef).toBe('repo-1');
    expect(launch.problem).toContain("'operations' steering type");
    expect(launch.problem).toContain('Codify the deploy-freeze rules');
    expect(launch.problem).toContain(`- ${dir}`);
    // The landing contract (crew#388): the problem names the per-run machine-readable proposal
    // file, and the launch declares the inbox as the run's extra write root so the propose phase
    // may actually write it — the file the gate handler's landing reads FIRST.
    const inbox = steeringInboxDir('steer-run-1');
    expect(launch.problem).toContain(join(inbox, 'proposed-rules.json'));
    expect(launch.extraWriteRoots).toEqual([inbox]);
    expect(existsSync(inbox)).toBe(true); // created for every authoring run, documents or not
  });

  it('writes inline documents into the per-run steering inbox and names their PATHS in the problem', async () => {
    steeringSupported = true;
    launches = [];
    const { status, body } = await send('POST', '/api/v1/governance/steering/author', {
      instructions: 'Turn this doc into steering rules.',
      sessionId: 'steer-run-2',
      documents: [{ name: 'a b/../weird name.md', content: '# handbook\nnever deploy on friday' }],
    });
    expect(status).toBe(201);
    expect(body).toEqual({ runId: 'steer-run-2' });
    const inbox = steeringInboxDir('steer-run-2');
    // basename + charset scrub + index prefix: the caller's name is display text, never a path.
    const docPath = join(inbox, '0-weird_name.md');
    expect(existsSync(docPath)).toBe(true);
    expect(readFileSync(docPath, 'utf8')).toContain('never deploy on friday');
    expect(launches[0]!.problem).toContain(`- ${docPath}`);
    // Only the PATH rides the problem statement, never the content.
    expect(launches[0]!.problem).not.toContain('never deploy on friday');
  });

  it('refuses a sessionId that could escape the inbox — the run id names a directory', async () => {
    steeringSupported = true;
    launches = [];
    for (const evil of ['../../escape', '..', 'a/b', 'a\\b']) {
      const { status, body } = await send('POST', '/api/v1/governance/steering/author', {
        instructions: 'x',
        sessionId: evil,
        documents: [{ name: 'a.md', content: 'never lands' }],
      });
      expect(status).toBe(400);
      expect(body['error']).toMatch(/sessionId/);
    }
    // The refusal came BEFORE the inbox write and the launch: nothing escaped, nothing ran.
    // (`steeringInboxDir('..')` would have aliased the inbox root's PARENT — this scratch dir —
    // landing the document at `<dir>/0-a.md`.)
    expect(launches).toEqual([]);
    expect(existsSync(join(dir, '0-a.md'))).toBe(false);
  });

  it('maps an engine-busy launch refusal to 409', async () => {
    steeringSupported = true;
    launchThrows = new Error('a run with this id is already in flight');
    const { status } = await send('POST', '/api/v1/governance/steering/author', {
      instructions: 'x',
    });
    expect(status).toBe(409);
    launchThrows = null;
  });
});

describe('CoreAdapter.importSteeringRules — the engine seam', () => {
  it('marshals {default_type, entries} and normalizes Rust `Option` nulls to ABSENT keys', async () => {
    // A fresh adapter (the shared one has this method stubbed out): inject the napi binding the
    // way the launch tests inject theirs, answering the null-spelled shape a Rust addon without
    // `skip_serializing_if` would ship — the published wire type spells absence as an absent key.
    const a = new CoreAdapter({ dbPath: join(dir, 'seam.db'), stub: true });
    try {
      let capturedBatch: string | undefined;
      (a as unknown as { core: Record<string, unknown> })['core']['steeringImport'] = async (
        batchJson: string,
      ) => {
        capturedBatch = batchJson;
        return JSON.stringify([
          { index: 0, name: null, status: 'imported', ids: ['PAT-301'], error: null },
          { index: 1, name: 'b.md', status: 'rejected', ids: null, error: 'INV-C1' },
        ]);
      };
      expect(a.steeringSupported()).toBe(true);
      const results = await a.importSteeringRules([{ kind: 'doc', content: '# x' }], 'security');
      expect(JSON.parse(capturedBatch!)).toEqual({
        default_type: 'security',
        entries: [{ kind: 'doc', content: '# x' }],
      });
      expect(results).toEqual([
        { index: 0, status: 'imported', ids: ['PAT-301'] },
        { index: 1, name: 'b.md', status: 'rejected', error: 'INV-C1' },
      ]);
      expect('error' in results[0]!).toBe(false);
      expect('ids' in results[1]!).toBe(false);
    } finally {
      a.close();
    }
  });
});

describe('the steering-author drop-in workflow (TH-12 propose-as-gate)', () => {
  it('is served, terminal `propose` phase gated by an UNCONDITIONAL human confirm', () => {
    const def = adapter.getWorkflow('steering-author');
    expect(def).not.toBeNull();
    expect(def!.phases.map((p) => p.id)).toEqual(['analyze', 'propose']);
    const propose = def!.phases[1]!;
    expect(propose.gate).toEqual({ human_confirm: { unconditional: true } });
    expect(propose.role).toBe('creator');
    // What GET /workflows/:id reports as humanGates — the operator sees the gate BEFORE launch.
    expect(humanGatePhaseIds(def!)).toEqual(['propose']);
    // Neither phase writes the store: the propose output is a PROPOSAL; approved rules land via
    // the governed rules CRUD with provenance.source "chat".
    for (const p of def!.phases) {
      expect(p.instructions).toMatch(/do not write/i);
    }
  });
});
