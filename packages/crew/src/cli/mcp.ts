/**
 * `wicked-crew mcp` — stdio MCP server that proxies the wicked-crew daemon's
 * run-lifecycle surface. One tool per verb; all calls are 1:1 HTTP passthroughs
 * to a running daemon. The MCP server is stateless: it carries NO in-process
 * adapter and does NOT open the engine DB.
 *
 * Usage:
 *   wicked-crew mcp [--port <n>]   # connects to daemon at 127.0.0.1:<port>
 *
 * The daemon must already be running (`wicked-crew serve`). Governance semantics,
 * repo-scoping, and run authority all live in the daemon — no new authority here.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { missingBearerAdvice, withBearerHeader } from './bearer.js';

// ─── Crew daemon client ───────────────────────────────────────────────────────

/** The daemon ANSWERED and refused — distinct from "no daemon there", which is a transport error. */
export class CrewHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CrewHttpError';
    this.status = status;
  }
}

/**
 * What to say when the startup health probe fails. A refusal is not unreachability: reporting
 * "Cannot reach daemon" for a 401 is false AND it throws away the bearer advice the refusal
 * carries (#637, codex review of #723).
 */
export function probeFailureMessage(err: unknown, port: number): string {
  if (err instanceof CrewHttpError) {
    return `[wicked-crew mcp] the daemon at port ${port} answered the health probe with ${err.status}: ${err.message}`;
  }
  return (
    `[wicked-crew mcp] Cannot reach daemon at port ${port}. ` +
    `Start it first with: wicked-crew serve --port ${port}`
  );
}

class CrewClient {
  private readonly base: string;

  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}/api/v1`;
  }

  /** The failure for a non-2xx: under a team runtime with no bearer, name the variable (#637). */
  private static async failure(verb: string, path: string, res: Response): Promise<CrewHttpError> {
    const head = `${verb} ${path} → ${res.status}: ${await res.text()}`;
    const advice = res.status === 401 || res.status === 403 ? missingBearerAdvice() : null;
    return new CrewHttpError(advice === null ? head : `${head}\n${advice}`, res.status);
  }

  async get(path: string): Promise<unknown> {
    // withBearerHeader: these verbs bypassed it entirely, so every one of them 401'd under a team
    // runtime with nothing said about why (#637, same class as the `wicked-crew start` regression).
    const res = await fetch(`${this.base}${path}`, withBearerHeader(undefined));
    if (!res.ok) throw await CrewClient.failure('GET', path, res);
    return res.json();
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, withBearerHeader({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    if (!res.ok) throw await CrewClient.failure('POST', path, res);
    return res.json();
  }
}

// ─── Tool result helpers ──────────────────────────────────────────────────────

function ok(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ─── MCP server ──────────────────────────────────────────────────────────────

export async function runMcpServer(port: number): Promise<void> {
  const client = new CrewClient(port);

  // Probe the daemon before advertising ourselves — fail loudly if unreachable.
  // Capture the version from the health response so serverInfo stays in sync with the daemon.
  // `/api/v1/health` IS a protected path (api/auth.ts `isProtectedPath`), so under a team runtime
  // with no bearer this probe gets a 401, not a transport failure — hence probeFailureMessage.
  let daemonVersion = '0.0.0';
  try {
    const health = await client.get('/health') as { version?: string };
    if (typeof health.version === 'string') daemonVersion = health.version;
  } catch (err) {
    throw new Error(probeFailureMessage(err, port));
  }

  const server = new McpServer({ name: 'wicked-crew', version: daemonVersion });

  // ── launch_run ─────────────────────────────────────────────────────────────
  server.tool(
    'launch_run',
    'Launch a new governed workflow run on the wicked-crew daemon. ' +
    'Returns the run ID which can be used with the other tools.',
    {
      problem: z.string().min(1).describe('The task description / problem statement for the run'),
      workflow: z.string().optional().describe(
        'Workflow id (e.g. "feature", "bug", "domain-extraction"). ' +
        'Use list_workflows to see available ids.',
      ),
      repo: z.string().optional().describe(
        'Registered repo reference (id returned by the daemon registry). ' +
        'Required for workflows that need a code graph.',
      ),
      project_id: z.string().optional().describe(
        'File the run into a project. The project must exist and be active.',
      ),
    },
    async ({ problem, workflow, repo, project_id }) => {
      const body: Record<string, string> = { problem };
      if (workflow) body['workflow'] = workflow;
      if (repo) body['repoRef'] = repo;
      if (project_id) body['projectId'] = project_id;
      return ok(await client.post('/runs', body));
    },
  );

  // ── run_status ─────────────────────────────────────────────────────────────
  server.tool(
    'run_status',
    'Get the current status and unit details of a run. ' +
    'Poll this after launch_run to track progress.',
    {
      run_id: z.string().min(1).describe('The run ID returned by launch_run'),
    },
    async ({ run_id }) => ok(await client.get(`/runs/${run_id}`)),
  );

  // ── list_runs ──────────────────────────────────────────────────────────────
  server.tool(
    'list_runs',
    'List all runs on the daemon, most-actionable first (awaiting gate/elicitation first, ' +
    'then active, then completed).',
    {},
    async () => ok(await client.get('/runs')),
  );

  // ── run_events ─────────────────────────────────────────────────────────────
  server.tool(
    'run_events',
    'Return the durable event trail for a run. ' +
    'Useful for inspecting exactly what happened during a governed workflow. ' +
    'The daemon returns all events; `limit` truncates client-side (most-recent last).',
    {
      run_id: z.string().min(1).describe('The run ID'),
      limit: z.number().int().min(1).max(1000).optional().describe(
        'Maximum number of events to return. Truncated from the tail (most-recent). Default: all.',
      ),
    },
    async ({ run_id, limit }) => {
      const data = await client.get(`/runs/${run_id}/events`) as {
        runId: string; total: number; returned: number; events: unknown[];
      };
      const events = limit !== undefined ? data.events.slice(-limit) : data.events;
      return ok({ ...data, returned: events.length, events });
    },
  );

  // ── answer_gate ────────────────────────────────────────────────────────────
  server.tool(
    'answer_gate',
    'Approve or reject the human gate on a run. ' +
    'Use run_status to check if a run is awaiting a gate decision before calling this.',
    {
      run_id: z.string().min(1).describe('The run ID'),
      approve: z.boolean().describe('true to approve, false to reject'),
      amend: z.string().optional().describe(
        'Optional steering text appended to the next unit\'s prompt when approving',
      ),
    },
    async ({ run_id, approve, amend }) => {
      const body: Record<string, unknown> = { approve };
      if (amend !== undefined) body['amend'] = amend;
      return ok(await client.post(`/runs/${run_id}/gate`, body));
    },
  );

  // ── cancel_run ─────────────────────────────────────────────────────────────
  server.tool(
    'cancel_run',
    'Cancel an active run. The run will be marked as failed immediately.',
    {
      run_id: z.string().min(1).describe('The run ID to cancel'),
    },
    async ({ run_id }) => ok(await client.post(`/runs/${run_id}/cancel`, {})),
  );

  // ── list_workflows ─────────────────────────────────────────────────────────
  server.tool(
    'list_workflows',
    'List all workflows available on the daemon, ' +
    'including their phases and evidence-floor requirements.',
    {},
    async () => ok(await client.get('/workflows')),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
