export type SessionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';
export type PhaseState = 'Pending' | 'InProgress' | 'AwaitingHuman' | 'AwaitingCouncil' | 'GateRunning' | 'Approved' | 'Rejected';
export type GateKind = 'auto' | 'human' | 'council';
export type GateResult = 'approved' | 'rejected' | 'approved-with-conditions';

export interface Session {
  id: string;
  type: string;
  goal: string;
  status: SessionStatus;
  workers: string[];
  created_at: string;
  updated_at: string;
}

export interface Phase {
  id: string;
  session_id: string;
  phase_id: string;
  state: PhaseState;
  gate_kind: GateKind;
  blocking_raid_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface Dispatch {
  id: string;
  session_id: string;
  phase_id: string;
  worker_id: string;
  prompt: string;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface Evidence {
  id: string;
  session_id: string;
  phase_id: string;
  kind: string;
  payload: unknown;
  created_at: string;
}

export interface Gate {
  id: string;
  session_id: string;
  phase_id: string;
  result: GateResult | null;
  blocking_policies: string[];
  council_score: number | null;
  conditions: string | null;
  evaluated_at: string | null;
  created_at: string;
}

export interface RaidItem {
  id: string;
  session_id: string;
  phase_id: string;
  kind: string;
  title: string;
  description: string;
  blocking: boolean;
  created_at: string;
}

export interface XstateSnapshot {
  session_id: string;
  snapshot: unknown;
  saved_at: string;
}
