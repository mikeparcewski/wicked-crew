/**
 * crew#1546 (coord merge check on #1613): an edited learning's replacement proposal names the memory it replaces
 * (`payload.replaces`, the old memory's id; every edit mints a new id, so the id is the version). A replacement is
 * STALE once that memory is gone (edited again or retired): approving it would put retired words back beside the
 * current ones. So it is refused at approval and rejected, whatever left it pending (a crash between filing and
 * approving included), and every edit rejects the pending replacements of its own memory and of memories that are gone.
 */

type EstateTool = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** The payload key a replacement proposal carries. */
export const REPLACES_KEY = 'replaces';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The memory a pending proposal's payload says it replaces, or null. */
export function replacesOf(payload: unknown): string | null {
  const r = isRecord(payload) ? payload[REPLACES_KEY] : undefined;
  return typeof r === 'string' && r !== '' ? r : null;
}

/** Every memory id in the store (throws on an unexpected answer: a caller that cannot read refuses). */
export async function memoryIds(estateTool: EstateTool): Promise<Set<string>> {
  const raw = await estateTool('memory.list', {});
  const items = isRecord(raw) ? raw['items'] : undefined;
  if (!Array.isArray(items)) throw new Error('memory.list returned an unexpected shape');
  return new Set(items.flatMap((i) => (isRecord(i) && typeof i['memory_id'] === 'string' ? [i['memory_id']] : [])));
}

/**
 * Before a person's approve of pending proposal `id` (its `payload`, from the pending read the approve makes anyway):
 * when it is a memory replacement whose memory is gone, reject it and say why (the caller answers 409 with these
 * words). Null, with no estate call, when it is not a replacement; null when its memory is still there.
 */
export async function refuseStaleReplacement(estateTool: EstateTool, id: string, payload: unknown): Promise<string | null> {
  const replaces = replacesOf(payload);
  if (replaces === null) return null;
  if ((await memoryIds(estateTool)).has(replaces)) return null;
  let rejected = true;
  await estateTool('proposal.reject', { id }).catch(() => {
    rejected = false;
  });
  return `proposal ${id} replaces the learning ${replaces}, which has since been edited or retired, so approving it would bring retired words back; ${
    rejected ? 'it was rejected as stale' : 'rejecting it failed, so reject it on the approve page'
  }`;
}
