// Scenario → CampaignNode mapping (TH-9): the pure half of the campaign surface.
//
// The load-bearing rule here is the 1022-byte one. PTY worker prompts over 1022 bytes are
// SILENTLY DISCARDED by the canonical line discipline — observed in the S8 campaign as a unit
// that burned its full timeout waiting on input that never arrived. The mapper is the daemon's
// one chance to refuse a scenario BODY inlined where a FILE PATH belongs, so these tests pin
// both sides of the ceiling: 1022 bytes maps, 1023 refuses with the file-path advice.

import { describe, expect, it } from 'vitest';
import {
  buildCampaign,
  buildReconCampaign,
  CAMPAIGN_WORKFLOW_PREFIX,
  MAX_INLINE_BYTES,
  RECON_INTAKE_GATE,
  scenarioWorkflowId,
} from '../src/campaigns/plan.js';
import type { LaunchCampaignBody } from '../src/core/types.js';

const CLIS = [{ key: 'alpha' }];

function body(overrides: Partial<LaunchCampaignBody> = {}): LaunchCampaignBody {
  return {
    id: 'camp-1',
    scenarios: [
      { id: 'a', tool: { cmd: ['node', '/specs/a.spec.mjs'] } },
      { id: 'b', deps: ['a'], tool: { cmd: ['node', '/specs/b.spec.mjs'] } },
    ],
    ...overrides,
  };
}

describe('buildCampaign — DAG shape', () => {
  it('maps scenarios to nodes and deps to on_success edges', () => {
    const { def } = buildCampaign(body(), CLIS);
    expect(def.id).toBe('camp-1');
    expect(def.nodes.map((n) => n.node_id)).toEqual(['a', 'b']);
    expect(def.edges).toEqual([{ from: 'a', to: 'b', condition: 'on_success' }]);
    expect(def.policy).toBe('continue_independent');
    expect(def.max_concurrency).toBe(2);
  });

  it('honors depsCondition, policy, and maxConcurrency', () => {
    const { def } = buildCampaign(
      body({
        policy: 'fail_fast',
        maxConcurrency: 4,
        scenarios: [
          { id: 'a', tool: { cmd: ['true'] } },
          { id: 'cleanup', deps: ['a'], depsCondition: 'on_terminal', tool: { cmd: ['true'] } },
        ],
      }),
      CLIS,
    );
    expect(def.edges).toEqual([{ from: 'a', to: 'cleanup', condition: 'on_terminal' }]);
    expect(def.policy).toBe('fail_fast');
    expect(def.max_concurrency).toBe(4);
  });

  it('rejects an unknown dep, a self-dep, and a duplicated dep — each named', () => {
    expect(() =>
      buildCampaign(body({ scenarios: [{ id: 'a', deps: ['ghost'], tool: { cmd: ['true'] } }] }), CLIS),
    ).toThrow(/depends on unknown scenario 'ghost'/);
    expect(() =>
      buildCampaign(body({ scenarios: [{ id: 'a', deps: ['a'], tool: { cmd: ['true'] } }] }), CLIS),
    ).toThrow(/depends on itself/);
    expect(() =>
      buildCampaign(
        body({
          scenarios: [
            { id: 'a', tool: { cmd: ['true'] } },
            { id: 'b', deps: ['a', 'a'], tool: { cmd: ['true'] } },
          ],
        }),
        CLIS,
      ),
    ).toThrow(/names dep 'a' twice/);
  });

  it('rejects a duplicate scenario id and an empty batch', () => {
    expect(() =>
      buildCampaign(
        body({ scenarios: [{ id: 'a', tool: { cmd: ['true'] } }, { id: 'a', tool: { cmd: ['true'] } }] }),
        CLIS,
      ),
    ).toThrow(/duplicate scenario id 'a'/);
    expect(() => buildCampaign(body({ scenarios: [] }), CLIS)).toThrow(/at least one scenario/);
  });

  it("rejects ids the engine's run-id scheme cannot key (`:`), and overlong ids", () => {
    expect(() =>
      buildCampaign(body({ scenarios: [{ id: 'a:b', tool: { cmd: ['true'] } }] }), CLIS),
    ).toThrow(/scenario id 'a:b'/);
    expect(() => buildCampaign(body({ id: 'camp:1' }), CLIS)).toThrow(/campaign id 'camp:1'/);
    expect(() => buildCampaign(body({ id: 'c'.repeat(65) }), CLIS)).toThrow(/at most 64 chars/);
    expect(() =>
      buildCampaign(body({ scenarios: [{ id: 's'.repeat(49), tool: { cmd: ['true'] } }] }), CLIS),
    ).toThrow(/at most 48 chars/);
  });
});

