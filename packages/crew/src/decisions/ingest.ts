/**
 * Where operator words enter the ledger (DES-decision-capture §4.3.1 / §4.3.2 / §4.3.3, DC-S4a + S4b).
 *
 * The structured hosts — a gate note, an elicitation answer, a run inject — call
 * {@link ingestDecision} POST-COMMIT, after their action succeeded; the studio chat recorder
 * (`chat-recorder.ts`) calls it at the end of a turn with the model's labels. Only a `human` actor is
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
import type { DecisionHost, DecisionModelLabels, DecisionRecord, DecisionType } from './types.js';

export interface HostWords {
  host: Extract<DecisionHost, 'gate' | 'elicitation' | 'inject' | 'studio-chat'>;
  actor: Actor;
  /** The operator's verbatim free text ('' when the decision was a bare choice). */
  words: string;
  /** A bare approve/reject, or a picked elicitation option, when there were no words. */
  choice?: string;
  projectId: string | null;
  /** The structured hosts: the run the words steered. */
  runId?: string;
  ord?: number;
  gateId?: string;
  elicitationId?: string;
  /** The chat host: the chat and the turn whose operator message carried the words. */
  chatId?: string;
  turnId?: string;
  /** The chat host: the recorder seat's labels for this span, and the other seats' votes. */
  labels?: DecisionModelLabels;
  votes?: Array<{ cli_key: string; type: DecisionType; codify: boolean }>;
  /** The chat host, DOC-4: the proposal a go-ahead approved (the previous turn, the recorder seat). */
  proposal?: { turn_id: string; cli_key: string; excerpt: string } | null;
  /**
   * DOC-4: the decision text written from the approved proposal (+ amendment). It replaces the
   * derived statement — a bare approval has no template of its own — while ORIGIN keeps the words.
   */
  statement?: string;
}

export async function ingestDecision(service: DecisionService, input: HostWords): Promise<DecisionRecord | null> {
  const { ledger, authMode, log } = service.deps;
  if (service.mode === 'off') return null;
  // §4.3.1: only human words are recorded — an agent token writes nothing at all.
  if (input.actor.kind !== 'human') return null;
  const words = input.words.trim();
  if (words === '' && input.choice === undefined) return null;
  const where = input.runId !== undefined ? `run ${input.runId}` : `chat ${input.chatId ?? '?'}`;
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
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      now,
    });
    const statement = input.statement !== undefined && input.statement.trim() !== '' ? input.statement.trim() : d.statement;
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
        ...(input.chatId !== undefined ? { chat_id: input.chatId } : {}),
        ...(input.turnId !== undefined ? { turn_id: input.turnId } : {}),
        ...(input.runId !== undefined ? { run_id: input.runId } : {}),
        ...(input.ord !== undefined ? { ord: input.ord } : {}),
        ...(input.gateId !== undefined ? { gate_id: input.gateId } : {}),
        ...(input.elicitationId !== undefined ? { elicitation_id: input.elicitationId } : {}),
        words: d.words,
        ...(input.choice !== undefined ? { choice: input.choice } : {}),
        message_sha256: createHash('sha256').update(input.words).digest('hex'),
        proposal: input.proposal ?? null,
        words_source: 'typed',
        redacted: d.redacted,
      },
      labels: {
        ...(input.labels !== undefined ? { model: input.labels } : {}),
        ...(input.votes !== undefined && input.votes.length > 0 ? { votes: input.votes } : {}),
        deterministic: { template: d.template, exclusions: d.exclusions, dgc: d.dgc, recurrence: d.recurrence },
      },
      derived: {
        statement,
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
    log?.(`[decisions] recording ${input.host} words for ${where} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
