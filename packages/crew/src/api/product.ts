/**
 * crew#372 slice 2: `POST /api/v1/projects/:id/product/compose` — draft epics → features → stories
 * from a project's selected requirements, as a GOVERNED RUN (design: DES-W4-CR5, posted on the
 * issue). There is no new execution path: the route re-reads every selected requirement on the
 * server (client text is never trusted), composes a two-step plan over the phase catalog —
 * `produce` (creator: the draft) then `critique` (evaluator, a human gate before anything leaves) —
 * and launches it through `POST /runs` itself, so the run gets the same roster, project filing,
 * audit and launch policy as any other run. `deliver: "none"`: nothing is published here.
 *
 * Why `critique` and not `review` (F34): a compose run has no repository, so it has no worktree.
 * The catalog's `review` entry carries the evidence floor pin ("the run left a change in its
 * worktree"), and the engine fails a pin closed when there is no worktree to re-verify it against,
 * so a `review` step here could never pass. `critique` is the evaluator the engine's own band
 * floor picks for a plan that writes no code; the step keeps its distinct evaluator (whose own
 * VERDICT gates it) and the human gate. No step of this plan may carry a validator pin.
 *
 * Publish (the second half of #372) is NOT registered: it is a remote write whose "published" must
 * be re-derived from a deterministic created-issue manifest plus a read-back, which does not exist
 * yet. An absent route is the honest answer until it does.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from '../zod.js';

import type { CoreAdapter } from '../core/adapter.js';
import type { Actor } from '../core/types.js';
import { CATALOG_V2_CARDS } from '../workflow-catalog/catalog-data-v2.js';
import { LaunchShapeSchema } from '../workflow-catalog/shape.js';
import { LOCAL_ACTOR } from './auth.js';
import { codeGraphErrorStatus } from '../core/repoPaths.js';
import { AggregateHttpError, membersOf } from './project-aggregates.js';
import { getRequirement } from './requirements.js';

const V = '/api/v1';

/** At most this many requirements per compose: the step instructions ride `plan.proposed`, which
 *  the engine caps at 8 KB, and every line here must reach the drafting seat whole. */
export const COMPOSE_MAX_REQUIREMENTS = 40;
/** The draft step's instructions stay under this many UTF-8 bytes (the engine caps a step's
 *  instructions at 8 KB on `plan.proposed`, and a cut there would lose the artifact shape). */
export const COMPOSE_INSTRUCTIONS_MAX_BYTES = 7600;

export const ProductComposeSchema = z.strictObject({
  requirements: z
    .array(z.strictObject({ repoId: z.string().min(1), key: z.string().min(1) }))
    .min(1)
    .max(COMPOSE_MAX_REQUIREMENTS),
  /** The operator's own steer for the draft (grouping, scope, tone). */
  instructions: z.string().max(500).optional(),
  /** (api-types 0.192.0, DES-CATALOG-002 §4.4) What this compose is the shape of: a Backlog option, whose compose level
   *  decides how far down the draft goes. */
  shape: LaunchShapeSchema.optional(),
});

/** How far down a draft goes (DES-CATALOG-002 §3.1 Backlog): epics, stories (today's default), or tasks too. */
export type ComposeLevel = 'epics' | 'stories' | 'tasks';

/** The compose level a Backlog shape names (the seed's own data; the shape itself is judged by the shared launch). */
export function composeLevelOf(shape: { card: string; option: string | null } | undefined): ComposeLevel {
  if (shape === undefined) return 'stories';
  const card = CATALOG_V2_CARDS.find((c) => c.id === shape.card);
  const option = card?.variant?.options.find((o) => o.id === (shape.option ?? card.variant!.default));
  return option?.compose?.level ?? 'stories';
}

const LEVEL_LINES: Readonly<Record<ComposeLevel, string>> = {
  epics: 'Level: epics. Draft the epics and their features only; leave the stories out (features: [] stories).',
  stories: '',
  tasks: 'Level: tasks. Under every story, add its tasks: `tasks: [{title}]`, each small enough for one change, traced to the story.',
};

/** What a compose launches with besides its body: crew's own, never a client's. */
export interface ComposeLaunchExtra {
  /** A chat job's launch fields (`jobLaunchCommon`): its derived run id (a retry adopts it), chat, seats, QE as shown
   *  and a reshape's lineage. Merged into the launch; the shape stays the body's. */
  common?: Record<string, unknown>;
  fromProposal?: string;
  /** Hold the run at its plan (a chat launch always does). */
  humanConfirm?: string;
}

