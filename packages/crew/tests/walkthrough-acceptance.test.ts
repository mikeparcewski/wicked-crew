// WT-W2 (DES-walkthrough-proof §4.6, §4.9): acceptance reads the run's PROOF ROOTS beside the repo
// ledger, deny-dominates.
//
//   - the seal: the LAST `WALKTHROUGH-SEAL {...}` line of the `walkthrough_review` unit's persisted
//     output (the engine store, which no seat can reach);
//   - `bundle_sha` recomputed from disk at every read — sha256 over the sorted
//     `<sha256>  <relative path>\n` lines of every regular file under the proof root except `app/`
//     and `data/`; a link anywhere else is refused — so a ledger row, capture or result edited after
//     the seal denies "changed after it was sealed";
//   - the proof root's own ledger: a verdict stamped with this crew run and step must exist, and the
//     newest stamped verdict per chapter must equal the sealed chapter verdict;
//   - `checkState` per creator step (checked / failed / claimed / owned_by_you);
//   - a unit whose catalog the engine's FULL catalog does not define fails the requirement closed.

import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WalkthroughView } from 'wicked-crew-api-types';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import { acceptanceRequirementOf } from '../src/qe/acceptance.js';
import {
  computeBundleSha,
  parseSeal,
  resolveWalkthroughGate,
  walkthroughCheckStates,
} from '../src/qe/walkthrough-acceptance.js';
import { removeScratch } from './setup/scratch.js';

const RUN = 'run-w2';
const STEP = 'walkthrough_review';

/** An independent bundle_sha, written from the spec text (not from the module under test). */
function expectedBundle(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(root, p).split(sep).join('/');
      if (rel === 'app' || rel === 'data') continue;
      if (statSync(p).isDirectory()) walk(p);
      else files.push(rel);
    }
  };
  walk(root);
  files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const lines = files.map((rel) => `${createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')}  ${rel}\n`).join('');
  return createHash('sha256').update(lines, 'utf8').digest('hex');
}

interface ChapterSpec {
  key: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  proves?: string[];
  take?: number;
}

/** A recorded proof root: result.json, one stamped ledger run + verdict per chapter, a capture, an app copy. */
function recordProofRoot(root: string, chapters: ChapterSpec[], opts: { overall?: string; stamp?: boolean; tree?: string } = {}): void {
  const tree = opts.tree ?? 'tree-1';
  mkdirSync(join(root, '.wicked-qe', 'runs'), { recursive: true });
  mkdirSync(join(root, '.wicked-qe', 'verdicts'), { recursive: true });
  mkdirSync(join(root, 'capture'), { recursive: true });
  mkdirSync(join(root, 'app', 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'app', 'index.js'), 'console.log(1)');
  writeFileSync(join(root, 'capture', 'c1.parsed.json'), '[{"id":1}]');
  const overall = opts.overall ?? (chapters.every((c) => c.verdict === 'PASS') ? 'PASS' : chapters.some((c) => c.verdict === 'FAIL') ? 'FAIL' : 'INCONCLUSIVE');
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({ overall, tree, chapters: chapters.map((c) => ({ key: c.key, verdict: c.verdict, proves: c.proves ?? ['build'] })) }),
  );
  chapters.forEach((c, i) => {
    const take = c.take ?? 1;
    const id = `qe-${c.key}-t${take}`;
    const at = new Date(Date.UTC(2026, 9, 2, 12, take, i)).toISOString();
    const stamp = opts.stamp === false ? {} : { crew_run_id: RUN, step_id: STEP, tree, take, chapter: c.key };
    writeFileSync(join(root, '.wicked-qe', 'runs', `${id}.json`), JSON.stringify({ id, project_id: 'p', scenario_id: c.key, started_at: at, status: 'done', created_at: at, ...stamp }));
    writeFileSync(
      join(root, '.wicked-qe', 'verdicts', `v-${id}.json`),
      JSON.stringify({ id: `v-${id}`, run_id: id, verdict: c.verdict, reviewer: 'walkthrough-judge', reason: null, created_at: at, ...stamp }),
    );
  });
}

