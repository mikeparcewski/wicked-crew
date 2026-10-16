// DES-CHAT-FIRST-001 C2: workflow descriptors. The engine's built-in presets carry `title`, `summary`
// and `use_when` (wicked-core `catalog::builtin_preset_descriptor`, served by `listPresets` on a
// wicked-core-ts after 0.12.1). Crew copies them into the def `GET /workflows` serves — for every
// built-in an operator picks, and for no system workflow — and never sends them to the engine, whose
// def parser is strict. The binding is mocked here (as preset-routes.test.ts does), so this answers
// the same on the pinned addon and on one that carries the fields.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { descriptorOf, engineDefOf, presetDef } from '../src/core/builtin-catalog.js';
import { isSystemWorkflow } from '../src/core/run-identity.js';
import type { Preset, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

/** A descriptor for preset `name`, as the engine would send it. */
const described = (name: string) => ({
  title: `Title of ${name}`,
  summary: `What ${name} does.`,
  use_when: [`when ${name} fits`, `another reason for ${name}`],
});

const DESCRIPTOR_KEYS = ['title', 'summary', 'use_when'] as const;

let dir: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>> | undefined;
/** The engine's built-in preset names (the installed addon's `listPresets`). */
let builtinNames: string[];

/**
 * Mock the BINDING's `listPresets` (the addon method the adapter calls, so the adapter's own handling —
 * the system flag — still runs): the installed engine's own rows, so every built-in it ships is here,
 * with the descriptor stamped on each built-in (`withDescriptors`) or stripped from all (an engine
 * older than the fields). `projectId` `proj_a` gets a saved project row shadowing `feature`, which
 * carries none, as the engine serves it.
 */
async function mockPresets(withDescriptors: boolean): Promise<void> {
  const core = (adapter as unknown as { core: Record<string, unknown> }).core;
  const real = core['listPresets'] as (projectId: string | null) => Promise<string>;
  const rows = JSON.parse(await real.call(core, null)) as Preset[];
  builtinNames = rows.filter((p) => p.created_by === 'builtin').map((p) => p.name).sort();
  core['listPresets'] = async (projectId: string | null): Promise<string> => {
    const out = rows.map((p) => {
      const bare = { ...p } as Preset;
      for (const k of DESCRIPTOR_KEYS) delete bare[k];
      return withDescriptors && p.created_by === 'builtin' ? { ...bare, ...described(p.name) } : bare;
    });
    if (projectId === 'proj_a') {
      const i = out.findIndex((p) => p.name === 'feature');
      out[i] = { name: 'feature', scope: 'project:proj_a', created_by: 'api', updated_at: 2, steps: [{ catalog: 'understand', id: 'u' }] };
    }
    return JSON.stringify(out);
  };
}

async function serve(): Promise<string> {
  app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-descriptors-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  adapter.close();
  removeScratch(dir);
});

