// X-MIG M11 (crew C): the workflow overlay is retired. A runtime def (crew's interactive review
// and theme seams) is validated and held by the engine IN MEMORY — nothing is written to disk and
// nothing is read back — and user def authoring (`POST /workflows`) answers 410 with the preset
// replacement. Each case below failed on main: main wrote the overlay file, served hydrated
// drop-ins, and accepted the POST.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import type { WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;
let adapter: CoreAdapter | undefined;

const DEF = {
  id: 'runtime-probe',
  phases: [{ id: 'only', executor: { type: 'tool', cmd: ['true'] } }],
} as unknown as WorkflowDef;

function stubRegister(a: CoreAdapter, impl: ((json: string) => Promise<string>) | undefined) {
  const core = (a as unknown as { core: Record<string, unknown> }).core;
  core['registerWorkflow'] = impl;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtime-workflows-'));
  overlayDir = join(dir, 'workflows');
  mkdirSync(overlayDir, { recursive: true });
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
});

afterEach(() => {
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  adapter?.close();
  adapter = undefined;
  removeScratch(dir);
});

describe('runtime defs: engine-validated, in memory, nothing on disk', () => {
  it('an accepted def is served and NOT written to the old overlay dir', async () => {
    const seen: string[] = [];
    stubRegister(adapter!, async (json) => { seen.push(json); return DEF.id; });
    await adapter!.registerWorkflow(DEF);
    expect(seen).toHaveLength(1);
    expect(adapter!.getWorkflow(DEF.id)?.phases).toEqual(DEF.phases);
    expect(readdirSync(overlayDir)).toEqual([]);
  });

  it('a def the engine rejects is not served, and is_system never reaches the engine', async () => {
    const seen: string[] = [];
    stubRegister(adapter!, async (json) => { seen.push(json); throw new Error('invalid workflow JSON: nope'); });
    await expect(adapter!.registerWorkflow({ ...DEF, is_system: true } as WorkflowDef)).rejects.toThrow(/nope/);
    expect(adapter!.getWorkflow(DEF.id)).toBeNull();
    expect(JSON.parse(seen[0]!)).not.toHaveProperty('is_system');
  });

  it('a file left in the old overlay dir is never read: not listed, not served, nothing named unavailable', async () => {
    writeFileSync(join(overlayDir, 'left-over.json'), JSON.stringify({ id: 'left-over', phases: [{ id: 'p' }] }));
    expect(adapter!.getWorkflow('left-over')).toBeNull();
    const { workflows, unavailable } = await adapter!.workflowCatalog();
    expect(workflows.some((w) => w.id === 'left-over')).toBe(false);
    expect(unavailable).toEqual([]);
  });
});

describe('POST /workflows is retired', () => {
  it('answers 410 naming the preset route, and registers nothing', async () => {
    const app = await createServer(adapter!, { auditPath: join(dir, 'audit.log') });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/workflows', payload: DEF });
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toMatch(/save a preset/);
      expect(res.json().replacement).toBe('PUT /api/v1/presets/:name');
      expect(adapter!.getWorkflow(DEF.id)).toBeNull();
    } finally {
      await app.close();
    }
  });
});
