// wicked-core#1930 F6 on the REAL engine (`stub: false`), at crew's real entry points with auth required: a person
// saves `standInReview: 'always'` through `PUT /settings`, a workload (agent-kind) token launches a run through
// `POST /runs`, and the run's OWN record, the engine's `assurance.standIn` (wicked-core `src/assurance.rs`,
// `StandInConsent` in `src/standin.rs`), names the PERSON who saved the setting, not the token that launched it. The
// audit's `run.launched` still names the token. Under `ask` the same roster (short a judge) gets the stand-in choice
// and starts nothing: the token cannot consent for a person.
// stand-in-setting-consent.test.ts pins the same rule at the route, up to the engine call; this file pins the record
// the receipts and studio read.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { tokenHash } from '../../src/api/auth.js';
import type { AuditEntry } from '../../src/core/types.js';
import { registerDef } from '../support/register-def.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

const WF = 'stand-in-always-e2e-wf';
const SEATS = ['alpha', 'beta'];
const SEAT_CLI = `
process.stdout.write('did the work\\nVERDICT: PASS\\n');
process.exit(0);
`;
const TOKENS = { person: 'person-token-1', bot: 'bot-token-1', observer: 'obs-token-1' } as const;

let dir: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let priorSettings: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let cliPath: string;
let standInsSupported = false;
const launched: string[] = [];

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function phase(id: string, kind: 'build' | 'review', role: 'neutral' | 'evaluator', dependsOn: string[]): Record<string, unknown> {
  return {
    id, kind, gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [],
    depends_on: dependsOn, role, skill_ref: null, allowed_skills: [], validator_pin: null,
  };
}

const clisJson = (): string => JSON.stringify(SEATS.map((key) => ({ key, display_name: key, binary: process.execPath, headless_invocation: `${process.execPath} ${cliPath} {PROMPT}` })));

/** The workload token launches over POST /runs (no `standIns`: a token cannot consent); the run's contract is read back. */
async function botLaunch(runId: string): Promise<{ status: number; body: Record<string, unknown>; assurance: Record<string, unknown> | null }> {
  const res = await call('POST', '/api/v1/runs', TOKENS.bot, { problem: 'Build the thing, then review it.', sessionId: runId, workflow: WF, entityMode: 'shared', humanConfirm: 'all', clisJson: clisJson() });
  if (res.status !== 201) return { ...res, assurance: null };
  launched.push(runId);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { body } = await call('GET', `/api/v1/runs/${runId}`, TOKENS.observer);
    const run = body['run'] as { session: Record<string, unknown> } | undefined;
    const assurance = run?.session['assurance'] as Record<string, unknown> | undefined;
    if (assurance !== undefined) return { ...res, assurance };
    if (Date.now() > deadline) throw new Error(`${runId}: no contract on the run`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function lastLaunchAudit(): Promise<AuditEntry | undefined> {
  const { body } = await call('GET', '/api/v1/audit?action=run.launched&limit=1', TOKENS.observer);
  return (body['entries'] as AuditEntry[] | undefined)?.[0];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-standin-always-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  priorHome = process.env['HOME'];
  priorUserProfile = process.env['USERPROFILE'];
  priorSettings = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(dir, 'settings.json');
  cliPath = join(dir, 'seat-cli.mjs');
  writeFileSync(cliPath, SEAT_CLI);
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    SEATS.flatMap((key) => ['[[cli]]', `key = "${key}"`, `display_name = "${key}"`, `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${cliPath} {PROMPT}`)}`, '']).join('\n'),
  );
  writeFileSync(
    join(dir, 'tokens.json'),
    JSON.stringify({
      version: 1,
      tokens: [
        { sha256: tokenHash(TOKENS.person), actor: { id: 'priya', kind: 'human', trust: 'admin' } },
        { sha256: tokenHash(TOKENS.bot), actor: { id: 'ci-bot', kind: 'agent', trust: 'operator' } },
        { sha256: tokenHash(TOKENS.observer), actor: { id: 'watcher', kind: 'human', trust: 'observer' } },
      ],
    }),
  );
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: false });
  standInsSupported = adapter.supportsStandIns();
  baseSkillOff();
  app = await createServer(adapter, {
    auth: { mode: 'required', tokensPath: join(dir, 'tokens.json') },
    auditPath: join(dir, 'audit.log'),
    projectEvents: { disabled: true },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const wf = await registerDef(adapter, { id: WF, phases: [phase('build', 'build', 'neutral', []), phase('review', 'review', 'evaluator', ['build'])] });
  expect(wf.status, JSON.stringify(wf.body)).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  for (const id of launched) await call('POST', `/api/v1/runs/${id}/cancel`, TOKENS.person, {}).catch(() => undefined);
  await app.close();
  adapter.close();
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  if (priorSettings === undefined) delete process.env['WICKED_CREW_SYSTEM_SETTINGS'];
  else process.env['WICKED_CREW_SYSTEM_SETTINGS'] = priorSettings;
  removeScratch(dir);
});

describe("a workload token's launch under standInReview 'always' records the person on the engine's run (wicked-core#1930 F6)", () => {
  it("'always': the run's assurance.standIn names the person who saved it, and run.launched names the token", async (ctx) => {
    if (!standInsSupported) ctx.skip();
    const before = Date.now();
    const put = await call('PUT', '/api/v1/settings', TOKENS.person, { standInReview: 'always' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const r = await botLaunch('it-standin-always-1');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.assurance!['standInAware']).toBe(true);
    const consent = r.assurance!['standIn'] as Record<string, unknown> | undefined;
    expect(consent).toEqual({ scope: 'always', by: 'priya (human)', at: expect.any(Number), via: 'setting' });
    expect(consent!['at'] as number).toBeGreaterThanOrEqual(before);
    expect(String(consent!['by'])).not.toContain('ci-bot');

    const audit = await lastLaunchAudit();
    expect(audit?.actor).toEqual({ id: 'ci-bot', kind: 'agent', trust: 'operator' });
    expect(audit?.runId).toBe('it-standin-always-1');
  }, 60_000);

  it("'ask': the same roster's token launch gets the stand-in choice and starts nothing; the token cannot consent", async (ctx) => {
    if (!standInsSupported) ctx.skip();
    const put = await call('PUT', '/api/v1/settings', TOKENS.person, { standInReview: 'ask' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    // The two seats share one identity, so the engine's preflight is short a judge: only a person's consent launches.
    const r = await botLaunch('it-standin-ask-1');
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body['code']).toBe('stand_in_choice');
    expect((await call('GET', '/api/v1/runs/it-standin-ask-1', TOKENS.observer)).status).toBe(404);
    expect((await lastLaunchAudit())?.runId).toBe('it-standin-always-1');
    // A workload token's own consent is refused (auth-required.test.ts pins the 403 too).
    const own = await call('POST', '/api/v1/runs', TOKENS.bot, { problem: 'p', sessionId: 'it-standin-ask-2', workflow: WF, standIns: true, clisJson: clisJson() });
    expect(own.status, JSON.stringify(own.body)).toBe(403);
  }, 60_000);
});