function sealLine(root: string, chapters: ChapterSpec[], overall?: string, extra: Record<string, unknown> = {}): string {
  const o = overall ?? (chapters.every((c) => c.verdict === 'PASS') ? 'PASS' : chapters.some((c) => c.verdict === 'FAIL') ? 'FAIL' : 'INCONCLUSIVE');
  return `WALKTHROUGH-SEAL ${JSON.stringify({
    tree: 'tree-1',
    storyline_sha: 'abc',
    contract_shas: {},
    bundle_sha: expectedBundle(root),
    overall: o,
    chapters: chapters.map((c) => ({ key: c.key, verdict: c.verdict })),
    ...extra,
  })}`;
}

describe('the seal and the bundle (WT-W2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wt-w2-'));
  });
  afterEach(() => removeScratch(dir));

  it('parseSeal reads the LAST seal line of the output; a malformed or absent seal is null', () => {
    const a = 'WALKTHROUGH-SEAL {"bundle_sha":"' + 'a'.repeat(64) + '","overall":"FAIL","chapters":[],"tree":"t"}';
    const b = 'WALKTHROUGH-SEAL {"bundle_sha":"' + 'b'.repeat(64) + '","overall":"PASS","chapters":[{"key":"01-a","verdict":"PASS"}],"tree":"t"}';
    expect(parseSeal(`noise\n${a}\nmore\n${b}\ntail`)).toMatchObject({ bundle_sha: 'b'.repeat(64), overall: 'PASS', tree: 't', chapters: [{ key: '01-a', verdict: 'PASS' }] });
    expect(parseSeal('WALKTHROUGH-SEAL {not json')).toBeNull();
    expect(parseSeal('WALKTHROUGH-SEAL {"overall":"PASS","chapters":[]}')).toBeNull();
    expect(parseSeal('no seal here')).toBeNull();
    // The tree binds the seal to the recorded take (Copilot on #759): a seal without one is refused.
    expect(parseSeal('WALKTHROUGH-SEAL {"bundle_sha":"' + 'c'.repeat(64) + '","overall":"PASS","chapters":[]}')).toBeNull();
    expect(parseSeal('WALKTHROUGH-SEAL {"bundle_sha":"' + 'c'.repeat(64) + '","overall":"PASS","chapters":[],"tree":""}')).toBeNull();
    expect(parseSeal(null)).toBeNull();
  });

  it('bundle_sha covers every file but app/ and data/, matches the spec text, and refuses a link', async () => {
    const root = join(dir, 'proof');
    recordProofRoot(root, [{ key: '01-pay', verdict: 'PASS' }]);
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'app.sqlite'), 'db');
    const first = await computeBundleSha(root);
    expect(first).toEqual({ ok: true, sha: expectedBundle(root), files: expect.any(Number) });
    writeFileSync(join(root, 'app', 'index.js'), 'changed');
    writeFileSync(join(root, 'data', 'app.sqlite'), 'changed');
    expect(await computeBundleSha(root)).toEqual(first);
    writeFileSync(join(root, 'capture', 'c1.parsed.json'), '[]');
    expect(((await computeBundleSha(root)) as { sha: string }).sha).not.toBe((first as { sha: string }).sha);
    // UTF-8 byte order, as LC_ALL=C sorts (Copilot on #759): U+E000 (EE 80 80) sorts before U+10000 (F0 90 80 80),
    // which UTF-16 code-unit order (a JS string compare) gets the other way round.
    writeFileSync(join(root, 'capture', '\u{E000}.json'), '1');
    writeFileSync(join(root, 'capture', '\u{10000}.json'), '2');
    expect(await computeBundleSha(root)).toMatchObject({ ok: true, sha: expectedBundle(root) });
    // A same-size rewrite is seen too (every check re-reads the bytes; nothing is memoized).
    const before = ((await computeBundleSha(root)) as { sha: string }).sha;
    writeFileSync(join(root, 'capture', '\u{E000}.json'), '9');
    expect(((await computeBundleSha(root)) as { sha: string }).sha).not.toBe(before);
    symlinkSync(join(dir, 'elsewhere'), join(root, 'capture', 'link.json'));
    expect(await computeBundleSha(root)).toMatchObject({ ok: false, error: expect.stringMatching(/link/) });
  });
});

