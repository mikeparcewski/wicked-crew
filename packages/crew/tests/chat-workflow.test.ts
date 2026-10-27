// crew#1157: which presets a chat may run, and the turn step it builds (src/api/chat-workflow.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Preset } from 'wicked-crew-api-types';

import { verifyCitations } from '../src/api/chat-citations.js';
import { CHAT_WORKFLOWS, chatTurnStep, readOnlyStepRefusal, resolveChatWorkflow, servedChatWorkflows } from '../src/api/chat-workflow.js';

const analyze: Preset = {
  name: 'analyze', scope: 'global', created_by: 'builtin', updated_at: 1,
  steps: [{ catalog: 'understand', id: 'answer', gate: { human_confirm: { unconditional: true } }, skill_ref: 'wicked-garden-search', instructions: 'Answer READ-ONLY, cited.' }],
};
const withStep = (patch: Record<string, unknown>): Preset => ({ ...analyze, steps: [{ ...analyze.steps[0]!, ...patch }] });

describe('chat workflows (crew#1157)', () => {
  it('runs only analyze, only as the built-in read-only one-step preset', () => {
    expect([...CHAT_WORKFLOWS]).toEqual(['analyze']);
    expect(resolveChatWorkflow('analyze', [analyze])).toEqual({
      ok: true, workflow: { name: 'analyze', instructions: 'Answer READ-ONLY, cited.', skillRef: 'wicked-garden-search' },
    });
    expect(resolveChatWorkflow('feature', [analyze])).toMatchObject({ ok: false, status: 400 });
    expect(resolveChatWorkflow('analyze', [])).toMatchObject({ ok: false, status: 409 });
    expect(resolveChatWorkflow('analyze', [{ ...analyze, scope: 'project:p1' }])).toMatchObject({ ok: false, status: 409 });
    expect(resolveChatWorkflow('analyze', [{ ...analyze, created_by: 'api' }])).toMatchObject({ ok: false, status: 409 });
    expect(resolveChatWorkflow('analyze', [{ ...analyze, steps: [analyze.steps[0]!, { catalog: 'build', id: 'b' }] }])).toMatchObject({ ok: false, status: 409 });
  });

  it.each([
    [{ catalog: 'build' }, /not 'understand'/],
    [{ catalog: 'produce' }, /not 'understand'/],
    [{ executor: { type: 'tool', cmd: ['sh', '-c', 'echo > x'] } }, /executor/],
    [{ executes_code: true }, /executes code/],
    [{ required_deliverables: ['out.md'] }, /deliverables/],
    [{ instructions: '' }, /no instructions/],
  ])('refuses a step that could write or says nothing: %j', (patch, why) => {
    expect(readOnlyStepRefusal({ ...analyze.steps[0]!, ...patch })).toMatch(why);
    expect(resolveChatWorkflow('analyze', [withStep(patch)])).toMatchObject({ ok: false, status: 409 });
  });

  it('serves what the engine carries', () => {
    expect(servedChatWorkflows([analyze])).toEqual(['analyze']);
    expect(servedChatWorkflows([])).toEqual([]);
    expect(servedChatWorkflows([withStep({ catalog: 'build' })])).toEqual([]);
  });

  it('a turn is the ask path\'s answer step with the workflow\'s skill and instructions first', () => {
    const r = resolveChatWorkflow('analyze', [analyze]);
    if (!r.ok) throw new Error('resolves');
    expect(chatTurnStep('answer-3', '# Chat scope\n\nQ?', r.workflow)).toEqual({
      catalog: 'understand', id: 'answer-3', gate: { human_confirm: { unconditional: true } }, budget_secs: 600,
      instructions: 'Answer READ-ONLY, cited.\n\n# Chat scope\n\nQ?', skill_ref: 'wicked-garden-search',
    });
    expect(chatTurnStep('answer-1', 'Q?')).not.toHaveProperty('skill_ref');
  });
});

// The answer form `analyze` asks for (`<repo>/<path>:<line>`, a symbol before its line ref) is the
// form the chat's citation check verifies: a cited answer over a small fixture repository.
describe('an analyze answer over a small fixture repository is cited and checkable', () => {
  let root = '';
  afterEach(() => { if (root !== '') rmSync(root, { recursive: true, force: true }); });

  it('verifies the file:line and symbol citations, and marks an invented one', async () => {
    root = mkdtempSync(join(tmpdir(), 'analyze-fixture-'));
    const repo = join(root, 'alpha');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'auth.ts'), 'import { hash } from "./hash";\n\nexport function signIn(user: string) {\n  return hash(user);\n}\n');
    writeFileSync(join(repo, 'src', 'hash.ts'), 'export function hash(s: string) {\n  return s.length;\n}\n');
    const answer = [
      'Sign-in hashes the user name and returns it.',
      '',
      '- `signIn` is defined at `alpha/src/auth.ts:3` and calls `hash` (graph path: `signIn -> hash`).',
      '- `hash` is at `alpha/src/hash.ts:1`.',
      '- A session store at `alpha/src/session.ts:9` (not grounded).',
    ].join('\n');
    const result = await verifyCitations(answer, [{ absRoot: repo, name: 'alpha' }]);
    const byRaw = Object.fromEntries(result.items.map((i) => [i.raw, i.status]));
    expect(byRaw['alpha/src/auth.ts:3']).toBe('verified');
    expect(byRaw['alpha/src/hash.ts:1']).toBe('verified');
    expect(byRaw['alpha/src/session.ts:9']).toBe('unverified');
    expect(result.verified).toBeGreaterThanOrEqual(2);
  });

  // xreview on #1160 (codex P2): a bare symbol or graph path is not something the check can verify,
  // so the analyze instructions require the file and line beside every one (core#1136). Pinned here:
  // the bare forms yield nothing to verify, a symbol named before its line ref is checked against
  // that line, and a symbol on the wrong line is caught.
  it('a symbol rides with its file:line, which is what gets checked', async () => {
    root = mkdtempSync(join(tmpdir(), 'analyze-fixture-'));
    const repo = join(root, 'alpha');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'auth.ts'), 'import { hash } from "./hash";\n\nexport function signIn(user: string) {\n  return hash(user);\n}\n');
    const roots = [{ absRoot: repo, name: 'alpha' }];
    expect((await verifyCitations('It is `alpha::signIn`, via `signIn -> hash`.', roots)).items).toEqual([]);
    const right = await verifyCitations('`signIn` at `alpha/src/auth.ts:3`', roots);
    expect(right.items.find((i) => i.raw.includes('auth.ts:3'))?.status).toBe('verified');
    const wrong = await verifyCitations('`signIn` at `alpha/src/auth.ts:1`', roots);
    expect(wrong.items.find((i) => i.raw.includes('auth.ts:1'))?.status).not.toBe('verified');
  });
});
