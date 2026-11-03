// Publishing a test app the way crew does: an app built, checked and granted through crew's own store,
// source stage and write path (crew's tests/support harness on a real Postgres), then the manifest from
// crew's buildManifest and the site from crew's writeSite. The site's server is then started on it.

import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildManifest } from '../../../crew/src/apps/publish/manifest.js';
import { writeSite } from '../../../crew/src/apps/publish/pack.js';
import type { AppAction, AppPublishBody, AppPublishManifest, AppQuery } from '../../../crew/src/core/types.js';
import { updateAction, type WriteRig } from '../../../crew/tests/support/apps-writes.js';

/** A stand-in for the wicked-apps runtime's standalone entry: it only records the handshake. */
export const FAKE_RUNTIME = { js: 'var wickedAppsStandalone = { boot: function (port, hello) { window.__wkHello = hello; } };', css: ':root { --surface-base: #ffffff; }' };

export const TICKETS: AppQuery = { id: 'tickets', source: 'writer', kind: 'sql', output: [{ name: 'id', type: 'integer' }, { name: 'owner', type: 'string' }, { name: 'region', type: 'string' }] };
export const TICKETS_SQL = 'SELECT id, owner, region FROM s.tickets ORDER BY id';
export const MINE: AppQuery = { id: 'mine', source: 'writer', kind: 'sql', params: { type: 'object', properties: { me: { type: 'string', from: 'viewer.email' } } }, output: [{ name: 'id', type: 'integer' }] };
export const MINE_SQL = 'SELECT id FROM s.tickets WHERE owner = $1 ORDER BY id';
export const ASSIGN: AppAction = updateAction('assign', 'writer', 's.tickets', { owner: { kind: 'viewer', claim: 'email' } });

export const SITE_ORIGIN = 'http://localhost:8080';

export async function publishSite(rig: WriteRig, body: AppPublishBody, endpoints: { authorization: string; token: string } | null): Promise<{ dir: string; manifest: AppPublishManifest }> {
  const at = await rig.h.store.acceptedFiles('desk', rig.version());
  const out = await buildManifest({
    app: { slug: 'desk', name: 'Desk', version: at.version!, tree: at.tree, commit: at.commit },
    files: at.files,
    body,
    registry: rig.h.registry,
    grantOf: (id) => rig.h.writePath.getGrant('desk', id),
    endpoints,
  });
  if (!out.ok) throw new Error(`publish refused: ${JSON.stringify(out.findings)}`);
  const dir = mkdtempSync(join(tmpdir(), 'apps-k6-site-'));
  writeSite(dir, { spec: at.files.spec, specText: JSON.stringify(at.files.spec, null, 2), lockText: JSON.stringify(at.files.lock, null, 2), queryText: at.files.queryText, manifest: out.manifest, sources: out.sources, runtime: FAKE_RUNTIME });
  return { dir, manifest: out.manifest };
}

export interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: Record<string, unknown> & { code?: string; error?: string };
}

/** One request to the site, with whatever headers the test sets (Origin included). */
export function call(port: number, method: string, path: string, opts: { token?: string; body?: unknown; origin?: string | null; contentType?: string | null; raw?: string } = {}): Promise<Answer> {
  const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (payload !== undefined && opts.contentType !== null) headers['content-type'] = opts.contentType ?? 'application/json';
  const origin = opts.origin === undefined ? (method === 'POST' ? SITE_ORIGIN : null) : opts.origin;
  if (origin !== null) headers['origin'] = origin;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Answer['json'] = {};
        try {
          json = JSON.parse(text) as Answer['json'];
        } catch {
          // a page
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
