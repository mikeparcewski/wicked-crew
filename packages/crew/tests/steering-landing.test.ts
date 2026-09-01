// The steering-author landing's PURE half (crew#388): proposal extraction from the three run
// records (deliverable file text, transcript prose, gate prompt), chat-provenance stamping, the
// problem-preamble type recovery, and steering-author run detection. The route-level behavior
// (approve lands / replay dedupes / reject lands nothing / fail-loud) lives in
// steering-gate-landing-route.test.ts — these are the parsers it stands on.

import { describe, expect, it } from 'vitest';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import {
  extractProposedRules,
  isSteeringAuthorRun,
  normalizeProposedRule,
  steeringTypeFromProblem,
} from '../src/api/steering-landing.js';
import type { SessionView } from '../src/core/types.js';

const RULES = [
  {
    id: 'POL-0001',
    rule_type: 'policy',
    statement: 'never deploy on friday',
    severity: 'error',
    confidence: 0.9,
    targets: {},
    provenance: { source: 'chat', source_kinds: [] },
  },
  {
    id: 'PAT-0002',
    rule_type: 'pattern',
    statement: 'errors bubble as typed classes, not strings',
    severity: 'warn',
    confidence: 0.8,
    targets: {},
    provenance: { source: 'chat', source_kinds: [] },
  },
];

describe('extractProposedRules', () => {
  it('parses a bare JSON array (the deliverable-file contract)', () => {
    const rules = extractProposedRules(JSON.stringify(RULES));
    expect(rules).not.toBeNull();
    expect(rules!.map((r) => r['id'])).toEqual(['POL-0001', 'PAT-0002']);
  });

  it('accepts a {rules: [...]} wrapper', () => {
    const rules = extractProposedRules(JSON.stringify({ rules: RULES }));
    expect(rules).not.toBeNull();
    expect(rules).toHaveLength(2);
  });

  it('finds the array inside a fenced code block (the transcript shape)', () => {
    const transcript = [
      'Here are the proposed steering rules based on my analysis:',
      '```json',
      JSON.stringify(RULES, null, 2),
      '```',
      'Awaiting your approval.',
    ].join('\n');
    const rules = extractProposedRules(transcript);
    expect(rules).not.toBeNull();
    expect(rules!.map((r) => r['id'])).toEqual(['POL-0001', 'PAT-0002']);
  });

  it('finds a bare array embedded in prose, and a `]` inside a statement never truncates it', () => {
    const withBracket = [
      { ...RULES[0], statement: 'wrap indices like [0] and [1] in bounds checks' },
      RULES[1],
    ];
    const transcript = `My proposal follows. ${JSON.stringify(withBracket)} — that is all.`;
    const rules = extractProposedRules(transcript);
    expect(rules).not.toBeNull();
    expect(rules).toHaveLength(2);
    expect(rules![0]!['statement']).toContain('[0] and [1]');
  });

  it('rejects text with no parseable rule array — prose, empty arrays, arrays of non-rules', () => {
    expect(extractProposedRules('I could not derive any rules from the material.')).toBeNull();
    expect(extractProposedRules('[]')).toBeNull();
    // An array of things that are not {id, statement} objects is NOT a proposal — landing a
    // shape the engine would half-accept is the silent-loss family this fix ends.
    expect(extractProposedRules('["POL-0001", "PAT-0002"]')).toBeNull();
    expect(extractProposedRules(JSON.stringify([{ id: 'POL-1' }]))).toBeNull();
    expect(extractProposedRules('')).toBeNull();
  });
});

describe('normalizeProposedRule', () => {
  it('FORCES provenance.source "chat" — a worker cannot disguise where the rule came from', () => {
    const out = normalizeProposedRule({
      id: 'POL-9',
      statement: 'x',
      provenance: { source: 'markdown', ref: 'handbook.md#3', source_kinds: ['doc'] },
    }) as unknown as Record<string, unknown>;
    expect(out['provenance']).toEqual({
      source: 'chat',
      ref: 'handbook.md#3', // the rest of the provenance survives
      source_kinds: ['doc'],
    });
  });

  it('synthesizes provenance when the proposal omitted it', () => {
    const out = normalizeProposedRule({ id: 'POL-9', statement: 'x' }) as unknown as Record<
      string,
      unknown
    >;
    expect(out['provenance']).toEqual({ source: 'chat', source_kinds: [] });
  });

  it('stamps the recovered default steering_type only where the rule declares none', () => {
    const bare = normalizeProposedRule({ id: 'POL-9', statement: 'x' }, 'operations') as unknown as
      Record<string, unknown>;
    expect(bare['steering_type']).toBe('operations');
    const declared = normalizeProposedRule(
      { id: 'POL-9', statement: 'x', steering_type: 'security' },
      'operations',
    ) as unknown as Record<string, unknown>;
    expect(declared['steering_type']).toBe('security');
    // No default recovered + none declared ⇒ absent (the engine's serde default applies).
    const neither = normalizeProposedRule({ id: 'POL-9', statement: 'x' }) as unknown as Record<
      string,
      unknown
    >;
    expect('steering_type' in neither).toBe(false);
  });
});

describe('steeringTypeFromProblem', () => {
  it("recovers the type from the author route's preamble", () => {
    expect(
      steeringTypeFromProblem(
        "Author steering rules for the 'operations' steering type (use it as the default steering_type for every proposed rule without a better fit).\n\nOperator intent:\nx",
      ),
    ).toBe('operations');
  });

  it('answers undefined for a hand-launched run or an unknown type', () => {
    expect(steeringTypeFromProblem('codify the deploy rules')).toBeUndefined();
    expect(
      steeringTypeFromProblem("Author steering rules for the 'vibes' steering type ..."),
    ).toBeUndefined();
  });
});

describe('isSteeringAuthorRun', () => {
  const view = (workflowId: string, phaseIds: string[]): SessionView =>
    ({
      session: { id: 'r1', workflow_id: workflowId, status: 'awaiting_human', problem: 'x' },
      units: phaseIds.map((p, i) => ({ id: `r1:${p}`, ord: i + 1 })),
    }) as unknown as SessionView;

  it('matches by the patched definition name', () => {
    expect(isSteeringAuthorRun(view('steering-author', ['analyze', 'propose']), BUILTIN_WORKFLOWS)).toBe(true);
  });

  it("matches a core instance id ('wf-<uuid>') by exact phase sequence", () => {
    expect(isSteeringAuthorRun(view('wf-abc123', ['analyze', 'propose']), BUILTIN_WORKFLOWS)).toBe(true);
  });

  it('never matches another workflow — the legacy gate path stays untouched', () => {
    expect(isSteeringAuthorRun(view('feature', ['clarify', 'design']), BUILTIN_WORKFLOWS)).toBe(false);
    expect(isSteeringAuthorRun(view('wf-abc123', ['gather', 'store']), BUILTIN_WORKFLOWS)).toBe(false);
    expect(isSteeringAuthorRun(view('wf-abc123', ['u1']), BUILTIN_WORKFLOWS)).toBe(false);
  });
});
