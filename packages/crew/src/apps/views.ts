/**
 * (DES-KNOWLEDGE-DATA-001 §5.2, crew#1317) The Apps detail as a non-human reader may see it.
 *
 * `GET /apps/:app` is an observer read. Its lock pins each source's connection DESCRIPTOR (driver, host,
 * port, database, login, TLS mode, confirmed ranges, secret-reference identity, a descriptor-version-2
 * entry's Toolbox document) and its `queryText` holds the app's SQL, which names the source's relations.
 * A human actor (studio's app viewers) reads it whole. Any other actor ({@link viewOf} `agent`) reads the
 * lock's sources reduced to `{kind, descriptorHash}` and no `queryText`; everything else passes through.
 * Crew's own readers (the K5 builder's turn, the check, the executor) call the store in process, not the
 * route, so they keep the full detail.
 */

import { viewOf } from '../api/auth.js';
import type { Actor, AppDetail, AppLock, AppLockSource } from '../core/types.js';

/** The agent-safe form of the Apps detail: no query text, no source descriptor. Crew-local (api-types unchanged). */
export type AppDetailAgentView = Omit<AppDetail, 'queryText' | 'lock'> & {
  lock: Omit<AppLock, 'sources'> & { sources: Record<string, Pick<AppLockSource, 'kind' | 'descriptorHash'>> };
};

/** `detail` as `actor` may read it. */
export function appDetailFor(actor: Actor | null | undefined, detail: AppDetail): AppDetail | AppDetailAgentView {
  if (viewOf(actor) === 'full') return detail;
  const view: Partial<AppDetail> = { ...detail };
  delete view.queryText;
  const sources = Object.fromEntries(Object.entries(detail.lock.sources).map(([name, s]) => [name, { kind: s.kind, descriptorHash: s.descriptorHash }]));
  return { ...(view as Omit<AppDetail, 'queryText' | 'lock'>), lock: { ...detail.lock, sources } };
}
