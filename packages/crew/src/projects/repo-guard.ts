/**
 * (DES-PM-001 §3.2 rule 5, Q-PM2) The two routes that widen a project's repos, and so its code and its tracker set,
 * are a HUMAN's only:
 *
 * - attaching a `crew.repo` member to a project (`POST /projects/:id/members`): 403 `repo_attach_human_only`;
 * - re-registering an existing repo id against another checkout (`POST /repos`): core keeps the slug as the id and
 *   overwrites the entry (core `src/repo.rs`), so the new checkout would keep the old repo's projects and links.
 *   A non-human actor gets 409 `repo_exists`. A person may still re-point a repo.
 *
 * Detaching only narrows, so it is unchanged.
 */

import { realpath } from 'node:fs/promises';

import type { Actor } from '../core/types.js';

/** Core's repo id for a name (`src/repo.rs` `slug`): the first four kebab words, alphanumerics lower-cased. */
export function coreRepoSlug(name: string): string {
  const base = [...name].map((c) => (/[\p{Alphabetic}\p{N}]/u.test(c) ? (c.length === 1 && c.charCodeAt(0) < 128 ? c.toLowerCase() : c) : '-')).join('');
  const words = base.split('-').filter((w) => w !== '').slice(0, 4);
  return words.length === 0 ? 'repo' : words.join('-');
}

/** Whether `actor` may attach a `crew.repo` member to a project. */
export function mayAttachRepo(actor: Actor): boolean {
  return actor.kind === 'human';
}

/**
 * Why registering `name` at `rootPath` (or by clone) is refused for `actor`, or `null` when it may go ahead: a
 * non-human actor may not re-point an existing repo id at another checkout.
 */
export async function reRegisterRefusal(
  actor: Actor,
  name: string,
  rootPath: string | undefined,
  viaClone: boolean,
  repos: () => Promise<Array<{ id: string; root_path: string; name?: string }>>,
): Promise<{ status: 409; body: { error: string; code: 'repo_exists' } } | null> {
  if (actor.kind === 'human') return null;
  const id = coreRepoSlug(name);
  // By core's id for the name, and by the name itself: a slug this mirror computes differently still finds it.
  const existing = (await repos()).find((r) => r.id === id || r.name === name);
  if (existing === undefined) return null;
  if (!viaClone && rootPath !== undefined) {
    const real = await realpath(rootPath).catch(() => rootPath);
    const was = await realpath(existing.root_path).catch(() => existing.root_path);
    if (real === was) return null;
  }
  return {
    status: 409,
    body: { error: `a repo with id ${id} is already registered at another checkout; only a person can register it again elsewhere (it would keep that repo's projects and tracker links)`, code: 'repo_exists' },
  };
}
