/**
 * Fixture harness for the GENERATED API suites (TH-11) — hand-written, committed.
 *
 * The generator (scripts/generate-api-tests.ts) derives WHICH cases exist from the committed
 * endpoint manifest; this module supplies the one thing a manifest cannot: a running route set
 * with known state. Same seams as every route unit test in this suite (registerRoutes over a
 * mock adapter, fastify inject, no NAPI engine), plus two fixture runs whose statuses the
 * generated negatives depend on:
 *
 *   - `run-fixture-done`  — status `completed`:      POST gate on it answers 409 (not awaiting).
 *   - `run-fixture-gated` — status `awaiting_human`: POST gate on it resolves (positive case).
 *
 * Both ids are load-bearing: the generator writes them into the emitted tests. Rename them here
 * and regenerate, never edit the generated file.
 */
import Fastify from 'fastify';
import { vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerRoutes } from '../../src/api/routes.js';
import { GateCache } from '../../src/api/gate-cache.js';
import { ElicitationCache } from '../../src/api/elicitation-cache.js';
import { InteractiveBridgePool, type LiveBridge } from '../../src/interactive/bridge-pool.js';
import { DocGroundingStore } from '../../src/interactive/doc-grounding.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { Project, SessionView } from '../../src/core/types.js';

export const RUN_DONE = 'run-fixture-done';
export const RUN_GATED = 'run-fixture-gated';
/** A project the interactive proxy can answer for (F-046: the typed doc-create endpoint). */
export const PROJECT_FIXTURE = 'proj-fixture';
/** Its one `crew.repo` member — what a create may name as `repo_ref`. */
export const REPO_FIXTURE = 'repo-fixture';

/**
 * A stand-in wicked-interactive bridge, in-process (the generated suite spawns no `npx`): it
 * speaks the two routes the sampled create exercises — `POST /api/docs` with the real bridge's
 * "valid name required" 400 and its `{ name, head, generating }` answer, `GET /api/docs` empty —
 * and the pool hands it out for every root. Started lazily on the first `ensure`.
 */
class FakeBridgePool extends InteractiveBridgePool {
  private server: Server | null = null;
  private bridgePromise: Promise<LiveBridge> | null = null;

  override ensure(): Promise<LiveBridge> {
    if (this.bridgePromise === null) {
      this.bridgePromise = new Promise<LiveBridge>((resolve) => {
        this.server = createHttpServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://x');
          if (url.pathname === '/api/docs' && req.method === 'POST') {
            let raw = '';
            req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
            req.on('end', () => {
              let body: Record<string, unknown> = {};
              try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* the bridge's own 400 below */ }
              const name = typeof body['name'] === 'string' ? body['name'].toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64) : '';
              if (name === '') {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'valid name required (lowercase letters, digits, hyphens; up to 64 chars)' }));
                return;
              }
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ name, head: 0, ...(body['kind'] === 'source' ? { generating: true } : {}), ...(typeof body['project'] === 'string' ? { project_id: body['project'] } : {}) }));
            });
            return;
          }
          if (url.pathname === '/api/docs') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('[]');
            return;
          }
          res.writeHead(404).end();
        });
        this.server.listen(0, '127.0.0.1', () => {
          const addr = this.server!.address();
          resolve({ host: '127.0.0.1', port: typeof addr === 'object' && addr ? addr.port : 0, pid: process.pid });
        });
      });
    }
    return this.bridgePromise;
  }

  override invalidate(): void {
    /* the fake never dies mid-request */
  }

  close(): void {
    this.server?.close();
  }
}

function view(id: string, status: string): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'generated-suite fixture',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status,
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

/** The route set the generated tests inject against. Build one per test file. */
export function buildGeneratedApiApp(): FastifyInstance {
  // The interactive docs root and the fixture repo live in a scratch dir — never the operator's
  // home (the proxy materializes `<root>/<doc>/crew-grounding.json` for a create naming a repo).
  const scratch = mkdtempSync(join(tmpdir(), 'crew-generated-'));
  const repoRoot = join(scratch, 'fixture-repo');
  mkdirSync(repoRoot, { recursive: true });
  process.env['WICKED_INTERACTIVE_ROOT'] = join(scratch, 'interactive-docs');
  const project: Project = {
    id: PROJECT_FIXTURE, name: 'Generated fixture', description: null, status: 'active',
    scope: `project:${PROJECT_FIXTURE}`, created_at: 0, updated_at: 0,
  } as Project;
  const adapter = {
    ping: vi.fn(async () => 'pong'),
    sessionsDetail: vi.fn(async () => [view(RUN_DONE, 'completed'), view(RUN_GATED, 'awaiting_human')]),
    sessions: vi.fn(async () => [RUN_DONE, RUN_GATED]),
    launchRun: vi.fn(async () => 'run-generated'),
    confirmGate: vi.fn(async () => 'running'),
    projectGet: vi.fn(async (id: string) => (id === PROJECT_FIXTURE ? project : null)),
    projectMembers: vi.fn(async (id: string) =>
      id === PROJECT_FIXTURE ? [{ member_kind: 'crew.repo', member_ref: REPO_FIXTURE }] : []),
    listRepos: vi.fn(async () => [{ id: REPO_FIXTURE, name: 'fixture-repo', root_path: repoRoot }]),
  } as unknown as CoreAdapter;
  const pool = new FakeBridgePool({});

  const app = Fastify({ logger: false });
  // Same tolerant empty-JSON-body parser createServer installs — some POSTs take no body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined || body === null) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, undefined, {
    interactiveBridges: pool,
    docGrounding: new DocGroundingStore(),
  });
  app.addHook('onClose', async () => {
    pool.close();
  });
  return app;
}
