/**
 * The working document's backend in production: the project's wicked-interactive bridge (the one pool the proxy and
 * the theme seam share). Create = `POST /api/docs {name, html}` (an html document; no draft, no model) then the
 * `phase-report` sidecar; read = `GET /d/:doc/api/versions` + `GET /d/:doc/doc`; edit = one UI-emittable
 * `wicked.interactive.feedback.submitted` batch of `content-edit` items with `expect_head`, then the head is polled
 * until the batch's version lands (interactive materializes it off its bus, as studio's document adapter waits).
 */

import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import type { InteractiveBridgePool } from '../interactive/bridge-pool.js';
import type { DocBackend } from './service.js';
import { writeSidecar } from './store.js';

const POLL_MS = 300;
const POLL_FOR_MS = 20_000;

function call(bridge: { host: string; port: number }, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: bridge.host, port: bridge.port, method, path, timeout: 30_000,
      headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 500, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`interactive did not answer ${method} ${path} in 30 s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

const json = (text: string): Record<string, unknown> => {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
};

export function bridgeBackend(pool: Pick<InteractiveBridgePool, 'ensure'>, rootFor: (projectId: string) => Promise<string | null>): DocBackend {
  const bridgeOf = async (projectId: string): Promise<{ bridge: { host: string; port: number }; root: string }> => {
    const root = await rootFor(projectId);
    if (root === null) throw new Error(`project ${projectId} has no documents root`);
    return { bridge: await pool.ensure(root), root };
  };
  const head = async (bridge: { host: string; port: number }, docId: string): Promise<number | null> => {
    const r = await call(bridge, 'GET', `/d/${encodeURIComponent(docId)}/api/versions`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`interactive versions read failed (${r.status})`);
    const h = json(r.text)['head'];
    return typeof h === 'number' ? h : null;
  };
  return {
    async create(projectId, docId, runId, html) {
      const { bridge, root } = await bridgeOf(projectId);
      // The sidecar first: the document is a `phase-report` before any seam can see it.
      writeSidecar(join(root, docId), runId);
      const r = await call(bridge, 'POST', '/api/docs', { name: docId, html });
      if (r.status >= 300) throw new Error(`interactive refused the working document (${r.status}): ${String(json(r.text)['error'] ?? r.text.slice(0, 200))}`);
      const h = json(r.text)['head'];
      return { head: typeof h === 'number' ? h : 0 };
    },
    async read(projectId, docId) {
      const { bridge } = await bridgeOf(projectId);
      const h = await head(bridge, docId);
      if (h === null) return null;
      const r = await call(bridge, 'GET', `/d/${encodeURIComponent(docId)}/doc`);
      if (r.status >= 300) throw new Error(`interactive head read failed (${r.status})`);
      return { head: h, html: r.text };
    },
    async edit(projectId, docId, batch) {
      const { bridge } = await bridgeOf(projectId);
      // A stale base is refused before anything is sent: the poll below reads ANY newer head as this batch's version,
      // which is sound only because crew is the document's one writer (the proxy refuses every browser event on it,
      // and the service writes one version per run at a time).
      const before = await head(bridge, docId);
      if (before !== batch.expectHead) return { headMoved: true, head: before ?? batch.expectHead };
      const r = await call(bridge, 'POST', '/api/events', {
        event_type: 'wicked.interactive.feedback.submitted',
        payload: {
          document_id: docId, ts: new Date().toISOString(), version_target: batch.expectHead, expect_head: batch.expectHead,
          author: batch.author, items: batch.items.map((it) => ({ type: 'content-edit', selector: it.selector, value: it.value })),
        },
      });
      if (r.status >= 300) throw new Error(`interactive refused the edit (${r.status}): ${String(json(r.text)['error'] ?? r.text.slice(0, 200))}`);
      const until = Date.now() + POLL_FOR_MS;
      while (Date.now() < until) {
        await new Promise((res) => setTimeout(res, POLL_MS));
        const h = await head(bridge, docId);
        if (h !== null && h > batch.expectHead) return { version: h, parent: batch.expectHead };
      }
      // No version: the batch landed nothing (a head that moved, or an edit interactive refused).
      const h = await head(bridge, docId);
      return { headMoved: true, head: h ?? batch.expectHead };
    },
  };
}
