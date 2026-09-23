/**
 * Phases that run WITHOUT a skill their workflow declares (crew#661).
 *
 * The interactive seams (draft / edit / chat) declare `wicked-garden-draft` on their agent phases,
 * but stamp it only when the PUBLISHED skills snapshot holds it (interactive/draft-skill.ts — the
 * engine refuses a `skill_ref` its snapshot lacks, at plan time). When it does not, the seam arms
 * with NO `skill_ref` and every run on it proceeds without the quality floor. Until this module the
 * only trace was one warn line per boot on stdout: nothing in `/diagnostics`, `/health`, or on the
 * run — the silent-degradation class (#535, #553).
 *
 * Posture: DEGRADE AND DISCLOSE, not fail loud. The skill is a document QUALITY floor; the run's
 * governance (evaluator ≠ creator, the gates, the deliverable floor that re-derives "done" from the
 * artifact) is unaffected by its absence. That is the class crew already discloses rather than
 * refuses — `unitDistributed.degradedReason` (a thinner council), `distinctnessFallback`
 * (creator-seat judge), `gateEvaluated.ungated`. The BASE skill is the counter-example that fails
 * loud (`baseSkillPolicy: 'require'`, D-8b): it IS the governance directive, so a run without it is
 * not governed the way it claims. Refusing here would stop every interactive ask on a snapshot that
 * was merely never republished — a capability outage for a quality gap.
 *
 * Two halves, both keyed on what the seam DECIDED at arm time (the decision holds until restart —
 * a republish does not re-arm a running seam, so "the snapshot holds it now" is not the answer):
 *
 *   - {@link PhaseSkillArming} records each seam's arm-time outcome; `GET /diagnostics` reports the
 *     gaps (`skills.phaseSkillGaps` + a `skills.phase-skill` finding) and `/health.warnings` carries
 *     the finding.
 *   - {@link RunSkillGapIndex} records, per LAUNCHED run whose workflow armed with a gap, a
 *     `run.skill.unarmed` audit entry and serves it as `AgentSession.skill_gaps` — durable across a
 *     restart through the trail, like every other daemon-side run fact (RetryIndex, GuidanceIndex).
 */

import type { AuditLog } from '../api/audit.js';
import type { LaunchNotice } from '../core/adapter.js';
import type { WorkflowDef } from '../core/types.js';
import type { SkillsHealth, SkillsHealthFinding } from './runtime.js';

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

/** The remedy text: republish from a garden carrying the skill, then restart (the seams judge at arm time). */
export function phaseSkillRemedy(skill: string): string {
  return (
    `republish the skills snapshot from a wicked-garden that carries '${skill}' (install or upgrade wicked-garden, ` +
    `then POST /api/v1/skills/refresh-baseline and POST /api/v1/skills/publish — or the studio Skills page), ` +
    `then restart crew: the seams decide at arm time`
  );
}

/** The operator-facing sentence for one gap (the `skills.phase-skill` finding's message). */
export function describePhaseSkillGap(gap: PhaseSkillGap): string {
  return (
    `${gap.subsystem}: phase${gap.phases.length === 1 ? '' : 's'} ${gap.phases.join(', ')} declare skill '${gap.skill}' ` +
    `but run WITHOUT it — the published skills snapshot${gap.gen === null ? ' (none published)' : ` (generation ${gap.gen})`} ` +
    `does not hold it; remedy: ${gap.remedy}`
  );
}

export class PhaseSkillArming {
  private readonly bySubsystem = new Map<string, PhaseSkillGap | null>();

