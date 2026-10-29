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
import { UndeterminedWriteError } from '../src/working-doc/service.js';
import { isDocEventsPost, pathDocumentId } from '../src/interactive/proxy-routes.js';
import { encodeSectionText, sectionsOf } from '../src/working-doc/sections.js';
import { WORKING_DOC_SIDECAR } from '../src/working-doc/store.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function standIn(opts: { foreign?: boolean; never?: boolean } = {}) {
  let head = 0;
  const html: Record<number, string> = { 0: '<div data-wid="wd-goal">v0</div>' };
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
      if (req.method === 'POST') posts.push({ path: req.url ?? '', body });
      if (req.method === 'POST' && req.url === '/api/docs') { res.end(JSON.stringify({ name: body['name'], head: 0 })); return; }
      if (req.method === 'POST' && req.url === '/api/events') {
        const item = ((body['payload'] as { items: Array<{ selector: string; value: string }> }).items)[0]!;
        if (!opts.never) setTimeout(() => { head += 1; html[head] = `<div data-wid="${item.selector}">${opts.foreign ? 'someone else' : item.value}</div>`; }, 50);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && /\/api\/versions$/u.test(req.url ?? '')) { res.end(JSON.stringify({ head })); return; }
      const v = /\/doc\/(\d+)$/u.exec(req.url ?? '');
      if (req.method === 'GET' && v !== null && html[Number(v[1])] !== undefined) { res.setHeader('content-type', 'text/html'); res.end(html[Number(v[1])]); return; }
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

  it('reads the head version pinned (never a torn head/html pair)', async () => {
    const s = await standIn();
    expect(await s.backend.read('default', 'working-run-1')).toEqual({ head: 0, html: '<div data-wid="wd-goal">v0</div>' });
  });

  it('a version that is not this batch’s, or none in time, is an UNKNOWN outcome — never a success, never a conflict', async () => {
    const foreign = await standIn({ foreign: true });
    await expect(foreign.backend.edit('default', 'w', { expectHead: 0, author: 'x', items: [{ selector: 'wd-goal', value: 'mine' }] })).rejects.toBeInstanceOf(UndeterminedWriteError);
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

describe('the proxy’s write fence reads every spelling', () => {
  it('the events route in any case, with a trailing slash', () => {
    for (const t of ['/api/events', '/API/EVENTS', '/api/events/', '/Api/Events//?x=1']) expect(isDocEventsPost('POST', t), t).toBe(true);
    expect(isDocEventsPost('GET', '/api/events')).toBe(false);
  });
  it('a write to a document by its path names the document; a read does not', () => {
    expect(pathDocumentId('POST', '/d/working-run-1/api/fork')).toBe('working-run-1');
    expect(pathDocumentId('PUT', '/D/working-run-1/api/theme/learned')).toBe('working-run-1');
    expect(pathDocumentId('DELETE', '/api/docs/working-run-1')).toBe('working-run-1');
    expect(pathDocumentId('POST', '/d/working%2Drun%2D1/api/deck')).toBe('working-run-1');
    expect(pathDocumentId('GET', '/d/working-run-1/doc')).toBeNull();
    expect(pathDocumentId('POST', '/api/docs')).toBeNull();
  });
});
