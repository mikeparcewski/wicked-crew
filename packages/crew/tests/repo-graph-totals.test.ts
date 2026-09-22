// crew#505 / F-RC1-100 / F-E2E-022 — `GET /repos/:id/graph` gains whole-graph `totals` (DES-L8 r2 §5
// PR-8D; api-types 0.38.0 `CodeGraphData.totals?`). `graph-view --limit` emits only the served SLICE,
// so `stats` alone read "my repo has 150 symbols"; the route now spawns `wicked-estate stats --db`
// beside `graph-view` (both under `Promise.all`, the same daemon-side CLI posture) and parses its
// `nodes=N edges=M files=F` line. Pins:
//
//   - `totals` = the stats counts, `stats` = the slice counts (unchanged meaning);
//   - both spawns happen (the stub records its argv), and they are two calls, not three;
//   - an unparseable stats line ⇒ `totals` ABSENT (never `stats` substituted), still 200;
//   - a stats spawn that FAILS (exit 1) ⇒ `totals` ABSENT, the slice still 200 — the tile keeps
//     working on an estate whose `stats` predates or post-dates the line.
//
// POSIX-only: the stub is a `#!/usr/bin/env node` script behind `WICKED_ESTATE_EXE` (the seam
// `projects/graph.ts` publishes and its refresh test already uses). Skipped on Windows rather than
// silently vacuous.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { parseEstateTotals, registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RepoEntry } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify(argv) + '\\n');
const cmd = argv[0];
if (cmd === 'graph-view') {
  process.stdout.write(JSON.stringify({
    nodes: [
      { id: 'a', name: 'alpha', kind: 'fn', file: 'src/a.ts', lang: 'typescript', score: 1, inDeg: 0, outDeg: 1 },
      { id: 'b', name: 'beta', kind: 'fn', file: 'src/b.ts', lang: 'typescript', score: 0.5, inDeg: 1, outDeg: 0 },
      { id: 'c', name: 'gamma', kind: 'fn', file: 'src/b.ts', lang: 'typescript', score: 0.2, inDeg: 0, outDeg: 0 },
    ],
    edges: [{ src: 'a', tgt: 'b' }],
  }));
  process.exit(0);
}
if (cmd === 'stats') {
  const mode = process.env.STUB_STATS_MODE || 'ok';
  if (mode === 'fail') { process.stderr.write('stats: unknown flag --db\\n'); process.exit(1); }
  if (mode === 'garbage') { process.stdout.write('estate 9.9.9 — no summary line here\\n'); process.exit(0); }
  process.stdout.write('nodes=5470 edges=9012 files=210 unresolved=3 db=1.2MB\\n  repo-a  files=210\\n');
  process.exit(0);
}
process.stderr.write('stub: unknown command ' + cmd + '\\n');
process.exit(2);
`;

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('GET /repos/:id/graph — totals beside the served slice (crew#505)', () => {
  let dir: string;
  let argvLog: string;
  let app: FastifyInstance;

  function argvCalls(): string[][] {
    return readFileSync(argvLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-graph-totals-'));
    const exe = join(dir, 'stub-estate');
    writeFileSync(exe, STUB);
    chmodSync(exe, 0o755);
    argvLog = join(dir, 'argv.log');
    writeFileSync(argvLog, '');
    const dbPath = join(dir, 'estate.db');
    writeFileSync(dbPath, ''); // the route only stats it for existence
    process.env['WICKED_ESTATE_EXE'] = exe;
    process.env['STUB_ARGV_LOG'] = argvLog;
    delete process.env['STUB_STATS_MODE'];
    const repo: RepoEntry = {
      id: 'repo-a',
      name: 'repo-a',
      root_path: dir,
      default_branch: 'main',
      registered_at: 0,
      code_graph_db: dbPath,
    };
    const adapter = {
      listRepos: vi.fn().mockResolvedValue([repo]),
      getSettings: vi.fn().mockResolvedValue({ graphNodeLimit: 150 }),
    };
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      adapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      new QeGateCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env['WICKED_ESTATE_EXE'];
    delete process.env['STUB_ARGV_LOG'];
    delete process.env['STUB_STATS_MODE'];
    removeScratch(dir);
  });

  it('serves `totals` from `wicked-estate stats --db` beside the slice `stats` — two spawns, one request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/repos/repo-a/graph' });
    expect(res.statusCode).toBe(200);
    const graph = (res.json() as { graph: Record<string, unknown> }).graph;
    expect(graph['stats']).toEqual({ nodeCount: 3, edgeCount: 1, fileCount: 2 });
    expect(graph['totals']).toEqual({ nodes: 5470, edges: 9012, files: 210 });
    const calls = argvCalls();
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[0]).sort()).toEqual(['graph-view', 'stats']);
    expect(calls.find((c) => c[0] === 'stats')).toEqual(['stats', '--db', join(dir, 'estate.db')]);
    expect(calls.find((c) => c[0] === 'graph-view')).toEqual(['graph-view', '--limit', '150', '--db', join(dir, 'estate.db')]);
  });

  it('an unparseable stats line leaves `totals` ABSENT — never `stats` in its place — and the slice is still 200', async () => {
    process.env['STUB_STATS_MODE'] = 'garbage';
    const res = await app.inject({ method: 'GET', url: '/api/v1/repos/repo-a/graph' });
    expect(res.statusCode).toBe(200);
    const graph = (res.json() as { graph: Record<string, unknown> }).graph;
    expect(graph['stats']).toEqual({ nodeCount: 3, edgeCount: 1, fileCount: 2 });
    expect('totals' in graph).toBe(false);
  });

  it('a FAILING stats spawn leaves `totals` ABSENT and the slice still 200 (the tile keeps working)', async () => {
    process.env['STUB_STATS_MODE'] = 'fail';
    const res = await app.inject({ method: 'GET', url: '/api/v1/repos/repo-a/graph' });
    expect(res.statusCode).toBe(200);
    const graph = (res.json() as { graph: Record<string, unknown> }).graph;
    expect(graph['stats']).toEqual({ nodeCount: 3, edgeCount: 1, fileCount: 2 });
    expect('totals' in graph).toBe(false);
    expect(argvCalls()).toHaveLength(2); // the stats spawn was still attempted, exactly once
  });
});

describe('parseEstateTotals — the `nodes=N edges=M files=F` line estate prints', () => {
  it('parses the first line of `wicked-estate stats` (main.rs summary), ignoring the trailing fields', () => {
    expect(parseEstateTotals('nodes=5470 edges=9012 files=210 unresolved=3 db=1.2MB\n  x  files=1\n')).toEqual({
      nodes: 5470,
      edges: 9012,
      files: 210,
    });
  });
  it('parses the line wherever it sits (multiline mode) and refuses anything else', () => {
    expect(parseEstateTotals('estate 0.16\nnodes=1 edges=0 files=1\n')).toEqual({ nodes: 1, edges: 0, files: 1 });
    expect(parseEstateTotals('')).toBeUndefined();
    expect(parseEstateTotals('error: no such db')).toBeUndefined();
    expect(parseEstateTotals('  nodes=1 edges=0 files=1')).toBeUndefined(); // indented = a repo row, not the summary
  });
});
