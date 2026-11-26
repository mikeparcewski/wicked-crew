// J6 K1: the 1.2.0 domain model over crew's API. Every fixture is a product route's own output
// (`tests/fixtures/domain-v3/README.md`): the model wicked-core's `domain-graph` built, the lines its `domain-ruling`
// answered, and garden's `scope.py` card. The tests read keys and hashes from those documents only.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DOMAIN_MODEL_V3, domainModelOf, domainScopeJsonOf, rulingAnswerOf, rulingRequestOf } from '../src/api/domain-model.js';
import { execScope, SCOPE_CONCURRENCY, scopeCardFor, scopeCardOf, type ScopeExec } from '../src/api/domain-scope.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { forgetRequirementsReads } from '../src/api/requirements.js';
import { registerRoutes } from '../src/api/routes.js';
import { launchPosture, type PostureFacts } from '../src/core/launch-posture.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput, RepoEntry } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

// The installed addon decides whether a scope can ride a launch; the route's own decision is what is tested here.
const scopeSupported = vi.hoisted(() => ({ value: true }));
vi.mock('../src/core/adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/adapter.js')>()),
  addonSupportsDomainScope: () => scopeSupported.value,
}));
vi.mock('../src/evals/routes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/evals/routes.js')>()),
  runAndRecord: vi.fn(async () => ({ id: 'e1', suites: [] })),
}));

const FIX = join(__dirname, 'fixtures', 'domain-v3');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), 'utf8'));
interface RulingLine { name: string; command: string; exit: number; stdout: string }
const rulings = fixture('rulings.json') as RulingLine[];
const line = (name: string): RulingLine => rulings.find((r) => r.name === name)!;
/** A `--flag 'value'` or `--flag value` of a recorded command. */
const flag = (command: string, name: string): string | undefined => {
  const m = new RegExp(`--${name} (?:'([^']*)'|(\\S+))`, 'u').exec(command);
  return m === null ? undefined : (m[1] ?? m[2]);
};

