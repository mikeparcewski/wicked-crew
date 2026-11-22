// studio#1150: a launch's human gates are ONE decision (`core/launch-posture.ts`). `POST /runs/preview` answers it for a
// body, `POST /runs` hands it to the engine. SAYS == DOES: for every body x daemon combination, what the preview says
// is what the launch does — and both are what the launch route did before the decision was lifted out of it
// (`mainSays`, the rules restated here independently of the code under test).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it, vi, type Mock } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { readNewWorkSeats, type CoreAdapter } from '../src/core/adapter.js';
import { ReviewService } from '../src/insights/review-service.js';
import { InsightsStore } from '../src/insights/store.js';
import type { LaunchRunInput } from '../src/core/types.js';

// The default evals run in-process at launch; here they answer at once (the preparation itself is the real one).
vi.mock('../src/evals/routes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/evals/routes.js')>()),
  runAndRecord: vi.fn(async () => ({ id: 'e1', suites: [] })),
}));

const CODE_DEF = { id: 'bug', phases: [{ id: 'build', kind: 'build', role: 'creator', executes_code: true }] };
const READ_ONLY_DEF = { id: 'notes', phases: [{ id: 'understand', kind: 'recon', role: 'creator', executes_code: false }] };

const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const a of apps.splice(0)) await a.close();
});

interface Daemon {
  supports: boolean;
  setting: boolean | undefined;
  deliverDefault: 'pr' | 'none';
}

async function daemon(d: Daemon, runtime: Parameters<typeof registerRoutes>[6] = {}) {
  const adapter: Record<string, Mock> = {
    launchRun: vi.fn().mockResolvedValue('run-1'),
    getSettings: vi.fn().mockResolvedValue({
      graphNodeLimit: 150,
      deliverDefault: d.deliverDefault,
      ...(d.setting !== undefined ? { powerModeDefault: d.setting } : {}),
    }),
    getWorkflow: vi.fn((name: string) => (name === 'notes' ? READ_ONLY_DEF : name === 'gone' ? null : CODE_DEF)),
    supportsPowerMode: vi.fn(() => d.supports),
    // `bug` and `notes` are presets; `my-def` is a registered def the engine plans the legacy way.
    listPresets: vi.fn().mockResolvedValue([
      { name: 'bug', scope: 'global', steps: [], created_by: 'builtin', updated_at: 0 },
      { name: 'notes', scope: 'global', steps: [], created_by: 'builtin', updated_at: 0 },
    ]),
    listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'r', root_path: '/nowhere', default_branch: 'main', registered_at: 0 }]),
  };
  const app = Fastify({ logger: false });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, runtime);
  await app.ready();
  apps.push(app);
  return { app, adapter };
}

const PLAN = { steps: [{ catalog: 'build' }] };
const shapes: Array<Record<string, unknown>> = [
  { workflow: 'bug' },
  { workflow: 'notes' },
  { workflow: 'my-def' },
  { plan: PLAN },
  {},
];

function* bodies(): Generator<Record<string, unknown>> {
  for (const shape of shapes)
    for (const repoRef of [undefined, 'repo-1'])
      for (const power of [undefined, true, false])
        for (const humanConfirm of [undefined, 'none', 'before:2', 'all'])
          for (const deliver of [undefined, 'pr', 'none'])
            for (const deliverGate of [undefined, 'human', 'auto']) {
              yield {
                ...shape,
                ...(repoRef !== undefined ? { repoRef } : {}),
                ...(power !== undefined ? { power } : {}),
                ...(humanConfirm !== undefined ? { humanConfirm } : {}),
                ...(deliver !== undefined ? { deliver } : {}),
                ...(deliverGate !== undefined ? { deliverGate } : {}),
              };
            }
}

type Body = Record<string, unknown>;
interface Said {
  status: number;
  posture?: { power: boolean; humanConfirm?: string; deliver: 'pr' | 'none'; autoDeliver: boolean; powerNotice?: string; humanConfirmNotice?: string };
}

