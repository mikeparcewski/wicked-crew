// crew#293 — POST /runs accepts deliver:"pr" and threads it to the adapter.
// crew#393 — the deliver DEFAULT: a repo-scoped launch that names a CODE-WORK workflow (a def
// with at least one `executes_code` phase) delivers unless somebody said otherwise (per-launch
// `deliver: 'none'`, or the daemon's `deliverDefault` setting); repo-less, free-text, and
// read-only-workflow launches (chat and its kin — the deliver script fails a clean worktree
// loudly, so defaulting it on would fail every repo-scoped chat) default to no deliver phase.
//
// Fastify inject() with a stub adapter (no NAPI): the route's job is to parse, validate,
// RESOLVE the default, and hand the option to CoreAdapter.launchRun — composition itself is
// covered by deliver-launch.test.ts. `clisJson` is always supplied so the route never consults
// the real council roster.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput, WorkflowDef } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

/** A minimal code-work def: one `executes_code` build phase — what makes the default engage. */
const CODE_WORK_DEF = {
  id: 'feature',
  phases: [
    { id: 'build', kind: 'build', gate_type: null, gate: 'auto', executes_code: true, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'creator', skill_ref: null, allowed_skills: [], validator_pin: null },
  ],
} as unknown as WorkflowDef;

/** A read-only def (chat-shaped): no `executes_code` phase anywhere — the default stays off. */
const READ_ONLY_DEF = {
  id: 'chat',
  phases: [
    { id: 'explore', kind: 'recon', gate_type: 'value', gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [], depends_on: [], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
  ],
} as unknown as WorkflowDef;

type MockAdapter = {
  launchRun: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
  getWorkflow: ReturnType<typeof vi.fn>;
};

function buildApp(mockAdapter: MockAdapter): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  registerRoutes(
    app,
    mockAdapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
  );
  return app;
}

describe('POST /runs deliver option (crew#293)', () => {
  let mockAdapter: MockAdapter;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = {
      launchRun: vi.fn().mockResolvedValue('run-1'),
      // The shipped default settings shape — individual tests override the resolved value.
      getSettings: vi.fn().mockResolvedValue({ graphNodeLimit: 150, deliverDefault: 'pr' }),
      getWorkflow: vi.fn().mockReturnValue(CODE_WORK_DEF),
    };
    app = buildApp(mockAdapter);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts deliver:"pr" with a workflow and threads it to launchRun', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'ship it', clisJson: '[]', workflow: 'feature', deliver: 'pr' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ runId: 'run-1' });

    expect(mockAdapter.launchRun).toHaveBeenCalledTimes(1);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(input.workflow).toBe('feature');
    expect(input.deliver).toBe('pr');
  });

  it('omitting deliver on a REPO-LESS workflow launch leaves the field off entirely (crew#393)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'ship it', clisJson: '[]', workflow: 'feature' },
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('deliver' in input).toBe(false);
    // The repo-less default never consults the setting — it is 'none' by construction.
    expect(mockAdapter.getSettings).not.toHaveBeenCalled();
  });

  it('400 on deliver without a workflow — nothing launches', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'ship it', clisJson: '[]', deliver: 'pr' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; details?: { message?: string }[] };
    // The refine's message names the requirement so the caller can fix the request.
    expect(JSON.stringify(body)).toContain('requires a workflow');
    expect(mockAdapter.launchRun).not.toHaveBeenCalled();
  });

  it('400 on an unknown deliver mode — "pr" and "none" are the only two', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'ship it', clisJson: '[]', workflow: 'feature', deliver: 'branch' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockAdapter.launchRun).not.toHaveBeenCalled();
  });
});

