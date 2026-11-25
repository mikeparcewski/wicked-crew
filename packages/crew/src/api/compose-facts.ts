/**
 * (crew#372) A compose's launch facts: recorded on its `run.launched` entry by the compose route, read back by the
 * run-timing index, and the only source product publish trusts for what a compose was given. No imports beyond node:
 * the index reads it at boot.
 */

import { createHash } from 'node:crypto';

/** How far down a draft goes (DES-CATALOG-002 §3.1 Backlog): epics, stories (today's default), or tasks too. */
export type ComposeLevel = 'epics' | 'stories' | 'tasks';

/**
 * (crew#372) What a compose launched with, recorded on its `run.launched` entry (and read back by the run-timing index):
 * the requirements it was given, the level, and each step's id, catalog and the sha256 of its instructions. Publish
 * reads the plan only from a run these facts describe, whose units still match them (DES-372 "The run").
 */
export interface ComposeFacts {
  /** The project the compose drafted for. */
  projectId: string;
  requirements: Array<{ repoId: string; key: string }>;
  level: ComposeLevel;
  steps: Array<{ id: string; catalog: string; instructionsSha: string }>;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The compose facts of one launch. */
export function composeFactsOf(projectId: string, requirements: ReadonlyArray<{ repoId: string; key: string }>, level: ComposeLevel, draft: string, review: string): ComposeFacts {
  return {
    projectId,
    requirements: requirements.map((r) => ({ repoId: r.repoId, key: r.key })),
    level,
    steps: [
      { id: 'draft', catalog: 'produce', instructionsSha: sha256Hex(draft) },
      { id: 'review', catalog: 'critique', instructionsSha: sha256Hex(review) },
    ],
  };
}

/** A recorded `compose` detail read back, or `null` when it is not one crew wrote. */
export function readComposeFacts(v: unknown): ComposeFacts | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const reqs = o['requirements'];
  const steps = o['steps'];
  const projectId = o['projectId'];
  if (typeof projectId !== 'string' || projectId === '' || !Array.isArray(reqs) || !Array.isArray(steps) || (o['level'] !== 'epics' && o['level'] !== 'stories' && o['level'] !== 'tasks')) return null;
  const requirements: ComposeFacts['requirements'] = [];
  for (const r of reqs as unknown[]) {
    const x = r as Record<string, unknown> | null;
    if (x === null || typeof x !== 'object' || typeof x['repoId'] !== 'string' || typeof x['key'] !== 'string') return null;
    requirements.push({ repoId: x['repoId'], key: x['key'] });
  }
  const out: ComposeFacts['steps'] = [];
  for (const st of steps as unknown[]) {
    const x = st as Record<string, unknown> | null;
    if (x === null || typeof x !== 'object' || typeof x['id'] !== 'string' || typeof x['catalog'] !== 'string' || typeof x['instructionsSha'] !== 'string') return null;
    out.push({ id: x['id'], catalog: x['catalog'], instructionsSha: x['instructionsSha'] });
  }
  return { projectId, requirements, level: o['level'], steps: out };
}