/** The shared launch function's shape here (DES-CHAT-FIRST-001 C3): the routes module passes its own. */
export type ComposeLaunchRun = (raw: unknown, ctx: { actor: Actor; log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>; fromProposal?: string; target?: 'compose' }) => Promise<{ statusCode: number; payload: unknown }>;

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

type ComposeRow = { repoId: string; key: string; title: string; statement: string };

/** The selection does not fit the step cap even with every description cut: its refs alone are
 *  too long. The route answers 400 (smaller selection) rather than hand a seat clipped refs. */
export class ComposeSelectionTooLargeError extends Error {}

/**
 * The step's instructions: `head`, the requirement list, `tail`, under the byte budget. Every
 * requirement keeps its line with its ref WHOLE (`- <repoId> <key>: `, codex review of the compose PR): only the
 * descriptive text shares what is left, equally. Throws {@link ComposeSelectionTooLargeError} when
 * the refs alone do not fit.
 */
function withRequirements(head: string, rows: ReadonlyArray<ComposeRow>, tail: readonly string[]): string {
  const fixed = Buffer.byteLength([head, ...tail].join('\n'), 'utf8') + rows.length;
  const prefixes = rows.map((r) => `- ${r.repoId} ${r.key}: `);
  const refBytes = prefixes.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0);
  const spare = COMPOSE_INSTRUCTIONS_MAX_BYTES - fixed - refBytes;
  if (spare < rows.length * 8) throw new ComposeSelectionTooLargeError('the selected requirement refs alone exceed the step instructions budget');
  const perText = Math.floor(spare / Math.max(1, rows.length));
  const lines = rows.map((r, i) => prefixes[i]! + clipBytes(oneLine(`${r.title} — ${r.statement}`), perText));
  return [head, ...lines, ...tail].join('\n');
}

/** The draft step's instructions: the requirements as the server read them, and the artifact. */
export function composeInstructions(projectId: string, rows: ReadonlyArray<ComposeRow>, steer: string | undefined): string {
  const head = `Compose a product plan for project ${projectId} from these ${rows.length} requirement(s):`;
  return withRequirements(head, rows, [
    ...(steer !== undefined && steer.trim() !== '' ? ['', `Operator's steer: ${oneLine(steer)}`] : []),
    '',
    'Group them into epics, each epic into features, each feature into user stories with acceptance',
    'criteria. Every feature names the requirement refs it covers ({"repoId","key"}, exactly as listed);',
    'every listed requirement is covered at least once, and nothing is invented that no requirement asks for.',
    'Do not create issues or change any repository. End with ONE fenced ```json block, the plan:',
    '{"epics":[{"title":"","features":[{"title":"","requirementRefs":[{"repoId":"","key":""}],',
    '"stories":[{"title":"","acceptance":[""]}]}]}]}',
  ]);
}

/** The review step's instructions: the SAME requirement list (codex review of the compose PR: the engine hands the
 *  evaluator the draft's output, not the draft's instructions), so a gap or an invented ref is
 *  checkable against what was selected. */
export function reviewInstructions(projectId: string, rows: ReadonlyArray<ComposeRow>): string {
  return withRequirements(`Review the drafted product plan for project ${projectId} against the ${rows.length} requirement(s) it was drafted from:`, rows, [
    '',
    "Every listed requirement is covered at least once; every feature's requirementRefs are refs from this list,",
    'exactly; nothing is invented that no requirement asks for; the stories are testable; the plan is ONE',
    'well-formed fenced JSON block. A gap, an unknown ref or an invented item is a FAIL naming it.',
  ]);
}

/**
 * (DES-CATALOG-002 §4.6) What a compose of these requirements would refuse, checked before anything changes (a chat
 * reshape answers its held plan only for a launch that can start): the project, each requirement's repository being one
 * of its members, and each key existing. `null` = it would launch.
 */