  constructor(
    /** The published generation right now (`SkillsRuntime.health().current?.gen`), or `null`. */
    private readonly currentGen: () => number | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Wrap the seam's `skillHeld` predicate so the arm-time answer is recorded against `subsystem`
   * and `def` (the UNSTAMPED def the seam registers — its agent phases are the ones the skill rides).
   * The answer itself is passed through unchanged.
   */
  probe(subsystem: string, def: WorkflowDef, held: (name: string) => boolean): (name: string) => boolean {
    return (name: string): boolean => {
      const answer = held(name);
      this.record(subsystem, def, name, answer);
      return answer;
    };
  }

  /** Drop a subsystem's outcome — its seam asked the question but then failed to arm (it returned
   *  null and runs nothing), so no phase of it runs, unarmed or otherwise. */
  forget(subsystem: string): void {
    this.bySubsystem.delete(subsystem);
  }

  /** Record one arm-time outcome (latest wins per subsystem). */
  record(subsystem: string, def: WorkflowDef, skill: string, held: boolean): void {
    if (held) {
      this.bySubsystem.set(subsystem, null);
      return;
    }
    let gen: number | null = null;
    try {
      gen = this.currentGen();
    } catch {
      gen = null; // an unreadable manifest is "unknown generation", never a guess
    }
    this.bySubsystem.set(subsystem, {
      subsystem,
      workflow: def.id,
      phases: def.phases.filter((p) => p.executor === undefined).map((p) => p.id),
      skill,
      gen,
      armedAt: this.now(),
      remedy: phaseSkillRemedy(skill),
    });
  }

  /** Every subsystem that armed without its declared skill, subsystem-sorted. Empty = nothing unarmed. */
  gaps(): PhaseSkillGap[] {
    return [...this.bySubsystem.values()]
      .filter((g): g is PhaseSkillGap => g !== null)
      .sort((a, b) => a.subsystem.localeCompare(b.subsystem));
  }

  /** The gap for runs launched on `workflowId`, or `undefined` when that workflow armed with its skill (or never armed here). */
  gapForWorkflow(workflowId: string): PhaseSkillGap | undefined {
    for (const g of this.bySubsystem.values()) if (g !== null && g.workflow === workflowId) return g;
    return undefined;
  }
}

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

/** The `skills.phase-skill` findings for the recorded gaps (one per subsystem, `warning`: the runs proceed, degraded). */
export function phaseSkillFindings(gaps: readonly PhaseSkillGap[]): SkillsHealthFinding[] {
  return gaps.map((g) => ({ kind: 'skills.phase-skill', severity: 'warning', message: describePhaseSkillGap(g) }));
}

/** The diagnostics `skills` block with the arm-time gaps folded in: `phaseSkillGaps` (always present — `[]`
 *  when nothing armed unarmed) and one `skills.phase-skill` finding per gap appended to `findings`. */
export function withPhaseSkillGaps(
  health: SkillsHealth,
  arming: PhaseSkillArming | undefined,
): SkillsHealth & { phaseSkillGaps: PhaseSkillGap[] } {
  const gaps = arming?.gaps() ?? [];
  return { ...health, findings: [...health.findings, ...phaseSkillFindings(gaps)], phaseSkillGaps: gaps };
}

/** run id → the skill gaps it launched with. Hydrated from the audit trail; set at launch. */
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

  /** Record a launch: the audit entry (durable) and the map (served). Idempotent per (run, subsystem, skill). */
  record(audit: AuditLog, actor: Parameters<AuditLog['record']>[1], runId: string, gap: PhaseSkillGap): RunSkillGap {
    const { armedAt: _armedAt, ...runGap } = gap;
    void _armedAt;
    if (this.add(runId, runGap)) audit.record(RUN_SKILL_UNARMED_ACTION, actor, { runId, detail: { gap: runGap } });
    return runGap;
  }

  /**
   * The daemon's launch listener half: a RUN the engine ACCEPTED on a workflow that armed with a
   * gap is recorded (audit + map) and logged at warn naming the run. Never throws — a listener
   * failure would fail the launch (`CoreAdapter.notifyLaunch`), and disclosure must not turn a
   * degraded run into a refused one; a failure to disclose is itself logged.
   */
  onLaunch(
    notice: LaunchNotice,
    arming: PhaseSkillArming,
    audit: AuditLog,
    actor: Parameters<AuditLog['record']>[1],
    warn: (msg: string) => void,
  ): RunSkillGap | undefined {
    try {
      // `accepted` only — the engine TOOK the run. A `handed` launch can still be refused, and a durable
      // record written then would stick to a later retry under the same (client-supplied) id.
      if (notice.kind !== 'run' || notice.status !== 'accepted' || notice.workflow === undefined) return undefined;
      const gap = arming.gapForWorkflow(notice.workflow);
      if (gap === undefined) return undefined;
      const runGap = this.record(audit, actor, notice.id, gap);
      warn(
        `[${gap.subsystem}] run ${notice.id} launched DEGRADED: phase${gap.phases.length === 1 ? '' : 's'} ` +
          `${gap.phases.join(', ')} run WITHOUT declared skill '${gap.skill}' (not in the published skills snapshot` +
          `${gap.gen === null ? '' : `, generation ${gap.gen}`}) — disclosed as skill_gaps on the run; remedy: ${gap.remedy}`,
      );
      return runGap;
    } catch (err) {
      warn(`[skills] could not disclose the skill gap on run ${notice.id}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
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
