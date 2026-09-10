/**
 * Doc → SUBJECT-REPO grounding for the interactive seams (acceptance findings F-046 + follow-up).
 *
 * WHAT WAS WRONG: a document created in a multi-repo project was grounded on the project's FIRST
 * `crew.repo` member — a brochure about wicked-studio was drafted against a wicked-core snapshot,
 * the brief's "use the wicked-studio repo in this project" had no way to reach the seam, and the
 * thread never said which repository the worker actually saw. The bridge's create wire carries
 * `name/kind/brief/style/project` only and builds `doc.created` explicitly (server.js `POST
 * /api/docs`), so a repo named on the create request never rides the bus: crew has to remember it
 * itself, keyed by the document id the bridge answers with.
 *
 * Three things live here, shared by the proxy's create interception and the draft/demo seams:
 *
 *  1. THE REQUEST GRAMMAR — `repo_ref` (one) / `repo_refs` (several) on the create body, each a
 *     registered repo id, its registry name, or its root directory's basename; `style` from the
 *     bridge's own set, or inferred from the brief's format words when the client sent none
 *     (`inferDocStyle`) so a print/A4 brief reaches the bridge's print instructions instead of
 *     defaulting to `web`.
 *  2. THE RESOLUTION RULE (`resolveGroundingRepos`) — in preference order: the repos NAMED on the
 *     request; else the member repos the BRIEF names by name; else the project's SOLE repo; else
 *     NONE — never a silent first-member substitution. A named repo that is not (or no longer) a
 *     member is reported as `missing`, so the seam can say so on the thread and the proxy can
 *     refuse the create up front.
 *  3. THE DURABLE BINDING (`DocGroundingStore`) — a `crew-grounding.json` sidecar BESIDE THE DOC,
 *     `<docs root>/<doc>/crew-grounding.json`, written atomically (tmp + rename, the handoff-ledger
 *     discipline): the proxy records `{project, repo_refs, style}` under the doc name the bridge's
 *     create answered with, the seams read it when `doc.created` arrives. The bridge emits
 *     `doc.created` BEFORE it answers the create, and the seams poll the bus, so a seam can see the
 *     event a few ms before the proxy has recorded the binding: `beginCreate`/`settleCreate`/
 *     `waitFor` close that window in-process (proxy and seams run in the same daemon) — a seam that
 *     finds no binding but sees an unsettled create for the same project waits, bounded, for it.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CoreAdapter } from '../core/adapter.js';

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/** The bridge's own style set (server.js `POST /api/docs`: anything else is dropped to null → web). */
export const DOC_STYLES = ['web', 'ppt', 'brochure', 'doc'] as const;
export type DocStyle = (typeof DOC_STYLES)[number];

export function isDocStyle(value: unknown): value is DocStyle {
  return typeof value === 'string' && (DOC_STYLES as readonly string[]).includes(value);
}

/** Format words → the bridge style they mean. Ordered: explicit slide words beat print words
 *  ("a slide deck to print" is a deck), print words beat the prose fallback. Conservative on
 *  purpose — an unmatched brief stays `undefined` (the bridge's own `web` default); a wrong guess
 *  here would hand the worker the WRONG print contract, which is worse than none. */
const STYLE_WORDS: ReadonlyArray<readonly [DocStyle, RegExp]> = [
  ['ppt', /\b(slide ?deck|slides|deck|presentation|pitch ?deck|keynote|powerpoint|pptx)\b/i],
  ['brochure', /\b(brochure|leaflet|flyer|pamphlet|one[- ]pager|print[- ]ready|printable|a4|a3|us letter|letter[- ]size)\b/i],
  ['doc', /\b(memo|white ?paper|briefing note|plain document|prose document)\b/i],
];

/** Infer the bridge style a brief asks for by its format words, or `undefined` when it names none. */
export function inferDocStyle(brief: string): DocStyle | undefined {
  for (const [style, re] of STYLE_WORDS) if (re.test(brief)) return style;
  return undefined;
}