export async function composePreflight(adapter: CoreAdapter, id: string, refs: ReadonlyArray<{ repoId: string; key: string }>, instructions?: string): Promise<string | null> {
  if (refs.length === 0) return 'pick at least one requirement';
  if (refs.length > COMPOSE_MAX_REQUIREMENTS) return `pick at most ${COMPOSE_MAX_REQUIREMENTS} requirements`;
  let members;
  try {
    members = await membersOf(adapter, id);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const rows: Array<{ repoId: string; key: string; title: string; statement: string }> = [];
  for (const ref of refs) {
    const repo = members.find((m) => m.ref === ref.repoId)?.repo ?? null;
    if (repo === null) return `${ref.repoId} is not a registered repository of this project`;
    try {
      const detail = await getRequirement(repo, ref.key, adapter);
      if (detail === null) return `${ref.repoId} has no requirement ${ref.key}`;
      rows.push({ ...ref, title: detail.title, statement: detail.statement });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  // The same instruction builders the launch runs, so their budget refuses here, before anything changes (codex r5).
  try {
    composeInstructions(id, rows, instructions);
    reviewInstructions(id, rows);
  } catch (err) {
    if (err instanceof ComposeSelectionTooLargeError) return `${err.message}: select fewer requirements`;
    throw err;
  }
  return null;
}

/**
 * One compose launch (DES-CATALOG-002 §4.6: the `compose` launcher): the route's and a chat Backlog job's Go. Every
 * requirement is re-read from its repository first; then the shared launch function runs the plan, judging the shape
 * as a compose.
 */
export async function composeLaunch(
  adapter: CoreAdapter,
  launchRun: ComposeLaunchRun,
  id: string,
  body: unknown,
  ctx: { actor: Actor; log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'> },
  extra: ComposeLaunchExtra = {},
): Promise<{ code: number; body: unknown }> {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code(n: number) { this.statusCode = n; return this; },
    send(p: unknown) { this.payload = p; return { code: this.statusCode, body: p }; },
  };
  {
    {
      const parsed = ProductComposeSchema.safeParse(body);
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
        let detail: Awaited<ReturnType<typeof getRequirement>>;
        try {
          detail = await getRequirement(repo, ref.key, adapter);
        } catch (err) {
          // A repo whose daemon resolved no graph root is the same 503 as the repo surfaces.
          const status = codeGraphErrorStatus(err);
          if (status === null) throw err;
          return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
        }
        if (detail === null) unknown.push({ ...ref, reason: 'no such requirement in the repository' });
        else rows.push({ ...ref, title: detail.title, statement: detail.statement });
      }
      if (unknown.length > 0) {
        return reply.code(400).send({ error: 'Unknown requirements: nothing was launched', unknown });
      }
      let draft: string;
      let review: string;
      const level = composeLevelOf(parsed.data.shape);
      try {
        draft = composeInstructions(id, rows, parsed.data.instructions);
        if (LEVEL_LINES[level] !== '') draft = `${draft}\n\n${LEVEL_LINES[level]}`;
        review = reviewInstructions(id, rows);
      } catch (err) {
        if (err instanceof ComposeSelectionTooLargeError) {
          return reply.code(400).send({ error: `${err.message}: select fewer requirements; nothing was launched` });
        }
        throw err;
      }
      // The shared launch function (DES-CHAT-FIRST-001 C3), as the caller: the launch is THEIR run, audited as theirs.
      const launch = await launchRun(
        {
          problem: `Compose the product plan for project ${id} (${rows.length} requirement(s))`,
          projectId: id,
          deliver: 'none',
          ...Object.fromEntries(Object.entries(extra.common ?? {}).filter(([k]) => k !== 'shape')),
          ...(extra.humanConfirm !== undefined ? { humanConfirm: extra.humanConfirm } : {}),
          ...(parsed.data.shape !== undefined ? { shape: parsed.data.shape } : {}),
          plan: {
            steps: [
              { catalog: 'produce', id: 'draft', instructions: draft },
              // `critique`, never `review`: the review entry's evidence floor needs a worktree diff (F34).
              { catalog: 'critique', id: 'review', gate: { human_confirm: { unconditional: true } }, instructions: review },
            ],
          },
        },
        { ...ctx, target: 'compose', ...(extra.fromProposal !== undefined ? { fromProposal: extra.fromProposal } : {}) },
      );
      // POST /runs' own refusal (no eligible seat, a busy engine, an archived project, …) is
      // relayed as it answered; its 201 `{runId}` becomes this route's 202.
      const out = launch.payload as Record<string, unknown>;
      if (launch.statusCode !== 201) return reply.code(launch.statusCode).send(out);
      return reply.code(202).send({ runId: out['runId'], requirements: rows.length });
    }
  }
}

export function registerProductRoutes(app: FastifyInstance, adapter: CoreAdapter, launchRun: ComposeLaunchRun): void {
  app.post(
    `${V}/projects/:id/product/compose`,
    { config: { manifest: { requestType: 'ProductComposeBody', responseType: 'ProductComposeResponse', statusCodes: [202, 400, 404, 409, 422, 501, 503] } } },
    async (req: FastifyRequest & { actor?: Actor }, reply) => {
      const { id } = req.params as { id: string };
      const out = await composeLaunch(adapter, launchRun, id, req.body, { actor: req.actor ?? LOCAL_ACTOR, log: req.log });
      return reply.code(out.code).send(out.body);
    },
  );
}
