/**
 * Linked issues through the registry (DES-PM-001 §3.2 "Linked issues at launch", §6 step 1; Q-PM5).
 *
 * Once a PM source of a system is registered, a reference of that system in a launch's intent resolves ONLY through
 * the launch's tracker set T(u) (its project and repo), through the source's own bound tool and response projector,
 * never through the daemon's `gh`. What cannot be read is reported, with a code, never read another way:
 *
 * - `#N`: the run repo's GitHub tracker (a GitHub tracker of T(u) linked to that repo); none = `not_linked`.
 * - `owner/repo#N`: only when `owner/repo` is a GitHub tracker of T(u).
 * - `PROJ-N` (Jira): only keys some registered Jira tracker has are references at all (so `UTF-8` is not one). Exactly
 *   one tracker of T(u) with that key resolves it; two (two sites, or two sources) = `ambiguous`, with the candidates,
 *   and the person picks, which writes the source-qualified `<source>:PROJ-N`.
 * - A tracker linked to the project or repo whose source's Agents switches keep the project out = `hidden`; one the
 *   project may see but not query = `query_off`; a vendor that cannot be read = `unavailable`.
 */

import type { LinkedIssue, PmSystem } from '../../core/types.js';
import { agentMay } from '../gate/access.js';
import { configOf, pmDescriptorHash } from '../../mcp/registry.js';
import { bindingInForce, GITHUB_TENANT, type PmItem } from './bindings.js';
import { liveTool, type PmGate, projectOptsOf } from './gate-pm.js';
import { effectiveDisclosure } from '../registry/entry.js';
import { linkedSetOf, type PmEntry, type TrackerScope, type TrackerSetEntry, trackerSetOf, unitRepos } from './set.js';

/** One issue reference of a PM system, as parsed from an intent. */
export type PmRef =
  | { system: 'github'; ref: string; repo: string | null; number: number; source: null }
  | { system: 'jira'; ref: string; key: string; number: number; source: string | null; tenant?: string | null };

/** What a PM read of one reference gives the linked-issues block. */
export interface PmIssueRead {
  issue: LinkedIssue;
  /** The block section for it (issue text: the caller makes it inert). */
  text: string;
  /** The tracker that admitted it, for the run's `addresses` record. */
  address?: { trackerId: string; source: string; system: PmSystem; ref: string; asked: string };
}

/**
 * The Jira references an intent names: `PROJ-12` whose key a registered Jira tracker has; `<source>:PROJ-12` (one
 * source of several); `<source>@<cloudId>:PROJ-12` (one site of a source that reaches several).
 */
