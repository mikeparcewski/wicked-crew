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
//  - The evals test plan's route scenarios (docs/testing/evals-test-plan.md): S13 the degraded
//    `facet-only` + `rule_coverage` readings pass through the run AND the history untouched; S18
//    the snake_case guard asserts PLACEMENT and OMISSION rules over the parsed body (not raw
//    substrings — `nearest_rules` rides gaps only, so `rule_id` need not occur at all); S19 the
//    two 501s carry the SAME upgrade pointer; S2 traversal ids over the real HTTP route; and the
//    persist-failure path (`testing.ts` LOUD-NON-FATAL) still answers the report.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, GovernanceEvalsUnsupportedError } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { perTypeRollup } from '../src/api/testing.js';
import { removeScratch } from './setup/scratch.js';
import type {
  GovernanceEvalReport,
  GovernanceEvalResult,
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
/** The report the stubbed engine answers — REPORT by default, reassigned per case (S13). */
let evalsAnswer: GovernanceEvalReport;
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

/** The engine's serde report, snake_case — the exact shape the wire must carry. `nearest_rules`
 *  rides the GAP only: the engine omits it on every other verdict (evals.rs `SampleResult`,
 *  `skip_serializing_if = Option::is_none`), so the fixture must not invent it elsewhere. */
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
    },
  ],
  summary: { total: 3, caught: 1, gaps: 1, false_positives: 1 },
  degraded: null,
};

/**
 * The same run as REPORT, but from an engine whose gap-hint embedder was unavailable
 * (`degraded: 'facet-only'` — verdicts identical, hints lexical) and which carries the core #394
 * rule-side coverage. The wire fixture the S12/S13 passthrough pins; the stub's `REPORT` always
 * said `degraded: null`, so this path had no crew-side test before.
 */
const REPORT_DEGRADED: GovernanceEvalReport = {
  ...REPORT,
  degraded: 'facet-only',
  rule_coverage: {
    exercised: 2,
    unexercised: [
      { rule_id: 'PAT-014', steering_type: 'development' },
      { rule_id: 'POL-1301', steering_type: 'architecture' },
    ],
  },
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
    return evalsAnswer;
  };
  adapter.importGovernanceCorpus = async (name, samples) => {
    if (!evalsSupported) throw new GovernanceEvalsUnsupportedError('Importing an eval corpus');
    if (importThrows) throw importThrows;
    importCaptured = { name, samples };
    return IMPORT_ANSWER;
  };

  app = await createServer(adapter, {
    auditPath: join(dir, 'audit.log'),
    // Isolate the eval history off the operator's real ~/.wicked-crew/evals (the run route records
    // every POST /testing/evals/run through this store).
    evalStoreRoot: join(dir, 'evals'),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  // close() returns before the actor thread finishes flushing SQLite's WAL sidecars, and
  // `force` does not cover the ENOTEMPTY that races with it — retries do (the repo pattern).
  removeScratch(dir);
});

beforeEach(() => {
  evalsSupported = false;
  evalsCaptured = null;
  evalsThrows = null;
  evalsAnswer = REPORT;
  importCaptured = null;
  importThrows = null;
});

/** Every key at every depth of a parsed wire body — the S18 spelling guard walks these. */
function allKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => allKeys(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      `${path}.${k}`,
      ...allKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

// Engine-generation probe (the SC-005 pattern): the evals bindings ship with wicked-core-ts
// 0.7.5. Against an older installed addon the routes MUST 501; against 0.7.5+ (what crew's CI
// links from wicked-core main, and what the ^0.7.5 pin installs) the same un-stubbed
// composition must serve the real seam — both postures are pinned below, gated on this probe.
const _require = createRequire(import.meta.url);
const EVALS_CAPABLE = (() => {
  try {
    const { Core } = _require('wicked-core-ts') as { Core: { spawnStub(p: string): Record<string, unknown> } };
    const probe = Core.spawnStub(join(tmpdir(), 'evals-probe.db'));
    return typeof probe['governanceEvals'] === 'function';
  } catch {
    return false;
  }
})();

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

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe.runIf(!EVALS_CAPABLE)('the real presence gate (installed wicked-core-ts predates the evals bindings)', () => {
  it('the un-stubbed adapter reports unsupported and refuses both seams', async () => {
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
      removeScratch(dir2);
    }
  });
});

