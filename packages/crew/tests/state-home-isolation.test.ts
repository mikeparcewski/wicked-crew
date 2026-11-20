import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreAdapter } from '../src/core/adapter.js';
import { ensureEstateStoreDirs } from '../src/core/estate-mcp-client.js';
import { learningSubmitEnv } from '../src/learnings/estate.js';
import { crewStateHome, defaultStateHome, setCrewStateHome, wickedWorkRoot } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';

let root: string;
let home: string;
let isolated: string;
let armed: string;
let saved: NodeJS.ProcessEnv;
const KEYS = ['HOME', 'USERPROFILE', 'WICKED_CREW_KNOWLEDGE_DB'] as const;
beforeEach(() => {
  armed = crewStateHome();
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), 'state-home-isolation-'));
  home = join(root, 'home');
  isolated = join(root, 'state');
  mkdirSync(home);
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  delete process.env['WICKED_CREW_KNOWLEDGE_DB'];
  setCrewStateHome(isolated);
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setCrewStateHome(armed);
  removeScratch(root);
});

describe('state-home path ladders', () => {
  it('work roots are siblings on an isolated home and historical paths on the default', () => {
    for (const name of ['repos', 'scripts']) expect(wickedWorkRoot(name)).toBe(`${isolated}-${name}`);
    setCrewStateHome(defaultStateHome(home));
    for (const name of ['repos', 'scripts']) expect(wickedWorkRoot(name)).toBe(join(home, '.wicked', name));
  });

  it('learning submits carry all isolated estate stores', () => {
    expect(learningSubmitEnv('r', 'codex', {})).toMatchObject({
      WICKED_MEMORY_DB: join(isolated, 'mcp', 'memory.db'),
      WICKED_KNOWLEDGE_DB: join(isolated, 'mcp', 'knowledge.db'),
      WICKED_XEDGE_DB: join(isolated, 'mcp', 'xedge.db'),
    });
  });

  it('estate spawns create the derived store directory on a fresh isolated home, never an explicit one', () => {
    expect(existsSync(join(isolated, 'mcp'))).toBe(false);
    expect(ensureEstateStoreDirs({})).toEqual({
      WICKED_MEMORY_DB: join(isolated, 'mcp', 'memory.db'),
      WICKED_KNOWLEDGE_DB: join(isolated, 'mcp', 'knowledge.db'),
      WICKED_XEDGE_DB: join(isolated, 'mcp', 'xedge.db'),
    });
    expect(existsSync(join(isolated, 'mcp'))).toBe(true);
    ensureEstateStoreDirs({ WICKED_MEMORY_DB: join(root, 'operator', 'memory.db') });
    expect(existsSync(join(root, 'operator'))).toBe(false);
  });

  it.each(['isolated', 'empty', 'explicit', 'default'] as const)('governance import and eval share the %s knowledge db ladder', async (mode) => {
    if (mode === 'default') setCrewStateHome(defaultStateHome(home));
    if (mode === 'empty') process.env['WICKED_CREW_KNOWLEDGE_DB'] = '';
    if (mode === 'explicit') process.env['WICKED_CREW_KNOWLEDGE_DB'] = join(root, 'explicit.db');
    const payloads: Record<string, unknown>[] = [];
    const capture = async (raw: string) => { payloads.push(JSON.parse(raw) as Record<string, unknown>); return '{}'; };
    // Exercise the adapter's serialization without depending on the installed addon's generation.
    const adapter = Object.create(CoreAdapter.prototype) as CoreAdapter;
    Object.assign(adapter, {
      core: { governanceEvals: capture, governanceCorpusImport: capture }, dbPath: join(isolated, 'core.db'),
    });
    await adapter.importGovernanceCorpus('isolation', []);
    await adapter.runGovernanceEvals({ corpus: 'evals:isolation' });
    expect(payloads).toHaveLength(2);
    const expected = mode === 'default' ? undefined : mode === 'explicit' ? join(root, 'explicit.db') : join(isolated, 'mcp', 'evals-knowledge.db');
    for (const payload of payloads) {
      expect(payload['knowledgeDb']).toBe(expected);
      expect(Object.hasOwn(payload, 'knowledgeDb')).toBe(expected !== undefined);
    }
  });
});
