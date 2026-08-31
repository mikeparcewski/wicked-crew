// The Testing surface (crew-testing) — route behavior over a stubbed adapter.
//
// The evals themselves (decide-path replay, gap detection, nearest-rule similarity) are the
// ENGINE's, exercised by wicked-core's own tests; THIS file pins the HTTP contract the crew
// routes owe regardless of the installed engine — the PINNED crew/studio wire contract (the
// steering wave shipped a drift because each side guessed, so the spellings here are load-
// bearing):
//
//  - POST /testing/evals/run — 200 with the engine's serde report passed through VERBATIM
//    (snake_case: `summary.false_positives`, `sample.steering_type`, `nearest_rules[].rule_id`;
//    `degraded` stays in-band, `null` included); `{}` and a bodyless POST are legal spellings
//    of the all-defaults run; 400 (zod, unknown keys named) / 501 (pre-evals engine) / 500
//    (engine failure).
//  - POST /testing/corpora/import — 200 `{ imported, scope: "evals:<name>", embedded }`
//    passthrough; strict sample schema (snake_case `steering_type`, closed `kind`); same
//    400/501/500 posture.
//  - The presence gate is REAL against the installed addon: wicked-core-ts 0.7.4 carries no
//    `governanceEvals` binding, so the un-stubbed adapter must refuse with
//    GovernanceEvalsUnsupportedError — the routes must serve 501, never crash (the binding
//    ships with the unreleased 0.7.5).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, GovernanceEvalsUnsupportedError } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type {
  GovernanceEvalReport,
  GovernanceEvalSample,
  ImportEvalCorpusResponse,
} from '../src/core/types.js';

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

/** Behavior toggles, reassigned per case (the governance-steering-routes pattern). */
let evalsSupported = false;
/** What the stubbed evals seam captured, and what it answers / throws. */
let evalsCaptured: { type?: string; corpus?: string } | null = null;
let evalsThrows: Error | null = null;
/** What the stubbed corpus-import seam captured, and what it answers / throws. */
let importCaptured: { name: string; samples: GovernanceEvalSample[] } | null = null;
let importThrows: Error | null = null;

/** The un-stubbed adapter methods, kept so the REAL 0.7.4 presence gate stays testable. */
let realEvalsSupported: () => boolean;
let realRunEvals: (args: { type?: string; corpus?: string }) => Promise<GovernanceEvalReport>;
let realImportCorpus: (
  name: string,
  samples: GovernanceEvalSample[],
) => Promise<ImportEvalCorpusResponse>;

/** The engine's serde report, snake_case — the exact shape the wire must carry. */
const REPORT: GovernanceEvalReport = {
  results: [
    {
      sample: {
        id: 'S-001',
        description: 'writes production config during the build phase',
        kind: 'bad',
        steering_type: 'security',
      },
      expected: 'deny',
      fired: ['POL-007'],
      verdict: 'caught',
    },
    {
      sample: {
        id: 'S-002',
        description: 'ships a schema migration with no review',
        kind: 'bad',
        steering_type: 'development',
      },
      expected: 'deny',
      fired: [],
      verdict: 'gap',
      nearest_rules: [{ rule_id: 'PAT-014', similarity: 0.62 }],
    },
    {
      sample: {
        id: 'S-003',
        description: 'ordinary lint fix in a leaf module',
        kind: 'good',
        steering_type: 'development',
      },
      expected: 'allow',
      fired: ['POL-002'],
      verdict: 'false_positive',
      nearest_rules: [],
    },
  ],
  summary: { total: 3, caught: 1, gaps: 1, false_positives: 1 },
  degraded: null,
};

const IMPORT_ANSWER: ImportEvalCorpusResponse = {
  imported: 2,
  scope: 'evals:dev-behaviors',
  embedded: true,
};

