/**
 * THE WORKING DOCUMENT AND STEERING FROM IT (program DES-POWER-MODE §8.3, §9; spike 3).
 *
 *  - Each run may have ONE working document: a wicked-interactive document (kind `phase-report`) in the run's
 *    project, bound by crew (`store.ts`). Versions are interactive's: write-once, parent-linked, each batch with
 *    its `author`. A section is rewritten with one deterministic `content-edit`: no model, never a governed run.
 *  - Attribution is crew's to decide. A person's edit (`author: 'operator'`) is accepted only from a HUMAN actor and
 *    is recorded as theirs, with the plugin that hosted it named as the surface. A plugin's own generated lines
 *    (`author: 'plugin'`) are recorded as `plugin:<id>@<version>` and may touch only the plugin's own section.
 *    Nothing a plugin writes is ever recorded as a person's, and a plugin's lines never steer.
 *  - STEERING. A person's version becomes ONE note for the run, sent through the operator's existing back-channel
 *    (`injectWorkerMessage`, the `POST /runs/:id/inject` path): queued by the engine, it rides the next step's
 *    prompt as an operator context block, and `workerMessageInjected` says which step picked it up.
 *    Goal, Approach and Next go to the next step once; Constraints and steering is a STANDING steer, re-sent before
 *    every later step until a later edit replaces it. Decisions and Open questions are recorded, not sent.
 *  - DOCUMENT TEXT HAS NO POWER OVER GATES. This module calls `injectWorkerMessage` and nothing else on the engine:
 *    no gate answer, no plan edit, no intent amendment, no rigor change. A note says in its first line that it
 *    adds to the step's brief and changes no gate, check or review. (Tested: `tests/working-doc.test.ts`.)
 */

import { randomUUID } from 'node:crypto';

import type { CoreEvent } from '../core/types.js';
import {
  PLUGIN_SECTIONS, SECTION_LABELS, SECTION_MAX_CHARS, SECTION_STEER, anchorOf, changedSections, encodeSectionText, initialHtml, isSectionId,
  sectionsOf, type SectionId,
} from './sections.js';
import type { DocAuthor, SteerRecord, TrailEntry, WorkingDocRecord, WorkingDocStore } from './store.js';

/** How crew reads and writes interactive documents (the bridge in production, a fake in tests). */
export interface DocBackend {
  /** Create the document with its first version; marks it `phase-report` (the sidecar) before it is used. */
  create(projectId: string, docId: string, runId: string, html: string): Promise<{ head: number }>;
  /** The head version and its HTML, or null when the document is gone. */
  read(projectId: string, docId: string): Promise<{ head: number; html: string } | null>;
  /** One feedback batch of content edits on `expectHead`; resolves when its version landed. */
  edit(projectId: string, docId: string, batch: { expectHead: number; items: Array<{ selector: string; value: string }>; author: string }):
    Promise<{ version: number; parent: number } | { headMoved: true; head: number }>;
}

/** The ONLY engine call steering makes. */
export interface SteerEngine {
  injectWorkerMessage(runId: string, message: string, target: string): Promise<string>;
}

export interface RunFacts {
  title: string;
  problem: string;
  projectId: string;
  /** `completed`, `cancelled`, `failed`: nothing can be steered any more. */
  terminal: boolean;
  /** A unit's step id (its `phase_ref`), for "picked up at Fix". */
  stepOf(ord: number): string | null;
}

export interface WorkingDocDeps {
  store: WorkingDocStore;
  backend: DocBackend;
  engine: SteerEngine;
  run(runId: string): Promise<RunFacts | null>;
  /** A change worth telling studio about (`workingDocChanged` on `/ws`). */
  changed?(runId: string, head: number | null): void;
  audit?(action: string, actor: { id: string; kind: string }, runId: string, detail: Record<string, unknown>): void;
  now?(): number;
  log?(m: string): void;
}

export interface WorkingDocView {
  runId: string;
  doc: { projectId: string; docId: string; head: number } | null;
  sections: Record<SectionId, string> | null;
  labels: Record<SectionId, string>;
  trail: TrailEntry[];
  steers: SteerRecord[];
}

