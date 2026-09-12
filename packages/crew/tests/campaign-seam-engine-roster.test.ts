// F-086 — the CAMPAIGN seam translates roster standing for the engine, the way `launchRun` already
// does (wave 6, `core/engine-roster.ts`). `POST /testing/recon` builds its `CampaignDef` from
// `rosterWithStanding()`, so every node's `run_spec.clis` carried crew's `health {status}` / `auth`
// / `council_eligible` readings; core-ts ≥ 0.7.22 (wicked-core#449) parses `AgenticCli.health` as
// `{usable, reason?}` and refused the def ("defJson is not a valid CampaignDef: missing field
// `usable`") — a 500 where a 201 was owed. `CoreAdapter.launchCampaign` used to `JSON.stringify(def)`
// verbatim.
//
// Three layers, each pinned here:
//   - `engineCampaignDef` (pure): every node's seats translated, nothing else touched, the caller's
//     def not mutated;
//   - `CoreAdapter.launchCampaign` (the seam): the JSON the ENGINE receives is the translated def — a
//     fake napi `launchCampaign` captures it (an own property shadowing the prototype method, the
//     deliver-launch.test.ts technique), so the assertion is about crew's seam, not the engine;
//   - `POST /campaigns` (the route): its default roster now carries crew's standing (F-086 parity
//     with POST /runs and POST /testing/recon), and the def the engine receives benches exactly the
//     seats the daemon's own GET /roster reports ineligible.
//
// The end-to-end proof against a REAL engine is tests/integration/recon-fanout-campaign.test.ts
// (201 on core-ts ≥ 0.7.22).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { CREW_ONLY_SEAT_FIELDS, engineCampaignDef } from '../src/core/engine-roster.js';
import type { CampaignDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const registrySeat = {
  key: 'codex',
  display_name: 'Codex',
  binary: 'codex',
  enabled_for_council: true,
  headless_invocation: 'codex {PROMPT}',
  login_invocation: 'codex login',
};

// The shapes `GET /roster` (`rosterWithStanding()`) serves — crew's readings on a registry seat.
const signedOutCodex = {
  ...registrySeat,
  health: { status: 'active', since: '2026-09-11T00:00:00Z' },
  signed_in: false,
  auth: 'signed_out',
  council_eligible: false,
  council_ineligible_reason: 'signed out — a council would bench this seat on its first ballot; sign it in from the System page',
};
const signedInClaude = {
  ...registrySeat,
  key: 'claude',
  display_name: 'Claude',
  binary: 'claude',
  health: { status: 'active', since: '2026-09-11T00:00:00Z' },
  signed_in: true,
  auth: 'signed_in',
  council_eligible: true,
};
const benchedPi = {
  ...registrySeat,
  key: 'pi',
  display_name: 'Pi',
  binary: 'pi',
  health: { status: 'active', since: '2026-09-11T00:00:00Z' },
  signed_in: true,
  auth: 'signed_in',
  council_eligible: false,
  council_ineligible_reason: 'benched by this daemon’s recent councils: 2 ballot failures in the last 1 min — last timed_out; an ok unit output clears it',
  council_bench: { failures: 2, last_kind: 'timed_out', last_at: '2026-09-11T00:00:00Z', window_ms: 60_000 },
};
/** A seat with NO standing at all (a raw registry seat, the pre-F-086 `POST /campaigns` roster). */
const plainOpencode = { ...registrySeat, key: 'opencode', display_name: 'OpenCode', binary: 'opencode' };

/** A recon-shaped def: two agent nodes, each with its own seat list, plus every non-roster field. */
function decoratedDef(): CampaignDef {
  return {
    id: 'camp-f086',
    name: 'F-086 recon fan',
    policy: 'continue_independent',
    max_concurrency: 2,
    edges: [{ from: 'a', to: 'b', condition: 'on_success' }],
    nodes: [
      {
        node_id: 'a',
        run_spec: { problem: 'survey alpha', clis: [signedOutCodex, signedInClaude], entity_mode: 'shared', repo_ref: 'alpha' },
      },
      {
        node_id: 'b',
        run_spec: {
          problem: 'survey beta',
          clis: [benchedPi, plainOpencode],
          entity_mode: 'shared',
          repo_ref: 'beta',
          workflow_id: 'campaign-camp-f086-b',
        },
      },
    ],
  };
}

function seatsOf(def: CampaignDef, node: number): Array<Record<string, unknown>> {
  return def.nodes[node]!.run_spec.clis as Array<Record<string, unknown>>;
}

function expectNoCrewReadings(seat: Record<string, unknown>): void {
  for (const k of CREW_ONLY_SEAT_FIELDS) {
    if (k !== 'health') expect(k in seat, `${String(seat['key'])}: ${k} must not reach the engine`).toBe(false);
  }
}

/** Shadow the napi campaign bindings with own properties: `launchCampaign` captures the def JSON
 *  the ENGINE receives; the other four exist so `CoreAdapter._campaigns()` sees a full surface on
 *  any installed addon (a benign answer each — none is exercised here). */
function stubCampaignBindings(a: CoreAdapter, onLaunch: (defJson: string) => Promise<string>): void {
  const core = (a as unknown as { core: Record<string, unknown> }).core;
  core['launchCampaign'] = onLaunch;
  core['resumeCampaign'] = () => Promise.resolve('running');
  core['cancelCampaign'] = () => Promise.resolve('cancelled');
  core['campaignDetail'] = () => Promise.resolve('null');
  core['campaignList'] = () => Promise.resolve('[]');
}

describe('engineCampaignDef (pure)', () => {
  it('translates EVERY node roster: crew readings stripped, council_eligible → the engine bench verdict, a plain seat untouched', () => {
    const out = engineCampaignDef(decoratedDef());
    const a = seatsOf(out, 0);
    const b = seatsOf(out, 1);
    for (const seat of [...a, ...b]) expectNoCrewReadings(seat);
    expect(a[0]!['health']).toEqual({ usable: false, reason: 'signed out' });
    expect(a[1]!['health']).toEqual({ usable: true });
    expect(b[0]!['health']).toEqual({ usable: false, reason: 'benched by recent councils (2 timed out)' });
    // Registry fields survive verbatim.
    expect(a[0]!['login_invocation']).toBe('codex login');
    expect(a[0]!['headless_invocation']).toBe('codex {PROMPT}');
    // A seat with no standing passes through unchanged — nothing stamped, the engine decides.
    expect(b[1]).toEqual(plainOpencode);
    expect('health' in b[1]!).toBe(false);
  });

  it('leaves every non-roster field of the def and its nodes verbatim (only `clis` is replaced)', () => {
    const input = decoratedDef();
    const out = engineCampaignDef(input);
    expect(out).toEqual({
      ...input,
      nodes: input.nodes.map((n) => ({ ...n, run_spec: { ...n.run_spec, clis: expect.any(Array) as unknown[] } })),
    });
    expect(out.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
  });

  it('does not mutate the caller’s def — the route reads it after the launch', () => {
    const input = decoratedDef();
    const before = JSON.stringify(input);
    const out = engineCampaignDef(input);
    expect(JSON.stringify(input)).toBe(before);
    // Fresh containers all the way down to the seat list; the seats themselves are new objects.
    expect(out).not.toBe(input);
    expect(out.nodes).not.toBe(input.nodes);
    expect(out.nodes[0]!.run_spec).not.toBe(input.nodes[0]!.run_spec);
    expect(out.nodes[0]!.run_spec.clis).not.toBe(input.nodes[0]!.run_spec.clis);
    expect(seatsOf(out, 0)[0]).not.toBe(seatsOf(input, 0)[0]);
    // The caller's seats still carry crew's readings.
    expect(seatsOf(input, 0)[0]!['council_eligible']).toBe(false);
    expect(seatsOf(input, 0)[0]!['health']).toEqual({ status: 'active', since: '2026-09-11T00:00:00Z' });
  });

  it('a node whose clis is not an array passes through so the engine reports its own reject', () => {
    const input = decoratedDef();
    (input.nodes[0]!.run_spec as { clis: unknown }).clis = 'garbage';
    const out = engineCampaignDef(input);
    expect((out.nodes[0]!.run_spec as { clis: unknown }).clis).toBe('garbage');
    // The other node is still translated.
    expect(seatsOf(out, 1)[0]!['health']).toEqual({ usable: false, reason: 'benched by recent councils (2 timed out)' });
  });
});

describe('CoreAdapter.launchCampaign (the seam)', () => {
  let dir: string;
  let adapter: CoreAdapter;
  const received: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'campaign-seam-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    stubCampaignBindings(adapter, (defJson) => {
      received.push(defJson);
      return Promise.resolve((JSON.parse(defJson) as CampaignDef).id);
    });
  });

  afterAll(() => {
    adapter.close();
    removeScratch(dir);
  });

  it('hands the ENGINE the translated def and leaves the caller’s def as built', async () => {
    const input = decoratedDef();
    const before = JSON.stringify(input);
    expect(await adapter.launchCampaign(input)).toBe('camp-f086');
    expect(received).toHaveLength(1);
    const wire = JSON.parse(received[0]!) as CampaignDef;
    // Byte-for-byte what the pure translation says (no `undefined` fields in the def, so the JSON
    // round-trip is lossless).
    expect(wire).toEqual(engineCampaignDef(input));
    const a = seatsOf(wire, 0);
    const b = seatsOf(wire, 1);
    for (const seat of [...a, ...b]) expectNoCrewReadings(seat);
    expect(a[0]!['health']).toEqual({ usable: false, reason: 'signed out' });
    expect(a[1]!['health']).toEqual({ usable: true });
    expect(b[0]!['health']).toEqual({ usable: false, reason: 'benched by recent councils (2 timed out)' });
    expect(b[1]).toEqual(plainOpencode);
    // Non-roster fields reached the engine untouched.
    expect(wire.edges).toEqual([{ from: 'a', to: 'b', condition: 'on_success' }]);
    expect(wire.nodes[1]!.run_spec.workflow_id).toBe('campaign-camp-f086-b');
    expect(wire.max_concurrency).toBe(2);
    // The caller's def is untouched — the route records/answers from it after this call.
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('POST /campaigns receives the roster WITH standing (F-086 parity), translated at the seam', () => {
  let dir: string;
  let adapter: CoreAdapter;
  let app: Awaited<ReturnType<typeof createServer>>;
  let baseUrl: string;
  const received: string[] = [];
  let priorInherit: string | undefined;

  beforeAll(async () => {
    // The signed-in probe reads the HERMETIC worker home (tests/setup/hermetic-home.ts) — empty, so
    // every credentialed seat reads `signed_out` and is benched. Pin that reading by NOT inheriting
    // the operator's own CLI homes (the one hatch that would make it depend on this machine).
    priorInherit = process.env['WICKED_WORKER_INHERIT_OPERATOR_CONFIG'];
    delete process.env['WICKED_WORKER_INHERIT_OPERATOR_CONFIG'];
    dir = mkdtempSync(join(tmpdir(), 'campaign-seam-route-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    stubCampaignBindings(adapter, (defJson) => {
      received.push(defJson);
      return Promise.resolve((JSON.parse(defJson) as CampaignDef).id);
    });
    app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await app.close();
    adapter.close();
    removeScratch(dir);
    if (priorInherit !== undefined) process.env['WICKED_WORKER_INHERIT_OPERATOR_CONFIG'] = priorInherit;
  });

  async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('the def the ENGINE receives benches exactly the seats GET /roster reports ineligible, with no crew reading on any seat', async () => {
    const rosterRes = await fetch(`${baseUrl}/api/v1/roster`);
    const { roster } = (await rosterRes.json()) as { roster: Array<Record<string, unknown>> };
    expect(roster.length).toBeGreaterThan(0);
    // Every served seat has a standing verdict — the field the raw registry roster never carried.
    for (const seat of roster) expect(typeof seat['council_eligible'], `${String(seat['key'])} standing`).toBe('boolean');
    const benched = roster.filter((s) => s['council_eligible'] === false).map((s) => s['key']);
    expect(benched, 'the hermetic worker home holds no codex credential, so codex reads signed out').toContain('codex');

    received.length = 0;
    const res = await post('/api/v1/campaigns', {
      id: 'camp-standing',
      scenarios: [{ id: 'n', agent: { problem: 'survey the repo' } }],
    });
    expect(res.status).toBe(201);
    expect(res.body['campaignId']).toBe('camp-standing');
    expect(received).toHaveLength(1);
    const wire = JSON.parse(received[0]!) as CampaignDef;
    const seats = seatsOf(wire, 0);
    expect(seats.map((s) => s['key'])).toEqual(roster.map((s) => s['key']));
    for (const seat of seats) {
      expectNoCrewReadings(seat);
      const standing = roster.find((s) => s['key'] === seat['key'])!;
      const health = seat['health'] as { usable?: unknown; reason?: unknown };
      expect(health.usable, `${String(seat['key'])} bench verdict mirrors council_eligible`).toBe(standing['council_eligible']);
      if (health.usable === false) expect(typeof health.reason, `${String(seat['key'])} names its bench reason`).toBe('string');
    }
    const codex = seats.find((s) => s['key'] === 'codex')!;
    expect(codex['health']).toEqual({ usable: false, reason: 'signed out' });
  });

  it('a caller-supplied clisJson (the studio round-tripping GET /roster seats) is translated at the seam too', async () => {
    received.length = 0;
    const res = await post('/api/v1/campaigns', {
      id: 'camp-clisjson',
      scenarios: [{ id: 'n', agent: { problem: 'survey the repo' } }],
      clisJson: JSON.stringify([signedOutCodex, signedInClaude, plainOpencode]),
    });
    expect(res.status).toBe(201);
    const seats = seatsOf(JSON.parse(received[0]!) as CampaignDef, 0);
    for (const seat of seats) expectNoCrewReadings(seat);
    expect(seats[0]!['health']).toEqual({ usable: false, reason: 'signed out' });
    expect(seats[1]!['health']).toEqual({ usable: true });
    expect(seats[2]).toEqual(plainOpencode);
  });
});
