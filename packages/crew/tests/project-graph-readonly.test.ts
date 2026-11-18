// crew#1497: seats are granted a project graph's directory READ-ONLY (wicked-core). crew's side of that:
// every refresh leaves the graph in DELETE journal mode (a read-only reader of a WAL database needs a `-shm`
// it cannot create), and crew's own manifest writes never follow or reuse a link planted in that directory.
// Written from the attack side: a link at the manifest, at its temp name, and a graph left in WAL.

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { graphReadersError, prepareGraphForReaders, prepareProjectGraphForReaders, projectGraphRefreshState, readManifest, readProjectGraph, writeManifest } from '../src/projects/graph.js';
import { sweepProjectGraphsForReaders } from '../src/projects/auto-refresh.js';
import { projectGraphManifest } from '../src/projects/graph-paths.js';

const PROJECT = 'p-readonly-1497';
let victim: string;

beforeEach(() => {
  const dir = dirname(projectGraphManifest(PROJECT, process.env));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  victim = join(dirname(dir), `victim-${process.pid}.txt`);
  writeFileSync(victim, 'OPERATIONAL\n');
});

afterEach(() => {
  rmSync(dirname(projectGraphManifest(PROJECT, process.env)), { recursive: true, force: true });
  rmSync(victim, { force: true });
});

const manifest = { version: 1 as const, projectId: PROJECT, repos: [{ repoId: 'r1', label: 'r1', rootPath: '/srv/r1', head: 'abc', indexedAt: 1 }] };

describe.skipIf(process.platform === 'win32')('crew#1497: the manifest never writes through a link', () => {
  it('a link planted at the old fixed temp name is neither followed nor reused', async () => {
    const path = projectGraphManifest(PROJECT, process.env);
    symlinkSync(victim, `${path}.tmp-${process.pid}`);
    await writeManifest(PROJECT, manifest, process.env);
    expect(readFileSync(victim, 'utf8')).toBe('OPERATIONAL\n');
    expect(lstatSync(path).isFile()).toBe(true);
    expect(await readManifest(PROJECT, process.env)).toEqual(manifest);
  });

  it('a link at the manifest itself is replaced, never written through, and never read as the manifest', async () => {
    const path = projectGraphManifest(PROJECT, process.env);
    const forged = join(dirname(victim), `forged-${process.pid}.json`);
    writeFileSync(forged, JSON.stringify({ ...manifest, repos: [{ ...manifest.repos[0], head: 'forged' }] }));
    try {
      symlinkSync(forged, path);
      // A falsified manifest reached through a link reads as missing: the refresh re-indexes everything.
      expect(await readManifest(PROJECT, process.env)).toBeNull();
      await writeManifest(PROJECT, manifest, process.env);
      expect(JSON.parse(readFileSync(forged, 'utf8')).repos[0].head).toBe('forged');
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(await readManifest(PROJECT, process.env)).toEqual(manifest);
    } finally {
      rmSync(forged, { force: true });
    }
  });
});

