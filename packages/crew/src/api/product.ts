/**
 * crew#372 slice 2: `POST /api/v1/projects/:id/product/compose` — draft epics → features → stories
 * from a project's selected requirements, as a GOVERNED RUN (design: DES-W4-CR5, posted on the
 * issue). There is no new execution path: the route re-reads every selected requirement on the
 * server (client text is never trusted), composes a two-step plan over the phase catalog —
 * `produce` (creator: the draft) then `review` (evaluator, a human gate before anything leaves) —
 * and launches it through `POST /runs` itself, so the run gets the same roster, project filing,
 * audit and launch policy as any other run. `deliver: "none"`: nothing is published here.
 *
 * Publish (the second half of #372) is NOT registered: it is a remote write whose "published" must
 * be re-derived from a deterministic created-issue manifest plus a read-back, which does not exist
 * yet. An absent route is the honest answer until it does.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { CoreAdapter } from '../core/adapter.js';
import { AggregateHttpError, membersOf } from './project-aggregates.js';
import { getRequirement } from './requirements.js';

const V = '/api/v1';

/** At most this many requirements per compose: the step instructions ride `plan.proposed`, which
 *  the engine caps at 8 KB, and every line here must reach the drafting seat whole. */
export const COMPOSE_MAX_REQUIREMENTS = 40;
/** The draft step's instructions stay under this many UTF-8 bytes (the engine caps a step's
 *  instructions at 8 KB on `plan.proposed`, and a cut there would lose the artifact shape). */
export const COMPOSE_INSTRUCTIONS_MAX_BYTES = 7600;

export const ProductComposeSchema = z
  .object({
    requirements: z
      .array(z.object({ repoId: z.string().min(1), key: z.string().min(1) }).strict())
      .min(1)
      .max(COMPOSE_MAX_REQUIREMENTS),
    /** The operator's own steer for the draft (grouping, scope, tone). */
    instructions: z.string().max(500).optional(),
  })
  .strict();

const oneLine = (s: string): string => s.replace(/\s+/gu, ' ').trim();
/** `s` cut to at most `max` UTF-8 bytes on a character boundary, `…` marking a cut. */
function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}

/** The draft step's instructions: the requirements as the server read them, and the artifact. */
export function composeInstructions(
  projectId: string,
  rows: ReadonlyArray<{ repoId: string; key: string; title: string; statement: string }>,
  steer: string | undefined,
): string {
  const head = `Compose a product plan for project ${projectId} from these ${rows.length} requirement(s):`;
  const steerLines = steer !== undefined && steer.trim() !== '' ? ['', `Operator's steer: ${oneLine(steer)}`] : [];
  const tail = [
    '',
    'Group them into epics, each epic into features, each feature into user stories with acceptance',
    'criteria. Every feature names the requirement refs it covers ({"repoId","key"}, exactly as listed);',
    'every listed requirement is covered at least once, and nothing is invented that no requirement asks for.',
    'Do not create issues or change any repository. End with ONE fenced ```json block, the plan:',
    '{"epics":[{"title":"","features":[{"title":"","requirementRefs":[{"repoId":"","key":""}],',
    '"stories":[{"title":"","acceptance":[""]}]}]}]}',
  ];
  // Whatever the selection, the whole text fits: the fixed parts first, then every requirement
  // gets an equal share of what is left (a long title is cut, a requirement is never dropped).
  const fixed = Buffer.byteLength([head, ...steerLines, ...tail].join('\n'), 'utf8') + rows.length;
  const perLine = Math.max(48, Math.floor((COMPOSE_INSTRUCTIONS_MAX_BYTES - fixed) / Math.max(1, rows.length)));
  const lines = rows.map((r) => clipBytes(`- ${r.repoId} ${r.key}: ${oneLine(`${r.title} — ${r.statement}`)}`, perLine));
  return [head, ...lines, ...steerLines, ...tail].join('\n');
}

const REVIEW_INSTRUCTIONS =
  "Review the drafted product plan against the requirements it was drafted from: every listed requirement is covered, every feature's requirementRefs exist in the list, nothing is invented, the stories are testable. The plan must be one well-formed fenced JSON block. A gap or an invented item is a FAIL naming it.";

export function registerProductRoutes(app: FastifyInstance, adapter: CoreAdapter): void {
  app.post(
    `${V}/projects/:id/product/compose`,
    { config: { manifest: { requestType: 'ProductComposeBody', responseType: 'ProductComposeResponse', statusCodes: [202, 400, 404, 409, 422, 501] } } },
    async (req: FastifyRequest, reply) => {
      const { id } = req.params as { id: string };
      const parsed = ProductComposeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
      let members;
      try {
        members = await membersOf(adapter, id);
      } catch (err) {
        if (err instanceof AggregateHttpError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
      // Every selected requirement is re-read HERE, from its repo's artifact: an unknown repo, a
      // repo that is not this project's, or a key the artifact does not hold is refused before
      // anything launches, and named.
      const rows: Array<{ repoId: string; key: string; title: string; statement: string }> = [];
      const unknown: Array<{ repoId: string; key: string; reason: string }> = [];
      for (const ref of parsed.data.requirements) {
        const repo = members.find((m) => m.ref === ref.repoId)?.repo ?? null;
        if (repo === null) {
          unknown.push({ ...ref, reason: 'not a registered repository of this project' });
          continue;
        }
        const detail = await getRequirement(repo, ref.key);
        if (detail === null) unknown.push({ ...ref, reason: 'no such requirement in the repository' });
        else rows.push({ ...ref, title: detail.title, statement: detail.statement });
      }
      if (unknown.length > 0) {
        return reply.code(400).send({ error: 'Unknown requirements: nothing was launched', unknown });
      }
      const launch = await app.inject({
        method: 'POST',
        url: `${V}/runs`,
        // The caller's own credentials: the launch is THEIR run, audited as theirs.
        headers: {
          'content-type': 'application/json',
          ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
          ...(req.headers.cookie !== undefined ? { cookie: req.headers.cookie } : {}),
        },
        payload: {
          problem: `Compose the product plan for project ${id} (${rows.length} requirement(s))`,
          projectId: id,
          deliver: 'none',
          plan: {
            steps: [
              { catalog: 'produce', id: 'draft', instructions: composeInstructions(id, rows, parsed.data.instructions) },
              { catalog: 'review', id: 'review', gate: { human_confirm: { unconditional: true } }, instructions: REVIEW_INSTRUCTIONS },
            ],
          },
        },
      });
      // POST /runs' own refusal (no eligible seat, a busy engine, an archived project, …) is
      // relayed as it answered; its 201 `{runId}` becomes this route's 202.
      const body = launch.json() as Record<string, unknown>;
      if (launch.statusCode !== 201) return reply.code(launch.statusCode).send(body);
      return reply.code(202).send({ runId: body['runId'], requirements: rows.length });
    },
  );
}
