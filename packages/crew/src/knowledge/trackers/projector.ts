/**
 * Trackers -> estate (DES-PM-001 §3.4): each linked tracker is a catalog of its own, `knowledge.replace_source
 * {sourceId: <tracker id>}`, so everything about it carries the one dep `source:<tracker id>` and recall, the
 * catalog, the relay's release and the record treat it exactly as a source.
 *
 * One generation holds:
 * - the `tracker` document: value-free (system, key, the vendor's label as untrusted text, the tenant's label), with
 *   one document-owned `tracked_in` link per person-made link, to the `control` endpoint `project:<id>` or `repo:<id>`
 *   (estate stamps each with the generation and its deps: the document's plus the far end's);
 * - one `issue_ref` document per issue a run addresses through this tracker (the runs' `addresses` records), owning
 *   `run:<id> addresses issue_ref` (`dir: 'in'`, deps the run's project, or its repo for an unfiled run).
 * Never an issue's text: only keys travel.
 *
 * Reconciled, not fired and forgotten: the registry is the truth and access follows it at once. Per tracker crew keeps
 * the desired revision (a hash of the generation's content), the state `pending` / `current` / `failed`, and retries
 * a failure with backoff. A tracker whose last link went is kept in its entry's `retired[]` until estate takes its
 * empty generation (which tombstones its documents and links); the boot backfill sends every tracker and every
 * retired one. A link change never waits on this: the routes answer once the registry commit lands.
 */

import { createHash } from 'node:crypto';

import { callEstateTool } from '../../core/estate-mcp-client.js';
import { canonicalJson } from '../../mcp/classify.js';
import { entryId, normalizeRegistryFile } from '../../mcp/registry.js';
import type { McpRegistryStore } from '../../mcp/registry-store.js';
import { replaceSource } from '../estate-write.js';
import { pmOf, type StoredTracker, trackersOf } from '../registry/entry.js';
import type { RunAddress } from './addresses.js';
import type { TrackerProjectionState } from './view.js';

/** Bumped when the documents' shape changes. */
export const TRACKER_PROJECTION_FORMAT = 1;
/** At most this many issue_ref documents per tracker generation (the newest runs first). */
export const TRACKER_ISSUE_REFS_MAX = 2_000;
/** Under estate's 20,000 links per generation. */
export const GENERATION_LINKS_MAX = 19_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;

export type EstateCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface TrackerProjectorDeps {
  store: Pick<McpRegistryStore, 'read' | 'mutate' | 'settled'>;
  /** Every run's addresses, with the run's project and repo (for the `run:` end's deps). */
  addresses?: () => Promise<Array<{ runId: string; projectId: string | null; repoId: string | null; addresses: RunAddress[] }>>;
  /** The PR a run delivered (`https://github.com/o/r/pull/7`), for the trail's `closes` link; absent = none drawn. */
  delivered?: (runId: string) => string | undefined;
  call?: EstateCall;
  log?: (message: string) => void;
  now?: () => number;
  /** TESTS ONLY: the wait between SQLite contention retries. */
  sleep?: (ms: number) => Promise<void>;
  /** TESTS ONLY: how a retry is scheduled (production: a timer). */
  schedule?: (fn: () => void, ms: number) => void;
}

export interface TrackerGenerationLink {
  rel: 'tracked_in' | 'addresses' | 'closes';
  dir: 'out' | 'in';
  end: { store: 'control'; id: string };
  deps?: string[];
}

export interface TrackerGeneration {
  sourceId: string;
  generation: number;
  label: string;
  catalog: Record<string, unknown>;
  docs: Array<{ key: string; title: string; entry: Record<string, unknown>; sections: Array<{ key: string; text: string }>; links?: TrackerGenerationLink[] }>;
}

const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');

/** `text` cut to at most `max` UTF-8 bytes, on a character boundary (estate's byte bounds). */
function cutBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, 'utf8') > max - 3) break;
    out += ch;
  }
  return `${out}…`;
}
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0]!;