describe('crew#1497: the owner migrates a graph before read-only seats read it', () => {
  it("prepares with estate's own binary only: one `stats --journal delete` writer open, and says why when it fails", async () => {
    const gdir = mkdtempSync(join(tmpdir(), 'pg-prep-'));
    const g = join(gdir, 'code-graph.db');
    writeFileSync(g, '');
    const calls: string[][] = [];
    const ok = vi.fn(async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return { stdout: 'nodes=1', stderr: '' };
    });
    expect(await prepareGraphForReaders(g, { WICKED_ESTATE_EXE: 'estate-x' }, ok as never)).toBeNull();
    // Nothing but estate opens the graph: no Node SQLite child (coord ruling on #1597).
    expect(calls).toEqual([['estate-x', 'stats', '--db', g, '--journal', 'delete']]);
    const failing = vi.fn(async () => {
      throw new Error('writer lock: busy');
    });
    expect(await prepareGraphForReaders(g, { WICKED_ESTATE_EXE: 'estate-x' }, failing as never)).toMatch(/--journal delete failed \(writer lock: busy\).*0\.35\.7/);
    expect(failing).toHaveBeenCalledTimes(1);
    rmSync(gdir, { recursive: true, force: true });
  });

  it('at boot, prepares every real project graph once, in order, skips what is not one, and survives a failing one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pg-sweep-'));
    try {
      for (const id of ['p-b', 'p-a', 'no-db', 'no-manifest', 'linked-db']) mkdirSync(join(root, id));
      for (const id of ['p-a', 'p-b']) {
        writeFileSync(join(root, id, 'code-graph.db'), '');
        writeFileSync(join(root, id, 'manifest.json'), '{}');
      }
      writeFileSync(join(root, 'no-manifest', 'code-graph.db'), '');
      writeFileSync(join(root, 'linked-db', 'manifest.json'), '{}');
      mkdirSync(join(root, 'bad id'));
      writeFileSync(join(root, 'bad id', 'code-graph.db'), '');
      writeFileSync(join(root, 'bad id', 'manifest.json'), '{}');
      if (process.platform !== 'win32') {
        symlinkSync(join(root, 'p-a', 'code-graph.db'), join(root, 'linked-db', 'code-graph.db'));
        symlinkSync(join(root, 'p-b'), join(root, 'linked-dir'));
      }
      const seen: string[] = [];
      const log = vi.fn();
      const out = await sweepProjectGraphsForReaders({
        root,
        log,
        prepare: async (id) => {
          seen.push(id);
          if (id === 'p-a') return 'writer lock: busy';
          return null;
        },
      });
      expect(seen).toEqual(['p-a', 'p-b']);
      expect(out).toEqual({ prepared: ['p-b'], failed: [{ projectId: 'p-a', error: 'writer lock: busy' }] });
      expect(log).toHaveBeenCalledWith('project graphs prepared for read-only seats at boot: 1 of 2');
      expect(await sweepProjectGraphsForReaders({ root: join(root, 'missing'), log, prepare: async () => null })).toEqual({ prepared: [], failed: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to prepare a graph that is a link, and records why a graph is not ready until it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-ready-'));
    try {
      const real = join(dir, 'real.db');
      writeFileSync(real, '');
      const ok = vi.fn(async () => ({ stdout: 'nodes=1', stderr: '' }));
      if (process.platform !== 'win32') {
        const link = join(dir, 'link.db');
        symlinkSync(real, link);
        expect(await prepareGraphForReaders(link, {}, ok as never)).toBe('the graph is not a regular file');
        expect(ok).not.toHaveBeenCalled();
        expect(graphReadersError(link)).toBe('the graph is not a regular file');
      }
      const busy = vi.fn(async () => {
        throw new Error('database is locked');
      });
      expect(await prepareGraphForReaders(real, {}, busy as never)).toMatch(/database is locked/);
      expect(graphReadersError(real)).toMatch(/database is locked/);
      expect(await prepareGraphForReaders(real, {}, ok as never)).toBeNull();
      expect(graphReadersError(real)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a boot preparation that fails is a visible refresh failure for that project, with the reason (coord, #1597)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pg-bootfail-'));
    try {
      const env = { WICKED_CREW_PROJECT_GRAPH_ROOT: root, WICKED_ESTATE_EXE: 'estate-x' };
      mkdirSync(join(root, 'p-fail'));
      writeFileSync(join(root, 'p-fail', 'code-graph.db'), '');
      const failing = vi.fn(async () => {
        throw new Error('unexpected flag --journal');
      });
      const why = await prepareProjectGraphForReaders('p-fail', env, failing as never);
      expect(why).toMatch(/unexpected flag --journal/);
      expect(projectGraphRefreshState('p-fail')?.lastFailure?.error).toMatch(/^the graph is not ready for read-only seats: .*unexpected flag --journal/);
      expect(graphReadersError(join(root, 'p-fail', 'code-graph.db'))).toMatch(/unexpected flag/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts a project graph back in DELETE mode after crew's own CLI read, and leaves any other graph alone", async () => {
    const root = mkdtempSync(join(tmpdir(), 'pg-read-'));
    try {
      const env = { WICKED_CREW_PROJECT_GRAPH_ROOT: root };
      mkdirSync(join(root, 'p1'));
      const db = join(root, 'p1', 'code-graph.db');
      writeFileSync(db, '');
      const other = join(root, 'elsewhere.db');
      writeFileSync(other, '');
      const run = vi.fn(async () => ({ stdout: '{"mode":"delete"}', stderr: '' }));
      expect(await readProjectGraph(db, async () => 'hits', env, run as never)).toBe('hits');
      expect(run).toHaveBeenCalledTimes(1);
      expect((run.mock.calls[0] as unknown as [string, string[]])[1]).toEqual(['stats', '--db', db, '--journal', 'delete']);
      // The read's own failure still restores the mode, and is the error the caller sees.
      await expect(readProjectGraph(db, async () => { throw new Error('resolve failed'); }, env, run as never)).rejects.toThrow('resolve failed');
      expect(run).toHaveBeenCalledTimes(2);
      expect(await readProjectGraph(other, async () => 'x', env, run as never)).toBe('x');
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