const SAMPLES: GovernanceEvalSample[] = [
  {
    id: 'S-101',
    description: 'force-push to the default branch',
    kind: 'bad',
    steering_type: 'development',
    signals: { phase: 'build', tool: 'git', content: 'git push --force origin main' },
  },
  {
    id: 'S-102',
    description: 'adds a unit test beside the changed module',
    kind: 'good',
    steering_type: 'testing',
    signals: { files: ['src/foo.ts', 'tests/foo.test.ts'] },
  },
];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'testing-routes-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

  // Keep the REAL methods reachable before stubbing: the installed wicked-core-ts (0.7.4)
  // carries no evals bindings, so these ARE the without-binding half of the contract.
  realEvalsSupported = adapter.governanceEvalsSupported.bind(adapter);
  realRunEvals = adapter.runGovernanceEvals.bind(adapter);
  realImportCorpus = adapter.importGovernanceCorpus.bind(adapter);

  // Stub the evals seams INSTANCE-LEVEL (the steering-routes pattern): these tests pin the
  // routes' mapping, and must answer the same whether the installed addon carries the evals
  // bindings or not.
  adapter.governanceEvalsSupported = () => evalsSupported;
  adapter.runGovernanceEvals = async (args) => {
    if (!evalsSupported) throw new GovernanceEvalsUnsupportedError('Running governance evals');
    if (evalsThrows) throw evalsThrows;
    evalsCaptured = args;
    return REPORT;
  };
  adapter.importGovernanceCorpus = async (name, samples) => {
    if (!evalsSupported) throw new GovernanceEvalsUnsupportedError('Importing an eval corpus');
    if (importThrows) throw importThrows;
    importCaptured = { name, samples };
    return IMPORT_ANSWER;
  };

  app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  // close() returns before the actor thread finishes flushing SQLite's WAL sidecars, and
  // `force` does not cover the ENOTEMPTY that races with it — retries do (the repo pattern).
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  evalsSupported = false;
  evalsCaptured = null;
  evalsThrows = null;
  importCaptured = null;
  importThrows = null;
});

async function post(path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe('the real presence gate (installed wicked-core-ts, no evals bindings)', () => {
  it('the un-stubbed adapter reports unsupported and refuses both seams', async () => {
    // The installed addon is 0.7.4 — no governanceEvals binding. If this ever flips to true,
    // the 501 posture below is obsolete and this file should start exercising the real seam.
    expect(realEvalsSupported()).toBe(false);
    await expect(realRunEvals({})).rejects.toThrow(GovernanceEvalsUnsupportedError);
    await expect(realImportCorpus('dev-behaviors', SAMPLES)).rejects.toThrow(
      GovernanceEvalsUnsupportedError,
    );
  });

  it('END TO END: both routes answer 501 over an adapter nothing stubbed (verifier pin)', async () => {
    // No instance-level stubs anywhere in this chain: a fresh adapter over the INSTALLED
    // addon, a fresh server over that adapter — the exact composition a `wicked-crew serve`
    // daemon ships against the released 0.7.4 engine. Proves the two halves the other tests
    // pin separately (adapter throws ⇒ route maps to 501) actually meet on the wire.
    const dir2 = mkdtempSync(join(tmpdir(), 'testing-gate-'));
    const bare = new CoreAdapter({ dbPath: join(dir2, 'core.db'), stub: true });
    const app2 = await createServer(bare, { auditPath: join(dir2, 'audit.log') });
    try {
      await app2.listen({ port: 0, host: '127.0.0.1' });
      const addr = app2.server.address();
      const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      for (const [path, body] of [
        ['/api/v1/testing/evals/run', {}],
        ['/api/v1/testing/corpora/import', { name: 'dev-behaviors', samples: SAMPLES }],
      ] as const) {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(501);
        const answer = (await res.json()) as { error?: string };
        expect(answer.error).toMatch(/governanceEvals binding/);
      }
    } finally {
      await app2.close();
      bare.close();
      // Same WAL-flush race as the afterAll above — `force` does not cover ENOTEMPTY; retries do.
      rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('POST /api/v1/testing/evals/run', () => {
  it('501 with an honest upgrade pointer when the engine predates the evals bindings', async () => {
    const res = await post('/api/v1/testing/evals/run', {});
    expect(res.status).toBe(501);
    expect(res.body['error']).toMatch(/governanceEvals binding/);
    expect(res.body['error']).toMatch(/0\.7\.5/);
  });

  it('200: passes the engine report through verbatim — snake_case survives the wire', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/evals/run', {
      type: 'development',
      corpus: 'evals:dev-behaviors',
    });
    expect(res.status).toBe(200);
    // The whole report, structurally identical to the engine's serde output.
    expect(res.body).toEqual(REPORT);
    // The pinned spellings, on the RAW wire text: no camelCasing, no reshaping.
    expect(res.text).toContain('"false_positives"');
    expect(res.text).toContain('"steering_type"');
    expect(res.text).toContain('"nearest_rules"');
    expect(res.text).toContain('"rule_id"');
    expect(res.text).not.toContain('"falsePositives"');
    // `degraded: null` stays IN-BAND (the honesty marker), never stripped.
    expect('degraded' in res.body).toBe(true);
    expect(res.body['degraded']).toBeNull();
    // The args reached the adapter as sent.
    expect(evalsCaptured).toEqual({ type: 'development', corpus: 'evals:dev-behaviors' });
  });

  it('200 on `{}` — both fields optional: default corpus, every steering type', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/evals/run', {});
    expect(res.status).toBe(200);
    expect(evalsCaptured).toEqual({});
  });

  it('200 on a bodyless POST — a legal spelling of the all-defaults run', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/evals/run');
    expect(res.status).toBe(200);
    expect(evalsCaptured).toEqual({});
  });

  it('400 on a type outside the 7-value steering vocabulary', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/evals/run', { type: 'vibes' });
    expect(res.status).toBe(400);
    expect(evalsCaptured).toBeNull();
  });

  it('400 names an unknown field rather than silently ignoring it', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/evals/run', { corpsu: 'evals:dev-behaviors' });
    expect(res.status).toBe(400);
    expect(res.body['error']).toContain('`corpsu`');
  });

  it('500 when the engine fails after a valid request — our fault, never a 400', async () => {
    evalsSupported = true;
    evalsThrows = new Error('store exploded');
    const res = await post('/api/v1/testing/evals/run', {});
    expect(res.status).toBe(500);
    expect(res.body['error']).toBe('store exploded');
  });
});

