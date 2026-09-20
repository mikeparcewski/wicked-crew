// Behavioral contract for #621: interactive-draft conformance floors.
//
// Pins three things:
//  1. withDraftFloors applies outlinePin / draftPin to the correct phases without mutating
//     the shared def or touching unrelated phases.
//  2. OUTLINE_NO_HTML_RULE's statement encodes the three HTML patterns and the char cap.
//  3. A derived check function — matching the statement's logic — correctly classifies
//     outline outputs (reject HTML, reject overlength, pass plain outlines).

import { describe, expect, it } from 'vitest';
import {
  DRAFT_SELF_CHECK_RULE,
  OUTLINE_MAX_CHARS,
  OUTLINE_NO_HTML_RULE,
  withDraftFloors,
} from '../src/interactive/draft-skill.js';
import type { WorkflowDef } from '../src/core/types.js';

// ─── minimal workflow fixture ─────────────────────────────────────────────────

const BASE_DEF: WorkflowDef = {
  id: 'test-draft',
  name: 'test-draft',
  phases: [
    { id: 'outline', name: 'outline', task: 'plan', model: 'fast', entity_mode: 'shared' },
    { id: 'draft', name: 'draft', task: 'write', model: 'full', entity_mode: 'shared' },
    { id: 'review', name: 'review', task: 'check', model: 'fast', entity_mode: 'shared' },
  ],
} as unknown as WorkflowDef;

// ─── 1. withDraftFloors ───────────────────────────────────────────────────────

describe('withDraftFloors', () => {
  it('returns the same reference when both pins are null', () => {
    expect(withDraftFloors(BASE_DEF, null, null)).toBe(BASE_DEF);
  });

  it('applies outlinePin to the outline phase only', () => {
    const result = withDraftFloors(BASE_DEF, 'outline-hash', null);
    const outline = result.phases.find((p) => p.id === 'outline')!;
    const draft = result.phases.find((p) => p.id === 'draft')!;
    const review = result.phases.find((p) => p.id === 'review')!;
    expect((outline as unknown as Record<string, unknown>)['validator_pin']).toBe('outline-hash');
    expect((draft as unknown as Record<string, unknown>)['validator_pin']).toBeUndefined();
    expect((review as unknown as Record<string, unknown>)['validator_pin']).toBeUndefined();
  });

  it('applies draftPin to the draft phase only', () => {
    const result = withDraftFloors(BASE_DEF, null, 'draft-hash');
    const outline = result.phases.find((p) => p.id === 'outline')!;
    const draft = result.phases.find((p) => p.id === 'draft')!;
    expect((outline as unknown as Record<string, unknown>)['validator_pin']).toBeUndefined();
    expect((draft as unknown as Record<string, unknown>)['validator_pin']).toBe('draft-hash');
  });

  it('applies both pins when both are provided', () => {
    const result = withDraftFloors(BASE_DEF, 'o-hash', 'd-hash');
    const outline = result.phases.find((p) => p.id === 'outline')!;
    const draft = result.phases.find((p) => p.id === 'draft')!;
    expect((outline as unknown as Record<string, unknown>)['validator_pin']).toBe('o-hash');
    expect((draft as unknown as Record<string, unknown>)['validator_pin']).toBe('d-hash');
  });

  it('does not mutate BASE_DEF (shared constant safety)', () => {
    withDraftFloors(BASE_DEF, 'x', 'y');
    expect(BASE_DEF.phases.every((p) => !('validator_pin' in p))).toBe(true);
  });

  it('preserves all phases including unrelated ones', () => {
    const result = withDraftFloors(BASE_DEF, 'o', null);
    expect(result.phases).toHaveLength(3);
    expect(result.phases.find((p) => p.id === 'review')).toBeDefined();
  });
});

// ─── 2. OUTLINE_NO_HTML_RULE content ─────────────────────────────────────────

describe('OUTLINE_NO_HTML_RULE', () => {
  it('has a stable id in the crew:interactive-draft namespace', () => {
    expect(OUTLINE_NO_HTML_RULE.id).toBe('crew:interactive-draft/outline/no-html');
  });

  it('is a policy rule with error severity', () => {
    expect(OUTLINE_NO_HTML_RULE.rule_type).toBe('policy');
    expect(OUTLINE_NO_HTML_RULE.severity).toBe('error');
    expect(OUTLINE_NO_HTML_RULE.confidence).toBe(1.0);
  });

  it('statement mentions the three disallowed HTML patterns', () => {
    const stmt = OUTLINE_NO_HTML_RULE.statement;
    expect(stmt).toMatch(/<html>/);
    expect(stmt).toMatch(/<!DOCTYPE>/i);
    expect(stmt).toMatch(/<body>/);
  });

  it(`statement mentions the ${OUTLINE_MAX_CHARS.toLocaleString()}-character cap`, () => {
    expect(OUTLINE_NO_HTML_RULE.statement).toContain(OUTLINE_MAX_CHARS.toLocaleString());
  });
});

// ─── 3. DRAFT_SELF_CHECK_RULE content ────────────────────────────────────────

describe('DRAFT_SELF_CHECK_RULE', () => {
  it('has a stable id in the crew:interactive-draft namespace', () => {
    expect(DRAFT_SELF_CHECK_RULE.id).toBe('crew:interactive-draft/draft/self-check');
  });

  it('is a policy rule with error severity', () => {
    expect(DRAFT_SELF_CHECK_RULE.rule_type).toBe('policy');
    expect(DRAFT_SELF_CHECK_RULE.severity).toBe('error');
  });

  it('statement references PASS and self-check', () => {
    const stmt = DRAFT_SELF_CHECK_RULE.statement.toLowerCase();
    expect(stmt).toMatch(/self-check|self_check/);
    expect(stmt).toContain('pass');
  });
});

// ─── 4. Behavioral check derived from OUTLINE_NO_HTML_RULE.statement ─────────
//
// The engine applies the conformance rule at runtime; these tests verify that the
// logic described in the statement (which the engine evaluates) correctly classifies
// outline outputs — HTML patterns and overlength are rejected, plain outlines pass.

function violatesOutlineFloor(output: string): boolean {
  return /<html[\s>]|<!DOCTYPE|<body[\s>]/i.test(output) || output.length > OUTLINE_MAX_CHARS;
}

describe('outline floor check (derived from OUTLINE_NO_HTML_RULE statement)', () => {
  it('rejects output containing <html>', () => {
    expect(violatesOutlineFloor('<html><head></head><body>content</body></html>')).toBe(true);
  });

  it('rejects output containing <!DOCTYPE', () => {
    expect(violatesOutlineFloor('<!DOCTYPE html><html></html>')).toBe(true);
  });

  it('rejects output containing <body>', () => {
    expect(violatesOutlineFloor('<body>hello</body>')).toBe(true);
  });

  it('rejects output exceeding OUTLINE_MAX_CHARS', () => {
    expect(violatesOutlineFloor('a'.repeat(OUTLINE_MAX_CHARS + 1))).toBe(true);
  });

  it('passes a plain text outline', () => {
    const plain = '# Outline\n\n1. Introduction\n2. Methods\n3. Conclusion';
    expect(violatesOutlineFloor(plain)).toBe(false);
  });

  it('passes output exactly at the char cap', () => {
    expect(violatesOutlineFloor('a'.repeat(OUTLINE_MAX_CHARS))).toBe(false);
  });

  it('does not reject inline code containing the word body (no angle brackets)', () => {
    expect(violatesOutlineFloor('Describe the body of the document here.')).toBe(false);
  });
});