/** What the launch route on main did with a body (crew#393 delivery, DES-POWER-MODE, F-E2E-030, the launch schema). */
function mainSays(b: Body, d: Daemon): Said {
  const workflow = b['workflow'] as string | undefined;
  const repo = b['repoRef'] !== undefined;
  const hc = b['humanConfirm'] as string | undefined;
  // The launch schema: a deliver gate on no delivery, and a free-text delivery, are refused…
  if (b['deliver'] === 'none' && b['deliverGate'] !== undefined) return { status: 400 };
  if (b['deliver'] === 'pr' && workflow === undefined && b['plan'] === undefined) return { status: 400 };
  // …and `bug` requires QE acceptance, which an unattended delivery cannot carry.
  if (workflow === 'bug' && b['deliverGate'] === 'auto') return { status: 400 };
  const deliver = (b['deliver'] as 'pr' | 'none' | undefined)
    ?? (repo && workflow !== undefined && workflow !== 'notes' && d.deliverDefault !== 'none' ? 'pr' : 'none');
  const wanted = (b['power'] as boolean | undefined) ?? (repo && (workflow !== undefined || b['plan'] !== undefined) ? d.setting ?? true : false);
  const preset = b['plan'] !== undefined || workflow === 'bug' || workflow === 'notes';
  const posture: NonNullable<Said['posture']> = { power: false, deliver, autoDeliver: b['deliverGate'] === 'auto', ...(hc !== undefined ? { humanConfirm: hc } : {}) };
  if (wanted) {
    if (!repo || !preset) posture.powerNotice = 'power mode runs a repo-scoped plan or preset launch; this launch runs phased';
    else if (!d.supports) posture.powerNotice = 'this engine has no power mode; the launch runs phased';
    else {
      posture.power = true;
      posture.humanConfirm = 'none';
      if (hc !== undefined && hc !== 'none') posture.humanConfirmNotice = `power mode asks once, at hand-off: humanConfirm ${hc} is not kept (launch with power: false to keep it)`;
    }
  }
  return { status: 201, posture };
}