export type ProposeResult =
  | { ok: true; version: number | null; unchanged: boolean; steer: SteerRecord | null; view: WorkingDocView }
  | { ok: false; code: 400 | 403 | 404 | 409; error: string; head?: number };

export interface ProposeInput {
  base: number;
  sections: Record<string, unknown>;
  /** Who wrote it, as the HOST decided: the operator typing, or the plugin's own generated text. */
  author: 'operator' | 'plugin';
  /** The plugin that hosted the edit (`operator`) or wrote it (`plugin`). */
  plugin?: { id: string; version: string } | undefined;
}

const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PLUGIN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** A doc name interactive accepts (lowercase, digits, hyphens; ≤ 64): one per run. */
export function workingDocName(runId: string): string {
  return `working-${runId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`;
}

/** The marker a note ends with, by which `workerMessageInjected` is matched back to its steer. */
export function steerMarker(runId: string, steerId: string): string {
  return `[working-doc ${runId.slice(0, 8)}:${steerId}]`;
}

/** The one note a person's version becomes. */
export function steerNote(version: number, by: string, kind: 'next' | 'standing', texts: Array<{ id: SectionId; text: string }>, marker: string): string {
  const head = kind === 'standing'
    ? `Standing operator constraint from the job's working document (version ${version}, by ${by}). Follow it in this step and every later one until it is replaced.`
    : `Operator steering from the job's working document (version ${version}, by ${by}).`;
  const lines = texts.map((t) => `- ${SECTION_LABELS[t.id]}: ${t.text.trim() === '' ? '(cleared)' : t.text.trim()}`);
  return [
    head,
    'It adds to your brief. It does not answer, skip or change any gate, check, review or QE step.',
    ...lines,
    marker,
  ].join('\n');
}

function blankSections(): Record<SectionId, string> {
  return { goal: '', approach: '', decisions: '', constraints: '', questions: '', next: '' };
}

export class WorkingDocService {
  private readonly now: () => number;
  /** The newest unit each run dispatched: the step a note injected now is picked up by. */
  private readonly lastOrd = new Map<string, number>();
  /** One write per run at a time (a second waits its turn). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: WorkingDocDeps) {
    this.now = d.now ?? Date.now;
  }

  private exclusive<T>(runId: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(runId) ?? Promise.resolve();
    const next = prev.then(f, f);
    this.locks.set(runId, next.catch(() => undefined));
    return next;
  }

  async view(runId: string): Promise<WorkingDocView> {
    const rec = this.d.store.get(runId);
    const base = { runId, labels: { ...SECTION_LABELS }, trail: rec?.trail ?? [], steers: rec?.steers ?? [] };
    if (rec === undefined) return { ...base, doc: null, sections: null };
    const head = await this.d.backend.read(rec.projectId, rec.docId);
    if (head === null) return { ...base, doc: null, sections: null };
    return { ...base, doc: { projectId: rec.projectId, docId: rec.docId, head: head.head }, sections: { ...blankSections(), ...sectionsOf(head.html) } };
  }

  /** The run's working document, created on first ask (its Goal seeded from the run's intent, by crew). */
  ensure(runId: string): Promise<WorkingDocView | null> {
    return this.exclusive(runId, async () => {
      if (this.d.store.get(runId) !== undefined) return this.view(runId);
      const run = await this.d.run(runId);
      if (run === null) return null;
      const docId = workingDocName(runId);
      const html = initialHtml(run.title, { goal: run.problem.trim().slice(0, 1_500) });
      const { head } = await this.d.backend.create(run.projectId, docId, runId, html);
      const rec: WorkingDocRecord = {
        runId, projectId: run.projectId, docId, createdAt: this.now(),
        trail: [{ version: head, parent: null, author: { kind: 'system', id: 'crew' }, surface: null, sections: ['goal'], at: this.now(), steerId: null }],
        steers: [],
      };
      this.d.store.put(rec);
      this.d.changed?.(runId, head);
      return this.view(runId);
    });
  }

  /**
   * One version from the block. `actor` is the HTTP caller: only a person may write as the operator.
   */
  propose(runId: string, input: ProposeInput, actor: { id: string; kind: string }): Promise<ProposeResult> {
    return this.exclusive(runId, () => this.proposeNow(runId, input, actor));
  }

