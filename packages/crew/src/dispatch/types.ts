export interface WorkerConfig {
  id: string;
  command: string;
  args: string[];
  timeout_ms?: number;
  council_capable?: boolean;
}

export interface WorkerVotes {
  recommendation: string;
  confidence: number;
  rationale: string;
  dimensions: Record<string, 'agree' | 'disagree' | 'uncertain'>;
}

export interface WorkerOutput {
  status: 'ok' | 'error';
  artifact: unknown;
  reasoning?: string;
  warnings?: string[];
  test_verdict?: string;
  votes?: WorkerVotes;
}

export interface DispatchResult {
  workerId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  output: WorkerOutput | null;
  parseError: string | null;
}

export interface CouncilResult {
  workerResults: DispatchResult[];
  synthesisScore: number;
  recommendation: string;
  dimensionAgreements: Record<string, number>;
}
