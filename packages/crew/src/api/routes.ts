import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { startSession, resolveHumanGate, pauseSession, resumeSession } from '../fsm/runner.js';
import { getSession, listPhases, listSessions, updatePhaseState } from '../store/sessions.js';
import { listWorkers } from '../dispatch/workers.js';
import { emit } from '../events/bus.js';
import { randomUUID } from 'node:crypto';

const CreateSessionSchema = z.object({
  type: z.string(),
  goal: z.string(),
  workers: z.array(z.string()).optional(),
  phase_gate_overrides: z.record(z.enum(['auto', 'human', 'council'])).optional(),
});

const ApproveWithConditionsSchema = z.object({
  conditions: z.string(),
});

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/v1/health', async () => ({ status: 'ok', version: '0.1.0' }));

  app.get('/api/v1/config', async () => {
    // Report the actually-bound port/host (honours --port / CREW_PORT / port 0).
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 7701;
    const host = typeof addr === 'object' && addr ? addr.address : '127.0.0.1';
    return { port, host, workers_config: 'workers.json' };
  });

  app.get('/api/v1/workers', async () => ({ workers: listWorkers() }));

  app.post('/api/v1/sessions', async (req, reply) => {
    const parsed = CreateSessionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    const body = parsed.data;
    const opts: import('../fsm/runner.js').StartSessionOpts = {
      type: body.type,
      goal: body.goal,
      ...(body.workers !== undefined ? { workers: body.workers } : {}),
      ...(body.phase_gate_overrides !== undefined ? { phaseGateOverrides: body.phase_gate_overrides } : {}),
    };
    const sessionId = await startSession(db, opts);
    const session = getSession(db, sessionId);
    const phases = listPhases(db, sessionId);
    return reply.code(201).send({ session, phases });
  });

  // List all sessions (most-recent first) with their phases — powers the studio list.
  app.get('/api/v1/sessions', async () => {
    const sessions = listSessions(db);
    return { sessions: sessions.map((session) => ({ session, phases: listPhases(db, session.id) })) };
  });

  app.get('/api/v1/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSession(db, id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const phases = listPhases(db, id);
    return { session, phases };
  });

  app.get('/api/v1/sessions/:id/phases', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSession(db, id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return { phases: listPhases(db, id) };
  });

  // Gate actions — resolve the deferred promise driving the FSM actor
  app.post('/api/v1/sessions/:id/gates/:phase/approve', async (req, reply) => {
    const { id, phase } = req.params as { id: string; phase: string };
    const session = getSession(db, id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    const resolved = resolveHumanGate(id, phase, 'approved');

    // Fallback: if no deferred promise (phase already auto-gated or gate already resolved),
    // write the approval directly to SQLite so the API stays usable for manual overrides.
    if (!resolved) {
      updatePhaseState(db, id, phase, 'Approved');
      db.prepare(`
        INSERT INTO gates (id, session_id, phase_id, result, blocking_policies, council_score, conditions, evaluated_at, created_at)
        VALUES (?, ?, ?, 'approved', '[]', NULL, NULL, ?, ?)
      `).run(randomUUID(), id, phase, new Date().toISOString(), new Date().toISOString());
      void emit('wicked.crew.phase.gate.approved', { session_id: id, phase_id: phase, human_override: true });
    }

    return { ok: true };
  });

  app.post('/api/v1/sessions/:id/gates/:phase/reject', async (req, reply) => {
    const { id, phase } = req.params as { id: string; phase: string };
    const session = getSession(db, id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    const resolved = resolveHumanGate(id, phase, 'rejected');

    if (!resolved) {
      updatePhaseState(db, id, phase, 'Rejected');
      void emit('wicked.crew.phase.gate.rejected', { session_id: id, phase_id: phase, human_override: true });
    }

    return { ok: true };
  });

  app.post('/api/v1/sessions/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSession(db, id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.status !== 'running') return reply.code(409).send({ error: 'Session is not running' });
    pauseSession(id);
    return { ok: true };
  });

  app.post('/api/v1/sessions/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSession(db, id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.status !== 'paused') return reply.code(409).send({ error: 'Session is not paused' });
    await resumeSession(db, id);
    return { ok: true };
  });

  app.post('/api/v1/sessions/:id/gates/:phase/approve-with-conditions', async (req, reply) => {
    const { id, phase } = req.params as { id: string; phase: string };
    const session = getSession(db, id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    const parsed = ApproveWithConditionsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    const body = parsed.data;

    // Store conditions as RAID assumption regardless of gate path
    db.prepare(`
      INSERT INTO raid_items (id, session_id, phase_id, kind, title, description, blocking, created_at)
      VALUES (?, ?, ?, 'assumption', 'Gate conditions', ?, 0, ?)
    `).run(randomUUID(), id, phase, body.conditions, new Date().toISOString());

    const resolved = resolveHumanGate(id, phase, 'approved', body.conditions);

    if (!resolved) {
      updatePhaseState(db, id, phase, 'Approved');
      db.prepare(`
        INSERT INTO gates (id, session_id, phase_id, result, blocking_policies, council_score, conditions, evaluated_at, created_at)
        VALUES (?, ?, ?, 'approved-with-conditions', '[]', NULL, ?, ?, ?)
      `).run(randomUUID(), id, phase, body.conditions, new Date().toISOString(), new Date().toISOString());
    }

    void emit('wicked.crew.phase.gate.approved', { session_id: id, phase_id: phase, human_override: true, conditions: body.conditions });
    return { ok: true };
  });
}
