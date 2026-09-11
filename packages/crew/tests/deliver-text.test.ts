// crew#524 (acceptance finding F-3R2-014) — the deliver phase's PR title/body and commit message
// are COMPOSED FROM THE RUN, never `gh pr create --fill`.
//
// The finding: wicked-studio#249 opened with title `wicked-crew run d74e4e8f-…: Found by the
// seed-surfaces suite (wicked-studio#211, scenario CLN-2) aga` (the intent cut mid-word at 72
// characters behind a 50-character prefix), an EMPTY body, no `Fixes #214`, no run link, nothing
// about what ran — and the commit carried the same truncated headline. These tests pin the
// composer (`core/deliver-text.ts`) on that exact intent and on a run view shaped like the
// persisted record of that run, plus the launch-time fallback and the framing both carriers share.

import { describe, expect, it } from 'vitest';
import {
  DELIVER_TITLE_MAX,
  composeDeliverText,
  deliverTitle,
  factsFromRun,
  factsFromWorkflow,
  framedDeliverText,
  gateLabel,
  issueRefs,
  parseFramedDeliverText,
  runUrlFor,
  urlPathSegment,
} from '../src/core/deliver-text.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { SessionView, WorkUnit } from '../src/core/types.js';

const RUN_ID = 'd74e4e8f-bbc9-4697-8c30-181bae005217';

/** The intent of run d74e4e8f verbatim (phase3-r2 evidence `01-intent.txt`). */
const INTENT = [
  'Found by the seed-surfaces suite (wicked-studio#211, scenario CLN-2) against a disposable wicked-crew 0.7.25 daemon.',
  '',
  '**Observed:** `ProjectDetailPage` (the page that carries Edit and Archive/Restore, `ProjectDetailPage.tsx:185/:204/:343/:355`) cannot be reached by navigating in the running app.',
  '',
  '**Expected:** a reachable route (or an affordance on the project shell/dashboard) to edit and archive/restore a project; a test that navigates there and asserts the controls render.',
  '',
  'fix issue #214',
].join('\n');

function unit(over: Partial<WorkUnit> & { id: string; ord: number }): WorkUnit {
  return {
    session_id: RUN_ID,
    description: 'x',
    stage: 'build',
    assigned_cli: null,
    assigned_invocation: null,
    council_task_ref: null,
    routing: null,
    denial_reason: null,
    phase_ref: null,
    conformance_ref: null,
    phase_status: 'approved',
    collection_scope: null,
    status: 'done',
    ...over,
  } as WorkUnit;
}

/** A run view shaped like run-final.json of the phase3-r2 evidence (the `bug` workflow, delivered). */
function runView(): SessionView {
  const verify = unit({
    id: `${RUN_ID}:verify`,
    ord: 4,
    stage: 'test',
    role: 'evaluator',
    assigned_cli: 'pi',
    routing: { method: 'evaluator_distinct', winner: 'pi', was: 'claude' },
    gate: { human_confirm_if: 'verdict_not_pass' },
  });
  // The engine's per-unit repo-check record (snake_case; not in the api-types yet).
  (verify as WorkUnit & { repo_checks: unknown }).repo_checks = {
    checks: [
      { name: 'typecheck', argv: ['npm', 'run', 'typecheck'], exit_code: 0, duration_ms: 6893, timed_out: false, spawn_error: null },
      { name: 'lint', argv: ['npm', 'run', 'lint'], exit_code: 0, duration_ms: 6118, timed_out: false, spawn_error: null },
      { name: 'test', argv: ['npm', 'run', 'test'], exit_code: 1, duration_ms: 79191, timed_out: false, spawn_error: null },
      { name: 'e2e', argv: ['npm', 'run', 'e2e'], exit_code: null, duration_ms: 600000, timed_out: true, spawn_error: null },
    ],
  };
  return {
    session: {
      id: RUN_ID,
      workflow_id: `bug-deliver-${RUN_ID}`,
      problem: INTENT,
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude', 'codex', 'pi'],
      status: 'executing',
      human_confirm: 'all',
      unit_ix: 5,
      attempt: 0,
      workdir: '/tmp/wt',
      repo_ref: 'wicked-studio',
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    } as SessionView['session'],
    units: [
      unit({
        id: `${RUN_ID}:deliver`,
        ord: 5,
        status: 'distributed',
        phase_status: null,
        routing: { method: 'tool' },
        gate: 'auto',
        tool_cmd: ['bash', '-lc', 'x'],
      }),
      unit({
        id: `${RUN_ID}:triage`,
        ord: 1,
        stage: 'recon',
        assigned_cli: 'codex',
        routing: { method: 'council', winner: 'codex', agreement_pct: 80, returned: 5, seated: 5, dissent: 1 },
        gate: 'auto',
      }),
      unit({
        id: `${RUN_ID}:fix`,
        ord: 3,
        role: 'creator',
        assigned_cli: 'claude',
        executes_code: true,
        routing: { method: 'council', winner: 'claude', agreement_pct: 60, returned: 5, seated: 5, dissent: 2 },
        gate: 'auto',
      }),
      verify,
      unit({ id: `${RUN_ID}:reproduce`, ord: 2, stage: 'test', assigned_cli: 'pi', gate: 'auto' }),
    ],
  };
}

