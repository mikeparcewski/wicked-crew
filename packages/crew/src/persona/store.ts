/**
 * THE ORCHESTRATOR'S PERSONALITY (program DES-LEARN §3.3): how the agent that talks to the person
 * speaks — one record for the person (`user`), and an optional override per project, started as a
 * copy of theirs. A personality changes tone only: it is never read by a gate, a review, QE or a
 * rule check, and nothing here can widen what a seat may do.
 *
 * Persisted as ONE file, `<state home>/daemon-persona.json`, under the registered `daemon-` prefix
 * (as `editors/registry.ts` keeps `daemon-editors.json`): a new top-level entry outside that prefix
 * is one core's worker fence refuses. Written atomically (temp file + rename), read once at boot.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { crewStateHome } from '../projects/state-home.js';

export const PERSONA_STATE_FILENAME = 'daemon-persona.json';

/** The four dials: 0 = the left word, 2 = the right word. */
export const PERSONA_DIALS = ['length', 'warmth', 'pushback', 'initiative'] as const;
export type PersonaDialName = (typeof PERSONA_DIALS)[number];

/** The habits a person can tick. */
export const PERSONA_HABITS = ['says-unchecked', 'tables', 'cites', 'names'] as const;
export type PersonaHabit = (typeof PERSONA_HABITS)[number];

const Dial = z.number().int().min(0).max(2);

/** What a person sends (`PUT /persona`): the server adds `version` and `updatedAt`. */
export const PersonaInputSchema = z
  .object({
    // One line of plain text: a line break or control character could open a section of its own in the
    // chat statement the voice block rides (codex + agy on #1236).
    name: z.string().trim().min(1).max(40).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u, 'name is one line of text'),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/u, 'colour is a #rrggbb hex'),
    dials: z.object({ length: Dial, warmth: Dial, pushback: Dial, initiative: Dial }).strict(),
    habits: z.array(z.enum(PERSONA_HABITS)).max(PERSONA_HABITS.length),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();
export type PersonaInput = z.infer<typeof PersonaInputSchema>;

export interface Persona extends PersonaInput {
  /** Starts at 1, one more on every save of this scope. */
  version: number;
  /** Unix ms of the save. */
  updatedAt: number;
}

/** `user`, or `project:<id>` (an override for one project). */
export type PersonaScope = 'user' | `project:${string}`;

const PROJECT_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/** The scope a query or body names, or null when it is not one. */
export function parseScope(raw: unknown): PersonaScope | null {
  if (raw === 'user') return 'user';
  if (typeof raw !== 'string' || !raw.startsWith('project:')) return null;
  const id = raw.slice('project:'.length);
  return PROJECT_ID.test(id) ? `project:${id}` : null;
}

const StoredSchema = PersonaInputSchema.extend({
  version: z.number().int().min(1),
  updatedAt: z.number().int().min(0),
}).strict();

interface PersistedState {
  v: 1;
  user?: Persona;
  projects?: Record<string, Persona>;
}

export class PersonaStore {
  private readonly file: string;
  private user: Persona | null = null;
  private readonly projects = new Map<string, Persona>();
  private readonly log: (m: string) => void;

  constructor(opts: { stateHome?: string; log?: (m: string) => void } = {}) {
    this.file = join(opts.stateHome ?? crewStateHome(), PERSONA_STATE_FILENAME);
    this.log = opts.log ?? (() => undefined);
    this.load();
  }

  /** Where the record lives (diagnostics / tests). */
  get path(): string {
    return this.file;
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`[persona] ${PERSONA_STATE_FILENAME} unreadable: ${String(err)}`);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.log(`[persona] ${PERSONA_STATE_FILENAME} is not JSON; starting with no personality`);
      return;
    }
    const o = (raw ?? {}) as Record<string, unknown>;
    const user = StoredSchema.safeParse(o['user']);
    if (o['user'] !== undefined) {
      if (user.success) this.user = user.data;
      else this.log(`[persona] the user personality in ${PERSONA_STATE_FILENAME} is malformed; ignored`);
    }
    const projects = o['projects'];
    if (projects !== null && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [id, p] of Object.entries(projects)) {
        const parsed = StoredSchema.safeParse(p);
        if (PROJECT_ID.test(id) && parsed.success) this.projects.set(id, parsed.data);
        else this.log(`[persona] project ${id}'s personality in ${PERSONA_STATE_FILENAME} is malformed; ignored`);
      }
    }
  }

  private write(): void {
    const state: PersistedState = { v: 1 };
    if (this.user !== null) state.user = this.user;
    if (this.projects.size > 0) state.projects = Object.fromEntries([...this.projects].sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** The person's own personality, or null before one is saved. */
  userPersona(): Persona | null {
    return this.user;
  }

  /** Every project override, by project id. */
  overrides(): Record<string, Persona> {
    return Object.fromEntries(this.projects);
  }

  /** The personality a talk in `projectId` uses: the project's override, else the person's, else none. */
  effective(projectId: string | null): { persona: Persona; scope: PersonaScope } | null {
    if (projectId !== null) {
      const p = this.projects.get(projectId);
      if (p !== undefined) return { persona: p, scope: `project:${projectId}` };
    }
    return this.user === null ? null : { persona: this.user, scope: 'user' };
  }

  /** Save one scope; the version is one more than that scope's last. Throws when the write fails
   *  (the in-memory record is rolled back, so a failed save never reads as saved). */
  save(scope: PersonaScope, input: PersonaInput, now: number = Date.now()): Persona {
    const prev = scope === 'user' ? this.user : this.projects.get(scope.slice('project:'.length)) ?? null;
    const next: Persona = {
      ...input,
      habits: [...new Set(input.habits)],
      ...(input.notes !== undefined && input.notes !== '' ? { notes: input.notes } : { notes: undefined }),
      version: (prev?.version ?? 0) + 1,
      updatedAt: now,
    };
    if (next.notes === undefined) delete next.notes;
    this.put(scope, next);
    try {
      this.write();
    } catch (err) {
      this.put(scope, prev);
      throw err;
    }
    return next;
  }

  /** Remove a project's override (the person's own is never removed here). True when there was one. */
  remove(projectId: string): boolean {
    const prev = this.projects.get(projectId);
    if (prev === undefined) return false;
    this.projects.delete(projectId);
    try {
      this.write();
    } catch (err) {
      this.projects.set(projectId, prev);
      throw err;
    }
    return true;
  }

  private put(scope: PersonaScope, p: Persona | null): void {
    if (scope === 'user') {
      this.user = p;
      return;
    }
    const id = scope.slice('project:'.length);
    if (p === null) this.projects.delete(id);
    else this.projects.set(id, p);
  }
}