  private async proposeNow(runId: string, input: ProposeInput, actor: { id: string; kind: string }): Promise<ProposeResult> {
    const rec = this.d.store.get(runId);
    if (rec === undefined) return { ok: false, code: 404, error: 'this job has no working document yet' };
    if (!Number.isInteger(input.base)) return { ok: false, code: 400, error: 'base must be the version the edit was made on' };
    const plugin = input.plugin;
    if (plugin !== undefined && (!PLUGIN_ID.test(plugin.id) || !PLUGIN_VERSION.test(plugin.version))) {
      return { ok: false, code: 400, error: 'plugin must be {id, version}' };
    }
    let author: DocAuthor;
    if (input.author === 'operator') {
      // A person's words are a person's only: a worker, system or plugin caller never writes as the operator.
      if (actor.kind !== 'human') return { ok: false, code: 403, error: 'only a person can edit the working document as the operator' };
      author = { kind: 'human', id: actor.id };
    } else if (input.author === 'plugin') {
      if (plugin === undefined) return { ok: false, code: 400, error: 'a plugin-written version names its plugin' };
      author = { kind: 'plugin', id: `plugin:${plugin.id}@${plugin.version}` };
    } else {
      return { ok: false, code: 400, error: "author is 'operator' or 'plugin'" };
    }
    const wanted: Partial<Record<SectionId, string>> = {};
    for (const [k, v] of Object.entries(input.sections ?? {})) {
      if (!isSectionId(k)) return { ok: false, code: 400, error: `unknown section ${JSON.stringify(k)}` };
      if (typeof v !== 'string' || v.length > SECTION_MAX_CHARS) return { ok: false, code: 400, error: `section ${k} is text of at most ${SECTION_MAX_CHARS} characters` };
      if (author.kind === 'plugin' && !PLUGIN_SECTIONS.has(k)) {
        return { ok: false, code: 403, error: `a plugin writes only its own section (${[...PLUGIN_SECTIONS].join(', ')}), not ${k}` };
      }
      wanted[k] = v.replace(/\r\n?/g, '\n');
    }
    const head = await this.d.backend.read(rec.projectId, rec.docId);
    if (head === null) return { ok: false, code: 404, error: 'the working document is gone' };
    if (head.head !== input.base) return { ok: false, code: 409, error: 'the working document changed since', head: head.head };
    const before = sectionsOf(head.html);
    const changed = changedSections(before, wanted);
    if (changed.length === 0) return { ok: true, version: null, unchanged: true, steer: null, view: await this.view(runId) };
    const surface = plugin !== undefined ? `plugin:${plugin.id}@${plugin.version}` : null;
    const written = await this.d.backend.edit(rec.projectId, rec.docId, {
      expectHead: input.base,
      // interactive's item selector is the bare anchor id (its own `[data-wid=…]` lookup).
      items: changed.map((id) => ({ selector: anchorOf(id), value: encodeSectionText(wanted[id] ?? '') })),
      // interactive records the batch's author; crew's trail records the full attribution and the surface.
      author: author.kind === 'human' ? `${author.id}${surface !== null ? ` via ${surface}` : ''}` : author.id,
    });
    if ('headMoved' in written) return { ok: false, code: 409, error: 'the working document changed since', head: written.head };
    const at = this.now();
    let steer: SteerRecord | null = null;
    if (author.kind === 'human') steer = await this.steer(runId, rec, written.version, changed, wanted, author.id);
    const entry: TrailEntry = { version: written.version, parent: written.parent, author, surface, sections: changed, at, steerId: steer?.id ?? null };
    this.d.store.update(runId, (r) => { r.trail.push(entry); });
    this.d.audit?.('run.steered.doc', actor, runId, {
      version: written.version, sections: changed, author: author.kind === 'human' ? 'operator' : author.id,
      ...(surface !== null ? { surface } : {}), ...(steer !== null ? { steer: steer.id, sent: steer.error === null } : {}),
    });
    this.d.changed?.(runId, written.version);
    return { ok: true, version: written.version, unchanged: false, steer, view: await this.view(runId) };
  }

