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
import { LINE_EVENTS, PHASE_REPORT_AUTHOR, docLines, foldLines, reconcileSection } from './event-lines.js';

/** How crew reads and writes interactive documents (the bridge in production, a fake in tests). */
export interface DocBackend {
  /** Create the document with its first version; marks it `phase-report` (the sidecar) before it is used. */
  create(projectId: string, docId: string, runId: string, html: string): Promise<{ head: number }>;
  /** The head version and ITS HTML (one version, never a torn pair), or null when the document is gone. */
  read(projectId: string, docId: string): Promise<{ head: number; html: string } | null>;
  /** One version's HTML, or null when there is no such version (yet). */
  readVersion(projectId: string, docId: string, version: number): Promise<string | null>;
  /** One feedback batch of content edits on `expectHead`; resolves when ITS version landed (checked by content), or
   *  `headMoved` when the base was stale. Throws {@link UndeterminedWriteError} when the outcome is not known. */
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
  /** The run's recorded events (the engine's log), from which crew writes the document's event-derived lines
   *  (Decisions answered, Open questions, Next). `null` when the log cannot be read. Absent: no such lines. */
  events?(runId: string): Promise<readonly CoreEvent[] | null>;
  /** How long after a line-relevant event the lines are brought up to date (one write per burst). */
  linesDelayMs?: number;
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
  const slug = runId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return `working-${slug === '' ? 'run' : slug}`;
}

/** The marker a note ends with, by which `workerMessageInjected` is matched back to its steer. */
export function steerMarker(runId: string, steerId: string): string {
  return `[working-doc ${runId.slice(0, 8)}:${steerId}]`;
}

/** The one note a person's version becomes: the sections that steer once, and the standing constraint, together. */
export function steerNote(version: number, by: string, standing: boolean, texts: Array<{ id: SectionId; text: string }>, marker: string): string {
  const head = standing
    ? `Operator steering from the job's working document (version ${version}, by ${by}). Its Constraints and steering is standing: follow it in this step and every later one until it is replaced. It replaces any standing constraint from an earlier version.`
    : `Operator steering from the job's working document (version ${version}, by ${by}).`;
  const lines = texts.map((t) => `- ${SECTION_LABELS[t.id]}: ${t.text.trim() === '' ? '(cleared)' : t.text.trim()}`);
  return [head, NO_GATE_LINE, ...lines, marker].join('\n');
}

/** The standing constraint alone, re-sent before every later step. */
export function standingNote(version: number, by: string, text: string, marker: string): string {
  return [
    `Standing operator constraint from the job's working document (version ${version}, by ${by}). Follow it in this step and every later one until it is replaced. If you also see a standing constraint from a later version, that one applies instead.`,
    NO_GATE_LINE,
    `- ${SECTION_LABELS.constraints}: ${text.trim()}`,
    marker,
  ].join('\n');
}

/** Every note's second line. */
export const NO_GATE_LINE = 'It adds to your brief. It does not answer, skip or change any gate, check, review or QE step.';

function blankSections(): Record<SectionId, string> {
  return { goal: '', approach: '', decisions: '', constraints: '', questions: '', next: '' };
}

/** A write whose outcome is not known (no version in time, or a version that is not this batch's). */
/** The orchestrator's notes for one write (from the engine's `powerWorkingNotes` frame). */
export interface AgentNotes {
  seat: string;
  turn: number;
  approach: string | null;
  decisions: Array<{ text: string; why: string | null }>;
}

/** A seat name as it may appear in an author id. */
const AGENT_SEAT = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class UndeterminedWriteError extends Error {
  constructor(message: string) { super(message); this.name = 'UndeterminedWriteError'; }
}

