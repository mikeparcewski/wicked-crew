// DC-S4a — the deterministic derivation's golden table (DES-decision-capture §4.4 / §8: ≥ 60 cases).
//
// Auto is decided from facts the model cannot set (human actor, auth=required, typed words, a
// T1/T2 template passing D and G, a known project, no redaction, no approval, no restatement or
// conflict). Model labels only add offers or turn an auto into a question (`maybe-restated`).

import { describe, expect, it } from 'vitest';

import { contentWords, deriveDecision, ruleKey, scrubWords, steeringTypeOf, type DeriveInput } from '../src/decisions/derive.js';

const P = 'kestrel';
const base = (words: string, over: Partial<DeriveInput> = {}): DeriveInput => ({
  words,
  actorKind: 'human',
  authMode: 'required',
  wordsSource: 'typed',
  projectId: P,
  inForce: [],
  now: 1_000,
  ...over,
});

type Row = [words: string, route: string, template: string | null, statement?: string | null];

// Under auth=required, a human, typed, in project P, nothing in force.
const GOLDEN: Row[] = [
  // T1 always → auto
  ["from now on, always check the payment provider's records", 'auto', 'T1-always', "Always check the payment provider's records."],
  ['always run the repo checks before a walkthrough', 'auto', 'T1-always', 'Always run the repo checks before a walkthrough.'],
  ["From now on, always run the repo's checks before a walkthrough", 'auto', 'T1-always', "Always run the repo's checks before a walkthrough."],
  ['We should always cite the failing test in the PR body', 'auto', 'T1-always', 'Always cite the failing test in the PR body.'],
  ['please always attach screenshots to UI changes', 'auto', 'T1-always', 'Always attach screenshots to UI changes.'],
  ['going forward, always pin the gh account before pushing', 'auto', 'T1-always', 'Always pin the gh account before pushing.'],
  ['every time, record the take beside its proof file', 'auto', 'T1-always', 'Always record the take beside its proof file.'],
  ['run lint on changed files every time', 'auto', 'T1-always', 'Always run lint on changed files.'],
  ['Always squash WIP commits before opening the PR.', 'auto', 'T1-always', 'Always squash WIP commits before opening the PR.'],
  ['always label held pull requests clearly', 'auto', 'T1-always'],
  // T2 never → auto
  ['never push straight to the default branch', 'auto', 'T2-never', 'Never push straight to the default branch.'],
  ['from now on, never merge a PR before CI is green', 'auto', 'T2-never', 'Never merge a PR before CI is green.'],
  ["don't ever print tokens in the run logs", 'auto', 'T2-never', 'Never print tokens in the run logs.'],
  ['do not ever delete the frozen brain archive', 'auto', 'T2-never', 'Never delete the frozen brain archive.'],
  ['from now on, do not mock the payment provider in walkthroughs', 'auto', 'T2-never', 'Never mock the payment provider in walkthroughs.'],
  ["going forward, don't skip the review gate on payments code", 'auto', 'T2-never', 'Never skip the review gate on payments code.'],
  ['from now on, stop writing report files into the repo root', 'auto', 'T2-never', 'Stop writing report files into the repo root.'],
  ['we must never merge on a red main', 'auto', 'T2-never', 'Never merge on a red main.'],
  // T3 before → offer
  ['fix blocking bugs before testing further', 'offer', 'T3-before', 'Fix blocking bugs before testing further.'],
  ['rebase onto main before requesting review', 'offer', 'T3-before', 'Rebase onto main before requesting review.'],
  ['run the full suite locally before tagging a release', 'offer', 'T3-before'],
  // T4 prefer → offer
  ['prefer small focused PRs over large batches', 'offer', 'T4-prefer', 'Prefer small focused PRs over large batches.'],
  ['use the estate graph instead of grep for blast radius', 'offer', 'T4-prefer', 'Prefer the estate graph over grep for blast radius.'],
  ['favour plain words over engine jargon on the desk', 'offer', 'T4-prefer'],
  // T5 must / should / do not → offer
  ['the deliver card should name the branch and the remote', 'offer', 'T5-must', 'The deliver card should name the branch and the remote.'],
  ['every walkthrough must show the provider records', 'offer', 'T5-must'],
  ['releases have to wait for green main CI', 'offer', 'T5-must'],
  ['do not reuse the operator rig for proofs', 'offer', 'T5-must', 'Do not reuse the operator rig for proofs.'],
  ["captions shouldn't show raw engine prompts", 'offer', 'T5-must'],
  // T6 only → offer
  ['only merge after codex adjudication passes', 'offer', 'T6-only', 'Only merge after codex adjudication passes.'],
  ['only use scratch repos in the demo reel', 'offer', 'T6-only'],
  // in your words (standing opener, no template) → offer
  ['from now on, checkout should feel calmer and slower', 'offer', 'T5-must'],
  ['going forward, payments changes get a second reviewer seat', 'offer', 'in-your-words', 'Payments changes get a second reviewer seat.'],
  ['as a rule, screenshots accompany every studio pull request', 'offer', 'in-your-words'],
  // exclusions → ledger
  ['never mind, skip that for now', 'ledger', null],
  ['Always?', 'ledger', null],
  ['does this always happen?', 'ledger', null],
  ['never again in this session', 'ledger', null],
  ['always run the checks for now', 'ledger', null],
  ['skip the walkthrough this time', 'ledger', null],
  ['just this once, push without the screenshots', 'ledger', null],
  ['should we always run the full suite', 'ledger', null],
  ['why does the desk never show the bell', 'ledger', null],
  ['from now on, always', 'ledger', null],
  ['from now on fix it', 'ledger', null],
  ['for this one, never squash', 'ledger', null],
  ['today never deploy after five', 'ledger', null],
  // not rule-shaped → ledger
  ['looks good, ship it', 'ledger', null],
  ['lets do it', 'ledger', null],
  ['thanks', 'ledger', null],
  ['the second option', 'ledger', null],
  ['please retry the codex seat', 'ledger', null],
  ['ok', 'ledger', null],
  // G fails (fewer than 3 content words) → ledger
  ['always test', 'ledger', 'T1-always'],
  ['never push', 'ledger', 'T2-never'],
  ['always fix v1.2.3 in src/foo.ts', 'ledger', 'T1-always'],
  ['never use ghp-abcdef1234 https://x.y/z', 'ledger', 'T2-never'],
  ['fix it before merging', 'ledger', 'T3-before'],
  ['prefer tabs', 'ledger', 'T4-prefer'],
  ['only main', 'ledger', 'T6-only'],
];

