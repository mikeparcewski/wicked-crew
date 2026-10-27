/**
 * A chat that RUNS A WORKFLOW (crew#1157): `POST /chats {workflow: "analyze"}`. The workflow is
 * data — a wicked-core built-in preset (`src/presets/analyze.json`) — and every turn of the chat is
 * its one step, re-stated as the ask path's `answer-N` step (`ask-paths.ts`), so the chat thread,
 * the turn gate, follow-ups and the citation check all work exactly as for a plain chat.
 *
 * What makes it safe to run in a chat is checked HERE, not trusted from the name: only a BUILT-IN
 * preset named in {@link CHAT_WORKFLOWS} is accepted, and only while it is one agent step on the
 * catalog's `understand` entry (neutral, `executes_code: false`, no pin: the engine gives it the
 * read-only write posture on a bound or unbound run), with no Tool executor, no raised
 * `executes_code`, and no deliverables. A chat that runs one launches without `deliver`, asks for no
 * reviewer, seats one helper, and its statement proposes no `PLAN+` work.
 */
import type { Preset, PresetStep } from 'wicked-crew-api-types';
import { answerStep } from './ask-paths.js';

/** The workflows a chat may run. Each is a built-in, read-only preset of the engine. */
export const CHAT_WORKFLOWS: ReadonlySet<string> = new Set(['analyze']);

/** The one step a chat workflow contributes to each answer step. */
export interface ChatWorkflow {
  name: string;
  instructions: string;
  skillRef?: string;
}

export type ChatWorkflowResolution =
  | { ok: true; workflow: ChatWorkflow }
  | { ok: false; status: 400 | 409; error: string };

/** Why `step` cannot run as a read-only chat turn, or `null` when it can. */
export function readOnlyStepRefusal(step: PresetStep): string | null {
  if (step.catalog !== 'understand') return `its step '${step.id}' is on catalog entry '${step.catalog}', not 'understand'`;
  if (step.executor !== undefined && step.executor !== null) return `its step '${step.id}' names an executor`;
  if (step.executes_code === true) return `its step '${step.id}' executes code`;
  const deliverables = step.required_deliverables;
  if (Array.isArray(deliverables) && deliverables.length > 0) return `its step '${step.id}' declares deliverables`;
  if (typeof step.instructions !== 'string' || step.instructions.trim() === '') return `its step '${step.id}' has no instructions`;
  return null;
}

/**
 * Resolve `name` against the engine's presets: a 400 for a name chats do not run, a 409 when this
 * engine does not carry it (an older core-ts) or carries a shape that could write.
 */
export function resolveChatWorkflow(name: string, presets: readonly Preset[]): ChatWorkflowResolution {
  if (!CHAT_WORKFLOWS.has(name)) {
    return { ok: false, status: 400, error: `a chat cannot run workflow '${name}' (chats run: ${[...CHAT_WORKFLOWS].join(', ')})` };
  }
  const preset = presets.find((p) => p.name === name && p.created_by === 'builtin' && p.scope === 'global');
  if (preset === undefined) {
    return {
      ok: false,
      status: 409,
      error: `this daemon's engine has no built-in '${name}' workflow (wicked-core-ts too old); open a plain chat instead`,
    };
  }
  if (preset.steps.length !== 1) {
    return { ok: false, status: 409, error: `workflow '${name}' has ${preset.steps.length} steps; a chat runs exactly one read-only step` };
  }
  const step = preset.steps[0]!;
  const why = readOnlyStepRefusal(step);
  if (why !== null) return { ok: false, status: 409, error: `workflow '${name}' cannot run in a chat: ${why}` };
  return {
    ok: true,
    workflow: {
      name,
      instructions: step.instructions as string,
      ...(typeof step.skill_ref === 'string' && step.skill_ref !== '' ? { skillRef: step.skill_ref } : {}),
    },
  };
}

/** The chat workflows this engine carries (served as `GET /health.capabilities.chatWorkflows`). */
export function servedChatWorkflows(presets: readonly Preset[]): string[] {
  return [...CHAT_WORKFLOWS].filter((name) => resolveChatWorkflow(name, presets).ok).sort();
}

/**
 * One turn of a chat: the ask path's answer step ({@link answerStep}: `understand`, the turn gate,
 * the turn budget), carrying the workflow's skill and its instructions ahead of the turn's own
 * (the scope statement, the preface, the operator's words).
 */
export function chatTurnStep(stepId: string, text: string, workflow?: ChatWorkflow): { catalog: string; id: string; [k: string]: unknown } {
  if (workflow === undefined) return answerStep(stepId, text);
  return {
    ...answerStep(stepId, `${workflow.instructions}\n\n${text}`),
    ...(workflow.skillRef !== undefined ? { skill_ref: workflow.skillRef } : {}),
  };
}