describe('GET /workflows serves the descriptor of every built-in an operator picks (booted daemon)', () => {
  it('every non-system built-in carries title, summary and use_when; no system workflow carries any', async () => {
    await mockPresets(true);
    const base = await serve();
    const res = await fetch(`${base}/api/v1/workflows`);
    expect(res.status).toBe(200);
    const { workflows } = (await res.json()) as { workflows: WorkflowDef[] };
    const builtins = workflows.filter((w) => builtinNames.includes(w.id));
    expect(builtins.map((w) => w.id).sort()).toEqual(builtinNames);
    // Both halves are exercised: the engine ships pickable and system built-ins.
    expect(builtins.some((w) => w.is_system === true)).toBe(true);
    expect(builtins.some((w) => w.is_system !== true)).toBe(true);
    for (const w of builtins) {
      if (isSystemWorkflow(w.id)) {
        expect(w.is_system, w.id).toBe(true);
        for (const k of DESCRIPTOR_KEYS) expect(w, `${w.id}.${k}`).not.toHaveProperty(k);
      } else {
        expect({ title: w.title, summary: w.summary, use_when: w.use_when }, w.id).toEqual(described(w.id));
      }
    }
    const one = (await (await fetch(`${base}/api/v1/workflows/feature`)).json()) as { workflow: WorkflowDef };
    expect(one.workflow.title).toBe('Title of feature');
    const chat = (await (await fetch(`${base}/api/v1/workflows/chat`)).json()) as { workflow: WorkflowDef };
    expect(chat.workflow).not.toHaveProperty('title');
  });

  it('an engine without the fields still serves every built-in, by id, with no descriptor keys', async () => {
    await mockPresets(false);
    const base = await serve();
    const { workflows } = (await (await fetch(`${base}/api/v1/workflows`)).json()) as { workflows: WorkflowDef[] };
    const builtins = workflows.filter((w) => builtinNames.includes(w.id));
    expect(builtins.map((w) => w.id).sort()).toEqual(builtinNames);
    for (const w of builtins) for (const k of DESCRIPTOR_KEYS) expect(w, `${w.id}.${k}`).not.toHaveProperty(k);
  });

  it('GET /presets passes the descriptor through, and a project row shadowing feature shows that row, undescribed', async () => {
    await mockPresets(true);
    const base = await serve();
    const global = (await (await fetch(`${base}/api/v1/presets`)).json()) as { presets: Preset[] };
    expect(global.presets.find((p) => p.name === 'feature')).toMatchObject({ scope: 'global', system: false, ...described('feature') });
    // GET /presets is the raw catalog: a system preset keeps what the engine sent, flagged `system`.
    expect(global.presets.find((p) => p.name === 'chat')).toMatchObject({ system: true });
    const inProject = (await (await fetch(`${base}/api/v1/presets?projectId=proj_a`)).json()) as { presets: Preset[] };
    const shadow = inProject.presets.find((p) => p.name === 'feature')!;
    expect(shadow.scope).toBe('project:proj_a');
    for (const k of DESCRIPTOR_KEYS) expect(shadow).not.toHaveProperty(k);
    expect(inProject.presets.find((p) => p.name === 'bug')).toMatchObject(described('bug'));
  });
});

describe('the descriptor is display data: never engine input', () => {
  it('registerWorkflow sends no descriptor key (nor is_system) to the engine', async () => {
    const seen: string[] = [];
    (adapter as unknown as { core: Record<string, unknown> }).core['registerWorkflow'] = async (json: string) => {
      seen.push(json);
      return 'runtime-probe';
    };
    const def = {
      id: 'runtime-probe',
      phases: [{ id: 'only', executor: { type: 'tool', cmd: ['true'] } }],
      is_system: false,
      ...described('runtime-probe'),
    } as unknown as WorkflowDef;
    await adapter.registerWorkflow(def);
    const sent = JSON.parse(seen[0]!) as Record<string, unknown>;
    for (const k of [...DESCRIPTOR_KEYS, 'is_system']) expect(sent).not.toHaveProperty(k);
    expect(sent['id']).toBe('runtime-probe');
  });

  it('engineDefOf strips only the display keys and leaves a bare def as the same object', () => {
    const bare = { id: 'x', phases: [], required_instruments: ['judge'] } as WorkflowDef;
    expect(engineDefOf(bare)).toBe(bare);
    const full = { ...bare, is_system: true, ...described('x') } as WorkflowDef;
    expect(engineDefOf(full)).toEqual(bare);
    expect(full.title).toBe('Title of x');
  });

  it('descriptorOf copies usable values only, and none for a system name', () => {
    expect(descriptorOf({ name: 'feature', ...described('feature') })).toEqual(described('feature'));
    expect(descriptorOf({ name: 'chat', ...described('chat') })).toEqual({});
    expect(descriptorOf({ name: 'feature' })).toEqual({});
    expect(
      descriptorOf({ name: 'feature', title: '  ', summary: 42 as unknown as string, use_when: ['ok', '', 7 as unknown as string] }),
    ).toEqual({ use_when: ['ok'] });
    const def = presetDef({ name: 'feature', steps: [], ...described('feature') }, [])!;
    expect(def).toEqual({ id: 'feature', phases: [], ...described('feature') });
  });
});
