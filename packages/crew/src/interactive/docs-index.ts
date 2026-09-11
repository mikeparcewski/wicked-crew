/**
 * `GET /api/v1/interactive/docs` — a daemon-wide, NON-SPAWNING listing of every interactive document
 * across projects (wave 6, studio #263 review).
 *
 * The per-project listing (`GET /projects/:id/interactive/api/docs`, doc-list-routes.ts) asks the
 * project's BRIDGE — spawning one `wicked-interactive serve` per project root (≈60 s cold start) —
 * so a skin that fans it out over every project on mount pays a cold start per project. This
 * listing reads what the bridge itself reads, straight from disk: every project's docs root
 * (bridge-root.ts precedence — the project's own `interactiveRoot`, else `WICKED_INTERACTIVE_ROOT`,
 * else the default root / its `projects/<id>` partition), each slug-named child carrying a
 * `versions.json` (the bridge's `listDocs` rule, restated from wicked-interactive `src/service/
 * server.js`: `kind` defaults to `doc`, `updated_at` is the last version's `created_at`, a retired
 * manifest lists only on request, a malformed manifest is skipped) — plus what only the DAEMON
 * knows: the seams that answered the document and the governed runs they launched (the handoff
 * ledgers, via `DocRunIndex`).
 *
 * A root shared by several projects (an explicit `interactiveRoot` binding, or `WICKED_INTERACTIVE_ROOT`
 * applying to all) is listed ONCE, under the first project that resolved to it. A root that does not
 * exist yet is an empty project, not a failure; a root that cannot be read, or a partition the
 * containment walk refuses, is reported in `unreachable` with the reason — never silently dropped.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { CoreAdapter } from '../core/adapter.js';
import { ProjectsUnsupportedError } from '../core/adapter.js';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import type { ProjectSettingsStore } from '../projects/settings.js';
import { resolveProjectInteractiveRoot } from './bridge-root.js';
import type { DocRunIndex } from './doc-run-index.js';

/** Interactive's doc-name grammar (the bridge's `DOC_NAME`): a safe single path segment. */
const DOC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The bridge's manifest file (wicked-interactive `fsstore.js` `MANIFEST`). */
export const VERSIONS_FILE = 'versions.json';

/** One document as the daemon lists it — published as `InteractiveDocIndexRow` (api-types 0.36.0). */
export interface InteractiveDocIndexRow {
  /** The project whose docs root holds the document (the first project, for a shared root). */
  projectId: string;
  name: string;
  /** Manifest `kind`; a manifest without one lists as `doc`. */
  kind: 'doc' | 'html' | 'source' | 'demo' | (string & {});
  /** Head version, `null` when the manifest carries none. */
  head: number | null;
  /** Lineage size. */
  versions: number;
  /** ISO-8601 of the head (last) version, or `null` when the lineage is empty. */
  updatedAt: string | null;
  /** Present only on a retired (tombstoned) row, listed only with `includeRetired`. */
  retired?: true;
  retiredAt?: string;
  /** The seams that answered this document (`draft` | `edit` | `chat` | `demo`), from the ledgers. */
  kinds: string[];
  /** The governed runs the seams launched for it (ledger order). */
  runs: string[];
}

/** A project docs root the listing could not read. */
export interface InteractiveDocsUnreachable {
  projectId: string;
  root: string | null;
  error: string;
}

export interface InteractiveDocsListing {
  docs: InteractiveDocIndexRow[];
  unreachable: InteractiveDocsUnreachable[];
}

export interface ListInteractiveDocsDeps {
  adapter: Pick<CoreAdapter, 'projectList'>;
  settings: ProjectSettingsStore;
  docRuns: Pick<DocRunIndex, 'kindsOf' | 'runsOf'>;
  env?: Record<string, string | undefined>;
  /** The home the default root hangs off (tests point it at a scratch dir). */
  home?: string;
  includeRetired?: boolean;
}

/** The project ids to list: the synthesized default first, then every stored project (an engine
 *  without the project bindings has only the default). */
async function projectIds(adapter: Pick<CoreAdapter, 'projectList'>): Promise<string[]> {
  const ids = [DEFAULT_PROJECT_ID];
  if (typeof adapter.projectList !== 'function') return ids;
  try {
    for (const p of await adapter.projectList()) if (p.id !== DEFAULT_PROJECT_ID) ids.push(p.id);
  } catch (err) {
    if (!(err instanceof ProjectsUnsupportedError)) throw err;
  }
  return ids;
}

/** One root's rows, the bridge's own rules. Throws when the root exists but cannot be read. */
function rowsOfRoot(
  root: string,
  projectId: string,
  docRuns: ListInteractiveDocsDeps['docRuns'],
  includeRetired: boolean,
): InteractiveDocIndexRow[] {
  if (!existsSync(root)) return [];
  const out: InteractiveDocIndexRow[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !DOC_NAME.test(entry.name)) continue;
    const manifestPath = join(root, entry.name, VERSIONS_FILE);
    if (!existsSync(manifestPath)) continue;
    let m: {
      kind?: unknown;
      head?: unknown;
      versions?: unknown;
      retired_at?: unknown;
    };
    try {
      m = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof m;
    } catch {
      continue; // malformed — skipped, as the bridge skips it
    }
    if (typeof m !== 'object' || m === null) continue;
    const retiredAt = typeof m.retired_at === 'string' && m.retired_at !== '' ? m.retired_at : undefined;
    if (retiredAt !== undefined && !includeRetired) continue;
    const versions = Array.isArray(m.versions) ? (m.versions as Array<{ created_at?: unknown }>) : [];
    const last = versions[versions.length - 1];
    out.push({
      projectId,
      name: entry.name,
      kind: typeof m.kind === 'string' && m.kind !== '' ? m.kind : 'doc',
      head: typeof m.head === 'number' ? m.head : null,
      versions: versions.length,
      updatedAt: typeof last?.created_at === 'string' ? last.created_at : null,
      ...(retiredAt !== undefined ? { retired: true as const, retiredAt } : {}),
      kinds: docRuns.kindsOf(entry.name),
      runs: docRuns.runsOf(entry.name),
    });
  }
  return out;
}

export async function listInteractiveDocs(deps: ListInteractiveDocsDeps): Promise<InteractiveDocsListing> {
  const env = deps.env ?? process.env;
  const docs: InteractiveDocIndexRow[] = [];
  const unreachable: InteractiveDocsUnreachable[] = [];
  const seenRoots = new Set<string>();
  for (const projectId of await projectIds(deps.adapter)) {
    let root: string;
    try {
      root = resolveProjectInteractiveRoot(
        projectId === DEFAULT_PROJECT_ID ? undefined : projectId,
        deps.settings.get(projectId),
        env,
        deps.home,
      );
    } catch (err) {
      unreachable.push({ projectId, root: null, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (seenRoots.has(root)) continue; // a shared root lists once, under the first project
    seenRoots.add(root);
    try {
      docs.push(...rowsOfRoot(root, projectId, deps.docRuns, deps.includeRetired === true));
    } catch (err) {
      unreachable.push({ projectId, root, error: err instanceof Error ? err.message : String(err) });
    }
  }
  docs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name));
  return { docs, unreachable };
}