describe('POST /runs deliver DEFAULT for repo-scoped launches (crew#393)', () => {
  let mockAdapter: MockAdapter;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = {
      launchRun: vi.fn().mockResolvedValue('run-1'),
      getSettings: vi.fn().mockResolvedValue({ graphNodeLimit: 150, deliverDefault: 'pr' }),
      getWorkflow: vi.fn().mockReturnValue(CODE_WORK_DEF),
    };
    app = buildApp(mockAdapter);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const launch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/runs', payload });

  it('DEFAULT ON: repoRef + a code-work workflow with no deliver field resolves to "pr"', async () => {
    const res = await launch({
      problem: 'fix #352',
      clisJson: '[]',
      workflow: 'feature',
      repoRef: 'repo-1',
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(input.deliver).toBe('pr');
  });

  it('OVERRIDE OFF: an explicit deliver:"none" beats the default — no deliver on the input', async () => {
    const res = await launch({
      problem: 'fix #352',
      clisJson: '[]',
      workflow: 'feature',
      repoRef: 'repo-1',
      deliver: 'none',
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('deliver' in input).toBe(false);
    // The operator decided; the setting is not consulted.
    expect(mockAdapter.getSettings).not.toHaveBeenCalled();
  });

  it('DAEMON SETTING flips the repo-scoped default: deliverDefault "none" ⇒ no deliver', async () => {
    mockAdapter.getSettings.mockResolvedValue({ graphNodeLimit: 150, deliverDefault: 'none' });
    const res = await launch({
      problem: 'fix #352',
      clisJson: '[]',
      workflow: 'feature',
      repoRef: 'repo-1',
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('deliver' in input).toBe(false);
  });

  it('a MISSING deliverDefault reads as "pr" (the shipped default, not off)', async () => {
    mockAdapter.getSettings.mockResolvedValue({ graphNodeLimit: 150 });
    const res = await launch({
      problem: 'fix #352',
      clisJson: '[]',
      workflow: 'feature',
      repoRef: 'repo-1',
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(input.deliver).toBe('pr');
  });

  it('FREE-TEXT repo-scoped launch (no workflow) defaults to none — there is no def to append to', async () => {
    const res = await launch({ problem: 'fix #352', clisJson: '[]', repoRef: 'repo-1' });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('deliver' in input).toBe(false);
  });

  it('deliver:"none" is legal WITHOUT a workflow (only "pr" requires one)', async () => {
    const res = await launch({ problem: 'just plan', clisJson: '[]', deliver: 'none' });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('deliver' in input).toBe(false);
  });

  it('READ-ONLY workflow (no executes_code phase — chat) defaults to none, never a doomed deliver', async () => {
    // The deliver script FAILS a clean worktree loudly ("nothing to deliver"); defaulting the
    // phase onto a workflow that writes nothing would flip completed chats to failed.
    mockAdapter.getWorkflow.mockReturnValue(READ_ONLY_DEF);
    const res = await launch({
      problem: 'what does this repo do?',
      clisJson: '[]',
      workflow: 'chat',
      repoRef: 'repo-1',
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('deliver' in input).toBe(false);
    // The setting is not even consulted — a read-only def can never default on.
    expect(mockAdapter.getSettings).not.toHaveBeenCalled();
  });

  it('an UNKNOWN workflow id defaults to none (the launch fails on its own workflow error, not a deliver-flavored one)', async () => {
    mockAdapter.getWorkflow.mockReturnValue(null);
    const res = await launch({
      problem: 'fix #352',
      clisJson: '[]',
      workflow: 'no-such-def',
      repoRef: 'repo-1',
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect('deliver' in input).toBe(false);
  });

  it('an EXPLICIT deliver:"pr" is threaded even for a read-only def — explicit beats the guard', async () => {
    mockAdapter.getWorkflow.mockReturnValue(READ_ONLY_DEF);
    const res = await launch({
      problem: 'deliver anyway',
      clisJson: '[]',
      workflow: 'chat',
      repoRef: 'repo-1',
      deliver: 'pr',
    });
    expect(res.statusCode).toBe(201);
    const input = mockAdapter.launchRun.mock.calls[0]![0] as LaunchRunInput;
    expect(input.deliver).toBe('pr');
  });
});
