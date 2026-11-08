/** `wicked-crew apps-produce`: the apps-publish produce Tool, authenticated by its unit token. */

import type { AppPublished } from '../core/types.js';

export interface AppsProduceIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
}

export async function runAppsProduce(io: AppsProduceIo): Promise<number> {
  const token = io.env['WICKED_MCP_TOKEN'] ?? '';
  const url = (io.env['WICKED_CREW_URL'] ?? '').replace(/\/+$/, '');
  if (token === '' || url === '') {
    io.err('apps_produce: no unit token or daemon URL (WICKED_MCP_TOKEN, WICKED_CREW_URL); this runs only as an apps-publish produce step');
    return 1;
  }
  try {
    const res = await (io.fetch ?? fetch)(`${url}/api/v1/apps/produce`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(16 * 60_000),
    });
    const body = await res.json() as { ok?: boolean; code?: string; error?: string; published?: AppPublished };
    if (!res.ok || body.ok !== true || body.published === undefined) {
      io.err(`apps_produce: refused: ${body.code ?? res.status}: ${(body.error ?? 'no published image').slice(0, 600)}`);
      return 1;
    }
    io.out(`apps_produce: ${body.published.image.tag} (${body.published.image.id})`);
    io.out(`Share: ${body.published.shareUrl}`);
    return 0;
  } catch (err) {
    io.err(`apps_produce: crew did not answer (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
}
