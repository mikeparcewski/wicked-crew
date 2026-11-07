/**
 * `GET /api/v1/projects/:projectId/interactive/docs/:doc/checks?version=` — the ONE checks read of
 * a document (DES-artifact-editor-plugins §4, §5.8, §7.6; EP-C2).
 *
 * Every verdict behind it is a wicked-ledger row stamped with the crew run that produced it: the
 * rows the interactive-review seam records in the document's review root (`review-ledger.ts`),
 * read here as canonical JSON, read-only, exactly as the seam read them back before it announced
 * them. There is no second verdict store, and nothing here writes.
 *
 * Per reviewer the answer is the newest verdict AT OR BELOW the version asked for (every version
 * when the query names none): a newer review replaces an older one, and an older one stays visible
 * — "on version N" — until then. A ledger that cannot be read is a 500 naming why, never an empty
 * list pretending the document was never reviewed.
 *
 * `demo-review` is not served here: a demo run is not bound to a document any more (demos are made
 * by the `demo` preset), and its reviewer's verdict already reads from `GET /runs/:id/demo`
 * (`DemoView.review`).
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DocCheck, DocCheckFinding, DocCheckSource, DocChecksResponse, DocFloorCheck, DocNotes, DocReviewerId } from 'wicked-crew-api-types';
import { UNFILED_MOUNT } from '../api/chat-context.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { ProjectsUnsupportedError, type CoreAdapter } from '../core/adapter.js';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import { readDocReviewVerdicts, type DocReviewLedgerRow } from '../qe/ledger.js';
import { DOC_NAME } from './draft-events.js';
import { reviewRootOf } from './review-ledger.js';
import type { LandingRecordStore } from './landing-record.js';

const V = API_PREFIX;

const SOURCE: Record<DocReviewerId, DocCheckSource> = { match: 'review:intent', a11y: 'review:a11y', copy: 'review:copy', qe: 'review:quality' };
const ORDER: DocReviewerId[] = ['match', 'a11y', 'copy', 'qe'];
const isReviewer = (v: string): v is DocReviewerId => Object.hasOwn(SOURCE, v);
const cliKey = (seat: string): string => (seat.includes('#') ? seat.slice(0, seat.indexOf('#')) : seat);

function findingsOf(raw: unknown[]): DocCheckFinding[] {
  const out: DocCheckFinding[] = [];
  for (const f of raw) {
    if (typeof f !== 'object' || f === null) continue;
    const r = f as Record<string, unknown>;
    if (typeof r['sentence'] !== 'string' || r['sentence'] === '') continue;
    out.push({
      wid: typeof r['wid'] === 'string' && r['wid'] !== '' ? r['wid'] : null,
      severity: r['severity'] === 'low' || r['severity'] === 'high' ? r['severity'] : 'medium',
      sentence: r['sentence'],
    });
  }
  return out;
}

/** A recorded review verdict as the checks panel shows it. */
export function docCheckOf(row: DocReviewLedgerRow & { reviewer: DocReviewerId }): DocCheck {
  return {
    id: row.id,
    source: SOURCE[row.reviewer],
    reviewer: row.reviewer,
    version: row.version,
    state: row.reviewVerdict === 'pass' ? 'pass' : row.reviewVerdict === 'changes' ? 'fail' : 'inconclusive',
    sentence: row.reason ?? '',
    findings: findingsOf(row.findings),
    by: {
      seat: row.seat,
      evaluator: row.authorKnown && row.seat !== null && !row.excludedSeats.map(cliKey).includes(cliKey(row.seat)),
      excluded_seats: row.excludedSeats,
      author_known: row.authorKnown,
    },
    skill: row.skill,
    run_id: row.runId,
    at: row.createdAt,
  };
}

/**
 * Per reviewer, the verdict of the HIGHEST version at or below `version` (any version when `null`),
 * newest first within a version; in the reviewers' display order.
 */
export function newestPerReviewer(rows: readonly DocReviewLedgerRow[], version: number | null): DocCheck[] {
  const best = new Map<DocReviewerId, DocReviewLedgerRow & { reviewer: DocReviewerId }>();
  for (const row of rows) {
    if (!isReviewer(row.reviewer)) continue;
    if (version !== null && row.version > version) continue;
    const cur = best.get(row.reviewer);
    if (cur === undefined || row.version > cur.version || (row.version === cur.version && row.createdAt > cur.createdAt)) {
      best.set(row.reviewer, row as DocReviewLedgerRow & { reviewer: DocReviewerId });
    }
  }
  return ORDER.flatMap((id) => {
    const row = best.get(id);
    return row !== undefined ? [docCheckOf(row)] : [];
  });
}

export interface DocChecksDeps {
  /** Where every document's review root lives (`<handoff root>/_reviews`), read at request time. */
  reviewsDir: () => string;
  /** A6 / G12: the per-run record of what crew checked before a version landed (floor, notes). Absent = not served. */
  landings?: LandingRecordStore;
  /** The docs root of a route project (`default` = Unfiled), where the document's version lineage is read. */
  docsRoot?: (projectId: string) => Promise<string | null>;
  log?: (msg: string) => void;
}

/** One version of a document's lineage: its parent and the run that made it (`null` = by hand; absent = not recorded). */
export interface LineageEntry {
  parent: number | null;
  runId: string | null | undefined;
}

