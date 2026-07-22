import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CoreAdapter } from '../core/adapter.js';
import type { GateCache } from './gate-cache.js';
import type { LaunchRunInput, SessionStatus, SessionView } from '../core/types.js';

const execFileAsync = promisify(execFile);

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

// Repo names become directory components under ~/.wicked/repos/ — reject anything
// that would allow path traversal (slashes, dots-only segments, control chars).
const SAFE_REPO_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const RegisterRepoSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_REPO_NAME, 'Repository name must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores'),
    // For local registration: path to an existing git repo on disk.
    // For remote clone: optional clone destination (absolute path); if omitted,
    // defaults to ~/.wicked/repos/<name>.
    rootPath: z.string().optional(),
    gitUrl: z.string().optional(),
  })
  .refine(
    (d) => {
      const hasRemote = typeof d.gitUrl === 'string' && d.gitUrl.length > 0;
      const hasLocal = typeof d.rootPath === 'string' && d.rootPath.length > 0;
      // gitUrl alone (clone to default path), gitUrl + rootPath (clone to custom path),
      // or rootPath alone (register existing local repo) — all valid.
      return hasRemote || hasLocal;
    },
    { message: 'Provide gitUrl (remote clone) or rootPath (local registration), or both.' },
  );

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

const InjectSchema = z.object({
  message: z.string().min(1),
  /** `"all"` broadcasts to every active worker; any other value is a CLI key. */
  target: z.string().min(1).default('all'),
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
    const { name, rootPath, gitUrl } = parsed.data;
    try {
      if (gitUrl) {
        // Remote: clone to rootPath (if provided) or default ~/.wicked/repos/<name>,
        // register, and launch onboarding run.
        const { repoId, runId } = await adapter.cloneAndRegisterRepo(name, gitUrl, rootPath);
        const repos = await adapter.listRepos();
        const repo = repos.find((r) => r.id === repoId);
        if (!repo) return reply.code(500).send({ error: 'Repo registered but could not be retrieved' });
        return reply.code(201).send({ repo, onboardRunId: runId });
      } else {
        // Local: register then launch onboarding run.
        const repo = await adapter.registerRepo(name, rootPath!);
        const runId = await adapter.launchOnboardingRun(repo.id, name);
        return reply.code(201).send({ repo, onboardRunId: runId });
      }
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Return the onboarding run id for a repo (so the UI can navigate to it).
  app.get(`${V}/repos/:id/onboard`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = adapter.getOnboardRunId(id) ?? null;
    return reply.code(200).send({ runId });
  });

  // Re-run (or run for the first time) the onboarding workflow for a registered repo.
  app.post(`${V}/repos/:id/onboard`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    try {
      const runId = await adapter.launchOnboardingRun(repo.id, repo.name);
      return reply.code(201).send({ runId });
    } catch (err) {
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
  // runs, `<phase_id>` for workflow runs (e.g. "survey", "coverage"). Strip any accidental
  // `<id>:` prefix so both `survey` and `run-1:survey` resolve to the same key.
  app.get(`${V}/runs/:id/units/:unitKey/output`, async (req, reply) => {
    const { id, unitKey } = req.params as { id: string; unitKey: string };
    const suffix = unitKey.startsWith(`${id}:`) ? unitKey.slice(id.length + 1) : unitKey;
    const output = await adapter.workOutput(`${id}:${suffix}`);
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

  // Inject an operator message into a run's active worker(s) (§11.7).
  // target="all" broadcasts; any other value targets a specific CLI key.
  // Use sessions() (IDs only) for existence check — cheaper than sessionsDetail() on a hot path.
  app.post(`${V}/runs/:id/inject`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = InjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    const ids = await adapter.sessions();
    if (!ids.includes(id)) return reply.code(404).send({ error: 'Run not found' });
    try {
      await adapter.injectWorkerMessage(id, parsed.data.message, parsed.data.target);
      return reply.send({ status: 'ok' });
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

  // ── Governance reads (crew#40) ──────────────────────────────────────────────

  app.get(`${V}/governance/policies`, async () => {
    const policies = await adapter.listPolicies();
    return { policies };
  });

  app.get(`${V}/governance/rules`, async () => {
    const rules = await adapter.listConformanceRules();
    return { rules };
  });

  app.get(`${V}/governance/claims`, async () => {
    const claims = await adapter.listConformanceClaims();
    return { claims };
  });

  app.get(`${V}/governance/coverage`, async () => {
    const report = await adapter.getCoverageReport();
    return { report };
  });

  // ── Governance writes (crew#42) ────────────────────────────────────────────

  app.post(`${V}/governance/policies`, async (req, reply) => {
    try {
      await adapter.upsertPolicy(req.body as import('../core/types.js').GovernancePolicy);
      return { status: 'ok' };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.post(`${V}/governance/rules`, async (req, reply) => {
    try {
      await adapter.upsertConformanceRule(req.body as import('../core/types.js').ConformanceRule);
      return { status: 'ok' };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.get(`${V}/governance/rules/preview`, async (req, reply) => {
    const q = req.query as Record<string, string | string[] | undefined>;
    try {
      const rules = await adapter.recallRulesPreview(q);
      return { rules };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // ── Workflow viewer + builder (crew#44) ───────────────────────────────────

  app.get(`${V}/workflows`, async () => {
    const workflows = adapter.listWorkflows();
    return { workflows };
  });

  app.get(`${V}/workflows/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const workflow = adapter.getWorkflow(id);
    if (!workflow) return reply.code(404).send({ error: `workflow '${id}' not found` });
    return { workflow };
  });

  // Register (or replace) a user-authored workflow definition.
  // Validates, persists to ~/.wicked/workflows/<id>.json, hot-registers in the
  // Rust actor when registerWorkflow NAPI is available.
  app.post(`${V}/workflows`, async (req, reply) => {
    const body = req.body as { id?: unknown };
    if (!body || typeof body.id !== 'string' || !body.id) {
      return reply.code(400).send({ error: 'workflow must have a string `id` field' });
    }
    if (!SAFE_REPO_NAME.test(body.id) || body.id.length > 128) {
      return reply.code(400).send({ error: 'workflow id must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores' });
    }
    try {
      const id = await adapter.registerWorkflow(body as import('../core/types.js').WorkflowDef);
      return reply.code(201).send({ id, status: 'registered' });
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // Save an inline script to ~/.wicked/scripts/ and return its path.
  // Tool-executor phases use the returned path as their command.
  app.post(`${V}/scripts`, async (req, reply) => {
    const body = req.body as { name?: unknown; content?: unknown; lang?: unknown };
    if (typeof body.name !== 'string' || typeof body.content !== 'string') {
      return reply.code(400).send({ error: '`name` and `content` are required strings' });
    }
    if (!SAFE_REPO_NAME.test(body.name) || body.name.length > 128) {
      return reply.code(400).send({ error: 'Script name must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores' });
    }
    const lang = (body.lang as string | undefined) ?? 'bash';
    if (!['bash', 'python', 'sh'].includes(lang)) {
      return reply.code(400).send({ error: '`lang` must be bash | python | sh' });
    }
    try {
      const path = await adapter.saveScript(body.name, body.content, lang as 'bash' | 'python' | 'sh');
      return reply.code(201).send({ path });
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Domain-model browser (crew#44) ────────────────────────────────────────
  // Reads the `requirements_graph.json` artifact produced by `wicked-core domain-graph`.
  // Path: `.wicked-estate/requirements/requirements_graph.json` relative to cwd.

  app.get(`${V}/domain-graph`, async (_req, reply) => {
    const path = join(process.cwd(), '.wicked-estate', 'requirements', 'requirements_graph.json');
    try {
      const content = await fsp.readFile(path, 'utf8');
      return { graph: JSON.parse(content) as unknown };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { graph: null };
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Per-repo domain graph ─────────────────────────────────────────────────
  // Reads requirements_graph.json from the repo root. Coverage stats come from
  // the live estate store via `wicked-core coverage --json` (not a cached file).

  app.get(`${V}/repos/:id/domain-graph`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    const graphPath = join(repo.root_path, '.wicked-estate', 'requirements', 'requirements_graph.json');
    const dbPath = join(repo.root_path, '.codegraph', 'estate.db');

    // Coverage from the live estate store — computed by wicked-core governance layer.
    let coverage: unknown = null;
    if (existsSync(dbPath)) {
      try {
        const { stdout } = await execFileAsync(
          process.env['WICKED_CORE_EXE'] ?? 'wicked-core',
          ['coverage', '--db', dbPath, '--json'],
          { timeout: 20_000, cwd: repo.root_path },
        );
        coverage = JSON.parse(stdout) as unknown;
      } catch { /* store not yet indexed — coverage stays null */ }
    }

    try {
      const content = await fsp.readFile(graphPath, 'utf8');
      return { graph: JSON.parse(content) as unknown, coverage };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { graph: null, coverage };
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Repo code graph (via wicked-estate graph-view) ──────────────────────────
  // Delegates to the estate CLI so the query goes through the proper service
  // layer (store-seam aware, overlay edges included). Postgres-safe.

  app.get(`${V}/repos/:id/graph`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    const dbPath = join(repo.root_path, '.codegraph', 'estate.db');
    if (!existsSync(dbPath)) {
      return reply.send({ graph: null });
    }

    try {
      const settings = await adapter.getSettings();
      const nodeLimit = String(settings.graphNodeLimit);
      const { stdout } = await execFileAsync(
        'wicked-estate',
        ['graph-view', '--limit', nodeLimit, '--db', dbPath],
        { timeout: 30_000, cwd: repo.root_path },
      );
      const raw = JSON.parse(stdout) as {
        nodes: Array<{ id: string; name: string; kind: string; file: string; lang: string; score: number; inDeg: number; outDeg: number }>;
        edges: Array<{ src: string; tgt: string }>;
      };
      const fileCount = new Set(raw.nodes.map((n) => n.file)).size;
      return reply.send({
        graph: {
          nodes: raw.nodes,
          edges: raw.edges,
          stats: { nodeCount: raw.nodes.length, edgeCount: raw.edges.length, fileCount },
        },
      });
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Git history (last 20 commits via git log) ─────────────────────────────

  app.get(`${V}/repos/:id/git-history`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ar', '-n', '20'],
        { timeout: 10_000, cwd: repo.root_path },
      );
      const commits = stdout.trim().split('\n').filter(Boolean).map((line) => {
        const parts = line.split('\x1f');
        return {
          sha:      parts[0] ?? '',
          shortSha: parts[1] ?? '',
          message:  parts[2] ?? '',
          author:   parts[3] ?? '',
          date:     parts[4] ?? '',
        };
      });
      return reply.send({ commits });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(500).send({ error: 'git executable not found on server' });
      }
      const msg = (err as Error).message ?? String(err);
      if (msg.includes('not a git repository') || msg.includes('does not have any commits')) {
        return reply.send({ commits: [] });
      }
      return reply.code(500).send({ error: msg });
    }
  });

  // ── Git contributors (top 10 by commit count via git shortlog) ─────────────

  app.get(`${V}/repos/:id/contributors`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['shortlog', '-sne', '--no-merges', 'HEAD'],
        { timeout: 10_000, cwd: repo.root_path },
      );
      // Output: "  42\tFull Name <email@example.com>"
      const contributors = stdout.trim().split('\n').filter(Boolean).slice(0, 10).map((line) => {
        const m = line.match(/^\s*(\d+)\s+(.+?)\s+<([^>]+)>/);
        if (!m) return null;
        return { commits: parseInt(m[1] ?? '0', 10), name: m[2] ?? '', email: m[3] ?? '' };
      }).filter((c): c is { commits: number; name: string; email: string } => c !== null);
      return reply.send({ contributors });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(500).send({ error: 'git executable not found on server' });
      }
      const msg = (err as Error).message ?? String(err);
      // "ambiguous argument 'HEAD'" means no commits yet; treat as empty list
      if (
        msg.includes('not a git repository') ||
        msg.includes('does not have any commits') ||
        msg.includes("ambiguous argument 'HEAD'") ||
        msg.includes('unknown revision')
      ) {
        return reply.send({ contributors: [] });
      }
      return reply.code(500).send({ error: msg });
    }
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

  // ── System settings ──────────────────────────────────────────────────────────
  app.get(`${V}/settings`, async () => ({ settings: await adapter.getSettings() }));

  app.put(`${V}/settings`, async (req, reply) => {
    const patch = req.body as Partial<import('../core/types.js').SystemSettings>;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }
    if ('graphNodeLimit' in patch) {
      const limit = patch.graphNodeLimit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 20 || limit > 500) {
        return reply.code(400).send({ error: 'graphNodeLimit must be an integer between 20 and 500' });
      }
    }
    // Only allow known keys through.
    const allowed: (keyof import('../core/types.js').SystemSettings)[] = ['graphNodeLimit'];
    const safe: Partial<import('../core/types.js').SystemSettings> = {};
    for (const key of allowed) {
      if (key in patch) (safe as Record<string, unknown>)[key] = patch[key];
    }
    return { settings: await adapter.updateSettings(safe) };
  });
}
