/**
 * Default evals (DES-DEFAULT-EVALS-001): the system's own judgments, tested against what really happened.
 *
 * Every suite uses ONE case shape. A case pairs what the system decided (`observed`) with what it should have
 * decided (`expected`), plus where each came from. Real cases are captured from the run store, so the operator's
 * answer at a gate is the label; synthetic cases come from a seeded generator and need a replay adapter (the current
 * classifier run on the case's input) to be scored. The two are never mixed in one figure: a report always gives
 * real, synthetic and combined side by side.
 */

import type * as W from 'wicked-crew-api-types';

/** The eight inference points (DES §2). */
export const SUITE_IDS = [
  'needs-you',
  'floor-class',
  'qe-verdict',
  'attribution',
  'steering',
  'recall',
  'archetype',
  'normalization',
] as const;
export type SuiteId = (typeof SUITE_IDS)[number];

// The wire contract lives in wicked-crew-api-types (studio builds against it); these are crew's short names.
// A suite id added on one side and not the other fails here at compile time.
const _sameSuites: W.DefaultEvalSuiteId extends SuiteId ? (SuiteId extends W.DefaultEvalSuiteId ? true : never) : never = true;
void _sameSuites;


export type CaseSource = W.DefaultEvalCaseSource;
export type LabelBy = W.DefaultEvalLabelBy;
export type Answer = W.DefaultEvalAnswer;
export type Observed = W.DefaultEvalObserved;
export type Expected = W.DefaultEvalExpected;
export type CaseEvidence = W.DefaultEvalCaseEvidence;
export type EvalCase = W.DefaultEvalCase;
export type Rate = W.DefaultEvalRate;
export type ClassScore = W.DefaultEvalClassScore;
export type Calibration = W.DefaultEvalCalibration;
export type SliceScore = W.DefaultEvalSliceScore;
export type TrendWord = W.DefaultEvalTrend;
export type SuiteScore = W.DefaultEvalSuiteScore;
export type DriftKey = W.DefaultEvalDriftKey;

export type {
  DefaultEvalReport,
  DefaultEvalSummary,
  DefaultEvalDetail,
  DefaultEvalSuitesResponse,
  RunDefaultEvalsBody,
  ListDefaultEvalRunsResponse,
} from 'wicked-crew-api-types';
