// crew#1774: rules the policy landing put in force with a project NAME as `targets.project` (the facet copied verbatim)
// apply to no run. The boot migration retargets each to the project its name or its filing run resolves to, through
// the one landing, and retires (never deletes) one that resolves nowhere. Against the REAL engine (stub mode), with
// rules shaped exactly as the old landing wrote them (policy-landing.ts policyProposalToRule before crew#1774).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { migrateInertPolicyRules } from '../src/api/policy-landing.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { ConformanceRule } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'policy-inert-migration-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
});

afterAll(() => {
  adapter.close();
  removeScratch(dir);
});

/** A rule as the landing before crew#1774 wrote it: `targets.project` is the proposal's facet, verbatim. */
const landed = (proposalId: string, project: string): ConformanceRule =>
  ({
    id: `proposal:${proposalId}`,
    rule_type: 'policy',
    statement: `rule from ${proposalId}`,
    severity: 'warn',
    confidence: 0.8,
    targets: { project },
    provenance: { source: 'proposal', ref: `proposal:${proposalId}`, source_kinds: [] },
    steering_type: 'testing',
  }) as ConformanceRule;

function audit() {
  const log = AuditLog.noop();
  const record = vi.spyOn(log, 'record');
  return { log, record };
}

describe('crew#1774: rules that name no project are retargeted or retired', () => {
  it('retargets by project name or filing run, retires what resolves nowhere, and leaves good rules alone', async () => {
    const crew = await adapter.projectCreate('wicked-crew');
    const studio = await adapter.projectCreate('Studio Work');
    await adapter.upsertConformanceRule(landed('byname', 'wicked-crew'));
    await adapter.upsertConformanceRule(landed('byrun', 'carddemo'));
    await adapter.upsertConformanceRule(landed('nowhere', 'autogpt-exec'));
    await adapter.upsertConformanceRule(landed('good', studio.id));
    // The reserved default project is an id too, though the project list leaves it out (codex review).
    await adapter.upsertConformanceRule(landed('reserved', 'default'));
    // The filing run of `byrun` is in the studio project, as the engine records it (not a crew-side index).
    await adapter.projectMemberAttach(studio.id, 'crew.run', 'run-1');
    // A deleted project's id is still an id: never touched.
    await adapter.upsertConformanceRule(landed('deleted', 'proj_000000000000000001'));
    const estateTool = vi.fn(async (tool: string) => {
      expect(tool).toBe('proposal.list');
      return { proposals: [{ id: 'byrun', provenance: { run_id: 'run-1' } }, { id: 'nowhere', provenance: { run_id: 'run-2' } }] };
    });
    const { log, record } = audit();

    const out = await migrateInertPolicyRules({ adapter, audit: log, estateTool, log: () => undefined });

    expect(out).toEqual({ retargeted: ['proposal:byname', 'proposal:byrun'], retired: ['proposal:nowhere'] });
    expect((await adapter.readConformanceRule('proposal:byname'))?.targets.project).toBe(crew.id);
    expect((await adapter.readConformanceRule('proposal:byrun'))?.targets.project).toBe(studio.id);
    const gone = await adapter.readConformanceRule('proposal:nowhere');
    expect(gone?.retired).toBe(true);
    expect(gone?.targets.project).toBe('autogpt-exec');
    expect((await adapter.readConformanceRule('proposal:good'))?.targets.project).toBe(studio.id);
    expect((await adapter.readConformanceRule('proposal:deleted'))?.retired).not.toBe(true);
    expect(await adapter.readConformanceRule('proposal:reserved')).toMatchObject({ targets: { project: 'default' } });
    expect((await adapter.readConformanceRule('proposal:reserved'))?.retired).not.toBe(true);
    expect(record).toHaveBeenCalledWith('governance.rule.upserted', expect.anything(), {
      detail: expect.objectContaining({ id: 'proposal:byname', via: 'inert-project-migration', from: 'wicked-crew', project: crew.id }),
    });
    expect(record).toHaveBeenCalledWith('governance.rule.retired', expect.anything(), {
      detail: { id: 'proposal:nowhere', via: 'inert-project-migration', project: 'autogpt-exec' },
    });

    // A second boot finds nothing to do and asks estate nothing.
    estateTool.mockClear();
    expect(await migrateInertPolicyRules({ adapter, audit: log, estateTool, log: () => undefined })).toEqual({ retargeted: [], retired: [] });
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('retires nothing when the approve queue cannot be read, or answers a shape that is not a list (a run might have resolved it)', async () => {
    await adapter.upsertConformanceRule(landed('queue-down', 'no-such-project'));
    const { log } = audit();
    for (const answer of [() => Promise.reject(new Error('estate down')), () => Promise.resolve({}), () => Promise.resolve({ proposals: null })]) {
      const out = await migrateInertPolicyRules({ adapter, audit: log, estateTool: answer, log: () => undefined });
      expect(out.retired).toEqual([]);
      expect((await adapter.readConformanceRule('proposal:queue-down'))?.retired).not.toBe(true);
    }
  });

  it('retires nothing whose filing run\'s project cannot be read from the engine', async () => {
    await adapter.upsertConformanceRule(landed('run-unread', 'still-no-project'));
    const { log } = audit();
    const flaky = Object.assign(Object.create(adapter) as CoreAdapter, {
      memberProjects: async () => {
        throw new Error('engine busy');
      },
    });
    const out = await migrateInertPolicyRules({
      adapter: flaky,
      audit: log,
      estateTool: async () => ({ proposals: [{ id: 'run-unread', provenance: { run_id: 'run-9' } }] }),
      log: () => undefined,
    });
    // (The earlier test's rule, with no filing run, resolves nowhere and is retired now that the queue reads.)
    expect(out.retired).not.toContain('proposal:run-unread');
    expect((await adapter.readConformanceRule('proposal:run-unread'))?.retired).not.toBe(true);
  });
});
