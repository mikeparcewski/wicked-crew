// Wave 6 acceptance findings on the roster / chat seam:
//
// F-A45-006 — a seat's `auth` must come from a credential PROBE, and the seat's OWN words override
// it. The fresh rig's pi `auth.json` was `{}` and every ballot failed "No API key found" while the
// roster read `auth: 'signed_in'` off the file's presence. The probe half lives in
// seat-signin.test.ts (a credential-SHAPED file); this file pins the FOLD half: the seat-health
// tracker records the seat's own "no credential" report (ballot / worker / ACP) and `seatStanding`
// flips `auth` (not only `council_eligible`), with the evidence on the wire.
//
// F-A45-011 — every requested-or-defaulted seat a chat did NOT seat is named on the 201, on
// GET /chats/:id, and as one thread frame, with a `source` — including a seat the ENGINE dropped at
// dispatch (absent from `seats` altogether), which #533's admission list never saw.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatScopeIndex } from '../src/api/chat-scope.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { AUTH_FAILURE_WINDOW_MS, SeatHealthTracker, isAuthRefusal } from '../src/api/seat-health.js';
import { chatSeatAdmission, seatStanding } from '../src/api/seat-standing.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;
const ACTIVE = { status: 'active' as const, since: '2026-09-11T00:00:00.000Z' };

describe('the seat-health fold records the seat’s OWN "no credential" report (F-A45-006)', () => {
  it('a council ballot lost to not_logged_in / "No API key found" sets the auth failure, with the seat’s words', () => {
    const t = new SeatHealthTracker();
    t.ingest(ev({ type: 'councilSeatFailed', session: 'r-1', cli: 'pi', kind: 'not_logged_in', detail: 'Error: No API key found for anthropic. Run /login.' }));
    const f = t.authFailureFor('pi');
    expect(f).not.toBeNull();
    expect(f).toMatchObject({ source: 'ballot', run: 'r-1' });
    expect(f!.detail).toContain('No API key found');
    // A benched-kind ballot whose stderr says "No API key" counts too (the kind is the engine's
    // classification; the words are the seat's).
    const t2 = new SeatHealthTracker();
    t2.ingest(ev({ type: 'councilSeatFailed', session: 'r-2', cli: 'codex', kind: 'non_zero_exit', stderr: 'codex: Not logged in. Run `codex login`.' }));
    expect(t2.authFailureFor('codex')?.source).toBe('ballot');
    // An unrelated ballot failure is NOT an auth failure.
    const t3 = new SeatHealthTracker();
    t3.ingest(ev({ type: 'councilSeatFailed', session: 'r-3', cli: 'codex', kind: 'timed_out', detail: 'ballot timed out after 40s' }));
    expect(t3.authFailureFor('codex')).toBeNull();
  });

  it('a worker failure naming the credential, and an authentication ACP fallback, set it too', () => {
    const t = new SeatHealthTracker();
    t.ingest(ev({ type: 'unitDistributed', session: 'r-4', ord: 1, cli: 'pi', routing_method: 'council' }));
    t.ingest(ev({ type: 'stepFailed', session: 'r-4', ord: 1, attempt: 0, failureKind: 'workerError', detail: '(cli `pi` exited 1) No API key found for anthropic' }));
    expect(t.authFailureFor('pi')).toMatchObject({ source: 'worker', run: 'r-4' });
    for (const kind of ['auth_failed', 'unauthenticated', 'auth_required']) {
      const tt = new SeatHealthTracker();
      tt.ingest(ev({ type: 'acpFallback', session: 'r-5', cliKey: 'pi', fallbackKind: kind, reason: 'pi-acp answered 401' }));
      expect(tt.authFailureFor('pi')).toMatchObject({ source: 'acp', detail: 'pi-acp answered 401' });
    }
    // A transport fallback is not an auth failure.
    const t6 = new SeatHealthTracker();
    t6.ingest(ev({ type: 'acpFallback', session: 'r-6', cliKey: 'pi', fallbackKind: 'session_died', reason: 'bridge exited 0' }));
    expect(t6.authFailureFor('pi')).toBeNull();
  });

  it('an ok unit output clears it (the seat proved it can work), and it ages out after the window', () => {
    const t = new SeatHealthTracker();
    const at = 1_000_000;
    t.ingest(ev({ type: 'councilSeatFailed', session: 'r-7', cli: 'pi', kind: 'not_logged_in', detail: 'No API key found', ts: at }));
    expect(t.authFailureFor('pi', at + 1)).not.toBeNull();
    expect(t.authFailureFor('pi', at + AUTH_FAILURE_WINDOW_MS + 1)).toBeNull();
    t.ingest(ev({ type: 'councilSeatFailed', session: 'r-7', cli: 'pi', kind: 'not_logged_in', detail: 'No API key found', ts: at }));
    t.ingest(ev({ type: 'unitDistributed', session: 'r-8', ord: 1, cli: 'pi', routing_method: 'council' }));
    t.ingest(ev({ type: 'unitOutputCaptured', session: 'r-8', ord: 1, attempt: 0, outputBytes: 10, stepStatus: 'ok', governed: true, ts: at + 5 }));
    expect(t.authFailureFor('pi', at + 6)).toBeNull();
  });

  it('isAuthRefusal knows the fresh-rig shapes and nothing else', () => {
    for (const s of ['No API key found', 'Not logged in', 'HTTP 401 Unauthorized', 'unauthenticated', 'Please sign in', 'invalid api key', 'authentication failed', 'missing API key', 'missing credentials']) {
      expect(isAuthRefusal(s), s).toBe(true);
    }
    // A 401 counts only as an HTTP STATUS (review M-3 of #536)…
    for (const s of ['HTTP/1.1 401', 'request failed: HTTP 401', 'status: 401', 'status code 401', 'status=401', '401 Unauthorized', '401 unauthorised']) {
      expect(isAuthRefusal(s), s).toBe(true);
    }
    for (const s of ['timeout waiting for response', 'rate limit exceeded', 'exit 137', 'the deliverable was not written']) {
      expect(isAuthRefusal(s), s).toBe(false);
    }
    // …never as a bare number: stack-trace line/column numbers, byte counts, ports, issue numbers.
    for (const s of ['    at run (src/foo.ts:401:12)', 'Error at /w/pkg/index.js:401', 'read 401 bytes', 'listening on port 401', 'closes #401', 'exit code 1 after 401 ms']) {
      expect(isAuthRefusal(s), s).toBe(false);
    }
  });
});

