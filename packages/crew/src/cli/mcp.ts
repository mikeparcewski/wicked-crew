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

// ─── Crew daemon client ───────────────────────────────────────────────────────

class CrewClient {
  private readonly base: string;

  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}/api/v1`;
  }

  async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
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
  try {
    await client.get('/health');
  } catch {
    throw new Error(
      `[wicked-crew mcp] Cannot reach daemon at port ${port}. ` +
      `Start it first with: wicked-crew serve --port ${port}`,
    );
  }

  const server = new McpServer({ name: 'wicked-crew', version: '0.5.0' });

  // ── launch_run ─────────────────────────────────────────────────────────────
  server.tool(
    'launch_run',
    'Launch a new governed workflow run on the wicked-crew daemon. ' +
    'Returns the run ID which can be used with the other tools.',
    {
      problem: z.string().min(1).describe('The task description / problem statement for the run'),
      workflow: z.string().optional().describe(
        'Workflow id (e.g. "feature", "bug", "survey-repo"). ' +
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
    'Useful for inspecting exactly what happened during a governed workflow.',
    {
      run_id: z.string().min(1).describe('The run ID'),
      limit: z.number().int().min(1).max(1000).optional().describe(
        'Maximum number of events to return (default 200)',
      ),
    },
    async ({ run_id, limit }) => {
      const q = limit !== undefined ? `?limit=${limit}` : '';
      return ok(await client.get(`/runs/${run_id}/events${q}`));
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