export class WorkingDocService {
  private readonly now: () => number;
  /** The newest dispatch of each run (unit and attempt): the step a note injected now is picked up by. */
  private readonly lastDispatch = new Map<string, { ord: number; attempt: number }>();
  /** A standing constraint with a copy queued and not yet picked up. */
  private readonly queued = new Map<string, boolean>();
  /** One write per run at a time (a second waits its turn); steering renewals take the same turn. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** A standing steer is re-queued once per dispatch that picked it up (a live worker hears it once, not in a loop). */
  private readonly renewedFor = new Map<string, string | null>();
  /** One pending event-lines write per run (a burst of events becomes one write). */
  private readonly linesDue = new Map<string, ReturnType<typeof setTimeout>>();

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
    // An edit whose outcome was unknown is settled on every read, not only by the next edit.
    if (this.d.store.get(runId)?.pending != null) await this.exclusive(runId, () => this.reconcile(runId));
    const rec = this.d.store.get(runId);
    const base = { runId, labels: { ...SECTION_LABELS }, trail: rec?.trail ?? [], steers: rec?.steers ?? [] };
    if (rec === undefined) return { ...base, doc: null, sections: null };
    const head = await this.d.backend.read(rec.projectId, rec.docId);
    if (head === null) return { ...base, doc: null, sections: null };
    return { ...base, doc: { projectId: rec.projectId, docId: rec.docId, head: head.head }, sections: { ...blankSections(), ...sectionsOf(head.html) } };
  }

  /** The run's working document, created on first ask (its Goal seeded from the run's intent, by crew). The view is
   *  read after the lock is released: `view()` settles a pending write under the same lock (review on #1218: reading it
   *  inside deadlocked the run's document). */
  async ensure(runId: string): Promise<WorkingDocView | null> {
    if (!(await this.ensureDoc(runId))) return null;
    return this.view(runId);
  }

  /** Make the run's document if it has none; `false` when the run is unknown. */
  private ensureDoc(runId: string): Promise<boolean> {
    return this.exclusive(runId, async () => {
      if (this.d.store.get(runId) !== undefined) return true;
      const run = await this.d.run(runId);
      if (run === null) return false;
      const docId = workingDocName(runId);
      const html = initialHtml(run.title, { goal: run.problem.replace(/\r\n?/g, '\n').trim().slice(0, 1_500) });
      const { head } = await this.d.backend.create(run.projectId, docId, runId, html);
      const rec: WorkingDocRecord = {
        runId, projectId: run.projectId, docId, createdAt: this.now(),
        trail: [{ version: head, parent: null, author: { kind: 'system', id: 'crew' }, surface: null, sections: ['goal'], at: this.now(), steerId: null }],
        steers: [],
      };
      this.d.store.put(rec);
      this.d.changed?.(runId, head);
      return true;
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
      const pluginActor = `plugin:${plugin.id}@${plugin.version}`;
      // A plugin's lines come from the plugin itself (its own actor) or from the person's studio hosting it; a worker or
      // system caller never writes as any plugin.
      if (!(actor.kind === 'human' || (actor.kind === 'plugin' && actor.id === pluginActor))) {
        return { ok: false, code: 403, error: 'only the plugin itself, or the studio hosting it, writes a plugin’s lines' };
      }
      author = { kind: 'plugin', id: pluginActor };
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
    await this.reconcile(runId);
    const head = await this.d.backend.read(rec.projectId, rec.docId);
    if (head === null) return { ok: false, code: 404, error: 'the working document is gone' };
    if (head.head !== input.base) return { ok: false, code: 409, error: 'the working document changed since', head: head.head };
    if (this.d.store.get(runId)?.pending != null) return { ok: false, code: 409, error: 'an earlier edit may still land; read the document again', head: head.head };
    const before = sectionsOf(head.html);
    const changed = changedSections(before, wanted);
    if (changed.length === 0) return { ok: true, version: null, unchanged: true, steer: null, view: await this.view(runId) };
    const surface = plugin !== undefined ? `plugin:${plugin.id}@${plugin.version}` : null;
    const values: Partial<Record<SectionId, string>> = {};
    for (const id of changed) values[id] = wanted[id] ?? '';
    let written: { version: number; parent: number } | { headMoved: true; head: number };
    try {
      written = await this.d.backend.edit(rec.projectId, rec.docId, {
        expectHead: input.base,
        // interactive's item selector is the bare anchor id (its own `[data-wid=…]` lookup).
        items: changed.map((id) => ({ selector: anchorOf(id), value: encodeSectionText(values[id] ?? '') })),
        // interactive records the batch's author; crew's trail records the full attribution and the surface.
        author: author.kind === 'human' ? `${author.id}${surface !== null ? ` via ${surface}` : ''}` : author.id,
      });
    } catch (err) {
      if (err instanceof UndeterminedWriteError) this.rememberPending(runId, input.base, author, surface, values, actor);
      throw err;
    }
    if ('headMoved' in written) return { ok: false, code: 409, error: 'the working document changed since', head: written.head };
    const steer = await this.record(runId, written.version, written.parent, author, surface, changed, values, actor);
    return { ok: true, version: written.version, unchanged: false, steer, view: await this.view(runId) };
  }

  /**
   * (power mode) The orchestrator's own working notes, from the engine's `powerWorkingNotes` frame, written as one
   * version by `agent:<seat>`. It never steers: only a person's version does. Approach is replaced, unless a person
   * wrote the current Approach: their edit stands, and the agent's restatement is recorded under Decisions instead.
   * Each decision is appended under Decisions with its reason. A person's edit racing this write wins: the agent
   * re-reads and writes again on top of it (twice at most). Resolves to the version written, or `null`.
   */
  async agentNotes(runId: string, notes: AgentNotes): Promise<number | null> {
    const seat = AGENT_SEAT.test(notes.seat) ? notes.seat : 'agent';
    const id = `agent:${seat}`;
    if (!(await this.ensureDoc(runId))) return null;
    return this.exclusive(runId, async () => {
      const rec = this.d.store.get(runId);
      if (rec === undefined) return null;
      await this.reconcile(runId);
      if (this.d.store.get(runId)?.pending != null) return null;
      const tag = `${seat}, turn ${notes.turn}`;
      const humanApproach = [...rec.trail].reverse().find((t) => t.sections.includes('approach'))?.author.kind === 'human';
      for (let attempt = 0; attempt < 3; attempt++) {
        const head = await this.d.backend.read(rec.projectId, rec.docId);
        if (head === null) return null;
        const before = { ...blankSections(), ...sectionsOf(head.html) };
        const wanted: Partial<Record<SectionId, string>> = {};
        const lines: string[] = [];
        const approach = notes.approach?.trim() ?? '';
        if (approach !== '') {
          if (humanApproach) lines.push(`- Approach now (${tag}): ${approach}. Your edit to Approach stands.`);
          else wanted.approach = approach.slice(0, SECTION_MAX_CHARS);
        }
        for (const d of notes.decisions) {
          const text = d.text.trim();
          if (text === '') continue;
          const why = d.why?.trim() ?? '';
          lines.push(`- ${text}${why !== '' ? `. Why: ${why}` : ''} (${tag})`);
        }
        if (lines.length > 0) {
          // The newest lines are kept when the section is full: the oldest are dropped first.
          const all = [...(before.decisions ?? '').split('\n').filter((l) => l.trim() !== ''), ...lines];
          while (all.join('\n').length > SECTION_MAX_CHARS && all.length > 1) all.shift();
          wanted.decisions = all.join('\n').slice(0, SECTION_MAX_CHARS);
        }
        const changed = changedSections(before, wanted);
        if (changed.length === 0) return null;
        const values: Partial<Record<SectionId, string>> = {};
        for (const sid of changed) values[sid] = wanted[sid] ?? '';
        let written: { version: number; parent: number } | { headMoved: true; head: number };
        try {
          written = await this.d.backend.edit(rec.projectId, rec.docId, {
            expectHead: head.head,
            items: changed.map((sid) => ({ selector: anchorOf(sid), value: encodeSectionText(values[sid] ?? '') })),
            author: id,
          });
        } catch (err) {
          // Not known whether it landed: the same recovery as a person's write (review on #1218).
          if (err instanceof UndeterminedWriteError) this.rememberPending(runId, head.head, { kind: 'agent', id }, null, values, { id, kind: 'agent' });
          throw err;
        }
        if ('headMoved' in written) continue;
        await this.record(runId, written.version, written.parent, { kind: 'agent', id }, null, changed, values, { id, kind: 'agent' });
        return written.version;
      }
      return null;
    });
  }

  /**
   * The document's EVENT-DERIVED lines (Decisions answered, Open questions, Next), brought up to date from the run's
   * own recorded events and written by crew as the Phase report plugin's actor ({@link PHASE_REPORT_AUTHOR}), whether
   * or not anyone has the run open (rig run ea73afc0: only a viewing tab wrote them). Like every plugin line they
   * never steer, and a person's own lines in those sections stay as they are, in place. A power run gets its document
   * here if it has none; any other run only once it has one. A person's edit racing this write wins: crew re-reads and
   * writes again on top of it (3 tries at most). Resolves to the version written, or `null` (nothing to change, no
   * log, no document).
   */
  async syncLines(runId: string): Promise<number | null> {
    if (this.d.events === undefined) return null;
    const events = await this.d.events(runId);
    if (events === null) return null;
    const model = foldLines(events);
    if (!model.power && this.d.store.get(runId) === undefined) return null;
    if (!(await this.ensureDoc(runId))) return null;
    const lines = docLines(model);
    const id = PHASE_REPORT_AUTHOR;
    return this.exclusive(runId, async () => {
      const rec = this.d.store.get(runId);
      if (rec === undefined) return null;
      await this.reconcile(runId);
      if (this.d.store.get(runId)?.pending != null) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const head = await this.d.backend.read(rec.projectId, rec.docId);
        if (head === null) return null;
        const before = { ...blankSections(), ...sectionsOf(head.html) };
        const wanted: Partial<Record<SectionId, string>> = {};
        for (const sid of ['decisions', 'questions', 'next'] as const) {
          let text = reconcileSection(sid, before[sid], lines[sid]);
          if (text === null) continue;
          // A full section keeps its newest lines: the oldest go first.
          const all = text.split('\n');
          while (all.join('\n').length > SECTION_MAX_CHARS && all.length > 1) all.shift();
          text = all.join('\n').slice(0, SECTION_MAX_CHARS);
          wanted[sid] = text;
        }
        const changed = changedSections(before, wanted);
        if (changed.length === 0) return null;
        const values: Partial<Record<SectionId, string>> = {};
        for (const sid of changed) values[sid] = wanted[sid] ?? '';
        let written: { version: number; parent: number } | { headMoved: true; head: number };
        try {
          written = await this.d.backend.edit(rec.projectId, rec.docId, {
            expectHead: head.head,
            items: changed.map((sid) => ({ selector: anchorOf(sid), value: encodeSectionText(values[sid] ?? '') })),
            author: id,
          });
        } catch (err) {
          if (err instanceof UndeterminedWriteError) this.rememberPending(runId, head.head, { kind: 'plugin', id }, null, values, { id, kind: 'plugin' });
          throw err;
        }
        if ('headMoved' in written) continue;
        await this.record(runId, written.version, written.parent, { kind: 'plugin', id }, null, changed, values, { id, kind: 'plugin' });
        return written.version;
      }
      return null;
    });
  }

  /** Bring the event-derived lines up to date shortly (a burst of events becomes one write). */
  private linesSoon(runId: string): void {
    if (this.d.events === undefined || this.linesDue.has(runId)) return;
    const t = setTimeout(() => {
      this.linesDue.delete(runId);
      void this.syncLines(runId).catch((err: unknown) => this.d.log?.(`[working-doc] lines for ${runId}: ${String(err)}`));
    }, this.d.linesDelayMs ?? 1_500);
    (t as { unref?: () => void }).unref?.();
    this.linesDue.set(runId, t);
  }

  /** A write whose outcome is not known: remembered, so a later read attributes it if it lands, never to the next
   *  caller, and looked at again on its own shortly, so its steer (a person's) is not left waiting for a reader. */
  private rememberPending(runId: string, expectHead: number, author: DocAuthor, surface: string | null, values: Partial<Record<SectionId, string>>, actor: { id: string; kind: string }): void {
    this.d.store.update(runId, (r) => { r.pending = { expectHead, author, surface, values, at: this.now(), actor: { id: actor.id, kind: actor.kind } }; });
    for (const ms of [30_000, 75_000]) {
      const t = setTimeout(() => { void this.exclusive(runId, () => this.reconcile(runId)).catch(() => undefined); }, ms);
      (t as { unref?: () => void }).unref?.();
    }
  }

  /** A version that landed: its trail entry, its steer (a person's only), its audit line and the change frame. */
  private async record(runId: string, version: number, parent: number, author: DocAuthor, surface: string | null, changed: SectionId[], values: Partial<Record<SectionId, string>>, actor: { id: string; kind: string }): Promise<SteerRecord | null> {
    const steer = author.kind === 'human' ? await this.steer(runId, version, changed, values, author.id) : null;
    const entry: TrailEntry = { version, parent, author, surface, sections: changed, at: this.now(), steerId: steer?.id ?? null };
    this.d.store.update(runId, (r) => { r.trail.push(entry); });
    this.d.audit?.('run.steered.doc', actor, runId, {
      version, sections: changed, author: author.kind === 'human' ? 'operator' : author.id,
      ...(surface !== null ? { surface } : {}),
      ...(steer !== null ? { steer: steer.id, kind: steer.kind, steered: steer.sections, sent: steer.error === null } : {}),
    });
    this.d.changed?.(runId, version);
    return steer;
  }

  /** An edit whose outcome was unknown: once the head moved past it, the version is checked against what it wrote and
   *  recorded as its author's if (and only if) it is that write. */
  private async reconcile(runId: string): Promise<void> {
    const rec = this.d.store.get(runId);
    const p = rec?.pending;
    if (rec === undefined || p == null) return;
    const v = p.expectHead + 1;
    const html = await this.d.backend.readVersion(rec.projectId, rec.docId, v);
    if (html === null) {
      const head = await this.d.backend.read(rec.projectId, rec.docId);
      // Still nothing after it: the batch is gone (interactive refused it). Only a wait of a minute settles that.
      if (head !== null && head.head === p.expectHead && this.now() - p.at > 60_000) this.d.store.update(runId, (r) => { r.pending = null; });
      return;
    }
    const got = sectionsOf(html);
    const ids = Object.keys(p.values) as SectionId[];
    this.d.store.update(runId, (r) => { r.pending = null; });
    if (ids.every((id) => got[id] === p.values[id])) await this.record(runId, v, p.expectHead, p.author, p.surface, ids, p.values, p.actor);
  }

  /**
   * A person's version → ONE steering note for the run (§9): Goal, Approach and Next for the next step, and Constraints
   * and steering as a standing constraint (an emptied Constraints is said once, as cleared). The record is stored
   * BEFORE the engine is asked, so a pickup reported at once is never lost.
   */
  private async steer(runId: string, version: number, changed: SectionId[], values: Partial<Record<SectionId, string>>, by: string): Promise<SteerRecord | null> {
    const steered = changed.filter((id) => SECTION_STEER[id] !== 'record');
    if (steered.length === 0) return null;
    const constraints = values.constraints;
    const standing = steered.includes('constraints') && constraints !== undefined && constraints.trim() !== '';
    const who = by === 'local' ? 'the operator' : by;
    const id = randomUUID().slice(0, 8);
    const marker = steerMarker(runId, id);
    const s: SteerRecord = {
      id, version, sections: steered, kind: standing ? 'standing' : 'next',
      note: steerNote(version, who, standing, steered.map((x) => ({ id: x, text: values[x] ?? '' })), marker),
      ...(standing ? { standingNote: standingNote(version, who, constraints ?? '', marker), supersededBy: null, renewals: 0 } : {}),
      at: this.now(), by, queuedAt: null, pickedUp: null, error: null,
    };
    const run = await this.d.run(runId);
    if (run === null || run.terminal) s.error = 'the job has ended, so there is no next step to steer';
    this.d.store.update(runId, (r) => {
      // Any edit of Constraints (a new one, or emptied) replaces the standing one before it.
      if (steered.includes('constraints')) for (const old of r.steers) if (old.kind === 'standing' && old.supersededBy == null) old.supersededBy = id;
      r.steers.push(s);
    });
    if (s.error !== null) return s;
    try {
      await this.d.engine.injectWorkerMessage(runId, s.note, 'all');
      this.d.store.update(runId, (r) => { const x = r.steers.find((y) => y.id === id); if (x !== undefined) x.queuedAt = this.now(); });
    } catch (err) {
      this.d.store.update(runId, (r) => { const x = r.steers.find((y) => y.id === id); if (x !== undefined) x.error = err instanceof Error ? err.message : String(err); });
    }
    return this.d.store.get(runId)?.steers.find((y) => y.id === id) ?? s;
  }

  /**
   * The daemon's CoreEvent tap.
   *
   *  - `unitDispatched` / `unitExecuting` (every run, also before its document exists): the dispatch a note injected now
   *    is picked up by, as `ord` + `attempt` (a retry of the same unit is another dispatch).
   *  - `workerMessageInjected`: the step whose prompt carried a note (recorded at once, its name read after).
   *  - A STANDING constraint is kept one copy ahead: when a dispatch picks a copy up, the next copy is queued at once
   *    (once per dispatch), so the next dispatch finds it waiting — never raced against `unitDone`. A live worker that
   *    takes the copy in the same dispatch leaves none waiting; then the step's `unitDone` queues it. Every copy says it
   *    replaces any earlier standing constraint, so a copy already queued when a person replaces it is overruled by the
   *    newer one (the engine has no way to withdraw a queued note).
   */
  onEvent(e: CoreEvent): void {
    const ev = e as unknown as Record<string, unknown>;
    const runId = typeof ev['session'] === 'string' ? ev['session'] : null;
    if (runId === null) return;
    if (LINE_EVENTS.has(ev['type'] as string)) this.linesSoon(runId);
    if ((ev['type'] as string) === 'powerWorkingNotes') {
      const decisions = Array.isArray(ev['decisions'])
        ? (ev['decisions'] as Array<Record<string, unknown>>)
            .filter((d) => typeof d['text'] === 'string')
            .map((d) => ({ text: d['text'] as string, why: typeof d['why'] === 'string' ? d['why'] : null }))
        : [];
      void this.agentNotes(runId, {
        seat: typeof ev['seat'] === 'string' ? ev['seat'] : 'agent',
        turn: typeof ev['turn'] === 'number' ? ev['turn'] : 0,
        approach: typeof ev['approach'] === 'string' ? ev['approach'] : null,
        decisions,
      }).catch(() => undefined);
      return;
    }
    if ((e.type === 'unitDispatched' || e.type === 'unitExecuting') && typeof ev['ord'] === 'number') {
      const attempt = typeof ev['attempt'] === 'number' ? ev['attempt'] : (this.lastDispatch.get(runId)?.ord === ev['ord'] ? this.lastDispatch.get(runId)?.attempt ?? 0 : 0);
      this.lastDispatch.set(runId, { ord: ev['ord'], attempt });
      return;
    }
    const rec = this.d.store.get(runId);
    if (rec === undefined) return;
    if (e.type === 'unitDone' || e.type === 'unitDenied') {
      for (const s of rec.steers) {
        if (s.kind === 'standing' && s.supersededBy == null && s.error === null && s.pickedUp !== null && this.queued.get(s.id) !== true) this.renew(runId, s.id, null);
      }
      return;
    }
    if (e.type !== 'workerMessageInjected' || typeof ev['message'] !== 'string') return;
    const message = ev['message'];
    const steer = rec.steers.find((s) => message.includes(steerMarker(runId, s.id)));
    if (steer === undefined) return;
    const at = this.lastDispatch.get(runId) ?? null;
    const ord = at?.ord ?? null;
    this.queued.set(steer.id, false);
    if (steer.pickedUp === null) {
      this.d.store.update(runId, (r) => { const s = r.steers.find((x) => x.id === steer.id); if (s !== undefined && s.pickedUp === null) s.pickedUp = { ord, step: null, at: this.now() }; });
      this.d.changed?.(runId, null);
      // The step's name, once the run's view is read.
      void this.d.run(runId).then((run) => {
        this.d.store.update(runId, (r) => { const s = r.steers.find((x) => x.id === steer.id); if (s?.pickedUp != null && s.pickedUp.step === null && ord !== null) s.pickedUp.step = run?.stepOf(ord) ?? null; });
        this.d.changed?.(runId, null);
      }).catch((err: unknown) => this.d.log?.(`[working-doc] pickup of ${steer.id} on ${runId}: ${String(err)}`));
    }
    if (steer.kind !== 'standing' || steer.standingNote == null) return;
    const dispatch = at === null ? null : `${at.ord}:${at.attempt}`;
    if (this.renewedFor.has(steer.id) && this.renewedFor.get(steer.id) === dispatch) return;
    this.renewedFor.set(steer.id, dispatch);
    this.renew(runId, steer.id, dispatch);
  }

  /** Queue one copy of a standing constraint, inside the run's turn, if it is still the one in force. */
  private renew(runId: string, steerId: string, dispatch: string | null): void {
    this.queued.set(steerId, true);
    void this.exclusive(runId, async () => {
      const current = this.d.store.get(runId)?.steers.find((x) => x.id === steerId);
      if (current === undefined || current.supersededBy != null || current.error !== null || current.standingNote == null) { this.queued.set(steerId, false); return; }
      const run = await this.d.run(runId);
      if (run === null || run.terminal || this.d.store.get(runId)?.steers.find((x) => x.id === steerId)?.supersededBy != null) { this.queued.set(steerId, false); return; }
      await this.d.engine.injectWorkerMessage(runId, current.standingNote, 'all');
      this.d.store.update(runId, (r) => { const x = r.steers.find((y) => y.id === steerId); if (x !== undefined) x.renewals = (x.renewals ?? 0) + 1; });
      this.d.changed?.(runId, null);
      void dispatch;
    }).catch((err: unknown) => { this.queued.set(steerId, false); this.d.log?.(`[working-doc] standing steer ${steerId} on ${runId}: ${String(err)}`); });
  }
}
