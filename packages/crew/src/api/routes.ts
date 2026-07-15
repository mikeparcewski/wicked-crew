import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../core/adapter.js';
import type { GateCache } from './gate-cache.js';
import type { LaunchRunInput, SessionStatus, SessionView } from '../core/types.js';

const V = '/api/v1';

// Daemon version reported by /health — read from package.json so it never drifts
// from the shipped version across releases. Resolves the package root from the
// compiled module location (dist/api/routes.js → ../../package.json) and works the
// same under the src layout (src/api/routes.ts → ../../package.json).
const PKG_VERSION = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }
).version;

// Actionable-first ordering for the run list (DES-STUDIO-001 §11.6): a run
// awaiting a human sorts to the top; terminal runs sink.
const STATUS_ORDER: Record<SessionStatus, number> = {
  awaiting_human: 0,
  executing: 1,
  distributing: 2,
  planning: 3,
  failed: 4,
  completed: 5,
  cancelled: 6,
};

function sortActionableFirst(views: SessionView[]): SessionView[] {
  return [...views].sort(
    (a, b) => (STATUS_ORDER[a.session.status] ?? 9) - (STATUS_ORDER[b.session.status] ?? 9),
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const RegisterRepoSchema = z.object({
  name: z.string().min(1),
  rootPath: z.string().min(1),
});

const LaunchSchema = z.object({
  problem: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  clisJson: z.string().min(1).optional(),
  entityMode: z.enum(['shared', 'isolated']).optional(),
  humanConfirm: z.string().min(1).optional(),
  repoRef: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
});

const GateSchema = z.object({
  approve: z.boolean(),
  amend: z.string().optional(),
});

const OpenTerminalSchema = z.object({
  cwd: z.string().min(1),
  cmd: z.array(z.string().min(1)).min(1).optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  // Optional so omission is the SAFE governed default (§7 — `false` is never a
  // default; the ungoverned operator shell must opt in explicitly).
  governed: z.boolean().optional(),
});

const ResizeTerminalSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/**
 * The daemon REST surface. Every endpoint is a thin wrapper over one adapter /
 * core-ts call (DES-STUDIO-001 §2). `session`/`phase` nouns are now `run`/`unit`.
 */
export function registerRoutes(app: FastifyInstance, adapter: CoreAdapter, gateCache: GateCache): void {
  // Liveness — also proves the actor + event pump are up.
  app.get(`${V}/health`, async () => {
    const ping = await adapter.ping();
    return { status: 'ok', version: PKG_VERSION, ping };
  });

  // Report the actually-bound port/host (honours --port / CREW_PORT / port 0).
  app.get(`${V}/config`, async () => {
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 7701;
    const host = typeof addr === 'object' && addr ? addr.address : '127.0.0.1';
    return { port, host };
  });

  // The council seats for the launch form (static production roster).
  app.get(`${V}/roster`, async () => ({ roster: CoreAdapter.roster() }));

  // Registered repos → target-repo picker.
  app.get(`${V}/repos`, async () => ({ repos: await adapter.listRepos() }));

  app.post(`${V}/repos`, async (req, reply) => {
    const parsed = RegisterRepoSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    try {
      const repo = await adapter.registerRepo(parsed.data.name, parsed.data.rootPath);
      return reply.code(201).send({ repo });
    } catch (err) {
      // Core rejects a non-git / zero-commit path — a client error, not a 500.
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Launch a run (replaces POST /sessions). `clisJson` defaults to the roster;
  // `sessionId` is minted if the client omits it.
  app.post(`${V}/runs`, async (req, reply) => {
    const parsed = LaunchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    const b = parsed.data;
    const input: LaunchRunInput = {
      problem: b.problem,
      sessionId: b.sessionId ?? randomUUID(),
      clisJson: b.clisJson ?? JSON.stringify(CoreAdapter.roster()),
    };
    if (b.entityMode !== undefined) input.entityMode = b.entityMode;
    if (b.humanConfirm !== undefined) input.humanConfirm = b.humanConfirm;
    if (b.repoRef !== undefined) input.repoRef = b.repoRef;
    if (b.workflow !== undefined) input.workflow = b.workflow;
    try {
      const runId = await adapter.launchRun(input);
      return reply.code(201).send({ runId });
    } catch (err) {
      const msg = message(err);
      const busy = /busy|in flight|already/i.test(msg);
      return reply.code(busy ? 409 : 400).send({ error: msg });
    }
  });

  // Run list (replaces GET /sessions). Actionable-first; reconciles the gate cache.
  app.get(`${V}/runs`, async () => {
    const views = await adapter.sessionsDetail();
    gateCache.reconcile(views);
    return { runs: sortActionableFirst(views) };
  });

  // One run's detail.
  app.get(`${V}/runs/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return { run };
  });

  // A unit's captured transcript. unitKey is the suffix after `<run>:` — `u<ord>` for free-text
  // runs, `<phase_id>` for workflow runs (e.g. "survey", "coverage").
  app.get(`${V}/runs/:id/units/:unitKey/output`, async (req, reply) => {
    const { id, unitKey } = req.params as { id: string; unitKey: string };
    const output = await adapter.workOutput(`${id}:${unitKey}`);
    return reply.send({ output });
  });

  // The steering gate (§11.1). approve+amend = approve-with-steer; approve:false = reject (cancels).
  app.post(`${V}/runs/:id/gate`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = GateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (run.session.status !== 'awaiting_human') {
      return reply
        .code(409)
        .send({ error: `Run is not awaiting a human gate (status: ${run.session.status})` });
    }
    try {
      const status = await adapter.confirmGate(id, parsed.data.approve, parsed.data.amend);
      return reply.send({ status });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  // Cancel a running or paused run (distinct third action, §11.1).
  app.post(`${V}/runs/:id/cancel`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    try {
      const status = await adapter.cancelRun(id);
      return reply.send({ status });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  // Advance semantics (§11.8): a gated run advances via confirmGate; otherwise
  // resumeRun re-enters the cursor. Never resumeRun a gated run (it would re-pause).
  app.post(`${V}/runs/:id/resume`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    try {
      const status =
        run.session.status === 'awaiting_human'
          ? await adapter.confirmGate(id, true)
          : await adapter.resumeRun(id);
      return reply.send({ status });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  // The daemon-cached gate prompt for a paused run (not a core call) so a fresh
  // browser can render the gate after a late join.
  app.get(`${V}/runs/:id/gate`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = gateCache.get(id);
    if (!entry) return reply.code(404).send({ error: 'No open gate for this run' });
    return { runId: id, ...entry };
  });

  // ── PTY terminal sessions (DES-TERMINAL-001 §6) ────────────────────────────
  // Open a PTY → its id. Drive it over the per-terminal WS `/ws/terminals/:id`;
  // raw output arrives there. `governed` defaults to `true` (the gate-hook-routed
  // default, §7) — an ungoverned operator shell must pass `governed:false` EXPLICITLY.
  app.post(`${V}/terminals`, async (req, reply) => {
    const parsed = OpenTerminalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    const b = parsed.data;
    try {
      const id = await adapter.openTerminal(b.cwd, b.cmd, b.cols, b.rows, b.governed ?? true);
      return reply.code(201).send({ id });
    } catch (err) {
      // Core rejects a bad cwd / spawn failure — a client error, not a 500.
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Resize a live terminal's PTY.
  app.post(`${V}/terminals/:id/resize`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ResizeTerminalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    try {
      const status = await adapter.resizeTerminal(id, parsed.data.cols, parsed.data.rows);
      return reply.send({ status });
    } catch (err) {
      // Unknown / already-closed terminal id → 404, not 500.
      return reply.code(404).send({ error: message(err) });
    }
  });

  // Close a live terminal (kill child, join reader). A second close of an
  // already-gone terminal 404s rather than 500s.
  app.post(`${V}/terminals/:id/close`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const status = await adapter.closeTerminal(id);
      return reply.send({ status });
    } catch (err) {
      return reply.code(404).send({ error: message(err) });
    }
  });
}
