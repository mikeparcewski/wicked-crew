// DES-mcp-server-workflow, crew half: the `mcp-server` drop-in core ships (wicked-core
// workflows/mcp-server.json) is served from crew's BUILTIN_WORKFLOWS mirror, delivers by default
// (its build phase writes code), and the per-run deliver composer places `deliver` BEFORE the gated
// `install` Tool phase, so the pull request exists when the install gate asks. The field-for-field
// equality with core's JSON lives in builtin-overlay-shadow.test.ts (MIRRORED_IDS), with the other
// drop-ins.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_WORKFLOWS, CoreAdapter, humanGatePhaseIds } from '../src/core/adapter.js';
import { composeDeliverWorkflow, DELIVER_PHASE_ID, EVIDENCE_FLOOR_PIN, INSTALL_PHASE_ID, placeDeliverBeforeInstall } from '../src/core/deliver.js';
import type { WorkflowDef } from '../src/core/types.js';
import { orderMayApprove } from '../src/standing-orders/evaluator.js';
import { removeScratch } from './setup/scratch.js';

const SEATS = JSON.stringify([{ key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' }]);

let adapter: CoreAdapter;
let dir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-server-mirror-'));
  overlayDir = join(dir, 'workflows');
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
  adapter = new CoreAdapter({ dbPath: join(dir, 'mirror.db'), stub: true });
});

afterAll(() => {
  if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
  else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
  if (adapter) adapter.close();
  if (dir) removeScratch(dir);
});

const served = (): WorkflowDef => {
  const def = adapter.listWorkflows().find((w) => w.id === 'mcp-server');
  expect(def, 'mcp-server must be served').toBeDefined();
  return def!;
};

describe('the mcp-server mirror', () => {
  it('serves the eight phases in order with their kinds, roles, gates, pins and skill_refs', () => {
    const def = served();
    expect(def.phases.map((p) => [p.id, p.kind, p.role, p.validator_pin, p.skill_ref])).toEqual([
      ['scope', 'recon', 'neutral', null, 'wicked-garden-mcp-scaffold'],
      ['source-discovery', 'recon', 'neutral', null, 'wicked-garden-mcp-scaffold'],
      ['design', 'recon', 'neutral', null, 'wicked-garden-mcp-scaffold'],
      ['build', 'build', 'creator', EVIDENCE_FLOOR_PIN, 'wicked-garden-mcp-scaffold'],
      ['test', 'test', 'neutral', EVIDENCE_FLOOR_PIN, 'wicked-garden-qe-contract-testing-engineer'],
      ['security-review', 'review', 'evaluator', EVIDENCE_FLOOR_PIN, 'wicked-garden-platform-security-engineer'],
      ['observability-review', 'review', 'evaluator', EVIDENCE_FLOOR_PIN, 'wicked-garden-qe-observability-test-engineer'],
      ['install', 'build', 'neutral', null, null],
    ]);
    const by = Object.fromEntries(def.phases.map((p) => [p.id, p]));
    expect(by['scope']!.gate).toEqual({ human_confirm: { unconditional: false } });
    expect(by['source-discovery']!.gate).toBe('auto');
    expect(by['build']!.gate).toBe('auto');
    expect(by['build']!.executes_code).toBe(true);
    expect(by['test']!.gate).toEqual({ human_confirm_if: 'verdict_not_pass' });
    expect(by['test']!.verified_evidence).toBe(true);
    expect(by['security-review']!.depends_on).toEqual(['test']);
    expect(by['observability-review']!.depends_on).toEqual(['test']);
    // crew#888 / core#801: the engine pauses BEFORE the install runs (`gateKind: 'consent'`).
    expect(by['install']!.gate).toBe('consent_before');
    expect(by['install']!.executes_code).toBe(false);
    expect(by['install']!.depends_on).toEqual(['security-review', 'observability-review']);
    // core#802: `bash -c` (no login shell) execs the admitted garden at WICKED_GARDEN_ROOT, never PATH.
    expect(by['install']!.executor).toMatchObject({ type: 'tool', cmd: ['bash', '-c', expect.stringContaining('scripts/mcp/install.py --from-run --json')] });
    const installCmd = (by['install']!.executor as { cmd: string[] }).cmd[2]!;
    expect(installCmd).toContain('${WICKED_GARDEN_ROOT:?');
    expect(installCmd).not.toMatch(/command -v|npx/);
    expect(by['install']!.instructions).toContain('Nothing has been installed yet: this asks before the install runs.');
    expect(by['design']!.instructions).toContain('never state what a rule id means when you could not read it');
    expect(humanGatePhaseIds(def)).toContain('install');
    for (const p of def.phases) {
      expect(typeof p.instructions, `${p.id} carries instructions`).toBe('string');
      expect(p.id).not.toBe(DELIVER_PHASE_ID);
      expect(p.required_deliverables).toEqual([]);
    }
    expect(def.is_system ?? false, 'an operator-selectable work mode, not a system workflow').toBe(false);
  });

  it('a standing order never answers the consent gate (crew#888: consent is the operator\'s decision every time)', () => {
    expect(orderMayApprove('consent', { landsDoctrine: false })).toBe(false);
    expect(orderMayApprove('def', { landsDoctrine: false })).toBe(true);
  });

  it('delivers by default: the build phase is a code-writing non-evaluator (the launch route\'s rule)', () => {
    expect(served().phases.some((p) => p.executes_code === true && p.role !== 'evaluator')).toBe(true);
  });

  it('a launch writes the drop-in to the overlay (core does not seed it)', async () => {
    try {
      await adapter.launchRun({ problem: 'probe mcp-server', sessionId: 's-mcp-server', clisJson: SEATS, workflow: 'mcp-server' });
    } catch {
      /* the stub run's own outcome is not what this measures */
    }
    expect(existsSync(join(overlayDir, 'mcp-server.json'))).toBe(true);
  });
});

describe('deliver goes before install', () => {
  it('composeDeliverWorkflow on mcp-server: …, security-review, observability-review, deliver, install; deliver takes install\'s depends_on, install depends on deliver', () => {
    const base = BUILTIN_WORKFLOWS.find((w) => w.id === 'mcp-server')!;
    const composed = composeDeliverWorkflow(base, 'run-1', 'build an MCP server');
    expect(composed.phases.map((p) => p.id)).toEqual([
      'scope', 'source-discovery', 'design', 'build', 'test', 'security-review', 'observability-review', DELIVER_PHASE_ID, INSTALL_PHASE_ID,
    ]);
    const by = Object.fromEntries(composed.phases.map((p) => [p.id, p]));
    expect(by[DELIVER_PHASE_ID]!.depends_on).toEqual(['security-review', 'observability-review']);
    expect(by[INSTALL_PHASE_ID]!.depends_on).toEqual([DELIVER_PHASE_ID]);
    // The base def is not mutated.
    expect(base.phases.find((p) => p.id === INSTALL_PHASE_ID)!.depends_on).toEqual(['security-review', 'observability-review']);
  });

  it('a def without install still appends deliver after its last phase (feature)', () => {
    const feature = BUILTIN_WORKFLOWS.find((w) => w.id === 'feature')!;
    const composed = composeDeliverWorkflow(feature, 'run-2');
    const ids = composed.phases.map((p) => p.id);
    expect(ids.at(-1)).toBe(DELIVER_PHASE_ID);
    expect(ids.slice(0, -1)).toEqual(feature.phases.map((p) => p.id));
    expect(composed.phases.at(-1)!.depends_on).toEqual([feature.phases.at(-1)!.id]);
  });

  it('the deliver collision probe still refuses a base that carries deliver, install or not', () => {
    const base = BUILTIN_WORKFLOWS.find((w) => w.id === 'mcp-server')!;
    const withDeliver: WorkflowDef = { ...base, phases: [...base.phases, { ...base.phases[0]!, id: DELIVER_PHASE_ID }] };
    expect(() => composeDeliverWorkflow(withDeliver, 'run-3')).toThrow(/already has a 'deliver' phase/);
  });

  it('placeDeliverBeforeInstall is pure and id-keyed', () => {
    const d = { id: 'deliver', depends_on: ['b'] };
    expect(placeDeliverBeforeInstall([{ id: 'a', depends_on: [] }, { id: 'b', depends_on: ['a'] }], d).map((p) => p.id)).toEqual(['a', 'b', 'deliver']);
    const phases = [{ id: 'a', depends_on: [] }, { id: 'install', depends_on: ['a'] }, { id: 'z', depends_on: ['install'] }];
    const out = placeDeliverBeforeInstall(phases, { id: 'deliver', depends_on: ['a'] });
    expect(out).toEqual([{ id: 'a', depends_on: [] }, { id: 'deliver', depends_on: ['a'] }, { id: 'install', depends_on: ['deliver'] }, { id: 'z', depends_on: ['install'] }]);
    expect(phases[1]!.depends_on).toEqual(['a']);
  });
});
