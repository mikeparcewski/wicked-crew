/**
 * Phases that ran WITHOUT a skill their workflow declares (crew#661) — the historical record.
 *
 * Until crew#935 the interactive seams (draft / edit / chat) stamped `wicked-garden-draft` only when
 * the published snapshot held it, and otherwise armed with NO `skill_ref` and ran every run without
 * the quality floor, disclosed on `/diagnostics` and on each run (`AgentSession.skill_gaps`, from a
 * `run.skill.unarmed` audit entry). Since crew#935 those seams launch wicked-core's built-in
 * `interactive-*` presets, which ALWAYS run the skill: a snapshot without it fails the run instead
 * (fail closed, the call on wicked-core#860). No seam arms degraded any more, so nothing new is
 * recorded. What stays:
 *
 *   - {@link RunSkillGapIndex} reads the trail's existing `run.skill.unarmed` entries back, so a run
 *     that DID run degraded keeps saying so (`skill_gaps`) across restarts.
 *   - `GET /diagnostics.skills.phaseSkillGaps` stays on the wire, always `[]` ({@link withPhaseSkillGaps}).
 */

import type { AuditLog } from '../api/audit.js';
import type { SkillsHealth } from './runtime.js';

/** One subsystem whose declared skill was not handed at arm time — the wire's `DiagnosticsPhaseSkillGap`. */
export interface PhaseSkillGap {
  /** The seam (`interactive-draft` / `interactive-edit` / `interactive-chat`). */
  subsystem: string;
  /** The workflow id the seam registered and launches. */
  workflow: string;
  /** The AGENT phases that declare the skill and run without it (tool phases take no skill). */
  phases: string[];
  /** The skill the phases declare. */
  skill: string;
  /** The published generation judged at arm time, or `null` when none was published / the seam is off. */
  gen: number | null;
  /** Epoch ms of the arm-time judgement. */
  armedAt: number;
  /** What fixes it. */
  remedy: string;
}

/** The skill gap carried on a run (`AgentSession.skill_gaps[]`) — the arm-time gap, minus when it was judged. */
export type RunSkillGap = Omit<PhaseSkillGap, 'armedAt'>;

/** The audit action a run launched with a skill gap is recorded under. */
export const RUN_SKILL_UNARMED_ACTION = 'run.skill.unarmed';

function isRunSkillGap(v: unknown): v is RunSkillGap {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['subsystem'] === 'string' &&
    typeof o['workflow'] === 'string' &&
    Array.isArray(o['phases']) &&
    (o['phases'] as unknown[]).every((p) => typeof p === 'string') &&
    typeof o['skill'] === 'string' &&
    (o['gen'] === null || typeof o['gen'] === 'number') &&
    typeof o['remedy'] === 'string'
  );
}

/** The diagnostics `skills` block with `phaseSkillGaps` (crew#661's field, kept on the wire): always
 *  `[]` since crew#935 — no seam arms without its declared skill. */
export function withPhaseSkillGaps(health: SkillsHealth): SkillsHealth & { phaseSkillGaps: PhaseSkillGap[] } {
  return { ...health, phaseSkillGaps: [] };
}

/** run id → the skill gaps it launched with, read back from the audit trail (crew#661 records; none are written since crew#935). */
export class RunSkillGapIndex {
  private readonly byRun = new Map<string, RunSkillGap[]>();

  /** Best-effort boot hydrate from every `run.skill.unarmed` entry (a failed read leaves runs undisclosed until the next launch, logged). */
  async hydrate(audit: AuditLog, log?: (msg: string) => void): Promise<void> {
    try {
      const entries = await audit.readAll({ action: RUN_SKILL_UNARMED_ACTION });
      // The trail answers newest first; insert oldest first so a run's list keeps launch order.
      for (const entry of [...entries].reverse()) {
        if (typeof entry.runId !== 'string' || entry.runId === '') continue;
        const gap = entry.detail?.['gap'];
        if (!isRunSkillGap(gap)) continue;
        this.add(entry.runId, gap);
      }
    } catch (err) {
      log?.(
        `[skills] run skill-gap hydrate failed (earlier runs read without their skill_gaps until restart): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** The gaps this run launched with, or `undefined` (the DTO field is then ABSENT). */
  gapsFor(runId: string): RunSkillGap[] | undefined {
    const list = this.byRun.get(runId);
    return list === undefined || list.length === 0 ? undefined : list;
  }

  private add(runId: string, gap: RunSkillGap): boolean {
    const list = this.byRun.get(runId) ?? [];
    if (list.some((g) => g.subsystem === gap.subsystem && g.skill === gap.skill)) return false;
    list.push(gap);
    this.byRun.set(runId, list);
    return true;
  }
}