describe('POST /runs/preview == POST /runs (studio#1150)', () => {
  const daemons: Daemon[] = [];
  for (const supports of [true, false])
    for (const setting of [undefined, true, false])
      for (const deliverDefault of ['pr', 'none'] as const) daemons.push({ supports, setting, deliverDefault });

  it.each(daemons)('every body agrees on %o', async (d) => {
    const { app, adapter } = await daemon(d);
    let compared = 0;
    for (const body of bodies()) {
      const said = mainSays(body, d);
      const what = JSON.stringify(body);
      const preview = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: body });
      adapter.launchRun!.mockClear();
      const launched = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', clisJson: '[]', ...body } });
      expect(launched.statusCode, `${what} launch status`).toBe(said.status);
      if (said.status !== 201) {
        expect(adapter.launchRun!, what).not.toHaveBeenCalled();
        continue;
      }
      expect(preview.statusCode, what).toBe(200);
      const p = preview.json().posture as Record<string, unknown>;
      // The preview says what main did…
      expect(p, `${what} preview`).toEqual(said.posture);
      // …and the launch does what the preview says.
      const input = adapter.launchRun!.mock.calls[0]![0] as LaunchRunInput;
      expect(input.power === true, `${what} power`).toBe(p['power']);
      expect(input.humanConfirm, `${what} humanConfirm`).toBe(p['humanConfirm']);
      expect(input.deliver ?? 'none', `${what} deliver`).toBe(p['deliver']);
      expect(input.autoDeliver === true, `${what} autoDeliver`).toBe(p['autoDeliver']);
      const answer = launched.json() as Record<string, unknown>;
      expect(answer['powerNotice'], `${what} powerNotice`).toBe(p['powerNotice']);
      expect(answer['humanConfirmNotice'], `${what} humanConfirmNotice`).toBe(p['humanConfirmNotice']);
      compared += 1;
    }
    // 1080 bodies: 240 put a deliver gate on no delivery, 72 deliver free text, 48 deliver `bug` unattended.
    expect(compared).toBe(720);
  }, 120_000);

  it('a power preset launch: the preview says power, hand-off only, and the posture it drops', async () => {
    const { app } = await daemon({ supports: true, setting: undefined, deliverDefault: 'pr' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', repoRef: 'repo-1', humanConfirm: 'before:2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      posture: {
        power: true,
        humanConfirm: 'none',
        deliver: 'pr',
        autoDeliver: false,
        humanConfirmNotice: 'power mode asks once, at hand-off: humanConfirm before:2 is not kept (launch with power: false to keep it)',
      },
    });
    // power: false keeps the step gate.
    const phased = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', repoRef: 'repo-1', humanConfirm: 'before:2', power: false } });
    expect(phased.json().posture).toMatchObject({ power: false, humanConfirm: 'before:2' });
  });

  it('the setting cannot change a launch that said power explicitly (the form sends what it showed)', async () => {
    const { app, adapter } = await daemon({ supports: true, setting: true, deliverDefault: 'pr' });
    const shown = (await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', repoRef: 'repo-1', power: false, humanConfirm: 'before:2' } })).json().posture;
    adapter.getSettings!.mockResolvedValue({ graphNodeLimit: 150, deliverDefault: 'pr', powerModeDefault: false });
    await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', clisJson: '[]', workflow: 'bug', repoRef: 'repo-1', power: false, humanConfirm: 'before:2' } });
    const input = adapter.launchRun!.mock.calls.at(-1)![0] as LaunchRunInput;
    expect(input.power === true).toBe(shown.power);
    expect(input.humanConfirm).toBe(shown.humanConfirm);
  });

  it('launches nothing and refuses an unknown field', async () => {
    const { app, adapter } = await daemon({ supports: true, setting: undefined, deliverDefault: 'pr' });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', problem: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/problem/);
    await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(adapter.launchRun!).not.toHaveBeenCalled();
  });

  // The daemon's own prepared workflows: delivery as main handed it to the engine, after the daemon's preparation.
  const d: Daemon = { supports: false, setting: undefined, deliverDefault: 'pr' };
  async function both(body: Body, runtime: Parameters<typeof registerRoutes>[6]) {
    const { app, adapter } = await daemon(d, runtime);
    // The preview reads the gate-deciding fields only (a revision is the launch's own preflight).
    const gateFields = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'revisesPr'));
    const preview = await app.inject({ method: 'POST', url: '/api/v1/runs/preview', payload: gateFields });
    expect(preview.statusCode, JSON.stringify(body)).toBe(200);
    const launched = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'x', clisJson: '[]', ...body } });
    const input = adapter.launchRun!.mock.calls[0]?.[0] as LaunchRunInput | undefined;
    if (launched.statusCode === 201) expect(input).toBeDefined();
    return { preview, launched, input };
  }
  // As `ReviewService.prepareLaunch` makes a run review: repo-less, no delivery.
  const reviewLaunch = async (input: LaunchRunInput) => {
    delete input.repoRef;
    delete input.deliver;
  };
  const resolvePullRequest = async () => ({ ok: true as const, pr: { headRef: 'feat', url: 'https://example.invalid/pr/1' } as never });

  it('a prepared run review delivers nothing, and the preview says so — a revision request still launches (main)', async () => {
    for (const body of [
      { workflow: 'review-recent-work', repoRef: 'repo-1' },
      { workflow: 'review-recent-work', repoRef: 'repo-1', deliver: 'pr' },
      { workflow: 'review-recent-work', repoRef: 'repo-1', deliver: 'pr', revisesPr: 1, power: false },
    ]) {
      const { preview, launched, input } = await both(body, { reviewLaunch, resolvePullRequest });
      expect(launched.statusCode, JSON.stringify(body)).toBe(201);
      expect(input?.deliver).toBeUndefined();
      expect(preview.json().posture.deliver).toBe('none');
    }
  });

  it('(crew#1592) a hand launch of the run review takes its seat from newWorkSeats through the real preparer and reader; a bad setting is a 409 that launches nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'posture-review-seat-'));
    const file = join(root, 'settings.json');
    const armed = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    process.env['WICKED_CREW_SYSTEM_SETTINGS'] = file;
    try {
      const prepared = (runId: string) => {
        const service = new ReviewService({
          store: new InsightsStore(join(root, `insights-${runId}.json`)),
          adapter: { sessionsDetail: async () => [], runEvents: async () => [], seatsForWorkflow: async () => [{ key: 'claude' }, { key: 'codex' }] },
          reviewsDir: join(root, `reviews-${runId}`),
          newWorkSeats: readNewWorkSeats,
          estateTool: async () => ({}),
          log: () => undefined,
        });
        return async (input: LaunchRunInput) => { await service.prepareLaunch(input, { trigger: 'manual' }); };
      };
      writeFileSync(file, JSON.stringify({ newWorkSeats: ['codex'] }));
      const ok = await both({ workflow: 'review-recent-work' }, { reviewLaunch: prepared('a') });
      expect(ok.launched.statusCode).toBe(201);
      expect((JSON.parse(ok.input!.clisJson) as Array<{ key: string }>).map((x) => x.key)).toEqual(['codex']);
      expect(ok.input!.primary).toBe('codex');
      writeFileSync(file, JSON.stringify({ newWorkSeats: 'codex' }));
      const { app, adapter } = await daemon(d, { reviewLaunch: prepared('b') });
      const refused = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'x', clisJson: '[]', workflow: 'review-recent-work' } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^the review could not be prepared: .*newWorkSeats/);
      expect(adapter.launchRun!).not.toHaveBeenCalled();
    } finally {
      if (armed === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
      else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = armed;
    }
  });

  it('(crew#1375) a refusal after the review was prepared records it as refused, so a retry under the same run id prepares again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'posture-review-retry-'));
    const store = new InsightsStore(join(root, 'insights.json'));
    const service = new ReviewService({
      store,
      adapter: { sessionsDetail: async () => [], runEvents: async () => [], seatsForWorkflow: async () => [{ key: 'claude' }] },
      reviewsDir: join(root, 'reviews'),
      estateTool: async () => ({}),
      log: () => undefined,
    });
    const docs = join(root, 'run-documents');
    const { app, adapter } = await daemon({ supports: false, setting: undefined, deliverDefault: 'none' }, {
      reviewLaunch: async (input: LaunchRunInput) => { await service.prepareLaunch(input, { trigger: 'manual' }); },
      reviewLaunchRefused: (runId: string, reason: string) => service.launchRefused(runId, reason),
      runDocumentsRoot: docs,
    });
    adapter['sessions'] = vi.fn().mockResolvedValue(['run-0']);
    // The earlier run's staged documents can't be read again: the launch is refused after the review was prepared.
    mkdirSync(join(docs, 'run-0', 'records'), { recursive: true });
    writeFileSync(join(docs, 'run-0', 'records', 'MANIFEST.json'), '{}');
    const body = { problem: 'x', clisJson: '[]', workflow: 'review-recent-work', sessionId: 'rev-retry', retryOf: 'run-0' };
    const refused = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: body });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe('documents_unavailable');
    expect(adapter.launchRun!).not.toHaveBeenCalled();
    expect(store.get('rev-retry')).toMatchObject({ status: 'failed', error: expect.stringMatching(/^the launch was refused: the documents of run run-0/u) });
    // The cause is gone; the same run id is prepared again and launches.
    rmSync(join(docs, 'run-0'), { recursive: true, force: true });
    const retried = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: body });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(adapter.launchRun!).toHaveBeenCalledTimes(1);
    expect(store.get('rev-retry')).toMatchObject({ status: 'running', error: null });
  });

  it('(crew#1375) a failure after the engine took the review leaves it running: a retry under its id is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'posture-review-taken-'));
    const store = new InsightsStore(join(root, 'insights.json'));
    const service = new ReviewService({
      store,
      adapter: { sessionsDetail: async () => [], runEvents: async () => [], seatsForWorkflow: async () => [{ key: 'claude' }] },
      reviewsDir: join(root, 'reviews'),
      estateTool: async () => ({}),
      log: () => undefined,
    });
    const { app, adapter } = await daemon({ supports: false, setting: undefined, deliverDefault: 'none' }, {
      reviewLaunch: async (input: LaunchRunInput) => { await service.prepareLaunch(input, { trigger: 'manual' }); },
      reviewLaunchRefused: (runId: string, reason: string) => service.launchRefused(runId, reason),
      // A skills seam that admits the launch and then fails the answer's garden read (after the engine took the run).
      skills: { health: () => ({ findings: [] }), baseSkill: () => null, installedAheadFinding: async () => { throw new Error('the garden could not be read'); } } as never,
    });
    const body = { problem: 'x', clisJson: '[]', workflow: 'review-recent-work', sessionId: 'rev-taken' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: body });
    expect(first.statusCode).not.toBe(201);
    expect(adapter.launchRun!).toHaveBeenCalledTimes(1);
    expect(store.get('rev-taken')).toMatchObject({ status: 'running', error: null });
    expect(existsSync(join(root, 'reviews', 'rev-taken'))).toBe(true);
    const retried = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: body });
    expect(retried.statusCode).toBe(409);
    expect(retried.json().error).toMatch(/already recorded/u);
    expect(adapter.launchRun!).toHaveBeenCalledTimes(1);
  });

  it('a run review on a daemon that does not prepare it is an ordinary launch: delivery as resolved', async () => {
    const { preview, input } = await both({ workflow: 'review-recent-work', repoRef: 'repo-1', deliver: 'pr' }, {});
    expect(input?.deliver).toBe('pr');
    expect(preview.json().posture.deliver).toBe('pr');
  });

  it('crew#1585: the default evals drop delivery, and the preview says none', async () => {
    const evalRunsDir = mkdtempSync(join(tmpdir(), 'posture-evals-'));
    for (const [body, engine] of [
      [{ workflow: 'run-evals' }, 'none'],
      [{ workflow: 'run-evals', repoRef: 'repo-1', deliver: 'pr', power: false }, 'none'],
    ] as const) {
      const { preview, launched, input } = await both(body, { evalRunsDir });
      expect(launched.statusCode, JSON.stringify(body)).toBe(201);
      expect(input?.repoRef).toBeUndefined();
      expect(input?.deliver ?? 'none').toBe(engine);
      expect(preview.json().posture.deliver).toBe(engine);
    }
  });

  it.each([undefined, 'pr'] as const)('crew#1418: mapping drops delivery (%s) in preview and launch', async (deliver) => {
    const { preview, launched, input } = await both({ workflow: 'domain-extraction', repoRef: 'repo-1', ...(deliver !== undefined ? { deliver } : {}) }, {});
    expect(launched.statusCode).toBe(201);
    expect(input).not.toHaveProperty('deliver');
    expect(preview.json().posture.deliver).toBe('none');
  });

  it('a change review never delivers: an explicit pr is refused, and the preview answers none', async () => {
    const refused = await both({ workflow: 'review-change', repoRef: 'repo-1', deliver: 'pr' }, {});
    expect(refused.launched.statusCode).toBe(400);
    expect(refused.launched.json().error).toBe('a review posts nothing and never delivers');
    const { preview } = await both({ workflow: 'review-change', repoRef: 'repo-1' }, {});
    expect(preview.json().posture.deliver).toBe('none');
  });
});
