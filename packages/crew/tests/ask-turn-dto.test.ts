// crew#854: an ask's run that has answered parks at its TURN gate (the answer step's HumanConfirm,
// DES-ASK-TEAM-CHAT-001 §4.7) — the chat's next message answers it. The run DTO says so
// (`ask_path`, `ask_turn`), live and after a restart (the `run.launched` entry's `askPath`), so a
// skin counts it as nothing needing you; any other gate on an ask's run stays a real gate.

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAskTurn } from '../src/api/ask-paths.js';
import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { RunTimingIndex, recordRunLaunched } from '../src/api/run-timing-index.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { removeScratch } from './setup/scratch.js';

const unit = (runId: string, step: string, ord: number, status = 'done') => ({ id: `${runId}:${step}`, ord, status });
const view = (id: string, status: string, units: Array<{ id: string; ord: number; status: string }>): SessionView =>
  ({
    session: { id, workflow_id: `${id}:plan-1`, problem: 'q', entity_mode: 'shared', collection_scope: null, clis: ['claude'], status, human_confirm: 'none', unit_ix: 1, attempt: 0, workdir: `/wt/${id}`, repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null },
    units,
  }) as unknown as SessionView;

describe('isAskTurn', () => {
  it('awaiting_human with every unit an answer step and none distributed', () => {
    expect(isAskTurn(view('r.1', 'awaiting_human', [unit('r.1', 'answer-1', 0), unit('r.1', 'answer-2', 1)]))).toBe(true);
    expect(isAskTurn(view('r.1', 'executing', [unit('r.1', 'answer-1', 0)]))).toBe(false);
    expect(isAskTurn(view('r.1', 'awaiting_human', []))).toBe(false);
    expect(isAskTurn(view('r.1', 'awaiting_human', [unit('r.1', 'answer-1', 0), unit('r.1', 'build-1', 1, 'pending')])), 'Continue in Build').toBe(false);
    expect(isAskTurn(view('r.1', 'awaiting_human', [unit('r.1', 'answer-1', 0, 'distributed')]))).toBe(false);
    // The run id is matched literally (a `.` is not "any character").
    expect(isAskTurn(view('r.1', 'awaiting_human', [unit('rx1', 'answer-1', 0)]))).toBe(false);
  });
});

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) removeScratch(d);
});

async function build(audit: AuditLog, views: SessionView[]): Promise<FastifyInstance> {
  const adapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
  } as unknown as CoreAdapter;
  const runTimingIndex = new RunTimingIndex();
  runTimingIndex.hydrateFromLaunchEntries(await audit.readAll({ action: 'run.launched' }));
  const app = Fastify({ logger: false });
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit, authMode: 'off' }, { runTimingIndex });
  apps.push(app);
  return app;
}

describe('crew#854 — AgentSession.ask_path / ask_turn', () => {
  it('an answered ask reads ask_turn; a build step on an ask is a real gate; a plain run carries neither — after a restart too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-turn-dto-'));
    dirs.push(dir);
    const audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    const actor = { id: 'local', kind: 'human', trust: 'operator' } as never;
    recordRunLaunched(audit, undefined, actor, 'ask-1', { chatId: 'c1', askPath: true, deliver: 'none' });
    recordRunLaunched(audit, undefined, actor, 'ask-2', { chatId: 'c2', askPath: true, deliver: 'none' });
    recordRunLaunched(audit, undefined, actor, 'plain', { workflow: 'bug', deliver: 'none' });
    await audit.flush();
    const app = await build(audit, [
      view('ask-1', 'awaiting_human', [unit('ask-1', 'answer-1', 0)]),
      view('ask-2', 'awaiting_human', [unit('ask-2', 'answer-1', 0), unit('ask-2', 'build-1', 1, 'pending')]),
      view('plain', 'awaiting_human', [unit('plain', 'answer-1', 0)]),
    ]);
    const runs = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as { runs: Array<{ session: Record<string, unknown> }> };
    const by = Object.fromEntries(runs.runs.map((r) => [r.session['id'], [r.session['ask_path'], r.session['ask_turn']]]));
    expect(by).toEqual({ 'ask-1': [true, true], 'ask-2': [true, undefined], plain: [undefined, undefined] });
    expect(runs.runs.find((r) => r.session['id'] === 'ask-1')?.session).toMatchObject({ chat_id: 'c1' });
  });
});