describe('domainModelOf: the model core built', () => {
  it('reads statements, claims, groups, follow-ups, targets and the counts of a 1.2.0 document', () => {
    const m = domainModelOf(fixture('model-built.json'))!;
    expect(m.schemaVersion).toBe(DOMAIN_MODEL_V3);
    expect(m.accounting).toEqual({ targets: 4, accounted: 2, open: 3, stale: 0 });
    expect(m.statements.map((s) => s.status)).toEqual(['Checked', 'open', 'open', 'open']);
    for (const s of m.statements) {
      expect(s.key).toMatch(/^v1:[0-9a-f]{64}$/u);
      expect(s.requirementKey).toBe('app/cbl/PAYCALC1.cbl::REQ-001');
      expect(s.ruling).toBeNull();
    }
    const checked = m.statements[0]!;
    expect(checked.checkedBy).toBe('codex');
    expect(checked.claims).toHaveLength(3);
    for (const c of checked.claims) expect(c.ranges.every((r) => r.file === 'app/cbl/PAYCALC1.cbl' && r.from <= r.to)).toBe(true);
    expect(m.ruleGroups).toHaveLength(1);
    expect(m.ruleGroups[0]!.rule).toEqual({ id: 'g1.r', text: 'Hours over forty are paid at the overtime rate.', cites: [checked.id] });
    expect(m.ruleGroups[0]!.withheld).toHaveLength(1);
    expect(m.followups.map((f) => f.kind)).toEqual(['flagged', 'open', 'open', 'refused']);
    expect(m.targets).toHaveLength(4);
    for (const t of m.targets) expect(t.targetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(m.targets.filter((t) => t.accounted)).toHaveLength(2);
    expect(m.builtAt).toEqual(expect.any(Number));
  });

  it('shows the rulings as the rebuilt document carries them', () => {
    const m = domainModelOf(fixture('model-after-rulings.json'))!;
    expect(m.accounting).toEqual({ targets: 4, accounted: 3, open: 2, stale: 0 });
    // The rejected statement leaves the requirement and stays on its target with its key and note.
    expect(m.statements.map((s) => s.status)).toEqual(['Checked', 'confirmed', 'open']);
    expect(m.statements[1]!.ruling).toMatchObject({ action: 'confirm', by: 'ana' });
    const read = m.targets.find((t) => t.id.endsWith('#READ-PARA().'))!;
    expect(read.accounted).toBe(false);
    expect(read.rejected).toHaveLength(1);
    expect(read.rejected[0]!.key).toBe(flag(line('reject-statement').command, 'expect'));
    expect(read.rejected[0]!.ruling).toMatchObject({ action: 'reject', note: 'Covers the end of file only; the FD is out of scope.' });
    const main = m.targets.find((t) => t.id.endsWith('#MAIN-PARA().'))!;
    expect(main).toMatchObject({ accounted: true, ruling: { action: 'confirm', by: 'ana' } });
  });

  it('keeps a statement with no target as null, never an invented id', () => {
    const doc = fixture('model-built.json') as { domains: Record<string, { requirements: Record<string, { business_rules: Array<Record<string, unknown>> }> }> };
    const r = Object.values(Object.values(doc.domains)[0]!.requirements)[0]!.business_rules[1]!;
    r['target'] = null;
    expect(domainModelOf(doc)!.statements[1]!.target).toBeNull();
  });

  it('is null for any other schema, and leaves out an item it cannot type', () => {
    expect(domainModelOf({ metadata: { schema_version: '1.1.0' }, domains: {} })).toBeNull();
    expect(domainModelOf(null)).toBeNull();
    const doc = fixture('model-built.json') as { metadata: { targets: unknown[] } };
    doc.metadata.targets.push({ id: 'x', file: 'f' });
    expect(domainModelOf(doc)!.targets).toHaveLength(4);
  });
});

describe('domainModelOf: the statements no requirement holds (garden#1545)', () => {
  // model-cert.json: core's own build of the train-16 cert's shape. MAIN-PARA's file open is cited only by a housekeeping
  // rule the prose check withheld, its file close only by a shown housekeeping rule, READ-PARA's open statement by
  // nothing; core keeps all three out of the requirements, in `metadata.statements`.
  const cert = (): Record<string, unknown> => fixture('model-cert.json') as Record<string, unknown>;
  const MAIN = 'ts-cobol . . . app/cbl/PAYCALC1/PAYCALC1#MAIN-PARA().';
  const READ = 'ts-cobol . . . app/cbl/PAYCALC1/PAYCALC1#READ-PARA().';

  it('reads them after the requirements\' statements, with no requirement', () => {
    const m = domainModelOf(cert())!;
    expect(m.statements.map((s) => [s.id, s.requirementKey, s.status])).toEqual([
      [`${READ}#0`, 'app/cbl/PAYCALC1.cbl::REQ-001', 'Checked'],
      [`${MAIN}#0`, null, 'Checked'],
      [`${MAIN}#1`, null, 'Checked'],
      [`${READ}#1`, null, 'open'],
    ]);
    for (const s of m.statements) expect(s.key).toMatch(/^v1:[0-9a-f]{64}$/u);
    expect(m.statements[1]!.claims.length).toBeGreaterThan(0);
  });

  it('resolves every cite of every group sentence, shown or withheld, and every follow-up (the Rules tab and Follow-ups read them by id)', () => {
    const m = domainModelOf(cert())!;
    const byId = new Map(m.statements.map((s) => [s.id, s]));
    expect(m.ruleGroups.map((g) => [g.kind, g.rule === null, g.withheld.length])).toEqual([
      ['business', false, 0], ['housekeeping', true, 1], ['housekeeping', false, 0],
    ]);
    const cites = m.ruleGroups.flatMap((g) => [...(g.rule ? [g.rule] : []), ...g.details, ...g.withheld]).flatMap((s) => s.cites);
    expect(cites).toEqual([`${READ}#0`, `${MAIN}#0`, `${MAIN}#1`]);
    for (const c of cites) expect(byId.has(c), c).toBe(true);
    const open = m.followups.filter((f) => f.statement !== null);
    expect(open.map((f) => f.statement)).toEqual([`${READ}#1`]);
    for (const f of open) expect(byId.get(f.statement!)?.key).toMatch(/^v1:/u);
  });

  it('a follow-up on one of them takes a ruling from the document alone: its key and its target\'s hash', () => {
    const m = domainModelOf(cert())!;
    const st = m.statements.find((s) => s.id === m.followups.find((f) => f.statement !== null)!.statement)!;
    const target = m.targets.find((t) => t.id === st.target)!;
    expect(JSON.parse(rulingRequestOf({ statement: st.id, expect: st.key, expectTarget: target.targetHash, action: 'confirm' }, 'ana'))).toEqual({
      statement: st.id, expect_key: st.key, expect_target_hash: target.targetHash, action: 'confirm', by: 'ana',
    });
  });

  it('a document built before the list reads exactly as it did: every statement has its requirement', () => {
    const doc = fixture('model-built.json') as { metadata: Record<string, unknown> };
    expect(doc.metadata['statements']).toBeUndefined();
    const m = domainModelOf(doc)!;
    expect(m.statements).toHaveLength(4);
    expect(m.statements.every((s) => s.requirementKey === 'app/cbl/PAYCALC1.cbl::REQ-001')).toBe(true);
    // a list that is not one is no statements, never an error
    expect(domainModelOf({ ...doc, metadata: { ...doc.metadata, statements: 'x' } })).toEqual(m);
  });
});

describe('rulings: the request core reads and the answer it gives', () => {
  it('the doc gives every value a ruling names: the recorded commands used the same key and hash', () => {
    const m = domainModelOf(fixture('model-built.json'))!;
    const cmd = line('confirm-statement').command;
    const st = m.statements.find((s) => s.id === flag(cmd, 'statement'))!;
    const target = m.targets.find((t) => t.id === st.target)!;
    expect(flag(cmd, 'expect')).toBe(st.key);
    expect(flag(cmd, 'expect-target')).toBe(target.targetHash);
    expect(JSON.parse(rulingRequestOf({ statement: st.id, expect: st.key, expectTarget: target.targetHash, action: 'confirm' }, 'ana'))).toEqual({
      statement: st.id, expect_key: st.key, expect_target_hash: target.targetHash, action: 'confirm', by: 'ana',
    });
    expect(JSON.parse(rulingRequestOf({ target: target.id, expectTarget: target.targetHash, action: 'confirm' }, 'ana'))).toEqual({
      target: target.id, expect_target_hash: target.targetHash, action: 'confirm', by: 'ana',
    });
  });

  it('maps each answer core printed to a status and body', () => {
    const ok = rulingAnswerOf(line('confirm-target').stdout);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      ruling: { subject: 'target', action: 'confirm', by: 'ana' },
      build: { rebuilt: true, accounting: { targets: 4, accounted: 3, open: 2, stale: 0 } },
    });
    const reject = rulingAnswerOf(line('reject-statement').stdout);
    expect(reject.body).toMatchObject({ ruling: { subject: 'statement', action: 'reject', note: 'Covers the end of file only; the FD is out of scope.' } });
    const refused = rulingAnswerOf(line('refused-note-required').stdout);
    expect(refused).toMatchObject({ status: 400, body: { code: 'note_required' } });
    expect(line('refused-note-required').exit).toBe(2);
    for (const [code, status] of [['not_found', 404], ['stale_code', 409], ['changed', 409], ['not_open', 409], ['bad_request', 400], ['store', 500]] as const) {
      expect(rulingAnswerOf(JSON.stringify({ ok: false, code, message: 'm' }))).toEqual({ status, body: { code, error: 'm' } });
    }
    expect(rulingAnswerOf('not json').status).toBe(500);
    // Saved, but the rebuild failed (core exit 3): the ruling stands and the answer says the model was not rebuilt.
    const saved = JSON.parse(line('confirm-target').stdout) as Record<string, unknown>;
    expect(rulingAnswerOf(JSON.stringify({ ...saved, build: { ok: false, error: 'busy' } })).body).toMatchObject({ build: { rebuilt: false, error: 'busy' } });
  });
});

