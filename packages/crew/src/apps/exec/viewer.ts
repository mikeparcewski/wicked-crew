/**
 * Who a viewer is (DES-APPS-001 §7.2 "Viewer identity"). Studio with auth off: the daemon user, whose email
 * and name are the global git `user.email` and `user.name` (read at most every 30 s). An authenticated
 * actor carries only its id until the app server's token profiles (K6) bring claims. Groups do not exist
 * locally.
 */

import { LOCAL_ACTOR } from '../../api/auth.js';
import type { Actor } from '../../core/types.js';
import { gitIdentity } from '../../setup/known.js';
import type { Viewer } from './params.js';

let cached: { at: number; value: { name: string | null; email: string | null } | null } | null = null;

export async function localViewerOf(actor: Actor): Promise<Viewer> {
  if (actor !== LOCAL_ACTOR) return { id: actor.id, email: null, name: null, groups: null };
  const now = Date.now();
  if (cached === null || now - cached.at > 30_000) {
    let value: { name: string | null; email: string | null } | null = null;
    try {
      value = await gitIdentity();
    } catch {
      value = null;
    }
    cached = { at: now, value };
  }
  return { id: actor.id, email: cached.value?.email ?? null, name: cached.value?.name ?? null, groups: null };
}

export type { Viewer };