/** The one-line format contract a style implies — folded into the worker's problem statement so
 *  the DRAFT phase (not only the outline's legend) knows what "brochure" must mean on disk. The
 *  brochure line is the F-050/F-053 lesson: a print doc rendered as fixed slide pages with
 *  `overflow:hidden` clipped its content. */
export function styleContract(style: string): string {
  switch (style) {
    case 'web':
      return 'a rich, scrollable single web page (responsive; no fixed page or slide size)';
    case 'ppt':
      return 'fixed 16:9 landscape slides — one section per slide, nothing scrolls inside a slide';
    case 'brochure':
      return (
        'PRINT pages — honour the page size and page count the brief asks for (default A4 portrait), ' +
        'use @page rules with page breaks between pages, never a fixed slide-size viewport and never ' +
        'overflow:hidden that clips content'
      );
    case 'doc':
      return 'minimal content-first prose in a single column, no decorative chrome';
    default:
      return `the requested style "${style}"`;
  }
}

// ── The request grammar ──────────────────────────────────────────────────────────────────────

/** How many repositories one document may name. A brochure is about a product, not a monorepo
 *  census; the cap also bounds how many snapshots one launch can clone. */
export const REPO_REFS_MAX = 8;

/** A repo ref as the create body may spell it: a registry id, a repo name, or a root basename.
 *  No whitespace or control characters — the ref rides the single-line PTY problem and names a
 *  filesystem path segment after sanitizing. */
const REPO_REF = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,199}$/;

/** A failed parse still carries `requested` — the refs AS THE CLIENT SPELLED them (best-effort:
 *  non-strings stringified, capped), so the refusal can render exactly what was sent (Copilot, #506). */
export type RepoRefsParse = { ok: true; refs: string[] } | { ok: false; error: string; requested: string[] };

/** The raw spellings a body carried, for a refusal's `requested` — never used for matching. */
function spelledRefs(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    const text = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
    if (out.length < REPO_REFS_MAX * 2) out.push(text.slice(0, 200));
  };
  if (body['repo_ref'] !== undefined && body['repo_ref'] !== null) push(body['repo_ref']);
  if (body['repo_refs'] !== undefined && body['repo_refs'] !== null) {
    if (Array.isArray(body['repo_refs'])) for (const v of body['repo_refs']) push(v);
    else push(body['repo_refs']);
  }
  return out;
}

/**
 * Read `repo_ref` / `repo_refs` off a create body. Both may be present; the union is de-duplicated
 * in order. `{ok: true, refs: []}` when neither is present — the common case, nothing named.
 */
export function parseRepoRefs(body: Record<string, unknown>): RepoRefsParse {
  const fail = (error: string): RepoRefsParse => ({ ok: false, error, requested: spelledRefs(body) });
  const raw: unknown[] = [];
  if (body['repo_ref'] !== undefined && body['repo_ref'] !== null) raw.push(body['repo_ref']);
  if (body['repo_refs'] !== undefined && body['repo_refs'] !== null) {
    if (!Array.isArray(body['repo_refs'])) return fail('repo_refs must be an array of repository ids');
    raw.push(...body['repo_refs']);
  }
  const refs: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return fail('repo_ref / repo_refs entries must be strings');
    const ref = entry.trim();
    if (ref.length === 0) continue;
    if (!REPO_REF.test(ref)) {
      return fail(`repo_ref "${ref.slice(0, 40)}" is not a repository id, name, or directory name`);
    }
    if (!refs.includes(ref)) refs.push(ref);
  }
  if (refs.length > REPO_REFS_MAX) {
    return fail(`a document may name at most ${REPO_REFS_MAX} repositories (${refs.length} given)`);
  }
  return { ok: true, refs };
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────

/** A project repo a document can be grounded on: the registry identity, its human name, and the
 *  root the snapshot is cloned from (never handed to the worker directly — wicked-core#294). */
export interface GroundingRepo {
  repoRef: string;
  name: string;
  rootPath: string;
}

/** Why a launch grounds where it grounds — narrated on the thread verbatim (F-046 follow-up). */
export type GroundingSource = 'named' | 'brief' | 'sole-member' | 'none';

