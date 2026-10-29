// The working document's production backend speaks interactive's own wire: create = POST /api/docs {name, html} with
// crew's phase-report sidecar written first; edit = ONE UI-emittable feedback.submitted batch of content edits on the
// BARE anchor id (interactive does its own `[data-wid=…]` lookup) with expect_head; a stale base is refused before
// anything is sent. Checked against a stand-in that records what it was sent (and verified once by hand against a
// real interactive bridge: a multi-line section and a leading bracket round-trip).

import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bridgeBackend } from '../src/working-doc/bridge-backend.js';
import { encodeSectionText, sectionsOf } from '../src/working-doc/sections.js';
import { WORKING_DOC_SIDECAR } from '../src/working-doc/store.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function standIn() {
  let head = 0;
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
      if (req.method === 'POST') posts.push({ path: req.url ?? '', body });
      if (req.method === 'POST' && req.url === '/api/docs') { res.end(JSON.stringify({ name: body['name'], head: 0 })); return; }
      if (req.method === 'POST' && req.url === '/api/events') { setTimeout(() => { head += 1; }, 50); res.end(JSON.stringify({ ok: true })); return; }
      if (req.method === 'GET' && /\/api\/versions$/u.test(req.url ?? '')) { res.end(JSON.stringify({ head })); return; }
      if (req.method === 'GET' && /\/doc$/u.test(req.url ?? '')) { res.setHeader('content-type', 'text/html'); res.end(`<div data-wid="wd-goal">v${head}</div>`); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  const root = mkdtempSync(join(tmpdir(), 'wd-bridge-'));
  dirs.push(root);
  const backend = bridgeBackend({ ensure: async () => ({ host: '127.0.0.1', port, pid: 0 }) as never }, async () => root);
  return { backend, posts, root };
}

describe('the bridge backend', () => {
  it('creates an html document, marked phase-report before interactive is asked', async () => {
    const s = await standIn();
    expect(await s.backend.create('default', 'working-run-1', 'run-1', '<p>x</p>')).toEqual({ head: 0 });
    expect(existsSync(join(s.root, 'working-run-1', WORKING_DOC_SIDECAR))).toBe(true);
    expect(s.posts[0]).toEqual({ path: '/api/docs', body: { name: 'working-run-1', html: '<p>x</p>' } });
  });

  it('edits with one feedback batch of content edits on the bare anchor, then waits for the version', async () => {
    const s = await standIn();
    const r = await s.backend.edit('default', 'working-run-1', { expectHead: 0, author: 'local via plugin:wicked-phase-report@1.0.0', items: [{ selector: 'wd-goal', value: 'g' }] });
    expect(r).toEqual({ version: 1, parent: 0 });
    const sent = s.posts.find((p) => p.path === '/api/events')!.body;
    expect(sent['event_type']).toBe('wicked.interactive.feedback.submitted');
    expect(sent['payload']).toMatchObject({ document_id: 'working-run-1', expect_head: 0, version_target: 0, author: 'local via plugin:wicked-phase-report@1.0.0', items: [{ type: 'content-edit', selector: 'wd-goal', value: 'g' }] });
  });

  it('a stale base is refused before anything is sent', async () => {
    const s = await standIn();
    expect(await s.backend.edit('default', 'working-run-1', { expectHead: 3, author: 'x', items: [{ selector: 'wd-goal', value: 'g' }] })).toEqual({ headMoved: true, head: 0 });
    expect(s.posts).toHaveLength(0);
  });

  it('a section keeps its line breaks and a leading bracket through interactive’s line-based feedback file', () => {
    const v = encodeSectionText('[x] keep /v1\nand /v2');
    expect(v).not.toContain('\n');
    expect(sectionsOf(`<div data-wid="wd-next">${v.replace(/\u2028/g, '&#x2028;')}</div>`).next).toBe('[x] keep /v1\nand /v2');
  });
});
