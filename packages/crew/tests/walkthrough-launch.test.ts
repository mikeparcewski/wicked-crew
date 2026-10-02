// WT-W1 (DES-walkthrough-proof §4.2, O7): every REPO-BOUND launch gets an evidence root, minted by
// crew at `$WICKED_WALKTHROUGH_DIR/<runId>` (default `<home>/.wicked/walkthroughs/<runId>`) and handed
// to the engine as `LaunchOptions.evidenceRoot`; only its `author/` subdirectory joins the launch's
// `extraWriteRoots` (the proof roots under it are the jailed recorder's alone). A repo-less launch
// gets none, an addon that cannot take the field gets none (napi would drop it silently), and a
// launch the engine refuses leaves no root behind.
//
// Same fake-engine technique as deliver-launch.test.ts: own properties shadow the napi methods.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOptions } from 'wicked-core-ts';
import { CoreAdapter } from '../src/core/adapter.js';
import { walkthroughRootDir } from '../src/api/recording.js';
import { STATE_HOME_ROOT_ENVS } from '../src/projects/state-home-preflight.js';
import { removeScratch } from './setup/scratch.js';

type Sent = LaunchOptions & { evidenceRoot?: string };

let dir: string;
let walkDir: string;
let adapter: CoreAdapter;
let launched: Sent[];
const prevOverlay = process.env['WICKED_WORKFLOWS_DIR'];
const prevWalk = process.env['WICKED_WALKTHROUGH_DIR'];

function stubCore(a: CoreAdapter, name: string, impl: unknown) {
  (a as unknown as { core: Record<string, unknown> }).core[name] = impl;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'walkthrough-launch-'));
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  process.env['WICKED_WORKFLOWS_DIR'] = join(dir, 'workflows');
  walkDir = join(dir, 'walkthroughs');
  process.env['WICKED_WALKTHROUGH_DIR'] = walkDir;
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  // The probe is the addon's version; pin it ON here and turn it off where a test says so.
  (adapter as unknown as { evidenceRootsSupported: () => boolean }).evidenceRootsSupported = () => true;
  launched = [];
  stubCore(adapter, 'launchRun', (opts: Sent) => {
    launched.push(opts);
    return Promise.resolve(opts.sessionId);
  });
});

afterEach(() => {
  if (prevOverlay === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = prevOverlay;
  if (prevWalk === undefined) delete process.env['WICKED_WALKTHROUGH_DIR'];
  else process.env['WICKED_WALKTHROUGH_DIR'] = prevWalk;
  adapter.close();
  removeScratch(dir);
});

describe('the evidence root minted at launch (WT-W1)', () => {
  it('a repo-bound launch gets evidenceRoot = $WICKED_WALKTHROUGH_DIR/<runId>, and only <root>/author joins the write roots', async () => {
    await adapter.launchRun({ problem: 'p', sessionId: 'run-a', clisJson: '[]', workflow: 'bug', repoRef: 'shop' });
    const root = join(walkDir, 'run-a');
    expect(walkthroughRootDir('run-a')).toBe(root);
    expect(launched[0]!.evidenceRoot).toBe(root);
    expect(launched[0]!.extraWriteRoots).toEqual([join(root, 'author')]);
    expect(statSync(join(root, 'author')).isDirectory()).toBe(true);
  });

  it('keeps the launch\'s own write roots and adds the author root after them', async () => {
    const own = join(dir, 'inbox');
    await adapter.launchRun({ problem: 'p', sessionId: 'run-b', clisJson: '[]', workflow: 'bug', repoRef: 'shop', extraWriteRoots: [own] });
    expect(launched[0]!.extraWriteRoots).toEqual([own, join(walkDir, 'run-b', 'author')]);
  });

  it('a repo-less launch gets no evidence root and creates nothing', async () => {
    await adapter.launchRun({ problem: 'p', sessionId: 'run-c', clisJson: '[]', workflow: 'bug' });
    expect('evidenceRoot' in launched[0]!).toBe(false);
    expect(launched[0]!.extraWriteRoots).toBeUndefined();
    expect(existsSync(join(walkDir, 'run-c'))).toBe(false);
  });

  it('an addon that cannot take the field gets none (it would drop it silently), and nothing is created', async () => {
    (adapter as unknown as { evidenceRootsSupported: () => boolean }).evidenceRootsSupported = () => false;
    await adapter.launchRun({ problem: 'p', sessionId: 'run-d', clisJson: '[]', workflow: 'bug', repoRef: 'shop' });
    expect('evidenceRoot' in launched[0]!).toBe(false);
    expect(existsSync(join(walkDir, 'run-d'))).toBe(false);
  });

  it('a launch the engine refuses leaves no evidence root behind', async () => {
    stubCore(adapter, 'launchRun', () => Promise.reject(new Error('refused at intake')));
    await expect(adapter.launchRun({ problem: 'p', sessionId: 'run-e', clisJson: '[]', workflow: 'bug', repoRef: 'shop' })).rejects.toThrow(
      'refused at intake',
    );
    expect(existsSync(join(walkDir, 'run-e'))).toBe(false);
  });

  it('a run id that is not one plain path segment gets no evidence root, and nothing is created outside the walkthrough dir (codex)', async () => {
    // `../escaped-<n>` would land beside the walkthrough dir, inside this test's own scratch dir.
    const name = `escaped-${process.pid}`;
    await adapter.launchRun({ problem: 'p', sessionId: `../${name}`, clisJson: '[]', workflow: 'bug', repoRef: 'shop' });
    expect('evidenceRoot' in launched[0]!).toBe(false);
    expect(existsSync(join(dir, name))).toBe(false);
    expect(() => walkthroughRootDir('../x')).toThrow(/plain/);
  });

  it('a refused launch never removes an evidence root it did not create — a duplicate run id keeps the first run\'s (codex)', async () => {
    const existing = join(walkDir, 'run-dup', 'author', 'walkthrough_plan');
    mkdirSync(existing, { recursive: true });
    stubCore(adapter, 'launchRun', () => Promise.reject(new Error('session run-dup already exists')));
    await expect(adapter.launchRun({ problem: 'p', sessionId: 'run-dup', clisJson: '[]', workflow: 'bug', repoRef: 'shop' })).rejects.toThrow('already exists');
    expect(existsSync(existing)).toBe(true);
  });

  it('defaults to <home>/.wicked/walkthroughs/<runId>, and the variable is refused inside the state home', () => {
    delete process.env['WICKED_WALKTHROUGH_DIR'];
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    expect(walkthroughRootDir('run-f')).toBe(join(home, '.wicked', 'walkthroughs', 'run-f'));
    expect(STATE_HOME_ROOT_ENVS.map((e) => e.variable)).toContain('WICKED_WALKTHROUGH_DIR');
  });
});