describe('resolveWalkthroughGate (WT-W2)', () => {
  let dir: string;
  let root: string;
  const PASSING: ChapterSpec[] = [
    { key: '01-pay-once', verdict: 'PASS' },
    { key: '02-receipt', verdict: 'PASS', proves: ['build', 'build-2'] },
  ];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wt-w2-gate-'));
    root = join(dir, STEP);
  });
  afterEach(() => removeScratch(dir));

  it('a sealed PASS with stamped PASS ledger rows is satisfied, sealed, and carries each chapter\'s proves', async () => {
    recordProofRoot(root, PASSING);
    const g = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: `recording…\n${sealLine(root, PASSING)}\n` });
    expect(g).toMatchObject({ stepId: STEP, sealed: true, satisfied: true, overall: 'PASS' });
    expect(g.reason).toMatch(/PASS/);
    expect(g.chapters).toEqual([
      { key: '01-pay-once', verdict: 'PASS', proves: ['build'] },
      { key: '02-receipt', verdict: 'PASS', proves: ['build', 'build-2'] },
    ]);
  });

  it('no proof root, or no seal in the recorder output, denies (missing ⇒ deny)', async () => {
    expect(await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: null, output: null })).toMatchObject({
      satisfied: false,
      sealed: false,
      reason: expect.stringMatching(/no proof root/),
    });
    recordProofRoot(root, PASSING);
    expect(await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: 'done, no seal' })).toMatchObject({
      satisfied: false,
      sealed: false,
      reason: expect.stringMatching(/not sealed/),
    });
  });

  it('a ledger row, a capture or the result edited after the seal denies: "changed after it was sealed"', async () => {
    for (const edit of [
      (r: string) => writeFileSync(join(r, '.wicked-qe', 'verdicts', 'v-qe-01-pay-once-t1.json'), readFileSync(join(r, '.wicked-qe', 'verdicts', 'v-qe-01-pay-once-t1.json'), 'utf8').replace('walkthrough-judge', 'someone')),
      (r: string) => writeFileSync(join(r, 'capture', 'c1.parsed.json'), '[{"id":1},{"id":2}]'),
      (r: string) => writeFileSync(join(r, 'result.json'), JSON.stringify({ overall: 'PASS', chapters: [] })),
      (r: string) => writeFileSync(join(r, 'capture', 'new.json'), '{}'),
    ]) {
      removeScratch(root);
      recordProofRoot(root, PASSING);
      const output = sealLine(root, PASSING);
      edit(root);
      const g = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output });
      expect(g).toMatchObject({ satisfied: false, sealed: false });
      expect(g.reason).toMatch(/changed after it was sealed/);
    }
  });

  it('a sealed FAIL or INCONCLUSIVE denies, naming the chapters that did not pass', async () => {
    const failing: ChapterSpec[] = [{ key: '01-pay-once', verdict: 'FAIL' }, { key: '02-receipt', verdict: 'PASS' }];
    recordProofRoot(root, failing);
    const f = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: sealLine(root, failing) });
    expect(f).toMatchObject({ sealed: true, satisfied: false, overall: 'FAIL' });
    expect(f.reason).toMatch(/01-pay-once FAIL/);
    removeScratch(root);
    const inc: ChapterSpec[] = [{ key: '01-pay-once', verdict: 'INCONCLUSIVE' }];
    recordProofRoot(root, inc);
    const i = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: sealLine(root, inc) });
    expect(i).toMatchObject({ sealed: true, satisfied: false, overall: 'INCONCLUSIVE' });
  });

  it('a seal that says PASS over a chapter it lists as FAIL denies (the seal must agree with itself)', async () => {
    recordProofRoot(root, PASSING);
    const lying = sealLine(root, [{ key: '01-pay-once', verdict: 'FAIL' }, { key: '02-receipt', verdict: 'PASS' }], 'PASS');
    expect((await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: lying })).satisfied).toBe(false);
  });

  it('the proof root\'s ledger must hold a verdict stamped with this run and step', async () => {
    recordProofRoot(root, PASSING, { stamp: false });
    const g = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: sealLine(root, PASSING) });
    expect(g).toMatchObject({ satisfied: false });
    expect(g.reason).toMatch(/no verdict stamped/);
  });

  it('the newest stamped ledger verdict per chapter must equal the sealed chapter verdict', async () => {
    recordProofRoot(root, [{ key: '01-pay-once', verdict: 'FAIL' }, { key: '02-receipt', verdict: 'PASS' }]);
    // A seal computed over this very tree that claims chapter 01 passed: the bundle matches, the ledger disagrees.
    const g = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: sealLine(root, PASSING) });
    expect(g.satisfied).toBe(false);
    expect(g.reason).toMatch(/01-pay-once/);
    expect(g.reason).toMatch(/ledger/);
  });

  it('every sealed chapter needs its own stamped ledger verdict on the sealed tree, and the ledger may not hold a chapter the seal omits (codex)', async () => {
    // The ledger holds only chapter 01; the seal lists 01 and 02.
    recordProofRoot(root, [{ key: '01-pay-once', verdict: 'PASS' }], { overall: 'PASS' });
    const missing = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: sealLine(root, PASSING) });
    expect(missing.satisfied).toBe(false);
    expect(missing.reason).toMatch(/02-receipt has no stamped ledger verdict/);
    removeScratch(root);
    // Rows on another tree do not count for the sealed one.
    recordProofRoot(root, PASSING, { tree: 'tree-OTHER' });
    const otherTree = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: sealLine(root, PASSING) });
    expect(otherTree.satisfied).toBe(false);
    removeScratch(root);
    // The ledger holds a chapter the seal does not list.
    recordProofRoot(root, [...PASSING, { key: '03-extra', verdict: 'FAIL' }], { overall: 'PASS' });
    const extra = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: sealLine(root, PASSING) });
    expect(extra.satisfied).toBe(false);
    expect(extra.reason).toMatch(/03-extra/);
  });

  it('an earlier take\'s FAIL rows stay listed and do not deny the sealed later take', async () => {
    recordProofRoot(root, [{ key: '01-pay-once', verdict: 'FAIL', take: 1 }]);
    recordProofRoot(root, [{ key: '01-pay-once', verdict: 'PASS', take: 2 }]);
    const sealed: ChapterSpec[] = [{ key: '01-pay-once', verdict: 'PASS' }];
    const g = await resolveWalkthroughGate({ runId: RUN, stepId: STEP, proofRoot: root, output: sealLine(root, sealed) });
    expect(g).toMatchObject({ satisfied: true, sealed: true });
  });
});

