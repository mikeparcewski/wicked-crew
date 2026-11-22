/**
 * The eval SAMPLE contract — ONE spelling shared by the route (`POST /testing/corpora/import`,
 * `api/testing.ts`), the offline comparison (`api/eval-compare.ts`) and the internal-corpus
 * derivation script (`scripts/evals-internal-corpus.mjs`, plain node — which is why this module is
 * plain ESM JavaScript with JSDoc types, not TypeScript: the script imports it directly from the
 * source tree, and tsc emits it into `dist/` beside the compiled route via `allowJs`).
 *
 * Two things live here, deliberately together:
 *
 *   1. The zod schemas of the pinned import wire shape (snake_case, the engine's serde spelling):
 *      strict objects, closed `kind`, non-empty strings, strict `signals`. `steering_type` stays
 *      an open string on purpose — the engine validates it against ITS vocabulary, so engine-side
 *      validation stays the one spelling of what a type is (the steering import doctrine).
 *   2. The sample PAYLOAD identity: the canonical hash of a sample's FULL payload (id, kind,
 *      description, steering_type, signals — every field the gate is asked to judge), which is
 *      what makes two eval runs comparable release over release (plan §3): the same id + kind is
 *      not the same action if the description, type or signals changed underneath it.
 *
 * A hand mirror of the schema in the script drifted from the route once (codex round 2 on #475:
 * `signals: {phase: 123, tool: []}` passed the mirror and failed the route). There is no mirror
 * any more — there is this module.
 */

import { createHash } from 'node:crypto';
import { z } from '../zod.js';

export const EvalSignalsSchema = z.strictObject({
  phase: z.string().optional(),
  tool: z.string().optional(),
  files: z.array(z.string()).optional(),
  content: z.string().optional(),
});

/**
 * (crew#1128, core#397) A memory the worker's recall for this action should (`expected_memories`) or must not
 * (`unexpected_memories`) surface: `id:<memory id>` names one memory, any other entry is a case-insensitive content
 * substring. The engine validates the entries; a run over a sample that declares memories needs the memory store.
 */
// The engine's own blank rule (evals.rs `EvalSample::validate`): blank after an optional `id:` prefix and a trim is
// refused here as a 400, never passed on to fail the engine's import as a 500 (coord F1 on #1758).
const MemoryMatchersSchema = z
  .array(z.string().refine((s) => (s.startsWith('id:') ? s.slice(3) : s).trim() !== '', 'a blank memory expectation (use `id:<memory id>` or a content substring)'))
  .optional();

export const EvalSampleSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(['good', 'bad']),
  steering_type: z.string().min(1),
  signals: EvalSignalsSchema,
  expected_memories: MemoryMatchersSchema,
  unexpected_memories: MemoryMatchersSchema,
});

export const ImportEvalCorpusSchema = z.strictObject({
  name: z.string().min(1),
  samples: z.array(EvalSampleSchema).min(1),
});

/** The shape of a payload hash: `sha256:` + 64 lowercase hex digits. */
export const PAYLOAD_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Canonical JSON: object keys codepoint-sorted at every depth, arrays in order, compact.
 * `undefined` follows `JSON.stringify` exactly: an `undefined` OBJECT member is dropped, while an
 * `undefined` ARRAY entry becomes `null` (an array keeps its length). Two structurally equal values
 * serialize to the same bytes regardless of the key order they were built in.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * The payload identity of ONE sample: `sha256:` over the canonical JSON of exactly the five
 * payload fields (id, description, kind, steering_type, signals) — never a subset, never an
 * extra (a `payload_hash` already stamped on the sample is NOT part of its own identity).
 * (crew#1128) A sample's memory matchers are part of the question it asks, so a NON-EMPTY
 * `expected_memories` / `unexpected_memories` joins the payload; an absent or empty one does not,
 * so every sample without memories keeps the hash it always had.
 *
 * @param {import('zod').input<typeof EvalSampleSchema>} sample
 * @returns {string}
 */
export function samplePayloadHash(sample) {
  /** @type {Record<string, unknown>} */
  const payload = {
    id: sample.id,
    description: sample.description,
    kind: sample.kind,
    steering_type: sample.steering_type,
    signals: sample.signals,
  };
  if (Array.isArray(sample.expected_memories) && sample.expected_memories.length > 0) payload['expected_memories'] = sample.expected_memories;
  if (Array.isArray(sample.unexpected_memories) && sample.unexpected_memories.length > 0) payload['unexpected_memories'] = sample.unexpected_memories;
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}