describe('deliverTitle — ≤72 characters, never cut mid-word (F-3R2-014)', () => {
  it('is the intent’s first line when it fits', () => {
    expect(deliverTitle('add the attention-reason helper', RUN_ID)).toBe('add the attention-reason helper');
  });

  it('cuts the F-3R2-014 intent at a word boundary with an ellipsis, inside 72 characters', () => {
    const title = deliverTitle(INTENT, RUN_ID);
    expect(title.length).toBeLessThanOrEqual(DELIVER_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    // The headline the finding recorded ended in `aga` — a word cut in half. Never again: the
    // characters before the ellipsis are a complete word of the intent.
    const kept = title.slice(0, -1);
    expect(INTENT.startsWith(kept)).toBe(true);
    expect(INTENT[kept.length]).toMatch(/[\s,;:(]/);
    expect(title).not.toContain('aga…');
    // No run-id prefix eating the width, no `wicked-crew run` boilerplate.
    expect(title).not.toContain(RUN_ID);
    expect(title.startsWith('Found by the seed-surfaces suite')).toBe(true);
  });

  it('strips markdown from the first line and skips leading blank lines', () => {
    expect(deliverTitle('\n\n## **Fix** the `useLegacyRedirect` [loop](http://x)\nmore', RUN_ID)).toBe(
      'Fix the useLegacyRedirect loop',
    );
    expect(deliverTitle('- add a thing', RUN_ID)).toBe('add a thing');
  });

  it('drops dangling punctuation before the ellipsis', () => {
    const line = `${'word '.repeat(13)}(paren, and a much longer tail that will not fit at all`;
    const title = deliverTitle(line, RUN_ID);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).toMatch(/[a-z]…$/);
  });

  it('names the run when the intent is blank, and never exceeds the cap even for one huge token', () => {
    expect(deliverTitle('', RUN_ID)).toBe(`wicked-crew run ${RUN_ID}`);
    expect(deliverTitle('   \n\t\n', RUN_ID)).toBe(`wicked-crew run ${RUN_ID}`);
    const huge = deliverTitle('x'.repeat(200), RUN_ID);
    expect(huge.length).toBe(72);
    expect(huge.endsWith('…')).toBe(true);
  });

  it('a blank intent with a LONG caller-supplied run id goes through the same bounded cut — never mid-id (Copilot on #525)', () => {
    // LaunchSchema only requires a non-empty sessionId and the CLI passes `--session` through.
    const longId = `campaign-${'a'.repeat(90)}`;
    const title = deliverTitle('', longId);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).toBe('wicked-crew run…'); // the word boundary before the id; the body carries the id in full
    // A 56-char id still fits whole (16 + 56 = 72).
    const fits = `r-${'b'.repeat(54)}`;
    expect(deliverTitle('', fits)).toBe(`wicked-crew run ${fits}`);
    expect(deliverTitle('', fits).length).toBe(72);
    // One more character and it is cut at the boundary, not inside the id.
    expect(deliverTitle('', `${fits}c`)).toBe('wicked-crew run…');
  });

  it('removes control characters — a title is one line', () => {
    expect(deliverTitle('fix\u0000 the\u0007 thing\rnow', RUN_ID)).toBe('fix the thing now');
  });

  it('a run id carrying newlines or control characters still yields a ONE-line blank-intent title (Copilot on #525)', () => {
    const title = deliverTitle('', 'r-1\nsecond line\r\tx\u0000y');
    expect(title).toBe('wicked-crew run r-1 second line x y');
    expect(title).not.toMatch(/[\u0000-\u001f]/);
    // …and the framed text keeps its shape: line 1 title, line 2 blank.
    const framed = framedDeliverText(
      composeDeliverText(
        factsFromWorkflow({ runId: 'r-1\nsecond', intent: '', workflowId: null, repoRef: null, phases: [], runUrl: null }),
      ),
    );
    expect(framed.split('\n')[0]).toBe('wicked-crew run r-1 second');
    expect(framed.split('\n')[1]).toBe('');
    expect(framed).toContain('- Run: `r-1 second`'); // code cells are one line too
  });
});