describe('scope card: garden scope.py output', () => {
  it('maps the real card', () => {
    const card = scopeCardOf(fixture('scope-mini-cobol.json'))!;
    expect(card).toEqual({
      scopeHash: 'a4e596a6916041c94971c5b17f131c1a527b4453eb0e64c869943a97d6f22479',
      phrases: { PAYCALC1: ['app/cbl/PAYCALC1.cbl'] },
      unmatchedPhrases: [],
      files: ['app/cbl/PAYCALC1.cbl', 'app/jcl/PAYJOB.jcl'],
      targets: 4,
      reachedFrom: ['STEP1 -> PAYCALC1 (app/jcl/PAYJOB.jcl:2)'],
      reachedMore: 0,
      questions: [],
    });
  });

  it('a typed phrase shows the code names it matched (garden scope.py:136, the TS branch), and a card without its hash is none', () => {
    const raw = fixture('scope-mini-cobol.json') as Record<string, unknown>;
    const ts = { ...raw, phrases: { 'pay run': { words: ['pay', 'run'], used: 'name', n: 1, files: ['src/pay.ts'], defs: ['payRun'] }, nope: { words: ['nope'], used: 'none', n: 0, files: [], defs: [] } } };
    expect(scopeCardOf(ts)!.phrases).toEqual({ 'pay run': ['payRun'], nope: [] });
    expect(scopeCardOf({ ...raw, scope_hash: 'short' })).toBeNull();
  });

  it('runs garden through its launcher and removes its scratch directory; each failure is said, not thrown', async () => {
    const calls: string[][] = [];
    const good = await scopeCardFor({
      root: '/repo', db: '/repo.db', gardenRoot: '/garden', scope: { intent: 'pay', phrases: ['PAYCALC1'] },
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        const input = JSON.parse(readFileSync(args[args.indexOf('--scope') + 1]!, 'utf8'));
        expect(input).toEqual({ intent: 'pay', phrases: ['PAYCALC1'] });
        writeFileSync(args[args.indexOf('--out') + 1]!, readFileSync(join(FIX, 'scope-mini-cobol.json')));
        return { outcome: 'exit', code: 0, stderr: '' };
      },
    });
    expect('card' in good && good.card.targets).toBe(4);
    expect(calls[0]!.slice(0, 7)).toEqual(['/garden/scripts/wicked-garden', 'run', 'scripts/domain/scope.py', '--root', '/repo', '--db', '/repo.db']);
    const scratch = dirname(calls[0]![calls[0]!.indexOf('--out') + 1]!);
    expect(existsSync(scratch)).toBe(false);
    const said = async (exec: ScopeExec) => scopeCardFor({ root: '/r', db: '/d', gardenRoot: null, scope: { intent: 'x' }, timeoutMs: 1000, exec });
    expect(await said(async () => ({ outcome: 'exit', code: 1, stderr: 'Traceback\nKeyError: nodes\n' }))).toEqual({ error: 'the scope failed: KeyError: nodes' });
    expect(await said(async () => ({ outcome: 'timeout', stderr: '' }))).toEqual({ error: 'the scope did not finish in 1 s' });
    expect(await said(async () => ({ outcome: 'spawn', error: 'spawn wicked-garden ENOENT' }))).toEqual({ error: 'the scope could not start garden: spawn wicked-garden ENOENT' });
    expect(await said(async () => ({ outcome: 'exit', code: 0, stderr: '' }))).toEqual({ error: 'the scope wrote no card' });
    expect(await said(async (_c, args) => {
      writeFileSync(args[args.indexOf('--out') + 1]!, '{');
      return { outcome: 'exit', code: 0, stderr: '' };
    })).toEqual({ error: 'the scope wrote a card that is not JSON' });
    // A card over the size bound is refused by its size, before it is read.
    const big = await scopeCardFor({
      root: '/r', db: '/d', gardenRoot: null, scope: { intent: 'x' }, maxCardBytes: 100,
      exec: async (_c, args) => {
        writeFileSync(args[args.indexOf('--out') + 1]!, readFileSync(join(FIX, 'scope-mini-cobol.json')));
        return { outcome: 'exit', code: 0, stderr: '' };
      },
    });
    expect(big).toEqual({ error: 'the scope is too large to show (0 MB); narrow it to fewer files or phrases' });
    // A scratch directory that cannot be made is said too (the daemon's TMPDIR points nowhere).
    vi.stubEnv('TMPDIR', join(tmpdir(), 'k1-no-such-dir', 'x'));
    expect(await said(async () => ({ outcome: 'exit', code: 0, stderr: '' }))).toEqual({ error: expect.stringMatching(/^the scope could not start: /u) });
    vi.unstubAllEnvs();
  });

  it('reads at most two scope cards at once; a waiting ask whose request ended leaves the queue and never runs (J6 M1, F6)', async () => {
    expect(SCOPE_CONCURRENCY).toBe(2);
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    // Set by the cleanup: a read admitted after it (its turn freed by the cleanup itself) ends at once.
    let closing = false;
    const ask = (intent: string, signal?: AbortSignal) => scopeCardFor({
      root: '/r', db: '/d', gardenRoot: null, scope: { intent }, ...(signal !== undefined ? { signal } : {}),
      exec: (_c, args) => new Promise((resolve) => {
        started.push(intent);
        if (closing) {
          writeFileSync(args[args.indexOf('--out') + 1]!, readFileSync(join(FIX, 'scope-mini-cobol.json')));
          resolve({ outcome: 'exit', code: 0, stderr: '' });
          return;
        }
        let done = false;
        finish.set(intent, () => {
          if (done) return;
          done = true;
          writeFileSync(args[args.indexOf('--out') + 1]!, readFileSync(join(FIX, 'scope-mini-cobol.json')));
          resolve({ outcome: 'exit', code: 0, stderr: '' });
        });
      }),
    });
    const a = ask('a');
    const b = ask('b');
    const gone = new AbortController();
    const c = ask('c', gone.signal);
    const d = ask('d');
    try {
      await vi.waitFor(() => expect([...started].sort()).toEqual(['a', 'b']), { timeout: 20_000 });
      // The person typed on: the older ask's request closed while it waited.
      gone.abort();
      expect(await c).toEqual({ error: 'the scope was not read: the request ended first' });
      expect(started).toHaveLength(2);
      finish.get('a')!();
      expect('card' in (await a)).toBe(true);
      // Its turn went to the next one still waiting, never to the ask that left.
      await vi.waitFor(() => expect([...started].sort()).toEqual(['a', 'b', 'd']), { timeout: 20_000 });
      finish.get('b')!();
      finish.get('d')!();
      expect('card' in (await b) && 'card' in (await d)).toBe(true);
      // An ask whose request had already ended never starts.
      const ended = new AbortController();
      ended.abort();
      expect(await ask('e', ended.signal)).toEqual({ error: 'the scope was not read: the request ended first' });
      expect(started).toHaveLength(3);
    } finally {
      // Whatever failed above, no read is left holding a turn for the tests after this one.
      closing = true;
      gone.abort();
      for (const f of finish.values()) f();
      await Promise.allSettled([a, b, c, d]);
    }
  }, 60_000);

  it('the time limit ends the whole process tree, so nothing writes after the scratch directory is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k1-tree-'));
    dirs.push(dir);
    const late = join(dir, 'late.txt');
    const pidFile = join(dir, 'grandchild.pid');
    const launcher = join(dir, 'launcher.sh');
    // The launcher starts a grandchild (as garden's launcher starts python) that says its pid, then would write after
    // half a minute. (J6 M1, per coord's no-wall-clock ruling: nothing here asserts a speed. An execScope that waited
    // for the grandchild would outlive the test's own limit; one that left it running leaves its pid alive. The waits
    // below are generous upper bounds for a correct one on a loaded host.)
    // The launcher itself writes the grandchild's pid as it starts it, before anything else can run.
    writeFileSync(launcher, `#!/bin/sh\nsh -c 'sleep 30; echo late > "${late}"' &\necho $! > "${pidFile}"\nwait\n`);
    chmodSync(launcher, 0o755);
    // A limit long enough for the grandchild to have started on a loaded host, far short of its 30 s.
    const r = await execScope(launcher, [], { env: { ...process.env }, timeoutMs: 3000 });
    expect(r.outcome).toBe('timeout');
    expect(existsSync(pidFile), 'the grandchild never started inside the limit').toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    // Gone, or a zombie waiting to be reaped (it can never write again): both mean the kill reached it.
    const alive = (): boolean => {
      try { process.kill(pid, 0); } catch { return false; }
      const st = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
      return st !== '' && !st.startsWith('Z');
    };
    // The kill is sent before execScope answers; the OS reaps the grandchild a moment later.
    for (let i = 0; i < 100 && alive(); i += 1) await new Promise((res) => setTimeout(res, 20));
    expect(alive()).toBe(false);
    expect(existsSync(late)).toBe(false);
    expect(await execScope(join(dir, 'missing'), [], { env: { ...process.env }, timeoutMs: 1000 })).toMatchObject({ outcome: 'spawn' });
    // Past the stderr cap, the last line is the one kept.
    const noisy = join(dir, 'noisy.sh');
    writeFileSync(noisy, `#!/bin/sh\nhead -c 70000 /dev/zero | tr '\\0' x >&2\necho >&2\necho FINAL_REASON >&2\nexit 3\n`);
    chmodSync(noisy, 0o755);
    const r3 = await execScope(noisy, [], { env: { ...process.env }, timeoutMs: 5000 });
    expect(r3).toMatchObject({ outcome: 'exit', code: 3 });
    expect(r3.outcome === 'exit' && r3.stderr.trimEnd().endsWith('FINAL_REASON')).toBe(true);
  });

  it('a phrase is kept as its own key whatever it says (a phrase "__proto__" included)', () => {
    const raw = fixture('scope-mini-cobol.json') as Record<string, unknown>;
    const card = scopeCardOf({ ...raw, phrases: JSON.parse('{"__proto__": ["app/cbl/PAYCALC1.cbl"]}') })!;
    expect(Object.keys(card.phrases)).toEqual(['__proto__']);
    expect(JSON.parse(JSON.stringify(card)).phrases).toEqual(JSON.parse('{"__proto__": ["app/cbl/PAYCALC1.cbl"]}'));
  });
});

