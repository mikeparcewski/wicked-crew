/**
 * Studio OS behaviour 8, "Capture anything": transcripts, photos and notes become intents,
 * decisions and memories in the right project — PROPOSED, never silently learned.
 *
 *   POST /projects/:id/capture   notes + text files + photos land in a per-run inbox on the daemon
 *                                host, and a small repo-less team run is launched THROUGH `POST /runs`
 *                                (one launch path: membership, the state-home and roster checks, the
 *                                audit trail), filed to the project, one read-only `understand` step.
 *                                The run's only output is proposals in the EXISTING estate queue
 *                                (`proposal.submit`), reviewed on `/proposals` like everything else.
 *
 * And the review's "edit" verb, {@link approveEdited}: estate has no proposal edit, so an accept WITH
 * an edit submits the edited copy to the same queue, approves the copy, then rejects the original.
 *
 * Confidentiality ("patterns cross projects; client details never do") is estate's facet admission:
 * a memory faceted `project:<id>` is recalled only under an intent naming that project, and the
 * garden shim stamps the run's project onto every proposal it files. Crossing projects is therefore
 * only ever a human accept that names `reach: "pattern"`, on a memory-class capture — the copy then
 * drops its `project`/`repo` facets. Everything else (what is an intent, a decision, a memory; which
 * seat reads the photo) is the team's judgment, stated in the brief, not code here.
 */

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from './api-prefix.js';

const V = API_PREFIX;

/** Notes are prose; a transcript is the biggest thing a person pastes. */
export const CAPTURE_NOTES_MAX_BYTES = 256 * 1024;
/** One dropped text file (a transcript, a meeting note). */
export const CAPTURE_TEXT_MAX_BYTES = 512 * 1024;
/** One decoded photo — a phone camera JPEG fits with room. */
export const CAPTURE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Every decoded byte of one capture together. */
export const CAPTURE_TOTAL_MAX_BYTES = 24 * 1024 * 1024;
export const CAPTURE_MAX_FILES = 8;
/** The route's JSON body limit: the decoded total as base64 (4/3) plus the JSON around it. */
export const CAPTURE_BODY_LIMIT = Math.ceil((CAPTURE_TOTAL_MAX_BYTES * 4) / 3) + 1024 * 1024;

/** The image types a vision-capable seat reads, and the extension each lands with. */
export const CAPTURE_IMAGE_TYPES: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
};

const NameSchema = z.string().min(1).max(128);
const CaptureTextFileSchema = z.object({ name: NameSchema, text: z.string() }).strict();
const CaptureImageFileSchema = z
  .object({ name: NameSchema, mediaType: z.string().min(1), dataBase64: z.string().min(1) })
  .strict();

export const CaptureSchema = z
  .object({
    notes: z.string().optional(),
    files: z.array(z.union([CaptureTextFileSchema, CaptureImageFileSchema])).max(CAPTURE_MAX_FILES).optional(),
  })
  .strict();

/** `POST /proposals/:id/approve` body — present only for an accept WITH an edit. */
export const ApproveEditSchema = z
  .object({
    content: z.string().trim().min(1).max(16 * 1024).optional(),
    reach: z.enum(['project', 'pattern']).optional(),
  })
  .strict();

/** Where a capture's materials land: a per-run inbox on the daemon host (the steering-author
 *  pattern — runs read the daemon's filesystem; only paths ride the problem statement). */