describe('issueRefs — `Fixes #N` from a closing verb, everything else as Refs', () => {
  it('reads `fix issue #214` as fixes and `wicked-studio#211` as a plain ref', () => {
    expect(issueRefs(INTENT)).toEqual({ fixes: ['#214'], refs: ['wicked-studio#211'] });
  });

  it('understands the closing verbs and cross-repo refs, deduplicated', () => {
    expect(issueRefs('Fixes #1 and fixes #1; closes #2. Resolved: #3, refs #4, see owner/repo#5 and a/b#5')).toEqual({
      fixes: ['#1', '#2', '#3'],
      refs: ['#4', 'owner/repo#5', 'a/b#5'],
    });
    expect(issueRefs('closes wicked-studio#7')).toEqual({ fixes: ['wicked-studio#7'], refs: [] });
  });

  it('ignores things that only look like refs', () => {
    // A path fragment glued to a hash, a non-numeric anchor, a plain number.
    expect(issueRefs('see /docs/a#b and CLN-2 and version 214 and #x')).toEqual({ fixes: [], refs: [] });
    expect(issueRefs('')).toEqual({ fixes: [], refs: [] });
  });
});

describe('composeDeliverText from the persisted run (GET /runs/:id/deliver-text)', () => {
  const facts = factsFromRun(runView(), runUrlFor('http://127.0.0.1:7701', RUN_ID));
  const text = composeDeliverText(facts);

  it('reads the run view: base workflow id, repo, intent, checks, evaluator', () => {
    expect(facts.source).toBe('run');
    expect(facts.workflowId).toBe('bug'); // `bug-deliver-<run>` reads as its base
    expect(facts.repoRef).toBe('wicked-studio');
    expect(facts.runUrl).toBe(`http://127.0.0.1:7701/runs/${RUN_ID}`);
    // Units are ordered by ord, whatever order the view listed them in.
    expect(facts.phases.map((p) => p.id)).toEqual(['triage', 'reproduce', 'fix', 'verify', 'deliver']);
    expect(facts.phases.map((p) => p.seat)).toEqual(['codex', 'pi', 'claude', 'pi', 'tool']);
    expect(facts.phases[3]).toMatchObject({ role: 'evaluator', gate: 'human if verdict not pass', outcome: 'approved' });
    expect(facts.phases[4]!.outcome).toBe('this PR'); // the deliver unit is running while it asks
    expect(facts.checks).toHaveLength(4);
    expect(facts.verdicts).toEqual([{ phase: 'verify', seat: 'pi', verdict: 'approved', reason: null }]);
  });

  it('carries every section the finding asked for — nothing is empty', () => {
    const { title, body } = text;
    expect(title.length).toBeLessThanOrEqual(72);
    expect(body).toContain('## Intent');
    expect(body).toContain('Found by the seed-surfaces suite (wicked-studio#211, scenario CLN-2)'); // the intent verbatim
    expect(body).toContain('\nFixes #214\n');
    expect(body).toContain('Refs: wicked-studio#211');
    expect(body).toContain(`- Run: [\`${RUN_ID}\`](http://127.0.0.1:7701/runs/${RUN_ID})`);
    expect(body).toContain('workflow `bug` · repo `wicked-studio`');
    // Phases with seats and gate outcomes.
    expect(body).toContain('| `triage` | recon | neutral | codex | auto | approved |');
    expect(body).toContain('| `fix` | build | creator | claude | auto | approved |');
    expect(body).toContain('| `verify` | test | evaluator | pi | human if verdict not pass | approved |');
    expect(body).toContain('| `deliver` | build | neutral | tool | auto | this PR |');
    // Repo checks WITH their exit codes (a failing and a timed-out one are reported as such).
    expect(body).toContain('| typecheck | `npm run typecheck` | 0 | 6.9s |');
    expect(body).toContain('| lint | `npm run lint` | 0 | 6.1s |');
    expect(body).toContain('| test | `npm run test` | 1 | 79.2s |');
    expect(body).toContain('| e2e | `npm run e2e` | timed out | 600.0s |');
    // The evaluator verdict.
    expect(body).toContain('## Evaluator verdict');
    expect(body).toContain('- `verify` (pi): **approved**');
    // The footer.
    expect(body).toContain(`Delivered by [wicked-crew](https://wc.wickedagile.com) run \`${RUN_ID}\`.`);
    expect(body).toContain('Merge stays human');
    expect(body).not.toContain('not available at composition time');
  });

  it('says so when a run recorded no checks, no evaluator, no intent', () => {
    const v = runView();
    v.session.problem = '';
    v.units = v.units.filter((u) => !u.id.endsWith(':verify'));
    const { title, body } = composeDeliverText(factsFromRun(v, null));
    expect(title).toBe(`wicked-crew run ${RUN_ID}`);
    expect(body).toContain('_(the run recorded no intent)_');
    expect(body).toContain('The run recorded no repo checks');
    expect(body).toContain('This workflow has no evaluator phase.');
    expect(body).toContain(`- Run: \`${RUN_ID}\``); // no origin ⇒ no link, still named
    expect(body).not.toContain('Fixes');
  });

  it('reports a denied evaluator with its reason, pipes escaped so the table survives', () => {
    const v = runView();
    const verify = v.units.find((u) => u.id.endsWith(':verify'))!;
    verify.phase_status = 'denied';
    verify.denial_reason = 'tests | red: 3 failures';
    const { body } = composeDeliverText(factsFromRun(v, null));
    expect(body).toContain('- `verify` (pi): **denied** — tests \\| red: 3 failures');
    expect(body).toContain('| `verify` | test | evaluator | pi | human if verdict not pass | denied |');
  });
});