describe('buildCampaign — deterministic scenarios are Tool phases carrying file paths', () => {
  it('composes one single-Tool-phase workflow per tool scenario, cmd verbatim', () => {
    const { def, workflows } = buildCampaign(body(), CLIS);
    expect(workflows.map((w) => w.id)).toEqual([
      scenarioWorkflowId('camp-1', 'a'),
      scenarioWorkflowId('camp-1', 'b'),
    ]);
    for (const wf of workflows) {
      expect(wf.id.startsWith(CAMPAIGN_WORKFLOW_PREFIX)).toBe(true);
      expect(wf.phases).toHaveLength(1);
      const phase = wf.phases[0]!;
      expect(phase.executor).toEqual({
        type: 'tool',
        cmd: ['node', `/specs/${wf.id.endsWith('-a') ? 'a' : 'b'}.spec.mjs`],
      });
      // Executor claim, not a verdict: no evidence floor (a probe run leaves no worktree diff),
      // no gate, no council.
      expect(phase.verified_evidence).toBe(false);
      expect(phase.gate).toBe('auto');
    }
    // Each node's run_spec references ITS composed workflow, and the problem is a label.
    expect(def.nodes[0]!.run_spec.workflow_id).toBe(scenarioWorkflowId('camp-1', 'a'));
    expect(def.nodes[0]!.run_spec.problem).toBe('a');
  });

  it(`accepts an argv token of exactly ${MAX_INLINE_BYTES} bytes and refuses ${MAX_INLINE_BYTES + 1}`, () => {
    const atLimit = '/x/'.concat('p'.repeat(MAX_INLINE_BYTES - 3));
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(MAX_INLINE_BYTES);
    expect(() =>
      buildCampaign(body({ scenarios: [{ id: 'a', tool: { cmd: ['node', atLimit] } }] }), CLIS),
    ).not.toThrow();

    const overLimit = atLimit.concat('p');
    expect(() =>
      buildCampaign(body({ scenarios: [{ id: 'a', tool: { cmd: ['node', overLimit] } }] }), CLIS),
    ).toThrow(/1022-byte PTY canonical-line limit.*file/s);
  });

  it('counts the ceiling in BYTES, not code points (a multibyte body must not slip through)', () => {
    // 512 two-byte chars = 1024 bytes but only 512 chars — a length check would admit it.
    const multibyte = 'é'.repeat(512);
    expect(multibyte.length).toBeLessThan(MAX_INLINE_BYTES);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(MAX_INLINE_BYTES);
    expect(() =>
      buildCampaign(body({ scenarios: [{ id: 'a', tool: { cmd: ['node', multibyte] } }] }), CLIS),
    ).toThrow(/PTY canonical-line limit/);
  });

  it('refuses a multiline argv token — the shape of an inlined scenario body', () => {
    expect(() =>
      buildCampaign(
        body({ scenarios: [{ id: 'a', tool: { cmd: ['bash', '-c', 'step one\nstep two'] } }] }),
        CLIS,
      ),
    ).toThrow(/contains a newline.*persist the content as a file/s);
  });

  it('refuses an empty argv', () => {
    expect(() =>
      buildCampaign(body({ scenarios: [{ id: 'a', tool: { cmd: [] } }] }), CLIS),
    ).toThrow(/tool\.cmd is empty/);
  });
});

describe('buildCampaign — agent scenarios', () => {
  it('maps an agent scenario to a plain run_spec (no composed workflow)', () => {
    const { def, workflows } = buildCampaign(
      body({
        scenarios: [
          { id: 'explore', agent: { problem: 'Probe the health surface', workflow: 'feature' } },
        ],
      }),
      CLIS,
    );
    expect(workflows).toEqual([]);
    expect(def.nodes[0]!.run_spec).toEqual({
      problem: 'Probe the health surface',
      clis: CLIS,
      entity_mode: 'shared',
      workflow_id: 'feature',
    });
  });

  it('applies the same byte ceiling to the agent problem — it reaches workers as a prompt', () => {
    expect(() =>
      buildCampaign(
        body({ scenarios: [{ id: 'x', agent: { problem: 'p'.repeat(MAX_INLINE_BYTES + 1) } }] }),
        CLIS,
      ),
    ).toThrow(/PTY canonical-line limit/);
  });

  it('refuses a scenario with both tool and agent, and one with neither', () => {
    expect(() =>
      buildCampaign(
        body({ scenarios: [{ id: 'x', tool: { cmd: ['true'] }, agent: { problem: 'p' } }] }),
        CLIS,
      ),
    ).toThrow(/exactly one of 'tool'.*or 'agent'/s);
    expect(() => buildCampaign(body({ scenarios: [{ id: 'x' }] }), CLIS)).toThrow(
      /exactly one of 'tool'.*or 'agent'/s,
    );
  });

  it('refuses pointing an agent scenario at a composed campaign workflow', () => {
    expect(() =>
      buildCampaign(
        body({
          scenarios: [{ id: 'x', agent: { problem: 'p', workflow: 'campaign-other-node' } }],
        }),
        CLIS,
      ),
    ).toThrow(/must name a registered workflow/);
  });
});

