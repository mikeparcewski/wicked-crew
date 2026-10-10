// A long-lived state home for the run-read latency test (crew#944), built in TWO child processes so
// the test process opens the store exactly once, after it is fully seeded:
//
//   `seed <dir>`        boots the REAL stub engine on <dir>/home/core.db, launches the template runs
//                       (one that completes, one parked at a gate) on a many-phase tool-only def,
//                       waits for both to settle and exits — the exit is what stops the engine
//                       (`adapter.close()` does not).
//   `clone <dir> <n>`   with no engine open on the store, copies the template runs' session + unit
//                       nodes (fresh run ids) until the store holds <n> runs. `node:sqlite` in its
//                       own process: never beside the engine's SQLite in one process.
//
// Engine-written nodes cloned row for row, so the fold reads exactly the shape a real home holds.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PHASES = 12;
const [mode, dir, total] = process.argv.slice(2);

async function seed(base: string): Promise<void> {
  process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';
  const { CoreAdapter } = await import('../../src/core/adapter.js');
  const { createServer } = await import('../../src/api/server.js');
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const args of [['config', 'user.email', 'r@t'], ['config', 'user.name', 'r'], ['commit', '--allow-empty', '-qm', 'base']]) {
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo });
  }
  writeFileSync(join(repo, 'README.md'), '# long-lived home\n');
  const ids = Array.from({ length: PHASES }, (_, i) => `step-${i + 1}`);
  const def = {
    id: 'long-lived-home',
    base_skill_ref: '',
    phases: ids.map((id, i) => ({
      id, kind: 'recon', executor: { type: 'tool', cmd: ['true'] }, gate_type: null, gate: 'auto',
      executes_code: false, verified_evidence: false, required_deliverables: [],
      depends_on: i === 0 ? [] : [ids[i - 1]], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null,
    })),
  };
  const adapter = new CoreAdapter({ dbPath: join(home, 'core.db'), stub: true });
  const app = await createServer(adapter, { stallWatchdog: { enabled: false } });
  const inject = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined ? { payload } : {}) });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  await adapter.registerRepo('long-lived-ws', repo);
  const repos = (await inject('GET', '/repos')).body['repos'] as Array<{ id: string; name: string }>;
  const repoRef = repos.find((r) => r.name === 'long-lived-ws')!.id;
  const wf = await inject('POST', '/workflows', def);
  if (wf.status !== 201) throw new Error(`workflow refused: ${JSON.stringify(wf.body)}`);
  const seats = JSON.stringify([{ key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' }]);
  for (const humanConfirm of ['none', 'all']) {
    const launch = await inject('POST', '/runs', { problem: `template (${humanConfirm})`, clisJson: seats, workflow: def.id, repoRef, humanConfirm });
    if (launch.status !== 201) throw new Error(`launch refused: ${JSON.stringify(launch.body)}`);
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    const views = await adapter.sessionsDetail();
    if (views.length === 2 && views.every((v) => v.session.status === 'completed' || v.session.status === 'awaiting_human')) break;
    if (Date.now() > deadline) throw new Error(`templates did not settle: ${views.map((v) => v.session.status).join(',')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  await app.close();
  process.exit(0);
}

async function clone(base: string, want: number): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(base, 'home', 'core.db'));
  const SESSION = '{"other":"agent_session"}';
  const UNIT = '{"other":"work_unit"}';
  const templates = (db.prepare('SELECT name FROM nodes WHERE kind = ?').all(SESSION) as Array<{ name: string }>).map((r) => r.name);
  const rowsOf = db.prepare(
    "SELECT s.sym, n.name, n.kind, n.language, n.file, n.data, n.scope FROM nodes n JOIN symbols s ON s.sid = n.symbol " +
      "WHERE (n.kind = ? AND n.name = ?) OR (n.kind = ? AND n.name LIKE ? || ':%')",
  );
  const addSymbol = db.prepare('INSERT INTO symbols (sym, had_node) VALUES (?, 1)');
  const addNode = db.prepare('INSERT INTO nodes (symbol, name, kind, language, file, data, scope) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let have = templates.length, i = 0; have < want; have++, i++) {
    const src = templates[i % templates.length]!;
    const id = randomUUID();
    const sub = (t: string) => t.split(src).join(id);
    for (const r of rowsOf.all(SESSION, src, UNIT, src) as Array<Record<string, string>>) {
      const { lastInsertRowid } = addSymbol.run(sub(r['sym']!));
      addNode.run(lastInsertRowid, sub(r['name']!), r['kind']!, r['language']!, sub(r['file']!), sub(r['data']!), sub(r['scope']!));
    }
  }
  db.exec('COMMIT');
  db.close();
}

if (mode === 'seed') await seed(dir!);
else if (mode === 'clone') await clone(dir!, Number(total));
else if (mode !== undefined) throw new Error(`unknown mode ${mode}`);
