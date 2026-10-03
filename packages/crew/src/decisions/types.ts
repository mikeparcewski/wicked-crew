/**
 * Decision capture — the ledger's shapes (DES-decision-capture §4.2.1, DC-S4a).
 *
 * The ledger is the ONLY source of ORIGIN: the operator's verbatim words, who typed them (a human
 * actor — an agent's words are never recorded), and the auth mode that decides auto eligibility.
 * One append-only JSONL file per project; a line is a `record` or an `outcome`, and a read folds
 * them into a {@link DecisionView} (api-types 0.80.0).
 */

import type {
  DecisionDismissReason,
  DecisionHost,
  DecisionRoute,
  DecisionState,
  DecisionTemplateId,
  DecisionType,
  SteeringType,
  TrustLevel,
} from 'wicked-crew-api-types';

export type { DecisionView } from 'wicked-crew-api-types';
export type {
  DecisionDismissReason,
  DecisionHost,
  DecisionRoute,
  DecisionState,
  DecisionTemplateId,
  DecisionType,
};

/** The model's labels for one quoted span (the studio chat recorder, DC-S4b). Optional here. */
export interface DecisionModelLabels {
  is_decision: boolean;
  type: DecisionType;
  codify: boolean;
  ambiguous: boolean;
  steering_type: SteeringType;
  same_as?: string | null;
  approves_proposal?: boolean;
  recorder: string;
  model_id?: string;
}

export interface DecisionRecord {
  op: 'record';
  v: 1;
  id: string;
  at: number;
  project_id: string | null;
  host: DecisionHost;
  origin: {
    actor: { id: string; kind: 'human'; trust: TrustLevel };
    auth_mode: 'off' | 'required';
    chat_id?: string;
    turn_id?: string;
    run_id?: string;
    ord?: number;
    attempt?: number;
    gate_id?: string;
    elicitation_id?: string;
    words: string;
    choice?: string;
    message_sha256: string;
    proposal?: { turn_id: string; cli_key: string; excerpt: string } | null;
    words_source: 'typed' | 'operator-files' | 'cli-transcript';
    redacted: boolean;
  };
  labels: {
    model?: DecisionModelLabels;
    votes?: Array<{ cli_key: string; type: DecisionType; codify: boolean }>;
    deterministic: {
      template: DecisionTemplateId | null;
      exclusions: string[];
      dgc: { durable: boolean; general: boolean; checkable: boolean };
      recurrence: { count: number; first_at: number; projects: string[] };
    };
  };
  derived: {
    statement: string | null;
    polarity: 'do' | 'dont' | null;
    key: string | null;
    scope: 'project' | 'everywhere';
    steering_type: SteeringType;
  };
  route: DecisionRoute;
  /** The in-force rule a `restated` / `maybe-restated` decision restates, or a `conflict` contradicts. */
  rule_ref?: string;
}

export interface DecisionOutcome {
  op: 'outcome';
  id: string;
  at: number;
  state: Exclude<DecisionState, 'recorded'>;
  how?: 'auto' | 'chip' | 'needs-you';
  by: { id: string; kind: 'human' | 'system' };
  proposal_id?: string;
  rule_id?: string;
  restates_rule_id?: string;
  edits?: { statement?: string; scope?: 'project' | 'everywhere'; type?: DecisionType; steering_type?: SteeringType };
  reason?: DecisionDismissReason;
  /** `landing_failed` only: the loud reason (never words). */
  error?: string;
}

export type DecisionLine = DecisionRecord | DecisionOutcome;

/** `WICKED_DECISIONS` (§5.6): one switch, not a fallback. */
export type DecisionsMode = 'off' | 'ledger' | 'on';

/**
 * Resolve the switch. Default `ledger`: record and label, no chips and no auto — the live-precision
 * mode §8 runs before `on` (the corpus gate). An unknown value is `ledger`, never `on`.
 */
export function resolveDecisionsMode(env: NodeJS.ProcessEnv = process.env): DecisionsMode {
  const raw = (env['WICKED_DECISIONS'] ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'on' || raw === 'ledger') return raw;
  return 'ledger';
}