describe('launch posture: a preset of host tools runs phased', () => {
  const facts = (toolOnly: boolean): PostureFacts => ({
    powerModeDefault: async () => true,
    namesPreset: async () => true,
    powerSupported: () => true,
    deliverDefault: async () => 'none',
    preparationDropsDelivery: () => false,
    toolOnly: async () => toolOnly,
  });

  it('says why, and keeps power for any other preset', async () => {
    const phased = await launchPosture({ workflow: 'domain-extraction', repoRef: 'r' }, facts(true));
    expect(phased.power).toBe(false);
    expect(phased.powerNotice).toBe('its steps run as host tools, with no agent session to lead; the launch runs phased');
    expect((await launchPosture({ workflow: 'bug', repoRef: 'r' }, facts(false))).power).toBe(true);
  });
});

// ── Routes ───────────────────────────────────────────────────────────────────

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) removeScratch(d);
  forgetRequirementsReads();
  scopeSupported.value = true;
  vi.unstubAllEnvs();
});

const TOOL = (cmd: string): Record<string, unknown> => ({ executor: { type: 'tool', cmd: ['bash', '-c', cmd] } });

async function daemon(extra: Record<string, unknown> = {}, actor?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'k1-'));
  dirs.push(dir);
  const db = join(dir, 'estate.db');
  writeFileSync(db, '');
  mkdirSync(join(dir, 'repo'));
  const repo: RepoEntry = { id: 'repo-1', name: 'r', root_path: join(dir, 'repo'), default_branch: 'main', registered_at: 0, code_graph_db: db };
  const adapter: Record<string, Mock> = {
    launchRun: vi.fn().mockResolvedValue('run-1'),
    getSettings: vi.fn().mockResolvedValue({ graphNodeLimit: 150, deliverDefault: 'none' }),
    getWorkflow: vi.fn(() => ({ id: 'x', phases: [{ id: 'build', kind: 'build', role: 'creator', executes_code: true }] })),
    supportsPowerMode: vi.fn(() => true),
    listPresets: vi.fn().mockResolvedValue([
      { name: 'domain-extraction', scope: 'global', steps: [TOOL('domain-run'), TOOL('domain-graph')], created_by: 'builtin', updated_at: 0 },
      { name: 'bug', scope: 'global', steps: [{ executor: { type: 'agent' } }], created_by: 'builtin', updated_at: 0 },
    ]),
    listRepos: vi.fn().mockResolvedValue([repo]),
    getRequirementsGraphForRepo: vi.fn(),
    domainRuling: vi.fn(),
    ...extra,
  };
  const app = Fastify({ logger: false });
  if (actor !== undefined) app.addHook('onRequest', async (req) => { (req as unknown as { actor: unknown }).actor = actor; });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, {});
  await app.ready();
  apps.push(app);
  return { app, adapter, dir, repo };
}