describe('the requirement fails closed on a catalog id the engine does not define (WT-W2, S12)', () => {
  const VERIFIED = new Set(['test', 'walkthrough_review', 'domain_coverage']);
  const KNOWN = new Set(['build', 'test', 'walkthrough_plan', 'walkthrough_review', 'review', 'deliver', 'understand']);
  const plan = (catalogs: string[]): SessionView =>
    ({
      session: { id: 'r', status: 'running', team_plan: { rev: 1, accepted_rev: 1 }, run_identity: { kind: 'user_plan', name: null, user_plan: true, system: false } },
      units: catalogs.map((c, i) => ({ id: `r:s${i}`, session_id: 'r', ord: i + 1, catalog: c, status: 'pending' })),
    }) as unknown as SessionView;

  it('a known plan declares its verified steps', () => {
    expect(acceptanceRequirementOf(plan(['build', 'walkthrough_plan', 'walkthrough_review']), [], VERIFIED, KNOWN)).toEqual({ declared: true, phases: ['s2'] });
  });

  it('a step whose catalog the engine does not define is denied by name — a downgrade cannot shrink the requirement', () => {
    const req = acceptanceRequirementOf(plan(['build', 'walkthrough_v9']), [], VERIFIED, KNOWN);
    expect(req.declared).toBe(true);
    expect(req.failClosed).toMatch(/step `s1` names catalog `walkthrough_v9`, which this engine does not define/);
  });

  it('a step that raises verified_evidence in the accepted plan is a requirement (wicked-core M10: qe verify is a `run` step)', () => {
    const v = plan(['understand', 'build', 'run']);
    (v.session as unknown as { team_plan: Record<string, unknown> }).team_plan.accepted = {
      steps: { steps: [{ catalog: 'understand', id: 's0' }, { catalog: 'build', id: 's1' }, { catalog: 'run', id: 's2', verified_evidence: true }] },
    };
    expect(acceptanceRequirementOf(v, [], VERIFIED, new Set([...KNOWN, 'run']))).toEqual({ declared: true, phases: ['s2'] });
    // Without the raise, a `run` step declares nothing: the catalog entry is not verified.
    expect(acceptanceRequirementOf(plan(['understand', 'build', 'run']), [], VERIFIED, new Set([...KNOWN, 'run']))).toEqual({ declared: false, phases: [] });
  });

  it('with no full catalog to compare against, nothing changes (the verified-set rule still applies)', () => {
    expect(acceptanceRequirementOf(plan(['build', 'walkthrough_v9']), [], VERIFIED, null)).toEqual({ declared: false, phases: [] });
  });
});