export interface GroundingDecision {
  repos: GroundingRepo[];
  source: GroundingSource;
  /** Named refs that resolve to no member repo (detached since the create, or never attached). */
  missing: string[];
  /** How many member repos the project has — the honest "none of N was named" note needs it. */
  memberCount: number;
}

/** The registry name a repo is known by — the `name` column when present, else its root basename. */
function repoName(repo: { id: string; name?: string | null; root_path: string }): string {
  if (typeof repo.name === 'string' && repo.name.trim().length > 0) return repo.name.trim();
  const base = basename(repo.root_path);
  return base.length > 0 ? base : repo.id;
}

/**
 * The project's `crew.repo` members verified against the repo registry (a stale membership whose
 * repo left the registry is skipped — it has no root to snapshot). `[]` when the project has no
 * repo members or the adapter cannot answer (old addon, engine hiccup): every caller degrades to an
 * ungrounded launch, narrated.
 */
export async function projectRepoCandidates(
  adapter: CoreAdapter,
  projectId: string,
  log?: (message: string) => void,
): Promise<GroundingRepo[]> {
  try {
    const members = await adapter.projectMembers(projectId);
    const refs = members.filter((m) => m.member_kind === 'crew.repo').map((m) => m.member_ref);
    if (refs.length === 0) return [];
    const registry = await adapter.listRepos();
    const out: GroundingRepo[] = [];
    for (const ref of refs) {
      const repo = registry.find((r) => r.id === ref);
      if (repo === undefined) {
        log?.(`[interactive] project ${projectId} has repo member ${ref} but the registry does not — skipped for grounding`);
        continue;
      }
      out.push({ repoRef: repo.id, name: repoName(repo), rootPath: repo.root_path });
    }
    return out;
  } catch (err) {
    log?.(
      `[interactive] could not resolve project ${projectId}'s repositories — grounding unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

/** Does a request ref name this repo? Its registry id, its name, or its root basename — case-
 *  insensitive on the human spellings, exact on the id. */
export function matchRepoRef(ref: string, repo: GroundingRepo): boolean {
  if (ref === repo.repoRef) return true;
  const lower = ref.toLowerCase();
  return lower === repo.name.toLowerCase() || lower === basename(repo.rootPath).toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The member repos a brief names OUTRIGHT — "use the wicked-studio repo in this project" names
 * wicked-studio. Whole-token matches only (a name followed by `-` or an alphanumeric is a
 * different repo: `wicked-studio` must not match `wicked-studio-archived`); case-insensitive.
 * Order follows the candidates, not the brief.
 */
export function reposNamedInBrief(brief: string, candidates: GroundingRepo[]): GroundingRepo[] {
  if (brief.trim().length === 0) return [];
  return candidates.filter((repo) => {
    const names = new Set([repo.name, basename(repo.rootPath)].filter((n) => n.length >= 3));
    for (const name of names) {
      const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, 'i');
      if (re.test(brief)) return true;
    }
    return false;
  });
}

/**
 * Decide which repositories a document is grounded on. The order IS the contract:
 *
 *  - `namedRefs` given (the create request said so) → THOSE, with unresolvable ones in `missing`;
 *  - else the member repos the brief names by name;
 *  - else the project's only repo;
 *  - else none — a multi-repo project whose document named nothing is NOT grounded on an arbitrary
 *    member (the F-046 defect); the caller narrates how to name one.
 */
export async function resolveGroundingRepos(
  adapter: CoreAdapter,
  projectId: string,
  brief: string,
  namedRefs: readonly string[] | undefined,
  log?: (message: string) => void,
): Promise<GroundingDecision> {
  const candidates = await projectRepoCandidates(adapter, projectId, log);
  const memberCount = candidates.length;
  if (namedRefs !== undefined && namedRefs.length > 0) {
    const repos: GroundingRepo[] = [];
    const missing: string[] = [];
    for (const ref of namedRefs) {
      const hit = candidates.find((c) => matchRepoRef(ref, c));
      if (hit === undefined) missing.push(ref);
      else if (!repos.includes(hit)) repos.push(hit);
    }
    return { repos, source: 'named', missing, memberCount };
  }
  if (candidates.length === 0) return { repos: [], source: 'none', missing: [], memberCount };
  if (candidates.length === 1) return { repos: candidates, source: 'sole-member', missing: [], memberCount };
  const fromBrief = reposNamedInBrief(brief, candidates);
  if (fromBrief.length > 0) return { repos: fromBrief, source: 'brief', missing: [], memberCount };
  return { repos: [], source: 'none', missing: [], memberCount };
}

/** A safe directory name for a repo's snapshot under `<runDir>/repos/` — the repo NAME (what the
 *  thread and the problem statement call it), reduced to the slug charset; the id when nothing
 *  survives. Never a free bus string on disk. */
export function snapshotDirName(repo: GroundingRepo): string {
  const slug = repo.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug : repo.repoRef.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'repo';
}

/** The thread line that says WHERE a launch is grounded and WHY (F-046 follow-up: the worker's
 *  own words were the only place "grounded on wicked-core only" appeared). `null` when there is
 *  nothing to say about repositories at all (a repo-less project, an unfiled doc). */
export function groundingNarration(
  decision: GroundingDecision,
  snapshotted: readonly GroundingRepo[],
  kind: 'draft' | 'demo',
): string | null {
  const parts: string[] = [];
  if (snapshotted.length > 0) {
    const why =
      decision.source === 'named'
        ? 'named in your request'
        : decision.source === 'brief'
          ? 'named in your brief'
          : "the project's only repository";
    parts.push(
      `Grounded on ${snapshotted.map((r) => r.name).join(', ')} (${why}) — the worker reads an offline ` +
        `snapshot of ${snapshotted.length === 1 ? 'it' : 'each'} plus the project's code graph where one is built.`,
    );
  }
  if (decision.missing.length > 0) {
    parts.push(
      `Requested ${decision.missing.length === 1 ? 'repository' : 'repositories'} ${decision.missing
        .map((m) => `"${m}"`)
        .join(', ')} ${decision.missing.length === 1 ? 'is' : 'are'} not a member of this project — skipped.`,
    );
  }
  if (snapshotted.length === 0 && decision.source === 'none' && decision.memberCount > 1) {
    parts.push(
      `This project has ${decision.memberCount} repositories and none was named for this ${kind} — working from ` +
        `the brief and the project's code graph only. Name one (repo_ref on the create request, or by name in ` +
        `the brief) to ground the next ${kind} on its source.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

// ── The durable binding, beside the doc ──────────────────────────────────────────────────────
//
// WHERE IT LIVES — and why NOT under the state home. wicked-core embeds crew's state-home registry
// (`tests/fixtures/state-home-subtrees.json`, core's `src/state_home.rs`) as the worker Read fence
// and REFUSES every launch that finds a top-level entry the registry does not classify (fail
// closed, never widen). A new store under `<state home>/` therefore needs a core release before a
// single governed run can start beside it. The binding is doc metadata anyway — "this document is
// about repository X" — so it lives where the doc lives: beside the bridge's own `versions.json`
// and the `project.json` breadcrumb the bridge writes for exactly the same kind of fact. The bridge
// never reads it; a retired doc keeps its directory and its name stays reserved (interactive#189),
// so a stale binding can never be inherited by a same-named successor — no delete sweep needed.

/** The sidecar's filename, beside `versions.json`. */
export const CREW_GROUNDING_FILE = 'crew-grounding.json';

/** Interactive's doc-name grammar, restated (draft-events.ts DOC_NAME imports this module, so it
 *  cannot be imported here): a document id is a safe single path segment or it names no path. */
const SAFE_DOC = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What the proxy recorded for one document at create time. */
export interface DocGroundingBinding {
  project_id: string;
  /** Registry ids, canonicalized from whatever spelling the request used. */
  repo_refs: string[];
  /** The style the create was forwarded with (client-given or brief-inferred), when known. */
  style?: string | undefined;
  recorded_at: string;
}

interface PendingCreate {
  projectId: string;
  settled: Promise<void>;
  settle: () => void;
}

export class DocGroundingStore {
  private readonly pending = new Map<number, PendingCreate>();
  private nextToken = 1;

  /** `<docsRoot>/<documentId>/crew-grounding.json`, or null for an id that is not a safe segment. */
  static sidecarPath(docsRoot: string, documentId: string): string | null {
    return SAFE_DOC.test(documentId) ? join(docsRoot, documentId, CREW_GROUNDING_FILE) : null;
  }

  /** The binding beside the doc, or `undefined` when absent or malformed (a malformed sidecar is
   *  read as "nothing named" — the thread narrates the fallback, the daemon never dies over it). */
  get(docsRoot: string, documentId: string): DocGroundingBinding | undefined {
    const path = DocGroundingStore.sidecarPath(docsRoot, documentId);
    if (path === null) return undefined;
    try {
      const row = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (typeof row !== 'object' || row === null) return undefined;
      if (typeof row['project_id'] !== 'string' || row['project_id'].length === 0) return undefined;
      const refs = Array.isArray(row['repo_refs'])
        ? row['repo_refs'].filter((r): r is string => typeof r === 'string' && r.length > 0)
        : [];
      return {
        project_id: row['project_id'],
        repo_refs: refs,
        ...(typeof row['style'] === 'string' ? { style: row['style'] } : {}),
        recorded_at: typeof row['recorded_at'] === 'string' ? row['recorded_at'] : new Date(0).toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  /** Write the sidecar atomically. The doc directory normally exists by now (the bridge created it
   *  before answering the create); it is created when it does not, so a record never fails on
   *  ordering alone. Throws on an unwritable root — the caller logs and the doc stays unbound. */
  record(
    docsRoot: string,
    documentId: string,
    binding: Omit<DocGroundingBinding, 'recorded_at'> & { recorded_at?: string },
  ): void {
    const path = DocGroundingStore.sidecarPath(docsRoot, documentId);
    if (path === null) throw new Error(`document id "${documentId}" cannot name a workspace path`);
    const row: DocGroundingBinding = { ...binding, recorded_at: binding.recorded_at ?? new Date().toISOString() };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(row, null, 2), 'utf8');
    renameSync(tmp, path);
  }

  /** Drop a document's sidecar. `true` when one was removed. */
  remove(docsRoot: string, documentId: string): boolean {
    const path = DocGroundingStore.sidecarPath(docsRoot, documentId);
    if (path === null) return false;
    try {
      readFileSync(path);
    } catch {
      return false;
    }
    rmSync(path, { force: true });
    return true;
  }

  /** The proxy is about to forward a create for `projectId` that WILL record a binding. */
  beginCreate(projectId: string): number {
    const token = this.nextToken++;
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.pending.set(token, { projectId, settled, settle });
    return token;
  }

  /** The create answered (recorded, refused, or failed) — wake every waiter. */
  settleCreate(token: number): void {
    const entry = this.pending.get(token);
    if (entry === undefined) return;
    this.pending.delete(token);
    entry.settle();
  }

  /** How many creates for `projectId` are still unanswered (diagnostics / tests). */
  pendingCount(projectId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.projectId === projectId) n += 1;
    return n;
  }

  /**
   * The binding for `documentId` under `docsRoot`, waiting (bounded) for an in-flight create of the
   * same project to settle first — the seam's answer to the bus racing the create response.
   * Resolves immediately when the binding is already there or nothing is pending for the project.
   */
  async waitFor(
    docsRoot: string,
    documentId: string,
    projectId: string,
    timeoutMs: number,
  ): Promise<DocGroundingBinding | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.get(docsRoot, documentId);
      if (hit !== undefined) return hit;
      const waiting = [...this.pending.values()].filter((p) => p.projectId === projectId);
      if (waiting.length === 0) return undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.race(waiting.map((p) => p.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
