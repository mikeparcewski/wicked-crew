// crew#1470, #1473, #1474: a daemon on a non-default state home creates nothing under
// the default HOME across register-repo, scripts, estate's stores and governance evals.
// Exercise the server routes and real engine against a temp HOME to catch escaped writes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/api/server.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';

const ENV = ['HOME', 'USERPROFILE', 'WICKED_HOME', 'WICKED_MEMORY_DB', 'WICKED_KNOWLEDGE_DB', 'WICKED_XEDGE_DB', 'WICKED_CREW_KNOWLEDGE_DB', 'WICKED_ESTATE_MCP_EXE', 'WICKED_MEMORY_EMBEDDER'] as const;
let saved: NodeJS.ProcessEnv;
let armed: string;
let root: string;
let home: string;
let stateHome: string;
let adapter: CoreAdapter | undefined;
let app: Awaited<ReturnType<typeof createServer>> | undefined;

function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const p = prefix + e.name;
    return e.isDirectory() ? [p + '/', ...tree(join(dir, e.name), p + '/')] : [p];
  });
}

beforeEach(() => {
  armed = crewStateHome();
  saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'crew-default-home-guard-')));
  home = join(root, 'fake-home');
  stateHome = join(root, 'state');
  mkdirSync(home);
  mkdirSync(stateHome);
  for (const key of ENV) delete process.env[key];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';
  setCrewStateHome(stateHome);
  const log = join(root, 'estate-env.json');
  const script = join(root, 'estate.cjs');
  writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(env));
for (const name of ['memory', 'knowledge', 'xedge']) {
  const db = env['WICKED_' + name.toUpperCase() + '_DB'] || path.join(env.WICKED_HOME || path.join(env.HOME, '.wicked'), name + '.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, name);
}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-estate', version: '1' } }
    : { content: [{ type: 'text', text: JSON.stringify({ proposals: [] }) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`, { mode: 0o755 });
  process.env['WICKED_ESTATE_MCP_EXE'] = script;
});

afterEach(async () => {
  try {
    await app?.close();
    adapter?.close();
  } finally {
    app = undefined;
    adapter = undefined;
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    setCrewStateHome(armed);
    removeScratch(root);
  }
});

async function boot() {
  adapter = new CoreAdapter({ dbPath: join(stateHome, 'core.db'), stub: true });
  app = await createServer(adapter, {
    auth: { mode: 'off' }, auditPath: join(stateHome, 'audit.log'),
    skills: { disabled: true }, projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true }, stallWatchdog: { enabled: false },
    studioRoot: join(root, 'no-studio'),
  });
  return { app, adapter };
}

// Engine-side, not crew's: wicked-core's governance root is `<HOME>/.wicked/core-gov` whatever the state home
// (gate_hook.rs gov_root, probed at boot since wicked-core#1652). Filed as wicked-core#1663; left out here until the
// engine follows the state home, so every crew-owned path stays guarded.
const ENGINE_GOV_ROOT = '.wicked/core-gov/';

function expectEmptyHome() {
  const left = tree(home).filter((p) => !p.startsWith(ENGINE_GOV_ROOT));
  const found = left.filter((p) => p !== '.wicked/' || left.some((q) => q !== p && q.startsWith('.wicked/')));
  expect(found, `unexpected fake HOME entries:\n${found.join('\n')}`).toEqual([]);
}

describe('non-default daemon never writes the default home', () => {
  it('clones via POST /repos and saves scripts under state-home siblings', async () => {
    const { app } = await boot();
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    execFileSync('git', ['init', '--quiet', seed]);
    execFileSync('git', ['-C', seed, '-c', 'user.name=Isolation Test', '-c', 'user.email=isolation@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'seed']);
    execFileSync('git', ['clone', '--bare', '--quiet', seed, remote]);
    const response = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'isolated', gitUrl: remote } });
    expect(response.statusCode, response.body).toBe(201);
    expect.soft(response.json().repo.root_path).toBe(join(`${stateHome}-repos`, 'isolated'));
    expect.soft(existsSync(join(`${stateHome}-repos`, 'isolated', '.git'))).toBe(true);
    const script = await app.inject({ method: 'POST', url: '/api/v1/scripts', payload: { name: 'isolated', content: 'echo isolated', lang: 'sh' } });
    expect(script.statusCode, script.body).toBe(201);
    expect.soft(script.json().path).toBe(join(`${stateHome}-scripts`, 'isolated.sh'));
    expectEmptyHome();
  });

  it('defaultSpawn pins all estate stores through the proposals route', async () => {
    const { app } = await boot();
    const response = await app.inject({ method: 'GET', url: '/api/v1/proposals' });
    expect(response.statusCode, response.body).toBe(200);
    const env = JSON.parse(readFileSync(join(root, 'estate-env.json'), 'utf8')) as NodeJS.ProcessEnv;
    for (const name of ['memory', 'knowledge', 'xedge']) {
      const db = join(stateHome, 'mcp', `${name}.db`);
      expect.soft(env[`WICKED_${name.toUpperCase()}_DB`]).toBe(db);
      expect.soft(existsSync(db), db).toBe(true);
    }
    expectEmptyHome();
  });

  it('corpus import and eval run use a separate isolated knowledge db', async () => {
    const { app, adapter } = await boot();
    expect(adapter.governanceEvalsSupported()).toBe(true);
    const imp = await app.inject({ method: 'POST', url: '/api/v1/testing/corpora/import', payload: {
      name: 'isolation', samples: [{ id: 'isolation-1', description: 'force push', kind: 'bad', steering_type: 'development', signals: { tool: 'git', content: 'git push --force origin main' } }],
    } });
    expect(imp.statusCode, imp.body).toBe(200);
    const run = await app.inject({ method: 'POST', url: '/api/v1/testing/evals/run', payload: { corpus: 'evals:isolation' } });
    expect(run.statusCode, run.body).toBe(200);
    expect.soft(existsSync(join(stateHome, 'mcp', 'evals-knowledge.db'))).toBe(true);
    expectEmptyHome();
  });
});