describe('walkthroughCheckStates (WT-W2, §4.9)', () => {
  const view = (units: Array<{ step: string; catalog: string; status: string; role?: string }>, override?: string[]): SessionView =>
    ({
      session: {
        id: RUN,
        status: 'running',
        team_plan: { rev: 1, accepted_rev: 1, accepted: { floor_override: override === undefined ? null : { remove: override, reason: 'mine' } } },
      },
      units: units.map((u, i) => ({ id: `${RUN}:${u.step}`, session_id: RUN, ord: i + 1, catalog: u.catalog, status: u.status, role: u.role ?? (u.catalog === 'build' ? 'creator' : 'neutral') })),
    }) as unknown as SessionView;
  const units = [
    { step: 'build', catalog: 'build', status: 'done' },
    { step: 'build-2', catalog: 'build', status: 'done' },
    { step: 'build-3', catalog: 'build', status: 'done' },
    { step: 'build-4', catalog: 'build', status: 'pending' },
  ];
  const sealed = {
    stepId: STEP,
    sealed: true,
    satisfied: false,
    reason: '',
    overall: 'FAIL',
    tree: 'a1b2c3d4',
    chapters: [
      { key: '01-a', verdict: 'PASS', proves: ['build'] },
      { key: '02-b', verdict: 'FAIL', proves: ['build-2'] },
      { key: '03-c', verdict: 'PASS', proves: ['build-2'] },
    ],
  };

  it('checked / failed / claimed, one row per creator step that passed its gate or is proved', () => {
    expect(walkthroughCheckStates(view(units), sealed)).toEqual([
      { stepId: 'build', checkState: 'checked', provedBy: [{ chapter: '01-a', atSec: null }] },
      { stepId: 'build-2', checkState: 'failed', provedBy: [{ chapter: '02-b', atSec: null }, { chapter: '03-c', atSec: null }] },
      { stepId: 'build-3', checkState: 'claimed', provedBy: [] },
    ]);
  });

  it('nothing sealed: every finished creator step is claimed; the override that removed the pair makes it owned_by_you', () => {
    expect(walkthroughCheckStates(view(units), null).map((s) => s.checkState)).toEqual(['claimed', 'claimed', 'claimed']);
    expect(walkthroughCheckStates(view(units, ['walkthrough_plan', 'walkthrough_review']), null).map((s) => s.checkState)).toEqual([
      'owned_by_you',
      'owned_by_you',
      'owned_by_you',
    ]);
  });

  it('an unsealed walkthrough proves nothing, whatever its result says', () => {
    expect(walkthroughCheckStates(view(units), { ...sealed, sealed: false }).map((s) => s.checkState)).toEqual(['claimed', 'claimed', 'claimed']);
  });
});

