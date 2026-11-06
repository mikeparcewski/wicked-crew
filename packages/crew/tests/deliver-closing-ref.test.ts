// e2e-1105 F4 (crew 0.17.0, runs e56eb6b5 + 9d3e4238): a bug job whose intent says "Fix <repo> issue #N" could not be
// delivered. Deliver composed "Refs: #1 / Refs are not closed by this PR", the deferred rule learn-linked-issue judged
// that text BROKEN, and nothing at the gate could change the closing line.
//
//  - "<verb> [the] <delivery repo> issue|bug #N" is a closing reference; another repo's or any other word's is not;
//  - a negated verb ("does not fix #1") never closes, and a mention ("see #1", "(tiny-math issue #1)") stays Refs;
//  - the person's note at the deliver gate (an `amend` ruling on the deliver unit) corrects the closing line.
import { describe, expect, it } from 'vitest';
import { composeDeliverText, deliveryNotesOf, factsFromRun, issueRefs, rulesSummaryLine } from '../src/core/deliver-text.js';
import type { SessionView, WorkUnit } from '../src/core/types.js';

/** The exact intent of run e56eb6b5 (the job-title form studio uses for an issue). */
const F4_INTENT =
  'Fix tiny-math issue #1: sum() in src/math.js skips the first element, so sum([1,2,3]) returns 5 instead of 6. Fix sum() so the tests in test/math.test.js pass. Keep the change minimal.';

describe('F4: "Fix <repo> issue #N" closes the issue in the delivery repo', () => {
  it('the exact e56eb6b5 intent says Fixes #1, with no Refs line', () => {
    expect(issueRefs(F4_INTENT, 'tiny-math')).toEqual({ fixes: ['#1'], refs: [] });
  });

  it('composes "Fixes #1" and never the not-closed disclaimer for it', () => {
    const run = view(F4_INTENT, []);
    const { body } = composeDeliverText(factsFromRun(run, null));
    expect(body).toContain('\nFixes #1\n');
    expect(body).not.toContain('Refs: #1');
    expect(body).not.toContain('Refs are not closed');
  });

  it.each([
    ['Fix the tiny-math issue #1', ['#1']],
    ['Fixes tiny-math bug #3 and #4', ['#3', '#4']],
    // An owner-qualified spelling closes that exact issue, as `owner/repo#N` always did (never this repo's bare #N).
    ['Closes mikeparcewski/tiny-math issue #2', ['mikeparcewski/tiny-math#2']],
    ['Fix rival/tiny-math issue #1', ['rival/tiny-math#1']],
    ['resolve Tiny-Math issues #5, #6', ['#5', '#6']],
    ['Fix tiny-math issue: #7', ['#7']],
    ['fix the issue #8', ['#8']],
    ['This not only fixes #9 but also the docs', ['#9']],
    // A negation in an earlier sentence or line does not reach the verb.
    ['the archive controls never render\n\nfix issue #10', ['#10']],
    ['It never rendered. Fix #11', ['#11']],
  ])('%s closes %j', (intent, fixes) => {
    expect(issueRefs(intent, 'tiny-math').fixes).toEqual(fixes);
  });

  it.each([
    // Another repository's #1 is not this repository's #1.
    ['Fix other-repo issue #1', 'tiny-math'],
    ['Fix owner/other-repo issue #1', 'tiny-math'],
    // A word that is not the delivery repo's name.
    ['Fix login issue #1', 'tiny-math'],
    ['Fix my-tiny-math issue #1', 'tiny-math'],
    // No delivery repo known: nothing to compare the word with.
    ['Fix tiny-math issue #1', null],
  ])('%s (repo %s) closes nothing', (intent, repo) => {
    expect(issueRefs(intent, repo).fixes).toEqual([]);
  });

  it.each([
    'see #1',
    'refs #1',
    'Related to tiny-math issue #1',
    // Run 9d3e4238's wording: the issue named, no closing verb on it.
    'In tiny-math, sum([1,2,3]) returns 5 instead of 6 (tiny-math issue #1). Fix sum() and add a test.',
    'This does not fix #1',
    "Don't close #1 yet",
    'it never resolves tiny-math issue #1',
    'This won’t fix #1',
    'This is not going to close #1',
    'Cannot fix tiny-math issue #1',
    'Do not\nclose tiny-math issue #1',
    'This does not, in this PR, close #1',
    "This won't, however, fix #1",
    'does not in any way fix #1',
    'do not under any circumstances close #1',
    'This PR will neither fix tiny-math issue #1 nor address the related problem.',
    'Do not, e.g. fix tiny-math issue #1.',
  ])('a mention or a negated verb stays Refs: %s', (intent) => {
    expect(issueRefs(intent, 'tiny-math')).toEqual({ fixes: [], refs: ['#1'] });
  });

  it('a negated verb in the same intent wins over a closing one for that ref only', () => {
    expect(issueRefs('Fix #1 and #2. This does not close #2.', 'tiny-math')).toEqual({ fixes: ['#1'], refs: ['#2'] });
  });
});

