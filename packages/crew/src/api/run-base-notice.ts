import type { Actor } from '../core/types.js';
import type { AuditLog } from './audit.js';

/** The engine emits this once per minted run worktree; disclose its failed fetch (crew#1566). */
export function recordBaseUnfetched(
  event: Record<string, unknown>,
  audit: AuditLog,
  actor: Actor,
  log?: (message: string) => void,
): void {
  if (event['type'] !== 'runBaseResolved' || event['fetched'] !== false || typeof event['session'] !== 'string') return;

  const { baseRef, baseCommit, localHead, note } = event;
  const at = typeof baseCommit === 'string' ? ` at ${baseCommit.slice(0, 7)}` : '';
  const why = typeof note === 'string' && note !== '' ? ` (${note})` : '';
  const message = `This run started from ${baseRef ?? "the folder's current HEAD"}${at}, and the daemon could not fetch origin${why}, so it may be behind the remote.`;
  audit.record('run.base_unfetched', actor, {
    runId: event['session'],
    detail: { message, baseRef, baseCommit, localHead, note },
  });
  log?.(message);
}