// ── The recon fan-out's campaign builder (crew#390/#391) ─────────────────────────────────────

describe('buildReconCampaign — the fan as a first-class campaign', () => {
  const REPOS = [
    { id: 'repo-alpha', name: 'alpha' },
    { id: 'repo-beta', name: 'beta' },
  ];

  it('one gated agent node per repo, independent, fan-width concurrency', () => {
    const { def, runIds } = buildReconCampaign({
      id: 'recon-abc-12345678',
      problem: 'survey the estate',
      repos: REPOS,
      clis: CLIS,
      ungated: false,
    });
    expect(def.id).toBe('recon-abc-12345678');
    expect(def.name).toBe('survey the estate');
    expect(def.nodes.map((n) => n.node_id)).toEqual(['alpha', 'beta']);
    expect(def.nodes.map((n) => n.run_spec.repo_ref)).toEqual(['repo-alpha', 'repo-beta']);
    // Every sibling carries the brief VERBATIM and the intake gate (crew#391).
    expect(def.nodes.every((n) => n.run_spec.problem === 'survey the estate')).toBe(true);
    expect(def.nodes.map((n) => n.run_spec.human_confirm)).toEqual([
      RECON_INTAKE_GATE,
      RECON_INTAKE_GATE,
    ]);
    // Independent siblings: no edges, one honest failure never cancels the rest, all-at-once.
    expect(def.edges).toEqual([]);
    expect(def.policy).toBe('continue_independent');
    expect(def.max_concurrency).toBe(2);
    // The attempt-0 node run ids, repo order — the route's runIds answer.
    expect(runIds).toEqual(['recon-abc-12345678:alpha:a0', 'recon-abc-12345678:beta:a0']);
  });

  it('ungated: true drops the gate from every node (the EXPLICIT unattended fan)', () => {
    const { def } = buildReconCampaign({
      id: 'recon-abc-12345678',
      problem: 'p',
      repos: REPOS,
      clis: CLIS,
      ungated: true,
    });
    expect(def.nodes.every((n) => n.run_spec.human_confirm === undefined)).toBe(true);
  });

  it('squeezes repo names into node-id-safe tokens and dedupes collisions by position', () => {
    const { def, runIds } = buildReconCampaign({
      id: 'recon-x-00000000',
      problem: 'p',
      repos: [
        { id: 'r1', name: 'my repo!' },       // spaces/punctuation squeezed
        { id: 'r2', name: 'my repo?' },       // collides with the first → position suffix
        { id: 'r3', name: '###' },            // nothing survives → positional fallback
        { id: 'r4', name: 'x'.repeat(60) },   // capped
      ],
      clis: CLIS,
      ungated: false,
    });
    const ids = def.nodes.map((n) => n.node_id);
    expect(ids[0]).toBe('my-repo-');
    expect(ids[1]).toBe('my-repo--r2');
    expect(ids[2]).toBe('r3');
    expect(ids[3]).toBe('x'.repeat(40));
    // Unique, ':'-free (the engine keys node run ids `{campaign}:{node}:a{attempt}`).
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => !id.includes(':'))).toBe(true);
    expect(runIds).toEqual(ids.map((id) => `recon-x-00000000:${id}:a0`));
  });

  it('names the campaign from the brief’s first line, capped; label fallback for whitespace', () => {
    const long = `${'t'.repeat(200)}\nsecond line`;
    const capped = buildReconCampaign({
      id: 'recon-x-00000000', problem: long, repos: REPOS, clis: CLIS, ungated: false,
    });
    expect(capped.def.name).toBe('t'.repeat(140));
    const blank = buildReconCampaign({
      id: 'recon-x-00000000', problem: '   \nreal text below', repos: REPOS, clis: CLIS, ungated: false,
    });
    expect(blank.def.name).toBe('recon-x-00000000');
  });

  it('refuses a fan of fewer than 2 repos (the per-run path owns those)', () => {
    expect(() =>
      buildReconCampaign({
        id: 'recon-x-00000000',
        problem: 'p',
        repos: [{ id: 'r1', name: 'solo' }],
        clis: CLIS,
        ungated: false,
      }),
    ).toThrow(/at least 2 resolved repos/);
  });
});
