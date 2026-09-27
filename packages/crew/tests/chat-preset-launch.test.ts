// DES-TEAMING-002 §14 M3 — `chat` is the engine's built-in PRESET, not a crew def.
//
// Studio's chat surface launches `POST /runs {workflow: 'chat'}` (`workflowOverride: 'chat'`). That
// body is unchanged; what answers it moved: crew deleted its `chat` mirror and `workflows/chat.json`,
// and the engine resolves the name as its built-in preset (explore → catalog `understand`). This
// pins, over the REAL engine (stub runner), that the same launch:
//   - plans the C1(a) unit list for chat — one `explore` unit, catalog `understand`, recon, neutral,
//     read-only — and NO `pa-scope` step: chat has no creator step, so the PA does not scope it (X1),
//     and the plan is decided at launch (score 0, empty floor, never high risk);
//   - is served as a SYSTEM preset run (`run_identity`), named `chat`, so every surface that kept
//     chat off delivery still does; `GET /presets` carries `system: true` for it, and
//     `GET /workflows` no longer lists a `chat` def;
//   - evaluator ≠ creator (§11.3): chat has no evaluator unit, so a ONE-seat roster launches and
//     plans — nothing needs a distinct seat, so nothing is refused `NoEligibleSeat`.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, engineSupportsPlanLaunch } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type { Preset, SessionView, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';
import { baseSkillOff } from './setup/base-skill-off.js';

const ONE_SEAT = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

const probeDir = mkdtempSync(join(tmpdir(), 'chat-preset-probe-'));
const probe = new CoreAdapter({ dbPath: join(probeDir, 'core.db'), stub: true });
const ENGINE_HAS_PLANS = probe.presetsSupported() && engineSupportsPlanLaunch();
probe.close();
removeScratch(probeDir);

describe.skipIf(!ENGINE_HAS_PLANS)('M3: POST /runs {workflow:"chat"} launches the built-in chat preset', () => {
  let dir: string;
  let adapter: CoreAdapter;
  let app: Awaited<ReturnType<typeof createServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    baseSkillOff(); // run mechanics, not grounding (tests/setup/base-skill-off.ts)
    dir = mkdtempSync(join(tmpdir(), 'chat-preset-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await app?.close();
    adapter?.close();
    if (dir) removeScratch(dir);
  });

  it('plans explore → understand with no scope step, served as a system preset run', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ problem: 'what does this module do?', workflow: 'chat', clisJson: ONE_SEAT }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { runId } = (await res.json()) as { runId: string };

    let view: SessionView | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const r = await fetch(`${baseUrl}/api/v1/runs/${runId}`);
      if (r.status === 200) view = ((await r.json()) as { run: SessionView }).run;
      if (view !== undefined && view.units.length > 0) break;
      await new Promise((r2) => setTimeout(r2, 50));
    }
    expect(view?.units.length, 'the chat run planned its unit').toBeGreaterThan(0);
    const session = view!.session;

    // The C1(a) unit list for chat, and no `pa-scope`: not a creator plan.
    expect(view!.units.map((u) => [u.ord, u.id.slice(runId.length + 1), u.catalog, u.stage, u.role, u.executes_code === true])).toEqual([
      [1, 'explore', 'understand', 'recon', 'neutral', false],
    ]);
    const plan = session.team_plan;
    expect(plan?.preset).toBe('chat');
    expect(plan?.scope ?? null).toBeNull();
    expect(plan?.accepted_rev).toBe(1);

    // Served as the system preset it replaced a def for.
    expect(session.run_identity).toMatchObject({ kind: 'preset', name: 'chat', system: true });
    expect(session.workflow_id).toBe('chat');
    // Evaluator ≠ creator: a one-seat roster, and nothing refused for want of a distinct seat.
    expect(session.clis).toEqual(['alpha']);
    expect(view!.units.some((u) => u.role === 'evaluator')).toBe(false);
  });

  it('GET /presets serves chat as a system built-in; GET /workflows lists no chat def', async () => {
    const presets = ((await (await fetch(`${baseUrl}/api/v1/presets`)).json()) as { presets: Preset[] }).presets;
    const chat = presets.find((p) => p.name === 'chat');
    expect(chat).toMatchObject({ scope: 'global', created_by: 'builtin', system: true });
    expect(chat?.steps.map((s) => `${s.catalog}:${s.id}`)).toEqual(['understand:explore']);
    const workflows = ((await (await fetch(`${baseUrl}/api/v1/workflows`)).json()) as { workflows: WorkflowDef[] }).workflows;
    expect(workflows.map((w) => w.id)).not.toContain('chat');
  });
});