describe('GET /runs/:id/acceptance and the walkthrough view read the proof roots (WT-W2)', () => {
  let dir: string;
  let ev: string;
  let app: FastifyInstance;
  let sessionsDetail: Mock;
  let workOutput: Mock;
  let catalogIds: Mock;
  let listRepos: Mock;

  const planRun = (withTest: boolean): SessionView => {
    const steps: Array<[string, string, string]> = [
      ['build', 'build', 'creator'],
      ...(withTest ? ([['test', 'test', 'evaluator']] as Array<[string, string, string]>) : []),
      ['walkthrough_plan', 'walkthrough_plan', 'evaluator'],
      [STEP, 'walkthrough_review', 'neutral'],
    ];
    return {
      session: {
        id: RUN,
        status: 'completed',
        repo_ref: null,
        unit_ix: steps.length,
        evidence_root: ev,
        team_plan: { rev: 1, accepted_rev: 1 },
        run_identity: { kind: 'user_plan', name: null, user_plan: true, system: false },
      },
      units: steps.map(([step, catalog, role], i) => ({
        id: `${RUN}:${step}`,
        session_id: RUN,
        ord: i + 1,
        catalog,
        role,
        status: 'done',
        assigned_cli: role === 'creator' ? 'claude' : 'codex',
        denial_reason: null,
      })),
    } as unknown as SessionView;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wt-w2-route-'));
    ev = join(dir, 'evidence');
    mkdirSync(ev, { recursive: true });
    sessionsDetail = vi.fn();
    workOutput = vi.fn().mockResolvedValue(null);
    catalogIds = vi.fn().mockResolvedValue(new Set(['build', 'test', 'walkthrough_plan', 'walkthrough_review']));
    listRepos = vi.fn().mockResolvedValue([]);
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      {
        sessionsDetail,
        workOutput,
        catalogIds,
        verifiedEvidenceCatalog: vi.fn().mockResolvedValue(new Set(['test', 'walkthrough_review'])),
        listWorkflows: () => [],
        listRepos,
        projectMembers: vi.fn().mockResolvedValue([]),
        listConformanceClaims: vi.fn().mockResolvedValue([]),
        runEvents: vi.fn().mockResolvedValue([]),
      } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      { callEstateTool: vi.fn() as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    removeScratch(dir);
  });

  const PASSING: ChapterSpec[] = [{ key: '01-pay-once', verdict: 'PASS', proves: ['build'] }];

  it('a sealed passing walkthrough satisfies a plan whose only verified step it is; the body lists it and the view is sealed', async () => {
    sessionsDetail.mockResolvedValue([planRun(false)]);
    const root = join(ev, STEP);
    recordProofRoot(root, PASSING);
    workOutput.mockImplementation(async (unitId: string) => (unitId.endsWith(':4') || unitId.includes(STEP) ? sealLine(root, PASSING) : null));
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/acceptance` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { gate: { satisfied: boolean; reason: string }; requirement: { declared: boolean; phases: string[] }; walkthrough: { sealed: boolean; roots: Array<{ stepId: string; sealed: boolean; satisfied: boolean }>; steps: Array<{ stepId: string; checkState: string }> } };
    expect(body.gate.satisfied).toBe(true);
    // The run's requirement stays declared on a walkthrough-only plan (Copilot on #759, r2).
    expect(body.requirement).toEqual({ declared: true, phases: [STEP] });
    expect(body.walkthrough.sealed).toBe(true);
    expect(body.walkthrough.roots).toEqual([expect.objectContaining({ stepId: STEP, sealed: true, satisfied: true })]);
    expect(body.walkthrough.steps).toEqual([{ stepId: 'build', checkState: 'checked', provedBy: [{ chapter: '01-pay-once', atSec: null }] }]);
    const v = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/walkthrough` })).json() as WalkthroughView;
    expect(v.sealed).toBe(true);
    expect(v.steps.map((s) => [s.stepId, s.checkState])).toEqual([['build', 'checked']]);
  });

  it('deny-dominates: an unsealed walkthrough denies the gate, and a missing repo ledger still denies a plan with a test step', async () => {
    sessionsDetail.mockResolvedValue([planRun(false)]);
    recordProofRoot(join(ev, STEP), PASSING);
    workOutput.mockResolvedValue('no seal');
    const unsealed = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/acceptance` })).json() as { gate: { satisfied: boolean; reason: string } };
    expect(unsealed.gate.satisfied).toBe(false);
    expect(unsealed.gate.reason).toMatch(/not sealed/);

    sessionsDetail.mockResolvedValue([planRun(true)]);
    workOutput.mockResolvedValue(sealLine(join(ev, STEP), PASSING));
    const both = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/acceptance` })).json() as { gate: { satisfied: boolean; reason: string } };
    expect(both.gate.satisfied).toBe(false);
    expect(both.gate.reason).toMatch(/no repo context/);
  });

  it('a walkthrough-only plan still denies when the repo ledger exists but cannot be read (Copilot)', async () => {
    const repoRoot = join(dir, 'repo');
    mkdirSync(join(repoRoot, '.wicked-qe', 'verdicts'), { recursive: true });
    writeFileSync(join(repoRoot, '.wicked-qe', 'verdicts', 'broken.json'), '{not json');
    const r = planRun(false);
    (r.session as unknown as { repo_ref: string }).repo_ref = 'shop';
    sessionsDetail.mockResolvedValue([r]);
    const root = join(ev, STEP);
    recordProofRoot(root, PASSING);
    workOutput.mockResolvedValue(sealLine(root, PASSING));
    listRepos.mockResolvedValue([{ id: 'shop', name: 'shop', root_path: repoRoot, default_branch: 'main', registered_at: 0 }]);
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/acceptance` })).json() as { gate: { satisfied: boolean; reason: string } };
    expect(body.gate.satisfied).toBe(false);
    expect(body.gate.reason).toMatch(/could not be read/);
  });

  it('the accepted plan\'s override removed the pair: the block is present with owned_by_you steps and the line counts them (#791, §4.9)', async () => {
    const r = planRun(false);
    // The override took the walkthrough pair out of the accepted plan: only the creator step ran.
    r.units.splice(1);
    (r.session as unknown as { unit_ix: number }).unit_ix = 1;
    (r.session as unknown as { team_plan: unknown }).team_plan = {
      rev: 1,
      accepted_rev: 1,
      accepted: { floor_override: { remove: ['walkthrough_plan', 'walkthrough_review'], reason: 'I will test it myself' } },
    };
    sessionsDetail.mockResolvedValue([r]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/acceptance` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      walkthrough?: { roots: unknown[]; sealed: boolean; steps: Array<{ stepId: string; checkState: string }> };
      summary: { line: string; walkthrough: { ownedByYou: number; steps: number; checked: number; tree: string | null } | null };
    };
    expect(body.walkthrough).toEqual({ roots: [], sealed: true, steps: [{ stepId: 'build', checkState: 'owned_by_you', provedBy: [] }] });
    expect(body.summary.walkthrough).toEqual({ checked: 0, failed: 0, ownedByYou: 1, steps: 1, sealed: true, tree: null });
    expect(body.summary.line).toBe('Nothing had to be proved before delivery; 1 left to your own testing.');
    expect(body.summary.line).not.toMatch(/Checked by a walkthrough/);
    const v = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/walkthrough` })).json() as WalkthroughView;
    expect(v.steps.map((s) => [s.stepId, s.checkState])).toEqual([['build', 'owned_by_you']]);
  });

  it('no walkthrough step and no override: the block stays absent and the summary has no walkthrough (unchanged)', async () => {
    const r = planRun(false);
    r.units.splice(1);
    (r.session as unknown as { unit_ix: number }).unit_ix = 1;
    sessionsDetail.mockResolvedValue([r]);
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/acceptance` })).json() as { walkthrough?: unknown; summary: { walkthrough: unknown; line: string } };
    expect(body.walkthrough).toBeUndefined();
    expect(body.summary.walkthrough).toBeNull();
    expect(body.summary.line).not.toMatch(/your own testing/);
  });

  it('a step naming a catalog the engine does not define denies the run by name', async () => {
    const r = planRun(false);
    (r.units[0] as { catalog: string }).catalog = 'build_v9';
    sessionsDetail.mockResolvedValue([r]);
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/acceptance` })).json() as { gate: { satisfied: boolean; reason: string } };
    expect(body.gate.satisfied).toBe(false);
    expect(body.gate.reason).toMatch(/names catalog `build_v9`, which this engine does not define/);
  });
});
