/**
 * The working document's binding and trail (program DES-POWER-MODE §8.3, §9; spike 3).
 *
 * ONE file, `<state home>/daemon-working-docs.json`, under the `daemon-` prefix the state-home fence already
 * classifies (as `daemon-editors.json`). Per run: the wicked-interactive document it is bound to (project + doc
 * name), the trail of versions crew wrote (who, through which surface, which sections, when) and the steering
 * notes made from them (what was sent, when it was queued and which step picked it up).
 *
 * The versions themselves are interactive's (write-once, parent-linked, `author` in each batch). This file holds
 * only what interactive cannot know: the run, the attribution crew decided, and the steering.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { crewStateHome } from '../projects/state-home.js';
import type { SectionId, SteerKind } from './sections.js';

export const WORKING_DOCS_FILENAME = 'daemon-working-docs.json';
/** The sidecar crew writes into the document's own directory: it is what makes every seam read the doc as kind
 *  `phase-report` (`interactive/chat-events.ts readDocHead`), whatever interactive's manifest says. */
export const WORKING_DOC_SIDECAR = 'crew-working-doc.json';
export const WORKING_DOC_KIND = 'phase-report';

/** Who a version is by. A person's edit is `human` (the operator), a plugin's own generated lines `plugin`, the power
 *  orchestrator's own notes `agent` (`agent:<seat>`), the document crew seeds `system`. Only `human` ever steers. */
export type DocAuthor =
  | { kind: 'human'; id: string }
  | { kind: 'plugin'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'system'; id: 'crew' };

export interface TrailEntry {
  version: number;
  parent: number | null;
  author: DocAuthor;
  /** The surface the edit was made in (`plugin:wicked-phase-report@0.13.1`), when a plugin hosted it. */
  surface: string | null;
  sections: SectionId[];
  at: number;
  /** The steering note this version made, if any. */
  steerId: string | null;
}

export interface SteerRecord {
  id: string;
  version: number;
  sections: SectionId[];
  kind: Exclude<SteerKind, 'record'>;
  /** Exactly what was sent to the run. */
  note: string;
  at: number;
  by: string;
  /** Set once the engine accepted it (queued for the next step, or written into a live worker). */
  queuedAt: number | null;
  /** The step whose prompt carried it (`workerMessageInjected`). */
  pickedUp: { ord: number | null; step: string | null; at: number } | null;
  /** Why it was not sent (the run had ended; the engine refused). */
  error: string | null;
  /** A standing steer: the constraint alone, re-sent before every later step. */
  standingNote?: string;
  /** A standing steer: superseded by a later edit of the same section, it is no longer re-sent. */
  supersededBy?: string | null;
  /** A standing steer: how many later steps it was re-sent to. */
  renewals?: number;
}

export interface WorkingDocRecord {
  runId: string;
  projectId: string;
  docId: string;
  createdAt: number;
  trail: TrailEntry[];
  steers: SteerRecord[];
  /** An edit whose outcome was not known (no version in time): attributed once the head shows it, never to another. */
  pending?: { expectHead: number; author: DocAuthor; surface: string | null; values: Partial<Record<SectionId, string>>; at: number; actor: { id: string; kind: string } } | null;
}

interface FileShape { version: 1; runs: Record<string, WorkingDocRecord> }

export class WorkingDocStore {
  private readonly path: string;
  private data: FileShape;

  constructor(opts: { stateHome?: string; log?: (m: string) => void } = {}) {
    const home = opts.stateHome ?? crewStateHome();
    this.path = join(home, WORKING_DOCS_FILENAME);
    this.data = { version: 1, runs: {} };
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
        if (raw !== null && typeof raw === 'object' && raw.runs !== undefined && typeof raw.runs === 'object') {
          this.data = { version: 1, runs: raw.runs as Record<string, WorkingDocRecord> };
        }
      } catch (err) {
        opts.log?.(`[working-doc] ${this.path} is unreadable (${String(err)}); starting empty`);
      }
    }
  }

  get(runId: string): WorkingDocRecord | undefined { return this.data.runs[runId]; }

  all(): WorkingDocRecord[] { return Object.values(this.data.runs); }

  put(rec: WorkingDocRecord): void {
    this.data.runs[rec.runId] = rec;
    this.save();
  }

  /** Mutate one run's record and persist. */
  update(runId: string, f: (rec: WorkingDocRecord) => void): WorkingDocRecord | undefined {
    const rec = this.data.runs[runId];
    if (rec === undefined) return undefined;
    f(rec);
    this.save();
    return rec;
  }

  private save(): void {
    const dir = join(this.path, '..');
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }
}

/** Mark a doc directory as a run's working document (kind `phase-report`). */
export function writeSidecar(docDir: string, runId: string): void {
  mkdirSync(docDir, { recursive: true });
  writeFileSync(join(docDir, WORKING_DOC_SIDECAR), `${JSON.stringify({ kind: WORKING_DOC_KIND, runId }, null, 2)}\n`, 'utf8');
}

/** Whether a doc directory is a run's working document. */
export function isWorkingDocDir(docDir: string): boolean {
  return existsSync(join(docDir, WORKING_DOC_SIDECAR));
}
