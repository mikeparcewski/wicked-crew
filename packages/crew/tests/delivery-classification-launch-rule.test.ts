// Adjudicated §4.8 — the LIVE-rule equivalence pin (review-L8-600 HIGH-1).
//
// `isCodeWorkDef(def)` (api/delivery-index.ts) is the hoisted twin of the `POST /runs` closure's
// inline deliver-default rule (`routes.ts`: `codeWork = def.phases.some(p => p.executes_code === true
// && p.role !== 'evaluator')` ⇒ `deliver = 'pr'` when the daemon's `deliverDefault` allows it, else
// `'none'`, recorded on the `run.launched` audit entry as `detail.deliver` + `deliverDefaulted: true`).
// The swap of that inline call to the import is the closure owner's (L9) follow-up; until then this
// test is what keeps the two from drifting SILENTLY — by DRIVING the real route for every shipped def
// and reading back what the closure's own rule decided, never by comparing against a copy of the
// predicate (which would be a tautology). If L9 edits the inline rule, this goes red.
//
// Harness: the testing-author-route template — a real stub-engine `CoreAdapter` (the real workflow
// registry: built-ins + the qe author def; `launchRun` recorded, not run), `createServer` with a temp
// audit trail, `POST /runs {problem, clisJson, workflow, repoRef}` with NO `deliver`.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { isCodeWorkDef } from '../src/api/delivery-index.js';
import { DEFAULT_SETTINGS } from '../src/core/types.js';
import type { AuditEntry, LaunchRunInput, RepoEntry, SessionView, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const REPOS: RepoEntry[] = [{ id: 'repo-alpha', name: 'alpha', root_path: '/x/alpha', default_branch: 'main', registered_at: 1 }];
const SEATS = JSON.stringify([{ key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' }]);

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;
let auditPath: string;
const launches: LaunchRunInput[] = [];

function viewOf(input: LaunchRunInput): SessionView {
  return {
    session: {
      id: input.sessionId, workflow_id: input.workflow ?? 'wf-x', problem: input.problem, entity_mode: 'shared', collection_scope: null,
      clis: ['alpha'], status: 'executing', human_confirm: 'none', unit_ix: 1, attempt: 0, workdir: null,
      repo_ref: input.repoRef ?? null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'l8-launch-rule-'));
  auditPath = join(dir, 'audit.log');
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapter.listRepos = async () => REPOS;
  adapter.getSettings = async () => ({ ...DEFAULT_SETTINGS }); // deliverDefault at its default (not 'none')
  adapter.launchRun = async (input: LaunchRunInput) => {
    launches.push(input);
    return input.sessionId;
  };
  adapter.sessionsDetail = async () => launches.map(viewOf);
  app = await createServer(adapter, { auditPath });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  await app?.close();
  adapter?.close();
  removeScratch(dir);
});

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The trail once `pred` holds — appends are fire-and-forget on the log's own chain. */
async function trail(pred: (entries: AuditEntry[]) => boolean, ms = 5_000): Promise<AuditEntry[]> {
  const deadline = Date.now() + ms;
  let entries: AuditEntry[] = [];
  while (Date.now() < deadline) {
    try {
      entries = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
      if (pred(entries)) return entries;
    } catch {
      /* not flushed yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return entries;
}

describe('§4.8 — isCodeWorkDef equals the LIVE POST /runs deliver-default rule for every shipped def', () => {
  it('drives POST /runs per shipped def (no `deliver`) and reads the closure\'s decision off the run.launched trail', async () => {
    const shipped: WorkflowDef[] = adapter.listWorkflows();
    expect(shipped.map((w) => w.id)).toEqual(expect.arrayContaining(['feature', 'bug', 'onboarding', 'capture-learnings', 'qe-author-tests']));
    const decided: Array<{ id: string; deliver: unknown; defaulted: unknown }> = [];
    for (const def of shipped) {
      const { status, body } = await post('/api/v1/runs', {
        problem: `§4.8 launch-rule pin for ${def.id}`,
        clisJson: SEATS,
        workflow: def.id,
        repoRef: 'repo-alpha',
      });
      expect(status, `${def.id}: ${JSON.stringify(body)}`).toBe(201);
      const runId = body['runId'] as string;
      const isOurs = (e: AuditEntry) => e.action === 'run.launched' && e.runId === runId;
      const launched = (await trail((es) => es.some(isOurs))).filter(isOurs);
      expect(launched, `${def.id}: run.launched recorded`).toHaveLength(1);
      const detail = launched[0]!.detail as Record<string, unknown>;
      decided.push({ id: def.id, deliver: detail['deliver'], defaulted: detail['deliverDefaulted'] });
    }
    // THE PIN: the closure's inline rule decided 'pr' exactly for the defs isCodeWorkDef calls code work.
    expect(decided).toEqual(
      shipped.map((def) => ({ id: def.id, deliver: isCodeWorkDef(def) ? 'pr' : 'none', defaulted: true })),
    );
    // Sanity on the table itself (the des-review-L8 answer per def), so the pin cannot pass vacuously.
    const pr = decided.filter((d) => d.deliver === 'pr').map((d) => d.id).sort();
    expect(pr).toEqual(expect.arrayContaining(['feature', 'bug', 'migration', 'qe-author-tests']));
    expect(pr).not.toEqual(expect.arrayContaining(['onboarding']));
    expect(decided.find((d) => d.id === 'capture-learnings')?.deliver).toBe('none');
  }, 60_000);
});
