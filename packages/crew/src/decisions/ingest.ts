/**
 * Where operator words enter the ledger (DES-decision-capture §4.3.1 / §4.3.2, DC-S4a).
 *
 * The structured hosts — a gate note, an elicitation answer, a run inject — call
 * {@link ingestDecision} POST-COMMIT, after their action succeeded. Only a `human` actor is
 * recorded: an agent's words are never a decision source (operator decision 4). `auth_mode` is the
 * daemon's resolved auth and decides auto eligibility (§4.4). Derivation is deterministic; under
 * `WICKED_DECISIONS=on` the record's route is then acted on (auto → `remember()`, offer → the review
 * queue). Never throws into the host route: a failure is logged and the host's answer stands.
 */

import { createHash } from 'node:crypto';

import type { Actor } from '../core/types.js';
import { deriveDecision } from './derive.js';
import { DECISION_DETECTED } from './events.js';
import { newDecisionId, type DecisionService } from './land.js';
import type { DecisionHost, DecisionRecord } from './types.js';

export interface HostWords {
  host: Extract<DecisionHost, 'gate' | 'elicitation' | 'inject'>;
  actor: Actor;
  /** The operator's verbatim free text ('' when the decision was a bare choice). */
  words: string;
  /** A bare approve/reject, or a picked elicitation option, when there were no words. */
  choice?: string;
  projectId: string | null;
  runId: string;
  ord?: number;
  gateId?: string;
  elicitationId?: string;
}

export async function ingestDecision(service: DecisionService, input: HostWords): Promise<DecisionRecord | null> {
  const { ledger, authMode, log } = service.deps;
  if (service.mode === 'off') return null;
  // §4.3.1: only human words are recorded — an agent token writes nothing at all.
  if (input.actor.kind !== 'human') return null;
  const words = input.words.trim();
  if (words === '' && input.choice === undefined) return null;
  try {
    const now = service.deps.now?.() ?? Date.now();
    const inForce = words === '' ? [] : await service.inForce(input.projectId);
    const d = deriveDecision({
      words,
      actorKind: 'human',
      authMode,
      wordsSource: 'typed',
      projectId: input.projectId,
      inForce,
      recurrence: (key) => ledger.recurrence(key),
      now,
    });
    const record: DecisionRecord = {
      op: 'record',
      v: 1,
      id: newDecisionId(now),
      at: now,
      project_id: input.projectId,
      host: input.host,
      origin: {
        actor: { id: input.actor.id, kind: 'human', trust: input.actor.trust },
        auth_mode: authMode,
        run_id: input.runId,
        ...(input.ord !== undefined ? { ord: input.ord } : {}),
        ...(input.gateId !== undefined ? { gate_id: input.gateId } : {}),
        ...(input.elicitationId !== undefined ? { elicitation_id: input.elicitationId } : {}),
        words: d.words,
        ...(input.choice !== undefined ? { choice: input.choice } : {}),
        message_sha256: createHash('sha256').update(input.words).digest('hex'),
        proposal: null,
        words_source: 'typed',
        redacted: d.redacted,
      },
      labels: {
        deterministic: { template: d.template, exclusions: d.exclusions, dgc: d.dgc, recurrence: d.recurrence },
      },
      derived: {
        statement: d.statement,
        polarity: d.polarity,
        key: d.key,
        scope: d.scope,
        steering_type: d.steering_type,
      },
      route: d.route,
      ...(d.rule_ref !== undefined ? { rule_ref: d.rule_ref } : {}),
    };
    ledger.appendRecord(record);
    const emit = service.deps.emit;
    if (emit !== null && emit !== undefined) {
      await emit(
        DECISION_DETECTED,
        {
          decision_id: record.id,
          project_id: record.project_id,
          host: record.host,
          type: input.choice !== undefined && words === '' ? 'choice' : (d.template ?? 'none'),
          route: record.route,
          template: d.template,
        },
        `detected:${record.id}`,
      ).catch((err: unknown) => log?.(`[decisions] emit detected failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    await service.act(record);
    return record;
  } catch (err) {
    log?.(`[decisions] recording ${input.host} words for run ${input.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