describe('deriveDecision — the golden table (auth=required, human, typed, project known)', () => {
  it(`has at least 60 cases (${GOLDEN.length})`, () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(60);
  });
  for (const [words, route, template, statement] of GOLDEN) {
    it(`${JSON.stringify(words)} → ${route}${template !== null ? ` (${template})` : ''}`, () => {
      const d = deriveDecision(base(words));
      expect(d.route, JSON.stringify(d)).toBe(route);
      expect(d.template).toBe(template);
      if (statement !== undefined) expect(d.statement).toBe(statement);
    });
  }
});

describe('deriveDecision — auto needs facts the model cannot set', () => {
  const rule = 'from now on, always check the payment provider\'s records';
  it('an auto case with auth_mode off routes to offer (never auto under auth=off)', () => {
    expect(deriveDecision(base(rule, { authMode: 'off' })).route).toBe('offer');
  });
  it('a gate-note "always X" with no model labels routes to auto under required', () => {
    const d = deriveDecision(base('always run the repo checks before a walkthrough'));
    expect(d.route).toBe('auto');
    expect(d.dgc).toEqual({ durable: true, general: true, checkable: true });
  });
  it('no project → no auto; the chip asks (offer, scope everywhere)', () => {
    const d = deriveDecision(base(rule, { projectId: null }));
    expect(d.route).toBe('offer');
    expect(d.scope).toBe('everywhere');
  });
  it('a non-human actor never autos', () => {
    expect(deriveDecision(base(rule, { actorKind: 'agent' })).route).toBe('offer');
    expect(deriveDecision(base(rule, { actorKind: 'system' })).route).toBe('offer');
  });
  it('words not typed by the operator (files, a CLI transcript) never auto', () => {
    expect(deriveDecision(base(rule, { wordsSource: 'operator-files' })).route).toBe('offer');
    expect(deriveDecision(base(rule, { wordsSource: 'cli-transcript' })).route).toBe('offer');
  });
  it('an approval of a proposal never autos (B6)', () => {
    const labels = { is_decision: true, type: 'rule' as const, codify: true, ambiguous: false, steering_type: 'testing' as const, approves_proposal: true, recorder: 'claude' };
    expect(deriveDecision(base(rule, { labels })).route).toBe('offer');
  });
  it('redacted words never auto, and the stored copy is masked', () => {
    const d = deriveDecision(base('always rotate the key token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 every release cycle'));
    expect(d.redacted).toBe(true);
    expect(d.words).not.toContain('ghp_');
    expect(d.route).toBe('offer');
  });
  it('`same_as` naming an in-force rule turns auto into maybe-restated (never a silent swallow)', () => {
    const inForce = [{ id: 'proposal:p9', statement: 'Always look at the provider ledger.', project: P }];
    const labels = { is_decision: true, type: 'rule' as const, codify: true, ambiguous: false, steering_type: 'testing' as const, same_as: 'proposal:p9', recorder: 'claude' };
    const d = deriveDecision(base(rule, { inForce, labels }));
    expect(d.route).toBe('maybe-restated');
    expect(d.rule_ref).toBe('proposal:p9');
  });
  it('`same_as` naming a rule that is NOT in force is ignored', () => {
    const labels = { is_decision: true, type: 'rule' as const, codify: true, ambiguous: false, steering_type: 'testing' as const, same_as: 'proposal:nope', recorder: 'claude' };
    expect(deriveDecision(base(rule, { labels })).route).toBe('auto');
  });
});