describe('F4c: the person’s note at the deliver gate corrects the closing line', () => {
  const NOTE = 'Operator ruling: this pull request fixes and closes issue #1 (the intent says Fix tiny-math issue #1). Say Fixes #1 in the description.';

  it('a note that says the PR closes #1 makes it Fixes #1, said as the person’s word', () => {
    const intent = 'In tiny-math, sum() is wrong (tiny-math issue #1). Fix sum().';
    const run = view(intent, [ruling('amend', NOTE, 10)]);
    const facts = factsFromRun(run, null);
    expect(facts.deliveryNotes).toEqual([NOTE]);
    const { body } = composeDeliverText(facts);
    expect(body).toContain('\nFixes #1\n');
    expect(body).toContain('#1 closed on the word of the person who answered the deliver gate');
    expect(body).not.toContain('Refs: #1');
    // The note's own words are not published.
    expect(body).not.toContain('Operator ruling');
  });

  it('a negated or quoted closing in a note closes nothing; a note cannot un-close what the intent closes', () => {
    const intent = 'see #1 and #2';
    expect(issueRefs(intent, 'tiny-math', ['Do not close #1, the fix is partial'])).toEqual({ fixes: [], refs: ['#1', '#2'] });
    expect(issueRefs(intent, 'tiny-math', ['The seat says "Fixes #1"; that is wrong.', 'it wrote `closes #2`'])).toEqual({ fixes: [], refs: ['#1', '#2'] });
    // The intent's own "Fix tiny-math issue #1" is published in the body: a note cannot take that back.
    expect(issueRefs(F4_INTENT, 'tiny-math', ['do not close #1']).fixes).toEqual(['#1']);
    // Fenced code, a `>` quote and a quote across lines are quoted words too.
    for (const note of [
      'The seat wrote this, which is wrong:\n```text\nFixes #1\n```',
      '> Fixes #1\n\nthat line is wrong',
      'it said "this\nfixes #1" and it does not',
      'The seat wrote \u2018Fixes #1\u2019; that is false.',
      'The seat wrote:\n\n    Fixes #1\n\nThat is false.',
      'The seat wrote:\n> This PR\nfixes #1\n\nThat is false.',
      // A negation far back in the same clause, and one in the same note as a closing line.
      `We cannot, ${'for reasons the triage and the review set out at length, '.repeat(4)}close #1.`,
      'Fix #1. This PR must not close #1.',
    ]) {
      expect(issueRefs('see #1', 'tiny-math', [note])).toEqual({ fixes: [], refs: ['#1'] });
    }
  });

  it('a note that closes what the intent negated is said as the person’s word', () => {
    const r = issueRefs('Fix tiny-math issue #1. This must not close tiny-math issue #1.', 'tiny-math', ['This PR closes #1']);
    expect(r).toEqual({ fixes: ['#1'], refs: [], byNote: ['#1'] });
  });

  it('notes are read oldest first across every deliver unit', () => {
    const units = [unit('deliver', 'deliver', [ruling('amend', 'second', 20)]), { ...unit('step-9', 'deliver', [ruling('amend', 'first', 10)]), catalog: 'deliver' } as WorkUnit];
    expect(deliveryNotesOf(units)).toEqual(['first', 'second']);
  });

  it('a skip the person asked at the deliver gate is named in the PR text that runs after it, its reason left on the run record', () => {
    const run = view(F4_INTENT, []);
    (run.units[1] as unknown as Record<string, unknown>)['rule_skips'] = [
      { ruleId: 'learn-linked-issue', reason: 'The evaluator wrote "Fixes #99"; checked by hand', ruleKey: 'k', evidenceKey: 'e', by: 'local', at: 1 },
      { ruleId: 'retired-rule', reason: 'x'.repeat(300), ruleKey: '', evidenceKey: 'e', by: 'local', at: 2 },
    ];
    (run.units[0] as unknown as Record<string, unknown>)['rule_skips'] = [
      { ruleId: 'delivery/linked issue', reason: 'r', ruleKey: '', evidenceKey: 'e', by: 'local', at: 3 },
      { ruleId: 'x'.repeat(120), reason: 'r', ruleKey: '', evidenceKey: 'e', by: 'local', at: 4 },
    ];
    const { body } = composeDeliverText(factsFromRun(run, null));
    expect(body).toContain(
      `Steering rules the person asked to skip at a gate, each with a written reason on the run record: \`delivery/linked issue\`, \`${'x'.repeat(120)}\`, \`learn-linked-issue\`, \`retired-rule\`.`,
    );
    // The reasons stay on the run record: free text in the PR could carry a closing keyword.
    expect(body).not.toContain('#99');
  });

  it('a skip reason on an earlier receipt never publishes a #N reference', () => {
    expect(rulesSummaryLine([{ ruleId: 'learn-linked-issue', status: 'skipped', reason: 'skipped by local: The evaluator wrote "Fixes #99"' }])).toContain('"Fixes # 99"');
  });

  it('reads only the person’s amend rulings on the deliver unit', () => {
    const units = [
      unit('fix', 'build', [ruling('amend', 'fixes #9', 1)]),
      unit('deliver', 'deliver', [ruling('request_changes', 'fixes #8', 2), ruling('judge', 'fixes #7', 3), ruling('amend', '  ', 4)]),
    ];
    expect(deliveryNotesOf(units)).toEqual([]);
    // The deliver unit is found by its catalog id too (a catalog-composed plan).
    expect(deliveryNotesOf([{ ...unit('step-7', 'deliver', [ruling('amend', 'fixes #6', 5)]), catalog: 'deliver' } as WorkUnit])).toEqual(['fixes #6']);
  });

  it('a note closing another repository’s issue closes nothing here', () => {
    expect(issueRefs('Fix sum()', 'tiny-math', ['fixes owner/other#1', 'Fix other-repo issue #2'])).toEqual({ fixes: [], refs: [] });
  });
});

function ruling(action: string, text: string, at: number): { action: string; text: string; attempt: number; at: number } {
  return { action, text, attempt: 0, at };
}

function unit(phase: string, stage: string, rulings: unknown[]): WorkUnit {
  return {
    id: `run-f4:${phase}`,
    session_id: 'run-f4',
    ord: phase === 'deliver' ? 7 : 4,
    description: phase,
    stage,
    status: 'done',
    operator_rulings: rulings,
  } as unknown as WorkUnit;
}

function view(problem: string, deliverRulings: unknown[]): SessionView {
  return {
    session: { id: 'run-f4', status: 'awaiting_human', problem, repo_ref: 'tiny-math', workflow_id: 'bug' },
    units: [unit('fix', 'build', []), unit('deliver', 'deliver', deliverRulings)],
  } as unknown as SessionView;
}
