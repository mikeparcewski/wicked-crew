// FINDING-075 residue: an upgraded deployment must not keep running the overlay the OLD code wrote.
//
// Pre-#197 crew wrote `<overlayDir>/onboarding.json` on every launch, baked with one repo's absolute
// paths. #197 stopped writing it — but the overlay dir is persistent state, and the engine's
// `load_dir` registers whatever it finds there, replacing a compiled def by id, wholesale.
//
// So merging the fix is not enough. Observed on a live host immediately after #197: three fresh
// registrations in three different orgs ALL indexed `agentic-products/eliza`, the last repo seeded
// before the fix, because its baked overlay was still on disk. Deterministic, not racy — every run,
// same wrong repo.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;
let adapter: CoreAdapter | undefined;

/** What pre-#197 crew left behind: one repo's absolute paths, frozen. */
const STALE = {
  id: 'onboarding',
  phases: [
    { id: 'index', executor: { type: 'tool', cmd: ['wicked-estate', 'index', '/repos/eliza'] } },
  ],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stale-overlay-'));
  overlayDir = join(dir, 'workflows');
  mkdirSync(overlayDir, { recursive: true });
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
});

afterEach(() => {
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  adapter?.close();
  adapter = undefined;
  removeScratch(dir);
});

describe('a stale onboarding overlay is cleared on startup', () => {
  it('moves it aside, so the engine resolves the built-in def instead', () => {
    const stale = join(overlayDir, 'onboarding.json');
    writeFileSync(stale, JSON.stringify(STALE), 'utf8');

    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

    expect(existsSync(stale), 'the stale overlay still shadows the built-in def').toBe(false);
    // Renamed, not deleted: the overlay dir is an operator-facing extension point, and the file is
    // also the evidence of what a wrong run would have done.
    const parked = `${stale}.superseded-by-crew197`;
    expect(existsSync(parked), 'the stale overlay was destroyed rather than parked').toBe(true);
    expect(JSON.parse(readFileSync(parked, 'utf8'))).toEqual(STALE);
  });

  it('leaves an operator-authored onboarding override alone', () => {
    // `registerWorkflow()` writes user definitions into this same directory, and `listWorkflows()`
    // prefers them. Parking one on every boot would delete a deliberate customization each time it
    // was re-registered — so the quarantine keys on the DEFECT's signature (one repo's absolute
    // paths baked into a shared def), not on the filename.
    const override = join(overlayDir, 'onboarding.json');
    writeFileSync(
      override,
      JSON.stringify({
        id: 'onboarding',
        phases: [
          // Placeholders, as the current def uses — nothing repo-specific frozen in.
          { id: 'index', executor: { type: 'tool', cmd: ['wicked-estate', 'index', '{repo_root}'] } },
          { id: 'review', executor: { type: 'agent' } },
        ],
      }),
      'utf8',
    );

    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

    expect(existsSync(override), 'an operator override was parked as if it were stale').toBe(true);
    expect(existsSync(`${override}.superseded-by-crew197`)).toBe(false);
  });

  it('leaves an unparseable file for the engine to complain about', () => {
    const broken = join(overlayDir, 'onboarding.json');
    writeFileSync(broken, '{ not json', 'utf8');
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    expect(existsSync(broken)).toBe(true);
  });

  it('leaves a clean overlay dir alone', () => {
    // Startup must not invent work on the ordinary path, and must not touch other ids.
    const other = join(overlayDir, 'chat.json');
    writeFileSync(other, JSON.stringify({ id: 'chat', phases: [] }), 'utf8');

    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(overlayDir, 'onboarding.json.superseded-by-crew197'))).toBe(false);
  });
});