/** A document's head and lineage, read from its `versions.json` beneath the docs root (no link followed); `null` when
 *  it cannot be read. */
export function readLineage(docsRoot: string, doc: string): { head: number; versions: Map<number, LineageEntry> } | null {
  if (!DOC_NAME.test(doc)) return null;
  try {
    // A plain read (codex r1: `readBeneath` refuses Windows): the name is a validated slug, and the manifest is parsed
    // as data, never followed anywhere.
    const path = join(docsRoot, doc, 'versions.json');
    if (statSync(path).size > 4 * 1024 * 1024) return null;
    const m = JSON.parse(readFileSync(path, 'utf8')) as { head?: unknown; versions?: unknown };
    if (typeof m.head !== 'number' || !Number.isInteger(m.head) || m.head < 0) return null;
    const versions = new Map<number, LineageEntry>();
    for (const e of Array.isArray(m.versions) ? (m.versions as Array<Record<string, unknown>>) : []) {
      if (e === null || typeof e !== 'object' || typeof e['version'] !== 'number') continue;
      const parent = typeof e['parent'] === 'number' ? e['parent'] : null;
      const runId = !('run_id' in e) ? undefined : typeof e['run_id'] === 'string' && e['run_id'] !== '' ? e['run_id'] : null;
      versions.set(e['version'], { parent, runId });
    }
    return { head: m.head, versions };
  } catch {
    return null;
  }
}

/**
 * The notes and the floor record of `version` (DES §11.2; PLAN G12): the floor is that version's own run's (a version a
 * person made has none: "not measured"); the notes are the nearest ancestor's on the parent chain, itself included,
 * whose run recorded notes, labelled with the version they are from.
 */
export function landingFacts(
  lineage: { versions: Map<number, LineageEntry> },
  version: number,
  ref: string,
  landings: LandingRecordStore,
): { notes: DocNotes | null; floor: DocFloorCheck | null } {
  let floor: DocFloorCheck | null = null;
  let notes: DocNotes | null = null;
  const seen = new Set<number>();
  for (let v: number | null = version; v !== null && !seen.has(v); v = lineage.versions.get(v)?.parent ?? null) {
    seen.add(v);
    const runId = lineage.versions.get(v)?.runId;
    if (typeof runId !== 'string') continue;
    const rec = landings.get(ref, runId);
    if (rec === null) continue;
    if (v === version) {
      floor = { source: 'floor', version: v, run_id: runId, verdict: rec.floor.verdict, pages: rec.floor.pages, summary: rec.floor.summary, sha256: rec.sha256, at: rec.at };
    }
    if (rec.notes !== null) {
      notes = { from_version: v, run_id: runId, ...rec.notes, struck: [...(rec.struck ?? [])] };
      break;
    }
  }
  return { notes, floor };
}

export function registerInteractiveDocChecks(app: FastifyInstance, adapter: CoreAdapter, deps: DocChecksDeps): void {
  const log = deps.log ?? ((): void => undefined);
  app.get(
    `${V}/projects/:projectId/interactive/docs/:doc/checks`,
    { config: { manifest: { responseType: 'DocChecksResponse', statusCodes: [200, 400, 404, 500] } } },
    async (req, reply) => {
      const { projectId, doc } = req.params as { projectId: string; doc: string };
      if (!DOC_NAME.test(doc)) return reply.code(400).send({ error: `"${doc}" is not a document name` });
      const rawVersion = (req.query as { version?: unknown }).version;
      let version: number | null = null;
      if (rawVersion !== undefined) {
        const n = typeof rawVersion === 'string' && /^\d{1,9}$/u.test(rawVersion) ? Number(rawVersion) : NaN;
        if (!Number.isInteger(n)) return reply.code(400).send({ error: 'version must be a whole number, 0 or above' });
        version = n;
      }
      if (projectId !== DEFAULT_PROJECT_ID) {
        try {
          if ((await adapter.projectGet(projectId)) === null) return reply.code(404).send({ error: `Project ${projectId} not found` });
        } catch (err) {
          // An engine without projects files every document under Unfiled: the default partition answers.
          if (!(err instanceof ProjectsUnsupportedError)) throw err;
        }
      }
      const read = readDocReviewVerdicts(reviewRootOf(deps.reviewsDir(), projectId, doc));
      if (read.error !== undefined) {
        log(`[doc-checks] the review record of ${doc} (project ${projectId}) could not be read: ${read.error}`);
        return reply.code(500).send({ error: 'The recorded reviews of this document could not be read', detail: read.error });
      }
      const body: DocChecksResponse = { document_id: doc, version, checks: newestPerReviewer(read.rows, version) };
      // A6 / G12: the writer's notes and the floor crew measured, for the asked version (the head when none was asked).
      if (deps.landings !== undefined && deps.docsRoot !== undefined) {
        const root = await deps.docsRoot(projectId);
        const lineage = root === null ? null : readLineage(root, doc);
        if (lineage !== null) {
          const ref = `${projectId === DEFAULT_PROJECT_ID ? UNFILED_MOUNT : projectId}/${doc}`;
          Object.assign(body, landingFacts(lineage, version ?? lineage.head, ref, deps.landings));
        }
      }
      return reply.send(body);
    },
  );
}
