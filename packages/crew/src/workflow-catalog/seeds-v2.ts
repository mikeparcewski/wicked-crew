/**
 * The shape of the v2 catalog seeds (`catalog-data-v2.ts`, DES-CATALOG-002 §3, §4.2). Design data: what each card and
 * option launches, its inputs and its words. `build-v2.ts` resolves it against what the engine serves.
 */
import type {
  CatalogCategoryV2Id,
  CatalogGateId,
  CatalogNeedV2,
  CatalogRelease,
  WorkflowCatalogLaunch,
} from '../core/types.js';

export interface CategorySeedV2 {
  id: Exclude<CatalogCategoryV2Id, 'yours'>;
  title: string;
  summary: string;
}

/** Seat rules a card or option states (§3 "Seat rules"); an absent one is `false`. */
export interface SeatSeedV2 {
  distinctEvaluator?: boolean;
  distinctJudge?: boolean;
  excludeChangeAuthors?: boolean;
  proposalOnly?: boolean;
  notRunSeat?: boolean;
  council?: boolean;
}

/** One input id as the seeds spell it: `repo`, `repo?` (optional), `intent?`, `depth` (a brief line, not a kind). */
export type InputSeed = string;

export interface OptionSeedV2 {
  id: string;
  title: string;
  summary?: string;
  archetype?: string;
  words?: string[];
  launch?: WorkflowCatalogLaunch;
  /** A framing-only option's brief line, which crew puts first in the brief. */
  brief?: string;
  compose?: { level: 'epics' | 'stories' | 'tasks' };
  changesPlan?: boolean;
  inputs?: InputSeed[];
  needs?: CatalogNeedV2[];
  delivers?: 'pr' | 'document' | 'video' | 'report' | 'answer' | 'proposals' | 'none';
  writes?: 'nothing' | 'repo' | 'domain-artifacts' | 'documents' | 'proposals';
  gate?: CatalogGateId[];
  seats?: SeatSeedV2;
  requiresQe?: boolean;
  status?: 'coming_soon';
  statusNote?: string;
  command?: string | null;
}

export interface CardSeedV2 {
  id: string;
  category: Exclude<CatalogCategoryV2Id, 'yours'>;
  release: CatalogRelease;
  title: string;
  archetype?: string;
  outcome?: string;
  words?: string[];
  hidden?: boolean;
  depth?: boolean;
  needs?: CatalogNeedV2[];
  inputs?: InputSeed[];
  delivers?: 'pr' | 'document' | 'video' | 'report' | 'answer' | 'proposals' | 'none';
  gate?: CatalogGateId[];
  seats?: SeatSeedV2;
  launch?: WorkflowCatalogLaunch;
  brief?: string;
  status?: 'coming_soon';
  statusNote?: string;
  handoff?: { card: string; option: string | null };
  nearest?: { card: string; option: string | null };
  later?: Array<{ release: CatalogRelease; adds: 'documents' | 'sources'; note: string }>;
  command: string | null;
  aliases: Array<{ command: string; option: string | null }>;
  evalSuites?: string[];
  variant?: {
    axis: 'kind' | 'lens' | 'docStyle';
    label: string;
    default: string;
    options: OptionSeedV2[];
  };
}