describe('POST /api/v1/testing/corpora/import', () => {
  const VALID = { name: 'dev-behaviors', samples: SAMPLES };

  it('501 with the same honest upgrade pointer — the bindings ship together', async () => {
    const res = await post('/api/v1/testing/corpora/import', VALID);
    expect(res.status).toBe(501);
    expect(res.body['error']).toMatch(/governanceEvals binding/);
  });

  it('200: happy path — samples reach the adapter as sent, answer passes through', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/corpora/import', VALID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: 2, scope: 'evals:dev-behaviors', embedded: true });
    expect(importCaptured).toEqual({ name: 'dev-behaviors', samples: SAMPLES });
  });

  it('400 on a missing name', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/corpora/import', { samples: SAMPLES });
    expect(res.status).toBe(400);
    expect(importCaptured).toBeNull();
  });

  it('400 on an empty samples array — an import that imports nothing is a caller mistake', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/corpora/import', { name: 'empty', samples: [] });
    expect(res.status).toBe(400);
  });

  it('400 on a sample kind outside good|bad', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/corpora/import', {
      name: 'dev-behaviors',
      samples: [{ ...SAMPLES[0], kind: 'ugly' }],
    });
    expect(res.status).toBe(400);
  });

  it('400 names an unknown sample field — strict all the way down', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/corpora/import', {
      name: 'dev-behaviors',
      samples: [{ ...SAMPLES[0], steeringType: 'development' }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body['details'])).toContain('steeringType');
  });

  it('400 names an unknown top-level field', async () => {
    evalsSupported = true;
    const res = await post('/api/v1/testing/corpora/import', { ...VALID, overwrite: true });
    expect(res.status).toBe(400);
    expect(res.body['error']).toContain('`overwrite`');
  });

  it('500 when the engine fails after a valid request', async () => {
    evalsSupported = true;
    importThrows = new Error('knowledge store locked');
    const res = await post('/api/v1/testing/corpora/import', VALID);
    expect(res.status).toBe(500);
    expect(res.body['error']).toBe('knowledge store locked');
  });
});
