// Regression tests for FINDING-031: the daemon silently discarded unknown request fields.
//
// zod's `.object()` STRIPS unknown keys by default, so every OPTIONAL field on every schema had a
// silent-failure twin — misspell it and the endpoint answered 2xx having run the engine default.
// Required fields were never at risk (a missing `problem` is a 400), which confines the defect to
// exactly the set that carries the governance choices: `workflow`, `humanConfirm`, `clisJson`,
// `entityMode`, `repoRef`.
//
// The live reproduction: `POST /runs {"problem": "...", "clis": ["claude"], "workflowId": "feature"}`
// — core's `LaunchSpec` field names rather than the HTTP layer's — returned `201` and ran the full
// 3-seat roster with no workflow at all. Nothing in the response said so. Two vocabularies for one
// launch is what makes this reachable by a careful caller: core says `clis`/`workflow`, HTTP says
// `clisJson`/`workflow`, and the `/ws` `sessionStarted` frame reports `workflowId`, so reading the
// event stream to learn the field names leads straight to a name the request schema rejects.
//
// These run against the STUB engine, in-process, over the real HTTP surface.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let repoDir: string;
let baseUrl: string;
let repoId: string;

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

const HAPPY_PATH_ID = 'strictness-happy-path';
const POLL_INTERVAL_MS = 50;
const RUN_TIMEOUT_MS = 15000;

interface ErrorBody {
  error: string;
  details?: unknown[];
}

/**
 * Block until `sessionId` stops running. Teardown removes the engine's whole state directory, and
 * a run still executing will recreate files inside it mid-`rmSync` — `rmSync` lists the directory,
 * unlinks what it listed, then fails `ENOTEMPTY` on the entry that appeared after the listing.
 * `force: true` does not cover that; it suppresses "already gone", not "came back".
 */
async function waitForTerminal(sessionId: string): Promise<void> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/v1/runs/${sessionId}`);
    if (res.ok) {
      const body = (await res.json()) as { run: { session: { status: string } } };
      const { status } = body.run.session;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return;
    } else if (res.status !== 404) {
      // 404 is the launch not yet visible; anything else is a broken surface, and swallowing it
      // here would surface as an unrelated teardown flake rather than as this test failing.
      throw new Error(`GET /runs/${sessionId} failed with status ${res.status}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`run ${sessionId} did not reach a terminal status within ${RUN_TIMEOUT_MS}ms`);
}

async function post(path: string, body: unknown): Promise<{ status: number; body: ErrorBody }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ErrorBody };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-strictness-'));
  repoDir = mkdtempSync(join(tmpdir(), 'crew-strictness-repo-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  // Registered through the adapter, not the route: the requirements endpoints look the repo up
  // BEFORE they parse, so their strictness is unreachable without one. No onboarding run needed.
  // `registerRepo` insists on a git repo with at least one commit (it prepares a worktree), hence
  // the init + empty commit. Identity is set locally so the test does not depend on a global
  // git config being present.
  const git = (...a: string[]): void => {
    execFileSync('git', a, { cwd: repoDir, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'strictness fixture');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  repoId = (await adapter.registerRepo('strictness-fixture', repoDir)).id;
});

afterAll(async () => {
  await app.close();
  // Releases the event-pump thread. Closing the server alone leaves it delivering into a callback
  // whose state directory is about to be deleted.
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe('POST /runs rejects fields it does not know (FINDING-031)', () => {
  it('refuses the exact launch that silently ran the wrong configuration', async () => {
    const { status, body } = await post('/api/v1/runs', {
      problem: 'Add a health endpoint',
      clis: ['claude'], // core's name; the HTTP layer wants `clisJson`
      workflowId: 'feature', // the /ws frame's name; the HTTP layer wants `workflow`
    });

    // The defect was a 201 here — a run dispatched with 3 seats and no workflow.
    expect(status).toBe(400);
    // Both unknown keys are named in `error` itself, not buried in `details`: a caller reading
    // `curl … | jq .error` is the one who needs to know which field was wrong.
    expect(body.error).toContain('clis');
    expect(body.error).toContain('workflowId');
  });

  it('names a single misspelled optional field so the caller can fix it without reading the source', async () => {
    const { status, body } = await post('/api/v1/runs', {
      problem: 'Add a health endpoint',
      humanConfirmm: 'gate-1',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('humanConfirmm');
    expect(body.details?.length).toBeGreaterThan(0);
  });

  it('still accepts a correctly-spelled launch (strictness did not break the happy path)', async () => {
    const { status } = await post('/api/v1/runs', {
      problem: 'Do step one. Do step two',
      sessionId: HAPPY_PATH_ID,
      clisJson: SEATS,
      entityMode: 'shared',
    });
    expect(status).toBe(201);
    // 201 means ACCEPTED, not finished — the engine goes on executing this run and spooling its
    // events. Every other case here is a 400 that dispatches nothing, so this is the only one that
    // outlives its own assertion, and teardown has to wait for it (see `afterAll`).
    await waitForTerminal(HAPPY_PATH_ID);
  });
});

describe('the other request surfaces reject unknown fields too', () => {
  // POST /repos carries a `.refine()`. `.strict()` has to come BEFORE it, or the refine runs on an
  // already-stripped object and passes — reporting the request valid while the field it validated
  // is gone.
  it('POST /repos names the unknown key rather than letting .refine() mask it', async () => {
    const { status, body } = await post('/api/v1/repos', {
      name: 'somerepo',
      rootPath: '/tmp/does-not-matter',
      gitUrlz: 'https://example.invalid/x.git',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('gitUrlz');
  });

  it('POST /runs/:id/gate rejects an unknown key on the human decision', async () => {
    const { status, body } = await post('/api/v1/runs/whatever/gate', {
      approve: true,
      ammend: 'looks fine', // `amend`
    });
    expect(status).toBe(400);
    expect(body.error).toContain('ammend');
  });

  it('PATCH requirements rejects a misspelled field instead of applying a partial edit', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/repos/${encodeURIComponent(repoId)}/requirements/REQ-1`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // `title` is valid, `note` is not — the old behaviour applied the title and dropped the
        // note, passing the non-empty-patch refine on the half of the edit that survived.
        body: JSON.stringify({ title: 'A better title', note: 'why' }),
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error).toContain('note');
  });

  it('the requirements query rejects an unknown parameter', async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/repos/${encodeURIComponent(repoId)}/requirements?limitt=5`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error).toContain('limitt');
  });
});