const SCOPE = { intent: 'How PAYCALC1 computes pay from the payroll file', phrases: ['PAYCALC1'], scopeHash: 'a4e596a6916041c94971c5b17f131c1a527b4453eb0e64c869943a97d6f22479', description: 'payroll' };

describe('POST /runs: a domain model run carries its scope', () => {
  it('hands the scope to the engine in core\'s keys, and runs phased', async () => {
    const { app, adapter } = await daemon();
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'model the payroll rules', clisJson: '[]', workflow: 'domain-extraction', repoRef: 'repo-1', domainScope: SCOPE } });
    expect(res.statusCode).toBe(201);
    const input = adapter.launchRun!.mock.calls[0]![0] as LaunchRunInput;
    expect(JSON.parse(input.domainScopeJson!)).toEqual({ intent: SCOPE.intent, phrases: ['PAYCALC1'], scope_hash: SCOPE.scopeHash, description: 'payroll' });
    expect(input.domainScopeJson).toBe(domainScopeJsonOf(SCOPE));
    expect(input.power === true).toBe(false);
    expect(res.json().powerNotice).toMatch(/host tools/u);
  });

  it('refuses a domain model run with no scope, a scope on another workflow, a malformed scope, and an engine that would drop it', async () => {
    const { app, adapter } = await daemon();
    const post = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', clisJson: '[]', repoRef: 'repo-1', ...body } });
    const none = await post({ workflow: 'domain-extraction' });
    expect(none.statusCode).toBe(400);
    expect(JSON.stringify(none.json())).toMatch(/say what the model should cover/u);
    expect((await post({ workflow: 'bug', domainScope: SCOPE })).statusCode).toBe(400);
    expect((await post({ workflow: 'domain-extraction', domainScope: { ...SCOPE, scopeHash: 'abc' } })).statusCode).toBe(400);
    expect((await post({ workflow: 'domain-extraction', domainScope: { intent: '  ' } })).statusCode).toBe(400);
    expect((await post({ workflow: 'domain-extraction', domainScope: { ...SCOPE, extra: 1 } })).statusCode).toBe(400);
    scopeSupported.value = false;
    const old = await post({ workflow: 'domain-extraction', domainScope: SCOPE });
    expect(old.statusCode).toBe(409);
    expect(old.json().code).toBe('engine_too_old');
    expect(adapter.launchRun!).not.toHaveBeenCalled();
  });
});