  /** A person's changed sections → at most one steering record per kind (`next`, `standing`); the standing one
   *  replaces any earlier standing steer. Returns the record the trail names (the `next` one if both). */
  private async steer(runId: string, rec: WorkingDocRecord, version: number, changed: SectionId[], wanted: Partial<Record<SectionId, string>>, by: string): Promise<SteerRecord | null> {
    const run = await this.d.run(runId);
    const made: SteerRecord[] = [];
    for (const kind of ['next', 'standing'] as const) {
      const ids = changed.filter((id) => SECTION_STEER[id] === kind);
      if (ids.length === 0) continue;
      const id = randomUUID().slice(0, 8);
      const note = steerNote(version, by === 'local' ? 'the operator' : by, kind, ids.map((s) => ({ id: s, text: wanted[s] ?? '' })), steerMarker(runId, id));
      const s: SteerRecord = { id, version, sections: ids, kind, note, at: this.now(), by, queuedAt: null, pickedUp: null, error: null, ...(kind === 'standing' ? { supersededBy: null, renewals: 0 } : {}) };
      if (run === null || run.terminal) {
        s.error = 'the job has ended, so there is no next step to steer';
      } else {
        try {
          await this.d.engine.injectWorkerMessage(runId, note, 'all');
          s.queuedAt = this.now();
        } catch (err) {
          s.error = err instanceof Error ? err.message : String(err);
        }
      }
      made.push(s);
    }
    if (made.length === 0) return null;
    this.d.store.update(runId, (r) => {
      for (const s of made) {
        if (s.kind === 'standing') for (const old of r.steers) if (old.kind === 'standing' && old.supersededBy == null && old.id !== s.id) old.supersededBy = s.id;
        r.steers.push(s);
      }
    });
    void rec;
    return made.find((s) => s.kind === 'next') ?? made[0] ?? null;
  }

  /**
   * The daemon's CoreEvent tap: which step picked a note up, and the standing steer re-sent before every later step.
   */
  onEvent(e: CoreEvent): void {
    const ev = e as unknown as Record<string, unknown>;
    const runId = typeof ev['session'] === 'string' ? ev['session'] : null;
    if (runId === null) return;
    const rec = this.d.store.get(runId);
    if (rec === undefined) return;
    if ((e.type === 'unitDispatched' || e.type === 'unitExecuting') && typeof ev['ord'] === 'number') {
      this.lastOrd.set(runId, ev['ord']);
      return;
    }
    if (e.type === 'workerMessageInjected' && typeof ev['message'] === 'string') {
      const message = ev['message'];
      const steer = rec.steers.find((s) => message.includes(steerMarker(runId, s.id)));
      if (steer === undefined || steer.pickedUp !== null) return;
      const ord = this.lastOrd.get(runId) ?? null;
      void this.d.run(runId).then((run) => {
        this.d.store.update(runId, (r) => {
          const s = r.steers.find((x) => x.id === steer.id);
          if (s !== undefined && s.pickedUp === null) s.pickedUp = { ord, step: ord !== null ? run?.stepOf(ord) ?? null : null, at: this.now() };
        });
        this.d.changed?.(runId, null);
      }).catch((err: unknown) => this.d.log?.(`[working-doc] pickup of ${steer.id} on ${runId}: ${String(err)}`));
      return;
    }
    if (e.type === 'unitDone') {
      // A standing steer is re-sent before every later step, until a later edit replaces it.
      const standing = rec.steers.find((s) => s.kind === 'standing' && s.supersededBy == null && s.error === null && s.pickedUp !== null);
      if (standing === undefined) return;
      void this.d.run(runId).then(async (run) => {
        if (run === null || run.terminal) return;
        await this.d.engine.injectWorkerMessage(runId, standing.note, 'all');
        this.d.store.update(runId, (r) => {
          const s = r.steers.find((x) => x.id === standing.id);
          if (s !== undefined) s.renewals = (s.renewals ?? 0) + 1;
        });
      }).catch((err: unknown) => this.d.log?.(`[working-doc] standing steer ${standing.id} on ${runId}: ${String(err)}`));
    }
  }
}