export function captureInboxDir(runId: string): string {
  if (process.env.WICKED_CAPTURE_INBOX_DIR) return join(process.env.WICKED_CAPTURE_INBOX_DIR, runId);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
  return join(home, '.wicked', 'capture-inbox', runId);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Caller names are display text, never paths: basename + charset scrub + an index prefix. */
function safeName(index: number, name: string, forceExt?: readonly string[]): string {
  let scrubbed = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (forceExt !== undefined && !forceExt.includes(extname(scrubbed).toLowerCase())) {
    scrubbed = `${scrubbed}${forceExt[0]}`;
  }
  return `${index}-${scrubbed}`;
}

/** The brief the capture run reads: the materials and the filing contract, in one file so the
 *  problem statement stays one short line. */
export function captureBrief(projectId: string, paths: readonly string[]): string {
  const project = JSON.stringify({ project: projectId });
  return [
    `# Capture brief — project ${projectId}`,
    '',
    `The user dropped these materials on project ${projectId}. Read every one; an image needs a`,
    'vision-capable read (open the file and look at it — a whiteboard photo is text and diagrams).',
    '',
    ...paths.map((p) => `- ${p}`),
    '',
    "File what they contain as proposals for the user's review — nothing you file is used until",
    'the user accepts it. One proposal per item, through the estate proposal tool (the wicked-garden',
    "estate shim: `wicked-garden run scripts/_estate_client.py --readonly propose '<json>'`, or the",
    'wicked-estate `proposal.submit` tool), with kind_type "memory" and:',
    '',
    `- an INTENT — work the user wants done next, one sentence someone could launch: payload {"content":"…","tier":"episodic","capture":"intent"}, facets ${project}`,
    `- a DECISION — a choice that was made, and why: payload {"content":"…","tier":"semantic","capture":"decision"}, facets ${project}`,
    `- a MEMORY — a durable fact or way of working: payload {"content":"…","tier":"semantic" or "procedural","capture":"memory"}, facets ${project}.`,
    '  If it is a general pattern that would help on ANY project, write it with no client names, people,',
    '  systems or data and add "reach":"pattern" to the payload — the user decides whether it crosses projects.',
    `- a RULE the team must follow from now on: kind_type "policy:<architecture|development|security|testing|operations|compliance|design-ux>", payload {"rule":"…","severity":"info|warn|error|critical","capture":"rule"}, facets ${project}`,
    '',
    'File only what the materials say; never invent. Never include secrets, credentials or personal',
    'data. Filing nothing is fine. Change no code and no file. Report what you filed.',
    '',
  ].join('\n');
}

type Material = { file: string; bytes: Buffer };

/** Validate and lay out the capture's materials, or name the first refusal (a 400). */
function materialsOf(body: z.infer<typeof CaptureSchema>): Material[] | string {
  const out: Material[] = [];
  let total = 0;
  const notes = body.notes ?? '';
  if (notes.trim() !== '') {
    const bytes = Buffer.from(notes, 'utf8');
    if (bytes.length > CAPTURE_NOTES_MAX_BYTES) {
      return `notes is ${bytes.length} bytes, over the ${CAPTURE_NOTES_MAX_BYTES}-byte cap — drop a long transcript as a file`;
    }
    out.push({ file: safeName(out.length, 'notes.md'), bytes });
    total += bytes.length;
  }
  for (const [i, f] of (body.files ?? []).entries()) {
    let bytes: Buffer;
    let file: string;
    if ('text' in f) {
      bytes = Buffer.from(f.text, 'utf8');
      if (bytes.length > CAPTURE_TEXT_MAX_BYTES) {
        return `files[${i}] is ${bytes.length} bytes, over the ${CAPTURE_TEXT_MAX_BYTES}-byte per-file cap`;
      }
      file = safeName(out.length, f.name);
    } else {
      const exts = CAPTURE_IMAGE_TYPES[f.mediaType];
      if (exts === undefined) {
        return `files[${i}]: mediaType ${JSON.stringify(f.mediaType)} is not one a vision seat reads — use one of ${Object.keys(CAPTURE_IMAGE_TYPES).join(', ')}`;
      }
      if (f.dataBase64.length % 4 !== 0 || !BASE64.test(f.dataBase64)) {
        return `files[${i}]: dataBase64 is not base64`;
      }
      bytes = Buffer.from(f.dataBase64, 'base64');
      if (bytes.length > CAPTURE_IMAGE_MAX_BYTES) {
        return `files[${i}] is ${bytes.length} bytes, over the ${CAPTURE_IMAGE_MAX_BYTES}-byte per-image cap`;
      }
      file = safeName(out.length, f.name, exts);
    }
    if (bytes.length === 0) return `files[${i}] is empty`;
    total += bytes.length;
    out.push({ file, bytes });
  }
  if (out.length === 0) return 'a capture needs notes or at least one file';
  if (total > CAPTURE_TOTAL_MAX_BYTES) {
    return `the capture is ${total} bytes, over the ${CAPTURE_TOTAL_MAX_BYTES}-byte total cap`;
  }
  return out;
}

export function registerCaptureRoutes(app: FastifyInstance): void {
  app.post(
    `${V}/projects/:id/capture`,
    {
      bodyLimit: CAPTURE_BODY_LIMIT,
      config: {
        manifest: {
          requestType: 'CaptureBody',
          responseType: 'CaptureResponse',
          // Every non-201 besides the body 400s is POST /runs' own answer, passed through.
          statusCodes: [201, 400, 404, 409, 422, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = CaptureSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid capture body', details: parsed.error.issues });
      }
      const materials = materialsOf(parsed.data);
      if (typeof materials === 'string') return reply.code(400).send({ error: materials });
      const projectId = (req.params as { id: string }).id;
      const runId = randomUUID();
      const dir = captureInboxDir(runId);
      await fsp.mkdir(dir, { recursive: true });
      const paths: string[] = [];
      for (const m of materials) {
        const target = join(dir, m.file);
        await fsp.writeFile(target, m.bytes);
        paths.push(target);
      }
      const briefPath = join(dir, 'CAPTURE.md');
      await fsp.writeFile(briefPath, captureBrief(projectId, paths), 'utf8');
      // The launch IS `POST /runs` — injected, so this route owns no second launch path.
      const auth = req.headers.authorization;
      const launched = await app.inject({
        method: 'POST',
        url: `${V}/runs`,
        headers: { 'content-type': 'application/json', ...(auth !== undefined ? { authorization: auth } : {}) },
        payload: {
          problem: `Capture for project ${projectId}: follow the capture brief at ${briefPath} — read every material it lists and file what they contain as proposals for the user's review. Change no code and no file.`,
          sessionId: runId,
          projectId,
          plan: { steps: [{ catalog: 'understand', id: 'capture' }] },
          deliver: 'none',
        },
      });
      if (launched.statusCode !== 201) {
        await fsp.rm(dir, { recursive: true, force: true });
        return reply.code(launched.statusCode).type('application/json').send(launched.body);
      }
      return reply.code(201).send({ runId });
    },
  );
}

type EstateTool = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** The outcome of {@link approveEdited}: an HTTP status and its body. */
export type EditedApproval = { status: number; body: Record<string, unknown> };

/**
 * Accept a pending MEMORY proposal WITH an edit — submit the edited copy, approve the copy, then
 * reject the original — and return the copy's approve outcome plus `edited: {from, to}`. The
 * original stays pending until the copy is approved, so a failed approve loses nothing; a reject
 * that fails AFTER the approve answers 200 with `edited.originalPending: true` (the edit landed;
 * the original is still in the queue for the person to reject), never a 502 inviting a retry that
 * would promote a second copy. A
 * `reach: "pattern"` copy drops the `project` and `repo` facets (it may now be recalled on any
 * project); it is refused on a decision or an intent, which are always the project's. A
 * `reach: "project"` row keeps (or, when the worker filed none, gains) the project facet — the
 * capture run's project, read from `projectOf(provenance.run_id)`. When nothing changes, the
 * original is approved as filed (no copy).
 */
export async function approveEdited(
  estateTool: EstateTool,
  id: string,
  edit: z.infer<typeof ApproveEditSchema>,
  projectOf: (runId: string) => string | undefined,
): Promise<EditedApproval> {
  const listed = (await estateTool('proposal.list', { state: 'pending' })) as {
    proposals?: {
      id: string;
      kind_type: string;
      payload: unknown;
      facets: Record<string, string>;
      provenance?: Record<string, string>;
    }[];
  };
  const row = (listed.proposals ?? []).find((p) => p.id === id);
  if (row === undefined) return { status: 404, body: { error: `no pending proposal ${id}` } };
  if (row.kind_type !== 'memory') {
    return {
      status: 400,
      body: { error: `only a memory proposal can be accepted with an edit (this is ${row.kind_type}); accept or reject it as filed` },
    };
  }
  const payload = { ...(typeof row.payload === 'object' && row.payload !== null ? row.payload : {}) } as Record<string, unknown>;
  const capture = payload['capture'];
  if (edit.reach === 'pattern' && (capture === 'decision' || capture === 'intent')) {
    return { status: 400, body: { error: `a ${capture} stays with its project — only a memory can cross projects` } };
  }
  const facets = { ...row.facets };
  if (edit.reach === 'pattern') {
    delete facets['project'];
    delete facets['repo'];
  } else if (edit.reach === 'project' && facets['project'] === undefined) {
    const runId = row.provenance?.['run_id'];
    const project = runId === undefined ? undefined : projectOf(runId);
    if (project === undefined) {
      return { status: 400, body: { error: `proposal ${id} names no project to keep it in, and no project files the run that proposed it` } };
    }
    facets['project'] = project;
  }
  const sameFacets =
    Object.keys(facets).length === Object.keys(row.facets).length &&
    Object.entries(facets).every(([k, v]) => row.facets[k] === v);
  if ((edit.content === undefined || edit.content === payload['content']) && sameFacets) {
    // Nothing the store keeps would change: approve the original as filed.
    return { status: 200, body: (await estateTool('proposal.approve', { id })) as Record<string, unknown> };
  }
  if (edit.content !== undefined) payload['content'] = edit.content;
  if (edit.reach !== undefined) payload['reach'] = edit.reach;
  payload['edited_from'] = id;
  const submitted = (await estateTool('proposal.submit', { kind_type: 'memory', payload, facets })) as { id?: unknown };
  if (typeof submitted.id !== 'string' || submitted.id === '') {
    throw new Error('proposal.submit returned no id for the edited copy');
  }
  const approved = (await estateTool('proposal.approve', { id: submitted.id })) as Record<string, unknown>;
  const edited: Record<string, unknown> = { from: id, to: submitted.id };
  try {
    await estateTool('proposal.reject', { id });
  } catch {
    edited['originalPending'] = true;
  }
  return { status: 200, body: { ...approved, edited } };
}