describe.runIf(EVALS_CAPABLE)('the real seam (installed wicked-core-ts carries the evals bindings)', () => {
  it('END TO END: the un-stubbed composition serves both routes for real', async () => {
    // The positive twin of the 501 pin: a fresh adapter over the INSTALLED addon, a fresh
    // server over that adapter, a temp store. The knowledge db is NOT dbPath-derived — the
    // engine defaults it to the operator's real `~/.wicked-estate/knowledge.db` (evals.rs
    // `default_knowledge_db()`), so this import is hermetic ONLY because
    // tests/setup/hermetic-home.ts arms WICKED_CREW_KNOWLEDGE_DB (crew#396) — asserted below.
    // An empty rules store means the default corpus evaluates to gaps — an HONEST report,
    // which is the product working.
    const armedKnowledgeDb = process.env['WICKED_CREW_KNOWLEDGE_DB'];
    expect(armedKnowledgeDb, 'hermetic-home.ts must arm WICKED_CREW_KNOWLEDGE_DB').toBeTruthy();
    expect(realEvalsSupported()).toBe(true);
    const dir2 = mkdtempSync(join(tmpdir(), 'testing-real-'));
    const bare = new CoreAdapter({ dbPath: join(dir2, 'core.db'), stub: true });
    const app2 = await createServer(bare, { auditPath: join(dir2, 'audit.log') });
    try {
      await app2.listen({ port: 0, host: '127.0.0.1' });
      const addr = app2.server.address();
      const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      const imp = await fetch(`${base}/api/v1/testing/corpora/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'dev-behaviors', samples: SAMPLES }),
      });
      expect(imp.status).toBe(200);
      const receipt = (await imp.json()) as { imported?: number; scope?: string; embedded?: boolean };
      expect(receipt.imported).toBe(SAMPLES.length);
      expect(receipt.scope).toBe('evals:dev-behaviors');
      expect(typeof receipt.embedded).toBe('boolean');
      const run = await fetch(`${base}/api/v1/testing/evals/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(run.status).toBe(200);
      const report = (await run.json()) as Record<string, unknown>;
      expect(Array.isArray(report['results'])).toBe(true);
      const summary = report['summary'] as Record<string, unknown>;
      for (const k of ['total', 'caught', 'gaps', 'false_positives']) {
        expect(typeof summary[k], `summary.${k}`).toBe('number');
      }
      expect('degraded' in report, 'degraded is always in-band').toBe(true);
      // The import LANDED in the armed store, not the operator's real ~/.wicked-estate —
      // the write half of the hermetic guarantee, provable because the path is ours.
      expect(
        existsSync(armedKnowledgeDb as string),
        `the corpus import did not write the armed knowledge db (${armedKnowledgeDb}) — ` +
          `if the adapter stopped honoring WICKED_CREW_KNOWLEDGE_DB it is writing the ` +
          `operator's real ~/.wicked-estate/knowledge.db (crew#396)`,
      ).toBe(true);
    } finally {
      await app2.close();
      bare.close();
      removeScratch(dir2);
    }
  }, 60000);
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
    expect(res.text).not.toContain('"falsePositives"');
    // `degraded: null` stays IN-BAND (the honesty marker), never stripped.
    expect('degraded' in res.body).toBe(true);
    expect(res.body['degraded']).toBeNull();
    // The args reached the adapter as sent.
    expect(evalsCaptured).toEqual({ type: 'development', corpus: 'evals:dev-behaviors' });
  });

  it('S18: the snake_case guard — PLACEMENT and OMISSION over the parsed body, not raw substrings', async () => {
    // Why not `text.toContain('"rule_id"')`: `nearest_rules` is omitted on non-gap results and a
    // gap may carry an EMPTY hint array, so a perfectly valid engine report need not contain
    // `rule_id` anywhere. The guard therefore asserts WHERE each spelling sits and WHEN it is
    // absent — the contract the studio's report view actually relies on.
    evalsSupported = true;
    const res = await post('/api/v1/testing/evals/run', {});
    expect(res.status).toBe(200);
    const body = res.body as unknown as GovernanceEvalReport;
    // 1. Every key at every depth is snake_case (or a bare lowercase word): no camelCase anywhere.
    const keys = allKeys(body).map((p) => p.slice(p.lastIndexOf('.') + 1));
    for (const k of keys) expect(k, `key ${k}`).toMatch(/^[a-z][a-z0-9_]*$/);
    // 2. Placement: the rollup's spelling and types.
    expect(typeof body.summary.false_positives).toBe('number');
    expect(body.summary.total).toBe(body.summary.caught + body.summary.gaps + body.summary.false_positives);
    // 3. Per result: the sample slice is the pinned 4-field echo; `expected` derives from `kind`;
    //    `nearest_rules` is present iff the verdict is `gap` (an array — possibly empty — of
    //    {rule_id, similarity}); absent — not null, not [] — on caught / false_positive.
    for (const r of body.results) {
      expect(Object.keys(r.sample).sort()).toEqual(['description', 'id', 'kind', 'steering_type']);
      expect(r.expected).toBe(r.sample.kind === 'bad' ? 'deny' : 'allow');
      expect(Array.isArray(r.fired)).toBe(true);
      if (r.verdict === 'gap') {
        expect(Array.isArray(r.nearest_rules), `${r.sample.id} gap carries nearest_rules`).toBe(true);
        for (const hint of r.nearest_rules!) {
          expect(Object.keys(hint).sort()).toEqual(['rule_id', 'similarity']);
          expect(typeof hint.rule_id).toBe('string');
          expect(typeof hint.similarity).toBe('number');
        }
      } else {
        expect('nearest_rules' in r, `${r.sample.id} (${r.verdict}) must OMIT nearest_rules`).toBe(false);
      }
    }
    // 4. The fixture's known gap carries a known non-empty hint — so the placement assertions above
    //    actually ran over a hint, not vacuously over an empty array.
    const gap = body.results.find((r) => r.sample.id === 'S-002') as GovernanceEvalResult;
    expect(gap.nearest_rules).toEqual([{ rule_id: 'PAT-014', similarity: 0.62 }]);
    // 5. `degraded` is in-band even when null; `rule_coverage` is ABSENT (not null) on a report
    //    from an engine that emitted none.
    expect('degraded' in body).toBe(true);
    expect('rule_coverage' in body).toBe(false);
  });

  it('S13: `degraded: "facet-only"` and `rule_coverage` pass through the run route untouched', async () => {
    evalsSupported = true;
    evalsAnswer = REPORT_DEGRADED;
    const res = await post('/api/v1/testing/evals/run', {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(REPORT_DEGRADED);
    expect(res.body['degraded']).toBe('facet-only');
    const coverage = res.body['rule_coverage'] as { exercised: number; unexercised: unknown[] };
    expect(coverage.exercised).toBe(2);
    expect(coverage.unexercised).toEqual([
      { rule_id: 'PAT-014', steering_type: 'development' },
      { rule_id: 'POL-1301', steering_type: 'architecture' },
    ]);
    // Verdicts are the SAME as the full-fidelity run — degradation is about hints, not judgments.
    expect(res.body['summary']).toEqual(REPORT.summary);
    expect(res.text).not.toContain('"ruleCoverage"');
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

  it('S19: 501 with the SAME honest upgrade pointer as the run route — the bindings ship together', async () => {
    const imp = await post('/api/v1/testing/corpora/import', VALID);
    expect(imp.status).toBe(501);
    const run = await post('/api/v1/testing/evals/run', {});
    expect(run.status).toBe(501);
    const impErr = imp.body['error'] as string;
    const runErr = run.body['error'] as string;
    // Both name the missing binding and the release that carries it …
    for (const err of [impErr, runErr]) {
      expect(err).toMatch(/governanceEvals binding/);
      expect(err).toMatch(/>= 0\.7\.5/);
    }
    // … and differ ONLY in the action prefix: strip it and the pointer text is byte-identical,
    // so an operator sees one upgrade instruction, not two that could drift apart.
    expect(impErr.startsWith('Importing an eval corpus ')).toBe(true);
    expect(runErr.startsWith('Running governance evals ')).toBe(true);
    expect(impErr.slice('Importing an eval corpus'.length)).toBe(runErr.slice('Running governance evals'.length));
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

// The eval RUN history the run route records (crew-side EvalRunStore) — the Evals section's list +
// drilldown. Stub-adapter path: a `POST /testing/evals/run` returns REPORT verbatim AND is recorded,
// so the GET routes read it back. A unique `corpus` tag per case makes assertions robust against the
// rows the run-route cases above already recorded into the same (per-suite) store.
describe('the eval RUN history — GET /api/v1/testing/evals[/:id]', () => {
  it('a successful run is RECORDED — it appears in the history with the DERIVED rollup, no results', async () => {
    evalsSupported = true;
    expect((await post('/api/v1/testing/evals/run', { corpus: 'evals:hist-a' })).status).toBe(200);

    const list = await get(`/api/v1/testing/evals?corpus=${encodeURIComponent('evals:hist-a')}`);
    expect(list.status).toBe(200);
    const runs = list.body['runs'] as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    const row = runs[0]!;
    expect(row['corpus']).toBe('evals:hist-a');
    expect(row['type_filter']).toBeNull();
    expect(row['summary']).toEqual(REPORT.summary);
    // per_type is DERIVED from the results (1 security caught, 2 development [1 gap + 1 fp]) — a
    // stored field, not a per-request recompute.
    const perType = row['per_type'] as Record<string, unknown>;
    expect(perType['security']).toEqual({ total: 1, caught: 1, gaps: 0, false_positives: 0 });
    expect(perType['development']).toEqual({ total: 2, caught: 0, gaps: 1, false_positives: 1 });
    // A rollup row is cheap — the per-sample results are NOT on it (they live on the drilldown).
    expect('results' in row).toBe(false);
    expect(typeof row['id']).toBe('string');
    expect(typeof row['created_at']).toBe('number');
    expect(row['rule_store']).toContain('core.db'); // the daemon's own steering store the run judged
    expect(row['degraded']).toBeNull();
  });

  it('the drilldown returns the full per-sample results, snake_case verbatim', async () => {
    evalsSupported = true;
    expect((await post('/api/v1/testing/evals/run', { corpus: 'evals:hist-b' })).status).toBe(200);
    const list = await get(`/api/v1/testing/evals?corpus=${encodeURIComponent('evals:hist-b')}`);
    const id = (list.body['runs'] as Array<Record<string, unknown>>)[0]!['id'] as string;

    const detail = await get(`/api/v1/testing/evals/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body['id']).toBe(id);
    // The same verbatim report the run returned — the report view renders it unchanged.
    expect(detail.body['results']).toEqual(REPORT.results);
    expect(detail.body['summary']).toEqual(REPORT.summary);
  });

  it('an unknown run id → 404, not a crash', async () => {
    const res = await get('/api/v1/testing/evals/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('S2 over HTTP: encoded / embedded-slash traversal ids → 404, the planted file is never read', async () => {
    // A sentinel OUTSIDE the results dir but inside the store root — the file a traversal id
    // that survived decoding would resolve. If any shape below reached it, the route would
    // answer 200 with THIS body instead of 404.
    writeFileSync(join(dir, 'evals', 'secret.json'), JSON.stringify({ id: 'secret', results: [] }), 'utf8');
    for (const raw of ['..%2Fsecret', '%2e%2e%2fsecret', '..%5Csecret', 'results%2F..%2Fsecret', 'x%2Fy', 'a.b', '.%2Esecret']) {
      const res = await get(`/api/v1/testing/evals/${raw}`);
      expect(res.status, raw).toBe(404);
      expect(res.body['id'], raw).toBeUndefined();
    }
  });

  it('S13: the degraded + rule_coverage readings are RECORDED verbatim and served by the list and the drilldown', async () => {
    evalsSupported = true;
    evalsAnswer = REPORT_DEGRADED;
    expect((await post('/api/v1/testing/evals/run', { corpus: 'evals:hist-degraded' })).status).toBe(200);
    const list = await get(`/api/v1/testing/evals?corpus=${encodeURIComponent('evals:hist-degraded')}`);
    const row = (list.body['runs'] as Array<Record<string, unknown>>)[0]!;
    expect(row['degraded']).toBe('facet-only');
    expect(row['rule_coverage']).toEqual(REPORT_DEGRADED.rule_coverage);
    const detail = await get(`/api/v1/testing/evals/${row['id'] as string}`);
    expect(detail.status).toBe(200);
    expect(detail.body['degraded']).toBe('facet-only');
    expect(detail.body['rule_coverage']).toEqual(REPORT_DEGRADED.rule_coverage);
    expect(detail.body['results']).toEqual(REPORT_DEGRADED.results);
    // And a run from an engine WITHOUT coverage is recorded without the key — the row says so
    // by absence, never by a fabricated `null`/`{}`.
    evalsAnswer = REPORT;
    expect((await post('/api/v1/testing/evals/run', { corpus: 'evals:hist-plain' })).status).toBe(200);
    const plain = await get(`/api/v1/testing/evals?corpus=${encodeURIComponent('evals:hist-plain')}`);
    const plainRow = (plain.body['runs'] as Array<Record<string, unknown>>)[0]!;
    expect('rule_coverage' in plainRow).toBe(false);
    expect(plainRow['degraded']).toBeNull();
  });

  it('a history-persist failure is LOUD-NON-FATAL: the report still answers 200, the history reads empty', async () => {
    // A fresh daemon whose eval store root has `results` pre-created as a FILE, so the store's
    // detail write fails on every record — the report is the contract and must answer anyway
    // (testing.ts: warned, swallowed, never a 500); the history honestly lists nothing.
    const dir3 = mkdtempSync(join(tmpdir(), 'testing-persist-fail-'));
    const storeRoot = join(dir3, 'evals');
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(join(storeRoot, 'results'), 'not a directory', 'utf8');
    const faulty = new CoreAdapter({ dbPath: join(dir3, 'core.db'), stub: true });
    faulty.governanceEvalsSupported = () => true;
    faulty.runGovernanceEvals = async () => REPORT;
    const app3 = await createServer(faulty, { auditPath: join(dir3, 'audit.log'), evalStoreRoot: storeRoot });
    try {
      await app3.listen({ port: 0, host: '127.0.0.1' });
      const addr = app3.server.address();
      const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      const run = await fetch(`${base}/api/v1/testing/evals/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(run.status).toBe(200);
      expect(await run.json()).toEqual(REPORT);
      const list = await fetch(`${base}/api/v1/testing/evals`);
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ runs: [] });
    } finally {
      await app3.close();
      faulty.close();
      removeScratch(dir3);
    }
  });

  it('?type= narrows the history to comparable runs (the request type, not the sample types)', async () => {
    evalsSupported = true;
    await post('/api/v1/testing/evals/run', { type: 'security', corpus: 'evals:hist-c' });
    const list = await get(`/api/v1/testing/evals?type=security&corpus=${encodeURIComponent('evals:hist-c')}`);
    const runs = list.body['runs'] as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!['type_filter']).toBe('security');
  });
});

describe('perTypeRollup — keys stay within the SteeringType vocabulary (Copilot #467)', () => {
  it('buckets the 7 known types and SKIPS an off-vocabulary steering_type (open wire string)', () => {
    const rollup = perTypeRollup([
      { sample: { id: 'a', description: '', kind: 'bad', steering_type: 'security' }, expected: 'deny', fired: [], verdict: 'caught' },
      { sample: { id: 'b', description: '', kind: 'good', steering_type: 'security' }, expected: 'allow', fired: [], verdict: 'false_positive' },
      // An off-vocabulary type the engine's open-string field could carry — must NOT become a key.
      { sample: { id: 'c', description: '', kind: 'bad', steering_type: 'made-up-type' }, expected: 'deny', fired: [], verdict: 'gap' },
    ]);
    expect(Object.keys(rollup)).toEqual(['security']);
    expect(rollup.security).toEqual({ total: 2, caught: 1, gaps: 0, false_positives: 1 });
    expect((rollup as Record<string, unknown>)['made-up-type']).toBeUndefined();
  });
});