describe('composeDeliverText from the workflow definition (the script’s embedded fallback)', () => {
  const bug = BUILTIN_WORKFLOWS.find((w) => w.id === 'bug')!;
  const facts = factsFromWorkflow({
    runId: RUN_ID,
    intent: INTENT,
    workflowId: bug.id,
    repoRef: 'wicked-studio',
    phases: bug.phases,
    runUrl: runUrlFor('http://127.0.0.1:7701/', RUN_ID),
  });
  const { title, body } = composeDeliverText(facts);

  it('knows the intent, the issue links, the run and the phase list — and says what it cannot know', () => {
    expect(facts.source).toBe('workflow');
    expect(title).toBe(deliverTitle(INTENT, RUN_ID));
    expect(body).toContain('\nFixes #214\n');
    expect(body).toContain(`- Run: [\`${RUN_ID}\`](http://127.0.0.1:7701/runs/${RUN_ID})`);
    expect(body).toContain('workflow `bug` · repo `wicked-studio`');
    for (const p of bug.phases) expect(body).toContain(`| \`${p.id}\` | ${p.kind} | ${p.role} |`);
    expect(body).toContain('From the workflow definition at launch');
    expect(body).toContain('Every phase before `deliver` had passed its gate');
    expect(body).toContain('## Repo checks\n\n_Not available at composition time');
    expect(body).toContain('## Evaluator verdict\n\n_Not available at composition time');
    expect(body).toContain(`run \`${RUN_ID}\`. Merge stays human`);
  });

  it('labels every gate shape', () => {
    expect(gateLabel('auto')).toBe('auto');
    expect(gateLabel({ human_confirm: { unconditional: true } })).toBe('human');
    expect(gateLabel({ human_confirm: { unconditional: false } })).toBe('human (conditional)');
    expect(gateLabel({ human_confirm_if: 'verdict_not_pass' })).toBe('human if verdict not pass');
    expect(gateLabel(undefined)).toBe('—');
  });
});

describe('framing — one shape for the daemon answer, the embedded fallback and the commit message', () => {
  it('round-trips: line 1 title, line 2 blank, then the body', () => {
    const text = composeDeliverText(factsFromRun(runView(), null));
    const framed = framedDeliverText(text);
    expect(framed.split('\n')[0]).toBe(text.title);
    expect(framed.split('\n')[1]).toBe('');
    expect(framed.endsWith('\n')).toBe(true);
    expect(parseFramedDeliverText(framed)).toEqual(text);
  });

  it('refuses text that is not framed', () => {
    expect(parseFramedDeliverText('')).toBeNull();
    expect(parseFramedDeliverText('title only')).toBeNull();
    expect(parseFramedDeliverText('\n\nbody without a title')).toBeNull();
    expect(parseFramedDeliverText('title\nno blank line\nbody')).toBeNull();
  });

  it('builds the run bookmark from an origin, tolerating a trailing slash', () => {
    expect(runUrlFor('http://127.0.0.1:7701', 'r1')).toBe('http://127.0.0.1:7701/runs/r1');
    expect(runUrlFor('http://[::1]:7701/', 'a b')).toBe('http://[::1]:7701/runs/a%20b');
    expect(runUrlFor(null, 'r1')).toBeNull();
    expect(runUrlFor('', 'r1')).toBeNull();
  });

  it('encodes a run id as ONE strict path segment — `/ # ? \'` and friends cannot change the request (Copilot on #525)', () => {
    expect(urlPathSegment("run/../../etc:passwd#x?y='z'(1)*!")).toBe(
      'run%2F..%2F..%2Fetc%3Apasswd%23x%3Fy%3D%27z%27%281%29%2A%21',
    );
    expect(urlPathSegment('d74e4e8f-bbc9-4697-8c30-181bae005217')).toBe('d74e4e8f-bbc9-4697-8c30-181bae005217');
    expect(urlPathSegment('ü')).toBe('%C3%BC');
    expect(urlPathSegment('a b')).not.toMatch(/[^A-Za-z0-9._~%-]/);
    expect(decodeURIComponent(urlPathSegment("run/#?'"))).toBe("run/#?'");
  });
});