describe('POST /runs/preview: the scope card', () => {
  /** A garden root whose launcher writes the real card (and records its arguments). */
  function fakeGarden(dir: string, body: string): string {
    const root = join(dir, 'garden');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    const launcher = join(root, 'scripts', 'wicked-garden');
    writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, 'args.txt')}"\n${body}\n`);
    chmodSync(launcher, 0o755);
    return root;
  }

  it('answers the posture and the card garden computed over the repository\'s checkout and store', async () => {
    const { app, dir, repo } = await daemon();
    const out = 'while [ $# -gt 0 ]; do if [ "$1" = --out ]; then cp "' + join(FIX, 'scope-mini-cobol.json') + '" "$2"; fi; shift; done';
    vi.stubEnv('WICKED_GARDEN_ROOT', fakeGarden(dir, out));
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'domain-extraction', repoRef: 'repo-1', domainScope: { intent: SCOPE.intent } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().posture.power).toBe(false);
    expect(res.json().scopeCard).toEqual(scopeCardOf(fixture('scope-mini-cobol.json')));
    const args = readFileSync(join(dir, 'args.txt'), 'utf8').split('\n');
    expect(args.slice(0, 6)).toEqual(['run', 'scripts/domain/scope.py', '--root', repo.root_path, '--db', repo.code_graph_db]);
  });

  it('says why there is no card, and asks for none without a scope', async () => {
    const { app, dir } = await daemon();
    vi.stubEnv('WICKED_GARDEN_ROOT', fakeGarden(dir, "echo 'scope: no index for this checkout' >&2; exit 2"));
    const failed = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'domain-extraction', repoRef: 'repo-1', domainScope: { intent: 'pay' } } });
    expect(failed.json().scopeError).toBe('the scope failed: scope: no index for this checkout');
    // A checkout that is gone is said by name: garden would read it as an empty tree and match nothing.
    rmSync(join(dir, 'repo'), { recursive: true });
    const gone = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'domain-extraction', repoRef: 'repo-1', domainScope: { intent: 'pay' } } });
    expect(gone.json().scopeError).toBe('repository repo-1 has no checkout on this machine (its registered folder is missing)');
    const noRepo = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'domain-extraction', domainScope: { intent: 'pay' } } });
    expect(noRepo.json().scopeError).toBe('name the repository the model covers to see its scope');
    const plain = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'domain-extraction', repoRef: 'repo-1' } });
    expect(Object.keys(plain.json())).toEqual(['posture']);
    expect((await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', domainScope: { intent: 'pay' } } })).statusCode).toBe(400);
  });
});