export function jiraRefs(intent: string, knownKeys: ReadonlySet<string>): PmRef[] {
  const out: PmRef[] = [];
  const seen = new Set<string>();
  for (const m of intent.matchAll(/(?<![\w@:-])(?:([a-z0-9][a-z0-9_-]{0,62})(?:@([A-Za-z0-9-]{1,64}))?:)?([A-Z][A-Z0-9_]{0,19})-([1-9][0-9]{0,9})(?![\w-])/g)) {
    const key = m[3]!;
    if (!knownKeys.has(key)) continue;
    const source = m[1] ?? null;
    const tenant = source !== null ? (m[2] ?? null) : null;
    const ref = `${source !== null ? `${source}${tenant !== null ? `@${tenant}` : ''}:` : ''}${key}-${m[4]}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ system: 'jira', ref, key, number: Number(m[4]), source, tenant });
  }
  return out;
}

/** A GitHub reference as `issueRefs` normalized it (`#41`, `owner/repo#41`), or `null` for one PM cannot read (`repo#41`). */
export function githubRef(ref: string): PmRef | null {
  const m = /^(?:([\w.-]+\/[\w.-]+))?#([1-9][0-9]{0,9})$/.exec(ref);
  if (m === null) return null;
  return { system: 'github', ref, repo: m[1] === undefined ? null : m[1].toLowerCase(), number: Number(m[2]), source: null };
}

/** Every registered system, and every key a registered Jira tracker has (any link), from one registry read. */
export function pmRegistered(entries: readonly PmEntry[]): { systems: Set<PmSystem>; jiraKeys: Set<string> } {
  const systems = new Set<PmSystem>();
  const jiraKeys = new Set<string>();
  for (const e of entries) {
    systems.add(e.system);
    if (e.system === 'jira') for (const t of e.trackers) jiraKeys.add(t.key);
  }
  return { systems, jiraKeys };
}

const fail = (ref: string, code: NonNullable<LinkedIssue['code']>, error: string, extra: Partial<LinkedIssue> = {}): PmIssueRead => ({
  issue: { ref, resolved: false, code, error, ...extra },
  text: `### ${ref}: not read (${error})`,
});

/** The trackers of a set that a reference names. */
export function candidatesFor(r: PmRef, set: readonly TrackerSetEntry[], repoRef: string | null): TrackerSetEntry[] {
  if (r.system === 'jira') return set.filter((t) => t.system === 'jira' && t.key === r.key && (r.source === null || t.source === r.source) && (r.tenant == null || t.tenant === r.tenant));
  if (r.repo !== null) return set.filter((t) => t.system === 'github' && t.tenant === GITHUB_TENANT && t.key.toLowerCase() === r.repo);
  // `#N`: the GitHub tracker(s) linked to the run's own repo.
  if (repoRef === null) return [];
  return set.filter((t) => t.system === 'github' && t.via.some((v) => v.kind === 'repo' && v.id === repoRef));
}

/** One issue rendered for the block (vendor text; the caller makes the whole block inert). */
function render(ref: string, system: PmSystem, item: PmItem): { title: string; text: string } {
  const v = item.value;
  const title = String((system === 'jira' ? v['summary'] : v['title']) ?? '').replace(/\s+/g, ' ').trim();
  const state = system === 'jira' ? (typeof v['status'] === 'string' ? v['status'] : null) : typeof v['state'] === 'string' ? v['state'] : null;
  const body = String((system === 'jira' ? v['description'] : v['body']) ?? '').trim();
  const lines = [`### ${ref}: ${title}${state !== null ? ` (${state})` : ''}`, '', body === '' ? '_(no description)_' : body];
  const comments = Array.isArray(v['comments']) ? (v['comments'] as Array<Record<string, unknown>>) : [];
  if (comments.length > 0) {
    lines.push('', `Comments (${comments.length}):`);
    for (const c of comments) lines.push('', `- ${typeof c['author'] === 'string' ? c['author'] : 'unknown'}: ${String(c['body'] ?? '').replace(/\n/g, '\n  ')}`);
  }
  return { title, text: lines.join('\n') };
}

/**
 * Read the PM references of a launch through its tracker set (module doc). `scope` is the launch's project and repo;
 * `entries` one registry read. Never throws for one reference: each is a `resolved: false` entry with a code.
 */
export async function readPmIssues(
  pm: Pick<PmGate, 'vendorRead'>,
  entries: readonly PmEntry[],
  scope: TrackerScope,
  members: ((projectId: string) => Promise<string[]>) | undefined,
  refs: readonly PmRef[],
  /** The registry read again once the issues were read: a link removed or a switch turned off meanwhile withholds. */
  fresh?: () => Promise<PmEntry[]>,
): Promise<PmIssueRead[]> {
  const repos = await unitRepos(scope, members);
  const set = trackerSetOf(entries, scope.projectId, repos);
  // The same links with every source's switches open: what a person linked, so a hidden one is told apart.
  const linkedOnly = trackerSetOf(entries.map((e) => ({ ...e, enabled: true, access: { ...e.access, see: true, everyProject: true } })), scope.projectId, repos);
  const out: PmIssueRead[] = [];
  for (const r of refs) {
    const cands = candidatesFor(r, set, scope.repoId);
    if (cands.length === 0) {
      const linked = candidatesFor(r, linkedOnly, scope.repoId);
      if (linked.length > 0) out.push(fail(r.ref, 'hidden', `${linked[0]!.source}'s Agents switches keep this project out, so it is not read`));
      else out.push(fail(r.ref, 'not_linked', r.system === 'github' && r.repo === null ? "no GitHub tracker is linked to this run's repository" : 'no tracker of this project or its repositories has it: link it on the Projects or Repositories page'));
      continue;
    }
    if (cands.length > 1) {
      out.push(
        fail(r.ref, 'ambiguous', r.system === 'jira' ? `${cands.length} linked trackers have it: pick one (write ${new Set(cands.map((c) => c.source)).size === cands.length ? '<source>' : '<source>@<site>'}:${r.key}-${r.number})` : `${cands.length} GitHub sources link this repository: a person unlinks it from all but one`, {
          candidates: cands.map((c) => ({ source: c.source, tenant: c.tenant, ...(c.tenantLabel !== null ? { tenantLabel: c.tenantLabel } : {}), key: c.key, trackerId: c.trackerId })),
        }),
      );
      continue;
    }
    const t = cands[0]!;
    const e = entries.find((x) => x.id === t.sourceId)!;
    if (!agentMay(e.access, { enabled: e.enabled, queryable: true }, scope.projectId, 'query')) {
      out.push(fail(r.ref, 'query_off', `${e.name}: "Agents can query this source" is off for this project, so issue text is not read`));
      continue;
    }
    const tool = e.system === 'jira' ? 'getJiraIssue' : 'issue_read';
    const stored = e.record.tools.find((x) => x.name === tool && x.present);
    // The same tool a unit's read needs: saved as seen, switched on, a reviewed class, crew's binding in force.
    const binding = stored === undefined || !liveTool(stored) || effectiveDisclosure(stored) === null ? null : bindingInForce(e.system, stored);
    if (binding === null) {
      out.push(fail(r.ref, 'unavailable', `${e.name} has no bound ${tool} tool: a person saves the source again`));
      continue;
    }
    const linked = linkedSetOf(set, e.id);
    const [owner, repo] = t.key.split('/');
    const args = r.system === 'jira' ? { cloudId: t.tenant, issueIdOrKey: `${r.key}-${r.number}` } : { method: 'get', owner, repo, issue_number: r.number };
    const prepared = binding.bindArgs(args, linked);
    if (!prepared.ok) {
      out.push(fail(r.ref, 'not_linked', prepared.reason));
      continue;
    }
    const read = await pm.vendorRead(e, tool, prepared.args, 'person');
    if (!read.ok) {
      out.push(fail(r.ref, 'unavailable', read.reason));
      continue;
    }
    const projected = binding.project(read.result, prepared, projectOptsOf(e));
    if (!projected.ok || projected.items.length !== 1) {
      out.push(fail(r.ref, projected.ok ? 'not_found' : projected.code === 'vendor_error' ? 'not_found' : 'unavailable', projected.ok ? 'the tracker answered no such issue' : projected.reason));
      continue;
    }
    const item = projected.items[0]!;
    const shown = render(item.ref, e.system, item);
    if (shown.title === '') {
      out.push(fail(r.ref, 'not_found', 'the tracker answered no title'));
      continue;
    }
    out.push({
      issue: { ref: r.ref, resolved: true, title: shown.title, chars: shown.text.length, trackerId: t.trackerId, source: e.name, system: e.system },
      text: shown.text,
      address: { trackerId: t.trackerId, source: e.name, system: e.system, ref: item.ref, asked: r.ref },
    });
  }
  if (fresh === undefined || !out.some((r) => r.address !== undefined)) return out;
  // The release check: T(u) and the query switch read again NOW, before any issue text enters the launch.
  const now = await fresh();
  const again = trackerSetOf(now, scope.projectId, await unitRepos(scope, members));
  return out.map((r) => {
    if (r.address === undefined) return r;
    const t = again.find((x) => x.trackerId === r.address!.trackerId);
    const e = t === undefined ? undefined : now.find((x) => x.id === t.sourceId);
    const was = entries.find((x) => x.id === t?.sourceId);
    const tool = e?.system === 'jira' ? 'getJiraIssue' : 'issue_read';
    const nt = e?.record.tools.find((x) => x.name === tool && x.present);
    // The same conditions the read was admitted under, read again: the link, the switch, the source's descriptor,
    // and the read tool saved as seen, switched on, reviewed and bound.
    const holds =
      t !== undefined &&
      e !== undefined &&
      was !== undefined &&
      agentMay(e.access, { enabled: e.enabled, queryable: true }, scope.projectId, 'query') &&
      pmDescriptorHash(configOf(e.record)) === pmDescriptorHash(configOf(was.record)) &&
      nt !== undefined &&
      liveTool(nt) &&
      effectiveDisclosure(nt) !== null &&
      bindingInForce(e.system, nt) !== null;
    if (holds) return r;
    return fail(r.issue.ref, 'not_linked', 'its tracker link, the source or its read tool changed while it was read, so it is not included');
  });
}