describe('seatStanding — the seat’s own report overrides the probe (F-A45-006)', () => {
  const failure = { at: '2026-09-11T00:00:00.000Z', detail: 'No API key found for anthropic', source: 'ballot' as const, run: 'r-1' };

  it('signed_in by the file probe, but the seat said it has no credential → signed_out, sourced, evidenced, council-ineligible', () => {
    const s = seatStanding({ key: 'pi' }, true, ACTIVE, null, failure);
    expect(s).toMatchObject({
      auth: 'signed_out',
      auth_source: 'seat-stderr',
      auth_evidence: 'No API key found for anthropic',
      council_eligible: false,
    });
    expect(s.council_ineligible_reason).toMatch(/the seat itself reported no credential \(ballot: No API key found/);
    // Without the report the probe decides exactly as before.
    expect(seatStanding({ key: 'pi' }, true, ACTIVE)).toMatchObject({ auth: 'signed_in', council_eligible: true });
    expect(seatStanding({ key: 'pi' }, true, ACTIVE).auth_source).toBeUndefined();
  });

  it('a free-tier seat that itself says "No API key" is NOT on its free tier', () => {
    const s = seatStanding({ key: 'opencode' }, false, ACTIVE, null, failure);
    expect(s.auth).toBe('signed_out');
    expect(s.free_tier).toBeUndefined();
    expect(seatStanding({ key: 'opencode' }, false, ACTIVE).auth).toBe('not_required');
  });

  it('chatSeatAdmission names the cause class: auth before scope', () => {
    expect(chatSeatAdmission({ key: 'pi', acp: { acp_input_governance: false } }, 'signed_out', true)).toMatchObject({ ok: false, source: 'auth' });
    expect(chatSeatAdmission({ key: 'pi', acp: { acp_input_governance: false } }, 'signed_in', true)).toMatchObject({ ok: false, source: 'scope' });
    expect(chatSeatAdmission({ key: 'pi' }, 'signed_out', false)).toMatchObject({ ok: false, source: 'auth' });
    expect(chatSeatAdmission({ key: 'claude', acp: { acp_input_governance: true } }, 'signed_in', true)).toEqual({ ok: true });
  });
});

// ── Route level: the roster and the chat over a fake engine ────────────────────────────────────

describe('GET /roster + POST /chats with the seat’s own evidence (F-A45-006 / F-A45-011)', () => {
  let base: string;
  let app: FastifyInstance;
  let seatHealth: SeatHealthTracker;
  let chatScopes: ChatScopeIndex;
  let broadcast: unknown[];
  /** What the fake engine seats: by default every requested seat, warm. */
  let seatsOf: (clis: string[]) => Array<{ cliKey: string; ok: boolean; error?: string }>;
  let signedIn: (seatKey: string) => boolean | null;
  const savedWorkerHome = process.env['WICKED_WORKER_HOME'];

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'seat-auth-wave6-'));
    writeFileSync(join(base, 'graph.db'), '');
    seatHealth = new SeatHealthTracker();
    chatScopes = new ChatScopeIndex(join(base, 'chats'));
    broadcast = [];
    seatsOf = (clis) => clis.map((c) => ({ cliKey: c, ok: true }));
    // The fresh rig: every credential file "present" — the probe says signed in for everyone.
    signedIn = () => true;
    vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      { key: 'claude', display_name: 'Claude', binary: 'claude', enabled_for_council: true, acp: { acp_input_governance: true, os_sandbox: false } },
      { key: 'pi', display_name: 'Pi', binary: 'pi', enabled_for_council: true, acp: { acp_input_governance: true, os_sandbox: false } },
      { key: 'opencode', display_name: 'OpenCode', binary: 'opencode', enabled_for_council: true, acp: { acp_input_governance: true, os_sandbox: false } },
    ]);
    const adapter = {
      listRepos: async () => [{ id: 'r1', name: 'alpha', root_path: '/srv/repos/alpha', default_branch: 'main', registered_at: 1, code_graph_db: join(base, 'graph.db') }],
      chatOpen: async (_id: string, clis: string[]) => seatsOf(clis),
      chatScopeApplied: async () => true,
      chatSeats: async () => ['claude', 'opencode'],
      chatClose: async () => undefined,
    } as unknown as CoreAdapter;
    app = Fastify({ logger: false });
    registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, undefined, {
      seatHealth,
      chatScopes,
      signedIn: (seatKey) => signedIn(seatKey),
      broadcast: (frame) => broadcast.push(frame),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    if (savedWorkerHome === undefined) delete process.env['WICKED_WORKER_HOME'];
    else process.env['WICKED_WORKER_HOME'] = savedWorkerHome;
    rmSync(base, { recursive: true, force: true });
  });

  type Seat = { key: string; auth: string; auth_source?: string; auth_evidence?: string; council_eligible: boolean; council_ineligible_reason?: string };
  const roster = async (): Promise<Seat[]> => ((await app.inject({ method: 'GET', url: '/api/v1/roster' })).json() as { roster: Seat[] }).roster;
  const open = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/chats', payload: body });
  type Refusal = { cliKey: string; reason: string; source: string };

  it('the roster flips pi to signed_out — sourced to the seat’s stderr — once a ballot said "No API key found", although the file probe still says signed in', async () => {
    expect((await roster()).find((s) => s.key === 'pi')).toMatchObject({ auth: 'signed_in', council_eligible: true });
    seatHealth.ingest(ev({ type: 'councilSeatFailed', session: 'run-1', cli: 'pi', kind: 'not_logged_in', detail: 'Error: No API key found for anthropic. Run /login.' }));
    const pi = (await roster()).find((s) => s.key === 'pi')!;
    expect(pi.auth).toBe('signed_out');
    expect(pi.auth_source).toBe('seat-stderr');
    expect(pi.auth_evidence).toContain('No API key found');
    expect(pi.council_eligible).toBe(false);
    expect(pi.council_ineligible_reason).toMatch(/reported no credential/);
    // claude and opencode are untouched.
    expect((await roster()).filter((s) => s.key !== 'pi').every((s) => s.auth === 'signed_in' && s.council_eligible)).toBe(true);
  });

  it('a seat the ENGINE dropped at dispatch is named in refused (source budget), on the 201, on GET /chats/:id, and in the thread — the fresh-rig gap', async () => {
    // Default chips claude·pi·opencode, scoped; the engine warms claude + opencode and simply omits pi.
    seatsOf = (clis) => clis.filter((c) => c !== 'pi').map((c) => ({ cliKey: c, ok: true }));
    const res = await open({ chatId: 'proj-chat', repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { seats: Array<{ cliKey: string }>; refused: Refusal[] };
    expect(body.seats.map((s) => s.cliKey)).toEqual(['claude', 'opencode']);
    expect(body.refused).toHaveLength(1);
    expect(body.refused[0]).toMatchObject({ cliKey: 'pi', source: 'budget' });
    expect(body.refused[0]!.reason).toMatch(/did not warm it within its dispatch budget/);
    // …GET /chats/:id carries the same list…
    const detail = (await app.inject({ method: 'GET', url: '/api/v1/chats/proj-chat' })).json() as { refused: Refusal[] | null };
    expect(detail.refused).toEqual(body.refused);
    // …and the thread got one frame, with the source.
    expect(broadcast).toEqual([{ type: 'chatSeatRefused', chat: 'proj-chat', cliKey: 'pi', reason: body.refused[0]!.reason, source: 'budget' }]);
  });

  it('the dropped seat’s cause is the most specific the daemon knows: its own "no credential" report (auth) beats the bench, the bench beats the budget', async () => {
    seatsOf = (clis) => clis.filter((c) => c !== 'pi').map((c) => ({ cliKey: c, ok: true }));
    // An EXPLICIT clis list (the studio's default chips are sent explicitly) bypasses admission —
    // the drop is only visible after the engine answered.
    seatHealth.ingest(ev({ type: 'councilSeatFailed', session: 'run-2', cli: 'pi', kind: 'timed_out', detail: 'ballot timed out' }));
    seatHealth.ingest(ev({ type: 'councilSeatFailed', session: 'run-3', cli: 'pi', kind: 'timed_out', detail: 'ballot timed out' }));
    const benched = (await open({ chatId: 'bench-chat', clis: ['claude', 'pi', 'opencode'] })).json() as { refused: Refusal[] };
    expect(benched.refused[0]).toMatchObject({ cliKey: 'pi', source: 'bench' });
    expect(benched.refused[0]!.reason).toMatch(/benched by this daemon/);
    seatHealth.ingest(ev({ type: 'councilSeatFailed', session: 'run-4', cli: 'pi', kind: 'not_logged_in', detail: 'No API key found for anthropic' }));
    const auth = (await open({ chatId: 'auth-chat', clis: ['claude', 'pi', 'opencode'] })).json() as { refused: Refusal[] };
    expect(auth.refused[0]).toMatchObject({ cliKey: 'pi', source: 'auth' });
    expect(auth.refused[0]!.reason).toMatch(/reported no credential \(ballot: No API key found/);
  });

  it('a DEFAULT seat the roster already reads signed out is refused up front with source auth, and never handed to the engine', async () => {
    seatHealth.ingest(ev({ type: 'councilSeatFailed', session: 'run-5', cli: 'pi', kind: 'not_logged_in', detail: 'No API key found' }));
    const handed: string[][] = [];
    seatsOf = (clis) => {
      handed.push(clis);
      return clis.map((c) => ({ cliKey: c, ok: true }));
    };
    const res = await open({ chatId: 'dflt-chat' });
    expect(res.statusCode).toBe(201);
    expect(handed).toEqual([['claude', 'opencode']]);
    const body = res.json() as { refused: Refusal[] };
    expect(body.refused).toEqual([expect.objectContaining({ cliKey: 'pi', source: 'auth' })]);
  });
});
