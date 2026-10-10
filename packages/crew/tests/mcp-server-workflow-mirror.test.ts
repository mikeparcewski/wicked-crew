// DES-mcp-server-workflow, crew half: `mcp-server` is the engine's built-in preset (X-MIG M12), and
// crew serves it DERIVED from that preset and the phase catalog (X-MIG M11, no mirror): it delivers
// by default (its build step writes code), and the per-run deliver composer, for a runtime def that
// carries an install, places `deliver` BEFORE the gated `install` Tool phase so the pull request
// exists when the install gate asks. (A delivering preset launch: the engine places it, M12.)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, humanGatePhaseIds } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { composeDeliverWorkflow, DELIVER_PHASE_ID, EVIDENCE_FLOOR_PIN, INSTALL_PHASE_ID, INSTALL_PLAN_PHASE_ID, placeDeliverBeforeInstall } from '../src/core/deliver.js';
import type { WorkflowDef } from '../src/core/types.js';
import { orderMayApprove } from '../src/standing-orders/evaluator.js';
import { removeScratch } from './setup/scratch.js';


let adapter: CoreAdapter;
let dir: string;
let overlayDir: string;
let priorOverlayDir: string | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-server-mirror-'));
  overlayDir = join(dir, 'workflows');
  priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
  process.env['WICKED_WORKFLOWS_DIR'] = overlayDir;
  adapter = new CoreAdapter({ dbPath: join(dir, 'mirror.db'), stub: true });
  await adapter.loadBuiltinCatalog(() => {});
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

describe('the mcp-server built-in, served from the engine\'s preset (X-MIG M11)', () => {
  it('serves the nine phases in order with their kinds, roles, gates, pins and skill_refs', () => {
    const def = served();
    expect(def.phases.map((p) => [p.id, p.kind, p.role, p.validator_pin, p.skill_ref])).toEqual([
      ['scope', 'recon', 'neutral', null, 'wicked-garden-mcp-scaffold'],
      ['source-discovery', 'recon', 'neutral', null, 'wicked-garden-mcp-scaffold'],
      ['design', 'recon', 'neutral', null, 'wicked-garden-mcp-scaffold'],
      ['build', 'build', 'creator', EVIDENCE_FLOOR_PIN, 'wicked-garden-mcp-scaffold'],
      // The preset's one bold cell (M12): test runs on the evaluator role.
      ['test', 'test', 'evaluator', EVIDENCE_FLOOR_PIN, 'wicked-garden-qe-contract-testing-engineer'],
      ['security-review', 'review', 'evaluator', EVIDENCE_FLOOR_PIN, 'wicked-garden-platform-security-engineer'],
      ['observability-review', 'review', 'evaluator', EVIDENCE_FLOOR_PIN, 'wicked-garden-qe-observability-test-engineer'],
      ['install-plan', 'build', 'neutral', null, null],
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
    // core#820: the install depends on its dry run, which is where the consent gate reads the plan.
    expect(by['install']!.depends_on).toEqual(['install-plan']);
    expect(by['install-plan']!.depends_on).toEqual(['security-review', 'observability-review']);
    expect(by['install-plan']!.gate).toBe('auto');
    // core#802: `bash -c` (no login shell) execs the admitted garden at WICKED_GARDEN_ROOT, never PATH.
    const planCmd = (by['install-plan']!.executor as { cmd: string[] }).cmd;
    expect(planCmd.slice(0, 2)).toEqual(['bash', '-c']);
    expect(planCmd[2]).toContain('scripts/mcp/install.py --from-run --dry-run --json');
    const installCmd = (by['install']!.executor as { cmd: string[] }).cmd[2]!;
    expect((by['install']!.executor as { cmd: string[] }).cmd.slice(0, 2)).toEqual(['bash', '-c']);
    expect(installCmd).toContain('${WICKED_GARDEN_ROOT:?');
    // The install writes exactly the choice the operator approved at the gate (core#820).
    expect(installCmd).toContain('--target "${WICKED_CONSENT_CHOICE:?');
    expect(installCmd).not.toContain('--dry-run');
    for (const cmd of [installCmd, planCmd[2]!]) expect(cmd).not.toMatch(/command -v|npx/);
    expect(by['install']!.instructions).toContain('Nothing has been installed yet: this asks before the install runs');
    expect(by['install']!.instructions).toContain('Install for workers (the default)');
    expect(humanGatePhaseIds(def)).not.toContain('install-plan');
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
});

describe('deliver goes before install', () => {
  it('composeDeliverWorkflow on mcp-server: …, observability-review, deliver, install-plan, install; the install still depends on its plan (core#820)', () => {
    const base = BUILTIN_WORKFLOWS.find((w) => w.id === 'mcp-server')!;
    const composed = composeDeliverWorkflow(base, 'run-1', 'build an MCP server');
    expect(composed.phases.map((p) => p.id)).toEqual([
      'scope', 'source-discovery', 'design', 'build', 'test', 'security-review', 'observability-review', DELIVER_PHASE_ID, INSTALL_PLAN_PHASE_ID, INSTALL_PHASE_ID,
    ]);
    const by = Object.fromEntries(composed.phases.map((p) => [p.id, p]));
    expect(by[DELIVER_PHASE_ID]!.depends_on).toEqual(['security-review', 'observability-review']);
    expect(by[INSTALL_PLAN_PHASE_ID]!.depends_on).toEqual([DELIVER_PHASE_ID]);
    // The consent gate reads the write plan from the phase the install DEPENDS ON: never deliver.
    expect(by[INSTALL_PHASE_ID]!.depends_on).toEqual([INSTALL_PLAN_PHASE_ID]);
    // The base def is not mutated.
    expect(base.phases.find((p) => p.id === INSTALL_PLAN_PHASE_ID)!.depends_on).toEqual(['security-review', 'observability-review']);
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
    // core#820: with a dry run before the install, deliver goes before the dry run.
    const planned = [{ id: 'a', depends_on: [] }, { id: 'install-plan', depends_on: ['a'] }, { id: 'install', depends_on: ['install-plan'] }];
    expect(placeDeliverBeforeInstall(planned, { id: 'deliver', depends_on: ['a'] })).toEqual([
      { id: 'a', depends_on: [] }, { id: 'deliver', depends_on: ['a'] }, { id: 'install-plan', depends_on: ['deliver'] }, { id: 'install', depends_on: ['install-plan'] },
    ]);
  });
});
