// crew#1960: the real shape of a chat answer run parked at its turn gate: run 85e84baa from the train-16 cert (a
// GET /api/v1/runs body the cert's browser kept), long text fields cut and host paths dropped. It carried crew's own DTO
// words `ask_path` / `ask_turn` there (routes.ts, crew#854); the engine's sessionsDetail, which the boot sweep reads,
// does not, so they are removed here.

import type { Actor, SessionView } from '../../src/core/types.js';

export const DAEMON: Actor = { id: 'daemon', kind: 'system', trust: 'admin' };

/** Run 85e84baa's session and its one answer unit, as the engine reports them (see the header). */
export function answeredAsk(id: string, unitStatus = 'done', status = 'awaiting_human'): SessionView {
  return {
    session: {
      archive_note: null,
      archived_at: null,
      assurance: { mode: 'full', required: ['distinct_evaluator', 'judge'] },
      attempt: 0,
      auto_deliver: false,
      clis: ['pi', 'claude', 'codex', 'copilot'],
      collection_scope: `wicked-agent/${id}/shared`,
      entity_mode: 'shared',
      extra_write_roots: [],
      human_confirm: 'none',
      id,
      problem: 'In carddemo-t16, extract the business rules',
      project_graph: null,
      project_id: null,
      repo_ref: 'carddemo-t16',
      run_branch: `wicked/${id}`,
      status,
      unit_ix: 1,
      workdir: null,
      workflow_id: `wf-${id}`,
      run_identity: { kind: 'user_plan', name: null, user_plan: true, system: false },
      document_id: null,
      created_at: 1795716558,
      delivery: 'none',
      deliver_requested: true,
      chat_id: '943153b4-a53c-5766-9f22-9f1bdcc9b82e',
    },
    units: [
      {
        assigned_cli: 'pi',
        budget_secs: 600,
        catalog: 'understand',
        denial_reason: null,
        gate: { human_confirm: { unconditional: true } },
        id: `${id}:answer-1`,
        ord: 1,
        phase_ref: `wf-${id}:unit-1`,
        phase_status: 'approved',
        session_id: id,
        stage: 'recon',
        status: unitStatus,
      },
    ],
  } as unknown as SessionView;
}

/** A governed job parked at a real gate (no ask launched it). */
export function plainGate(id: string): SessionView {
  const v = answeredAsk(id);
  return { ...v, units: [{ ...(v.units[0] as object), id: `${id}:review` }] } as unknown as SessionView;
}