describe('deriveDecision — restated, conflict, recurrence, scope', () => {
  it('the exact key of an in-force rule in this project → restated (B7), no rule', () => {
    const inForce = [{ id: 'proposal:p1', statement: "Always check the payment provider's records.", project: P }];
    const d = deriveDecision(base("always check the payment provider's records", { inForce }));
    expect(d.route).toBe('restated');
    expect(d.rule_ref).toBe('proposal:p1');
  });
  it('a global in-force rule also restates', () => {
    const inForce = [{ id: 'proposal:g1', statement: 'Never push straight to the default branch.' }];
    expect(deriveDecision(base('never push straight to the default branch', { inForce })).route).toBe('restated');
  });
  it("another project's rule does not restate (a project rule never applies elsewhere)", () => {
    const inForce = [{ id: 'proposal:p1', statement: "Always check the payment provider's records.", project: 'other' }];
    expect(deriveDecision(base("always check the payment provider's records", { inForce })).route).toBe('auto');
  });
  it('same subject, opposite polarity → conflict (a chip, never auto)', () => {
    const inForce = [{ id: 'proposal:p2', statement: 'Always mock the payment provider in walkthroughs.', project: P }];
    const d = deriveDecision(base('never mock the payment provider in walkthroughs', { inForce }));
    expect(d.route).toBe('conflict');
    expect(d.rule_ref).toBe('proposal:p2');
  });
  it('recurrence comes from the ledger index', () => {
    const d = deriveDecision(base('always run the repo checks before a walkthrough', {
      recurrence: () => ({ count: 2, first_at: 5, projects: ['a', 'b'] }),
    }));
    expect(d.recurrence).toEqual({ count: 2, first_at: 5, projects: ['a', 'b'] });
  });
  it('the key is template|polarity|sorted content words — exact, so word order does not matter', () => {
    const a = deriveDecision(base('always run the repo checks before a walkthrough')).key;
    const b = deriveDecision(base('always run before a walkthrough the repo checks')).key;
    expect(a).toBe(b);
    expect(a).toBe('T1-always|do|checks repo run walkthrough');
  });
  it('ruleKey reads a stored statement back to the same key', () => {
    const d = deriveDecision(base("from now on, always check the payment provider's records"));
    expect(ruleKey(d.statement!)?.key).toBe(d.key);
  });
  it('the model offer arm: type rule ∧ codify ∧ D ∧ G ∧ (C ∨ R) on words no template shapes', () => {
    const labels = { is_decision: true, type: 'rule' as const, codify: true, ambiguous: false, steering_type: 'design-ux' as const, recorder: 'claude' };
    // No template → not durable by the deterministic rule → the model alone cannot make it an offer.
    expect(deriveDecision(base('looks good, ship it', { labels })).route).toBe('ledger');
  });
});

describe('helpers', () => {
  it('contentWords strips ids, URLs, SHAs, paths and versions', () => {
    expect(contentWords('fix #123 in src/a/b.ts at v1.2.3 per https://x.io/y and abcdef1234567 now')).toEqual(['fix']);
  });
  it('scrubWords masks secrets and emails', () => {
    expect(scrubWords('mail me at someone@example.com').redacted).toBe(true);
    expect(scrubWords('nothing secret here').redacted).toBe(false);
  });
  it('steeringTypeOf picks the steering page deterministically', () => {
    expect(steeringTypeOf('Always run the repo checks before a walkthrough.')).toBe('testing');
    expect(steeringTypeOf('Never print tokens in the run logs.')).toBe('security');
    expect(steeringTypeOf('Never push straight to the default branch.')).toBe('development');
    expect(steeringTypeOf('Checkout should feel calmer.')).toBe('design-ux');
  });
});