/** The control endpoint of a link target. */
export function controlId(target: { kind: 'project' | 'repo'; id: string }): string {
  return `${target.kind}:${target.id}`;
}

/**
 * The generation of one tracker (module doc), with no generation number yet. `null` tracker = retired: an empty
 * generation, which tombstones its documents and links.
 */
export function trackerGenerationBody(
  source: { name: string; system: string },
  trackerId: string,
  t: StoredTracker | null,
  runs: ReadonlyArray<{ runId: string; projectId: string | null; repoId: string | null; addresses: RunAddress[] }>,
  delivered: (runId: string) => string | undefined = () => undefined,
): Omit<TrackerGeneration, 'generation'> {
  if (t === null) return { sourceId: trackerId, label: `${source.name} tracker (retired)`, catalog: { system: source.system, retired: true, format: TRACKER_PROJECTION_FORMAT }, docs: [] };
  const links: TrackerGenerationLink[] = [...t.links]
    .sort((a, b) => controlId(a.target).localeCompare(controlId(b.target)))
    .map((l) => ({ rel: 'tracked_in', dir: 'out', end: { store: 'control', id: controlId(l.target) } }));
  // The text names no link target and no count: those are the links' own (each gated by its far end's deps), so a
  // unit that holds the tracker through one repo never reads which other project it is linked to.
  const structure = t.structure ?? null;
  const sections = [{ key: 'summary', text: cutBytes(`${source.system} tracker ${t.key} ("${t.label}") of source ${source.name}.`, 4_000) }];
  if (structure !== null && (structure.issueTypes.length > 0 || structure.states.length > 0 || (structure.fields ?? []).length > 0)) {
    sections.push({
      key: 'structure',
      text: cutBytes(
        [
          structure.issueTypes.length > 0 ? `Issue types: ${structure.issueTypes.join(', ')}.` : '',
          structure.states.length > 0 ? `Workflow states: ${structure.states.map((x) => `${x.name} (${x.category ?? 'unmapped'})`).join(', ')}.` : '',
          (structure.fields ?? []).length > 0 ? `Fields: ${(structure.fields ?? []).map((x) => `${x.name} [${x.id}${x.type !== null ? `: ${x.type}` : ''}]`).join(', ')}.` : '',
        ]
          .filter((x) => x !== '')
          .join(' '),
        8_000,
      ),
    });
  }
  const docs: TrackerGeneration['docs'] = [
    {
      key: 'tracker',
      title: cutBytes(`${source.name} · ${t.key}`, 200),
      entry: { kind: 'tracker', system: source.system, key: t.key, label: t.label, tenantLabel: t.tenantLabel },
      sections,
      links,
    },
  ];
  // issue_refs: every issue a run addresses through this tracker, each owning its runs' `addresses` links.
  const byRef = new Map<string, Array<{ runId: string; deps: string[]; pr: string | null }>>();
  for (const r of [...runs].reverse()) {
    const deps = r.projectId !== null ? [`project:${r.projectId}`] : r.repoId !== null ? [`repo:${r.repoId}`] : [];
    if (deps.length === 0) continue;
    // The PR the run delivered, as estate's `pr:<repo id>#<n>` (its dep is the repo, read from the id).
    const url = delivered(r.runId);
    const n = url === undefined ? null : /\/pull\/([1-9][0-9]{0,9})(?:[/?#]|$)/.exec(url);
    const pr = n !== null && r.repoId !== null ? `pr:${r.repoId}#${n[1]}` : null;
    for (const a of r.addresses) {
      if (a.trackerId !== trackerId) continue;
      const list = byRef.get(a.ref) ?? [];
      // `closes` only for an issue the run's PR closes (Fixes, or a Jira key the title carries): a mention is not one.
      if (!list.some((x) => x.runId === r.runId)) list.push({ runId: r.runId, deps, pr: a.closing === true ? pr : null });
      byRef.set(a.ref, list);
    }
  }
  // estate's generation-wide link bound (20,000): the newest issues' trail links first, the tracker's own links kept.
  let budget = GENERATION_LINKS_MAX - links.length;
  for (const [ref, rs] of [...byRef.entries()].slice(0, TRACKER_ISSUE_REFS_MAX)) {
    if (budget <= 0) break;
    docs.push({
      key: `issue/${ref}`,
      title: ref,
      entry: { kind: 'issue_ref', system: source.system, ref },
      sections: [{ key: 'ref', text: `issue ${ref} of tracker ${t.key}.` }],
      // Each run that addresses it, and the PR it delivered (`closes`): at most 200 links (estate's per-document bound).
      links: rs
        .sort((a, b) => a.runId.localeCompare(b.runId))
        .flatMap((x): TrackerGenerationLink[] => [
          { rel: 'addresses', dir: 'in', end: { store: 'control', id: `run:${x.runId}` }, deps: x.deps },
          ...(x.pr !== null ? [{ rel: 'closes' as const, dir: 'in' as const, end: { store: 'control' as const, id: x.pr } }] : []),
        ])
        .filter((l, i, all) => all.findIndex((y) => y.rel === l.rel && y.end.id === l.end.id) === i)
        .slice(0, Math.min(200, budget)),
    });
    budget -= docs[docs.length - 1]!.links!.length;
  }
  return {
    sourceId: trackerId,
    label: cutBytes(`${source.name} · ${t.key}`, 200),
    catalog: { system: source.system, key: t.key, format: TRACKER_PROJECTION_FORMAT },
    docs,
  };
}

interface TrackerState {
  desired: string;
  acked: string | null;
  /** `retired`: its source was removed and its tombstone sent (never shown on a link: it has none). */
  state: TrackerProjectionState | 'retired';
  attempts: number;
}

/** The one writer of trackers into estate (module doc). */
export class TrackerProjector {
  private readonly call: EstateCall;
  private readonly now: () => number;
  private readonly states = new Map<string, TrackerState>();
  private readonly sent = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private pendingAll = false;

  constructor(private readonly deps: TrackerProjectorDeps) {
    this.call = deps.call ?? ((tool, args) => callEstateTool(tool, args));
    this.now = deps.now ?? Date.now;
  }

  /** Whether estate holds a tracker's current links (`pending` until known). */
  projection = (trackerId: string): TrackerProjectionState => {
    const st = this.states.get(trackerId)?.state ?? 'pending';
    return st === 'retired' ? 'pending' : st;
  };

  /** Whether estate has taken ANY generation of a tracker (the visible set admits its dep only then). */
  acknowledged(trackerId: string): boolean {
    const st = this.states.get(trackerId);
    return st !== undefined && st.state !== 'retired' && st.acked !== null;
  }

  private nextGeneration(id: string): number {
    const g = Math.max(this.now() * 16 + TRACKER_PROJECTION_FORMAT, (this.sent.get(id) ?? 0) + 16);
    this.sent.set(id, g);
    return g;
  }

  /** Something changed (a link, a run's addresses): reconcile every tracker, once, after the registry write lands. */
  changed(trackerId?: string): void {
    // A tracker whose links just changed is not known to be current until this reconcile compares it again.
    const st = trackerId === undefined ? undefined : this.states.get(trackerId);
    if (st !== undefined && st.state === 'current') st.state = 'pending';
    if (this.pendingAll) return;
    this.pendingAll = true;
    this.chain = this.chain
      .then(async () => {
        this.pendingAll = false;
        await this.reconcile();
      })
      .catch((err: unknown) => this.deps.log?.(`[knowledge] trackers were not projected into estate: ${message(err)}`));
  }

  /** Every queued reconcile has finished (tests; the boot backfill). */
  async idle(): Promise<void> {
    await this.chain;
  }

  /** Project every tracker whose desired revision estate does not hold, and every retired one. Never throws. */
  async reconcile(): Promise<void> {
    await this.deps.store.settled();
    const file = normalizeRegistryFile(await this.deps.store.read());
    // An unreadable address record is not "no issues": nothing is projected this time, and the reconcile retries.
    let runs: Awaited<ReturnType<NonNullable<TrackerProjectorDeps['addresses']>>> = [];
    if (this.deps.addresses !== undefined) {
      try {
        runs = await this.deps.addresses();
      } catch (err) {
        this.deps.log?.(`[knowledge] the runs' tracker addresses could not be read, so trackers are not projected now: ${message(err)}`);
        (this.deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.()))(() => this.changed(), RETRY_BASE_MS);
        return;
      }
    }
    const retiredDone: Array<{ server: string; id: string }> = [];
    const seen = new Set<string>();
    for (const s of file.servers) {
      const pm = pmOf(s);
      if (pm === null) continue;
      const src = { name: s.name, system: pm.system };
      const jobs: Array<{ id: string; t: StoredTracker | null }> = [...trackersOf(s).map((t) => ({ id: t.id, t })), ...(s.retired ?? []).map((r) => ({ id: r.id, t: null }))];
      for (const j of jobs) {
        seen.add(j.id);
        const body = trackerGenerationBody(src, j.id, j.t, runs, this.deps.delivered);
        const desired = sha({ body, source: entryId(s) });
        const st: TrackerState = this.states.get(j.id) ?? { desired, acked: null, state: 'pending', attempts: 0 };
        if (st.desired !== desired) {
          st.desired = desired;
          st.attempts = 0;
        }
        if (st.acked === desired) {
          st.state = 'current';
          this.states.set(j.id, st);
          if (j.t === null) retiredDone.push({ server: s.name, id: j.id });
          continue;
        }
        st.state = 'pending';
        this.states.set(j.id, st);
        try {
          await replaceSource(this.call, { ...body, generation: this.nextGeneration(j.id) } as unknown as Record<string, unknown>, this.deps);
          st.acked = desired;
          st.state = 'current';
          st.attempts = 0;
          if (j.t === null) retiredDone.push({ server: s.name, id: j.id });
        } catch (err) {
          st.state = 'failed';
          st.attempts += 1;
          this.deps.log?.(`[knowledge] tracker ${j.id} of ${s.name} was not projected into estate (attempt ${st.attempts}): ${message(err)}`);
          const wait = Math.min(RETRY_BASE_MS * 2 ** (st.attempts - 1), RETRY_MAX_MS);
          (this.deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.()))(() => this.changed(), wait);
        }
      }
    }
    // A tracker this process projected whose PM entry is gone (the source removed): tombstoned once, so estate keeps
    // nothing of it. (Across a restart such a tracker's documents stay, invisible: no tracker set holds its id.)
    for (const [id, st] of this.states) {
      if (seen.has(id) || st.state === 'retired') continue;
      try {
        await replaceSource(this.call, { ...trackerGenerationBody({ name: 'removed source', system: 'unknown' }, id, null, []), generation: this.nextGeneration(id) } as unknown as Record<string, unknown>, this.deps);
        st.state = 'retired';
      } catch (err) {
        this.deps.log?.(`[knowledge] tracker ${id} of a removed source was not tombstoned in estate: ${message(err)}`);
      }
    }
    // A retired tracker whose empty generation estate took leaves the entry's list.
    if (retiredDone.length > 0) {
      await this.deps.store.mutate((f) => {
        for (const d of retiredDone) {
          const s = f.servers.find((x) => x.name === d.server);
          if (s?.retired === undefined) continue;
          // Only while it is still retired: a tracker linked again since is a live one now.
          if (trackersOf(s).some((t) => t.id === d.id)) continue;
          s.retired = s.retired.filter((r) => r.id !== d.id);
          if (s.retired.length === 0) delete s.retired;
        }
      });
    }
  }
}