describe('POST /runs/preview: a scope ask whose request closed while it waited (J6 M1, F6, codex r1)', () => {
  it('never runs: the next ask in line takes its turn (over a real socket)', async () => {
    const { app, dir } = await daemon();
    const runs = join(dir, 'runs');
    mkdirSync(runs);
    const hold = join(dir, 'hold');
    writeFileSync(hold, '');
    // Each read says which words it read, waits while `hold` exists, then writes the real card.
    const launcher = [
      'while [ $# -gt 0 ]; do case "$1" in --scope) s="$2";; --out) o="$2";; esac; shift; done',
      // One file per read (two reads at once never share a write).
      `cp "$s" "${runs}/$$.json"`,
      `while [ -f "${hold}" ]; do sleep 0.05; done`,
      `cp "${join(FIX, 'scope-mini-cobol.json')}" "$o"`,
    ].join('\n');
    const root = join(dir, 'garden');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'wicked-garden'), `#!/bin/sh\n${launcher}\n`);
    chmodSync(join(root, 'scripts', 'wicked-garden'), 0o755);
    vi.stubEnv('WICKED_GARDEN_ROOT', root);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const lines = (): string[] => readdirSync(runs).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(runs, f), 'utf8'));
    const ask = (intent: string): { done: Promise<{ status: number; body: string }>; req: ClientRequest } => {
      const body = JSON.stringify({ workflow: 'domain-extraction', repoRef: 'repo-1', domainScope: { intent } });
      let req!: ClientRequest;
      const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
        req = request({ host: '127.0.0.1', port, path: '/api/v1/runs/preview', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
          let text = '';
          res.on('data', (c: Buffer) => { text += c.toString(); });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        });
        req.on('error', reject);
        req.end(body);
      });
      return { done, req };
    };
    const connections = (): Promise<number> => new Promise((r) => app.server.getConnections((_e, n) => r(n)));
    try {
      const a = ask('first');
      const b = ask('second');
      await vi.waitFor(() => expect(lines()).toHaveLength(2), { timeout: 20_000 });
      const c = ask('typed on');
      c.done.catch(() => undefined);
      await vi.waitFor(async () => expect(await connections()).toBe(3), { timeout: 20_000 });
      // The person typed on: studio aborts the older ask, which closes its request while it waits for a turn.
      c.req.destroy();
      await vi.waitFor(async () => expect(await connections()).toBe(2), { timeout: 20_000 });
      const d = ask('latest');
      rmSync(hold);
      const answers = await Promise.all([a.done, b.done, d.done]);
      expect(answers.map((x) => x.status)).toEqual([200, 200, 200]);
      expect(answers.every((x) => (JSON.parse(x.body) as { scopeCard?: unknown }).scopeCard !== undefined)).toBe(true);
      // First in, first served: had the closed ask stayed in line, it would have run before "latest".
      expect(lines().map((l) => (JSON.parse(l) as { intent: string }).intent).sort()).toEqual(['first', 'latest', 'second']);
    } finally {
      rmSync(hold, { force: true });
      await app.close();
    }
  }, 90_000);
});

