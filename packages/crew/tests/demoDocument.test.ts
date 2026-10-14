// A demo run's video as an editable document (POST /runs/:id/demo/document): the run's recorded segments become a
// wicked-interactive document (one take per chapter), linked from crew's state home and shown on DemoView.document.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { demoDocumentLink, demoRootDir, makeDemoDocument, type BridgeCall } from '../src/api/recording.js';
import type { SessionView } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';

const RUN = 'run-0f3a9c2e-77aa-4c1b-9d2e-000000000001';

function view(status: string, projectId?: string): SessionView {
  const steps = ['pa-scope', 'plan', 'record', 'review'];
  return {
    session: { id: RUN, status, unit_ix: 3, workflow_id: `${RUN}:plan-2`, problem: 'Make a demo', extra_write_roots: [], team_plan: { rev: 2, accepted_rev: 2, preset: 'demo' }, ...(projectId ? { project_id: projectId } : {}) },
    units: steps.map((s, i) => ({ id: `${RUN}:${s}`, session_id: RUN, ord: i + 1, status: status === 'completed' ? 'done' : i < 3 ? 'done' : 'pending', assigned_cli: null })),
  } as unknown as SessionView;
}

/** A fake bridge: records every call and answers like interactive does. */
function bridge(opts: { refuseImport?: boolean; cutExists?: boolean } = {}): { call: BridgeCall; calls: Array<{ method: string; path: string; bytes?: number; body?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; path: string; bytes?: number; body?: Record<string, unknown> }> = [];
  const call: BridgeCall = async (method, path, body) => {
    calls.push({ method, path, ...(Buffer.isBuffer(body) ? { bytes: body.length } : { body }) });
    if (path === '/api/docs') return { status: 200, body: { name: (body as { name: string }).name, head: 0 } };
    if (method === 'PUT') return opts.cutExists ? { status: 409, body: { error: 'cut_exists', rev: 1 } } : { status: 200, body: { staged: true } };
    if (opts.refuseImport) return { status: 400, body: { error: 'invalid_body' } };
    return opts.cutExists ? { status: 409, body: { error: 'cut_exists', rev: 1 } } : { status: 200, body: { rev: 1, version: 1 } };
  };
  return { call, calls };
}

describe('a demo run becomes an editable document', () => {
  let scratch: string;
  let prevHome: string;
  const prevDemo = process.env.WICKED_DEMO_DIR;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'demo-doc-'));
    prevHome = crewStateHome();
    setCrewStateHome(join(scratch, 'home'));
    process.env.WICKED_DEMO_DIR = join(scratch, 'demos');
    const root = demoRootDir(RUN);
    mkdirSync(join(root, 'demo-video', 'segments', '01-open'), { recursive: true });
    mkdirSync(join(root, 'demo-video', 'segments', '02-close'), { recursive: true });
    writeFileSync(join(root, 'BRIEF.md'), '# Demo brief\n\n- **App:** http://127.0.0.1:5173/\n');
    writeFileSync(join(root, 'chapters.json'), JSON.stringify([{ key: '01-open', title: 'Open it', blurb: 'Where it starts.' }, { key: '02-close', title: 'Close it' }]));
    writeFileSync(join(root, 'demo-video', 'segments', '01-open', 'segment.mp4'), Buffer.alloc(10, 1));
    writeFileSync(join(root, 'demo-video', 'segments', '02-close', 'segment.mp4'), Buffer.alloc(20, 2));
  });
  afterEach(() => {
    setCrewStateHome(prevHome);
    if (prevDemo === undefined) delete process.env.WICKED_DEMO_DIR;
    else process.env.WICKED_DEMO_DIR = prevDemo;
    removeScratch(scratch);
  });

  it('creates the document, uploads each segment, imports the chapters and links it (once)', async () => {
    const b = bridge();
    const r = await makeDemoDocument(view('completed', 'proj_1'), { bridgeFor: async () => b.call });
    expect(r).toEqual({ status: 200, body: { projectId: 'proj_1', docId: 'demo-run0f3a9c2e7', created: true } });
    expect(b.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/docs',
      'PUT /d/demo-run0f3a9c2e7/api/demo/import/01-open',
      'PUT /d/demo-run0f3a9c2e7/api/demo/import/02-close',
      'POST /d/demo-run0f3a9c2e7/api/demo/import',
    ]);
    expect(b.calls[0]!.body).toMatchObject({ name: 'demo-run0f3a9c2e7', project: 'proj_1' });
    expect(b.calls.slice(1, 3).map((c) => c.bytes)).toEqual([10, 20]);
    expect(b.calls[3]!.body).toEqual({ title: 'Demo of http://127.0.0.1:5173/', url: 'http://127.0.0.1:5173/', chapters: [{ id: '01-open', title: 'Open it', say: 'Where it starts.' }, { id: '02-close', title: 'Close it' }] });
    expect(await demoDocumentLink(RUN)).toEqual({ projectId: 'proj_1', docId: 'demo-run0f3a9c2e7' });
    const again = bridge();
    expect(await makeDemoDocument(view('completed', 'proj_1'), { bridgeFor: async () => again.call })).toEqual({ status: 200, body: { projectId: 'proj_1', docId: 'demo-run0f3a9c2e7', created: false } });
    expect(again.calls).toEqual([]);
  });

  it('an unfiled run is made in the default project, without a project binding', async () => {
    const b = bridge();
    const r = await makeDemoDocument(view('completed'), { bridgeFor: async () => b.call });
    expect(r.body).toMatchObject({ projectId: 'default' });
    expect(b.calls[0]!.body).not.toHaveProperty('project');
  });

  it('a retry after a half-finished import links the cut interactive already has', async () => {
    const b = bridge({ cutExists: true });
    expect((await makeDemoDocument(view('completed'), { bridgeFor: async () => b.call })).status).toBe(200);
    expect(await demoDocumentLink(RUN)).not.toBeNull();
  });

  it('refuses before the review gate, without recorded segments, for an unknown project, or when interactive refuses', async () => {
    expect((await makeDemoDocument(view('running'), { bridgeFor: async () => bridge().call })).status).toBe(409);
    writeFileSync(join(demoRootDir(RUN), 'demo-video', 'segments', '02-close', 'segment.mp4'), '');
    expect(await makeDemoDocument(view('completed'), { bridgeFor: async () => bridge().call })).toMatchObject({ status: 409, body: { error: expect.stringContaining('02-close') } });
    writeFileSync(join(demoRootDir(RUN), 'demo-video', 'segments', '02-close', 'segment.mp4'), Buffer.alloc(5));
    expect((await makeDemoDocument(view('completed', 'nope'), { bridgeFor: async () => null })).status).toBe(404);
    expect((await makeDemoDocument(view('completed'), { bridgeFor: async () => bridge({ refuseImport: true }).call })).status).toBe(502);
    expect(await demoDocumentLink(RUN)).toBeNull();
  });
});