describe('GET /repos/:id/requirements and POST …/rulings', () => {
  it('carries the 1.2.0 model on the page', async () => {
    const graph = fixture('model-built.json');
    const { app } = await daemon({ getRequirementsGraphForRepo: vi.fn().mockResolvedValue({ graph, coverage: { targets: 4, accounted: 2, open: 3, stale: 0 } }) });
    const res = await app.inject({ method: 'GET', url: '/api/v1/repos/repo-1/requirements' });
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toEqual(domainModelOf(graph));
  });

  it('lists only the requirements, and carries every statement on the page (garden#1545)', async () => {
    const graph = fixture('model-cert.json');
    const { app } = await daemon({ getRequirementsGraphForRepo: vi.fn().mockResolvedValue({ graph, coverage: null }) });
    const page = (await app.inject({ method: 'GET', url: '/api/v1/repos/repo-1/requirements' })).json();
    expect(page.items.map((i: { key: string; title: string }) => [i.key, i.title])).toEqual([['app/cbl/PAYCALC1.cbl::REQ-001', 'Overtime pay']]);
    expect(page.model.statements).toHaveLength(4);
    expect(page.model).toEqual(domainModelOf(graph));
  });

  it('records a ruling through the engine, and the next read rebuilds from the new document', async () => {
    const read = vi.fn().mockResolvedValue({ graph: fixture('model-built.json'), coverage: null });
    const ruling = vi.fn().mockResolvedValue(line('reject-statement').stdout);
    const { app } = await daemon({ getRequirementsGraphForRepo: read, domainRuling: ruling });
    const before = (await app.inject({ method: 'GET', url: '/api/v1/repos/repo-1/requirements' })).json().model;
    const st = before.statements[2];
    const target = before.targets.find((t: { id: string }) => t.id === st.target);
    read.mockResolvedValue({ graph: fixture('model-after-rulings.json'), coverage: null });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/repos/repo-1/requirements/rulings',
      payload: { statement: st.id, expect: st.key, expectTarget: target.targetHash, action: 'reject', note: 'Covers the end of file only; the FD is out of scope.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ruling).toMatchObject({ subject: 'statement', action: 'reject' });
    expect(ruling).toHaveBeenCalledWith('repo-1', JSON.stringify({ statement: st.id, expect_key: st.key, expect_target_hash: target.targetHash, action: 'reject', note: 'Covers the end of file only; the FD is out of scope.', by: 'local' }));
    const after = (await app.inject({ method: 'GET', url: '/api/v1/repos/repo-1/requirements' })).json().model;
    expect(after.accounting).toEqual({ targets: 4, accounted: 3, open: 2, stale: 0 });
  });

  it('refuses a malformed ruling before the engine, says the engine\'s refusal by name, and takes rulings from a person only', async () => {
    const ruling = vi.fn().mockResolvedValue(line('refused-note-required').stdout);
    const { app } = await daemon({ domainRuling: ruling });
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/repos/repo-1/requirements/rulings', payload });
    const T = 'a'.repeat(64);
    for (const bad of [
      { expectTarget: T, action: 'confirm' },
      { statement: 's', target: 't', expect: 'k', expectTarget: T, action: 'confirm' },
      { statement: 's', expectTarget: T, action: 'confirm' },
      { target: 't', expectTarget: T, action: 'reject', note: 'n' },
      { statement: 's', expect: 'k', expectTarget: T, action: 'reject' },
      { statement: 's', expect: 'k', expectTarget: T, action: 'edit' },
    ]) expect((await post(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect(ruling).not.toHaveBeenCalled();
    const refused = await post({ statement: 's', expect: 'k', expectTarget: T, action: 'reject', note: 'n' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('note_required');
    expect((await app.inject({ method: 'POST', url: '/api/v1/repos/nope/requirements/rulings', payload: { target: 't', expectTarget: T, action: 'confirm' } })).statusCode).toBe(404);

    const agent = await daemon({ domainRuling: ruling }, { id: 'bot', kind: 'agent', trust: 'operator' });
    const res = await agent.app.inject({ method: 'POST', url: '/api/v1/repos/repo-1/requirements/rulings', payload: { target: 't', expectTarget: T, action: 'confirm' } });
    expect(res.statusCode).toBe(403);
    expect(ruling).toHaveBeenCalledTimes(1);
  });
});
