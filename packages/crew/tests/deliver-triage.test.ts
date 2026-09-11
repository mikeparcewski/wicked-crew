// wicked-core#431 follow-through — the deliver-failure triage (`core/deliver-triage.ts`).
//
// A failed deliver unit's excerpt — `stepFailed.detail`, or the unit's `denial_reason` — may now be
// ENGINE-authored (wicked-core#433's pre-push lift + re-verify) as well as crew's own script's. Every
// such refusal is an operator ESCALATION, never a seat fault, and only a lift CONFLICT is
// recoverable by a post-hoc lift. These pin the classifier against the engine's texts verbatim
// (`wicked-core/src/deliver_lift.rs` `lift_and_reverify` / `require_run_branch`) and against the
// head+tail excerpt the engine bounds them to (`actor.rs` `bounded_excerpt`: 150 + 250 chars), so a
// phrase moving out of the kept text — or the engine rewording a remedy — fails here, not in a
// seat-health chip.

import { describe, expect, it } from 'vitest';
import { DELIVER_BASE_MOVED_MARKER, DELIVER_LIFT_CONFLICT_MARKER } from '../src/core/deliver.js';
import {
  ENGINE_CHECKS_MUTATED_PHRASE,
  ENGINE_LIFT_APPLY_FAILED_PHRASE,
  ENGINE_LIFT_CONFLICT_PHRASE,
  ENGINE_REVERIFY_FAILED_PHRASE,
  ENGINE_RUN_BRANCH_PHRASE,
  ENGINE_SNAPSHOT_FAILED_PHRASE,
  triageDeliverFailure,
  type DeliverFailureKind,
} from '../src/core/deliver-triage.js';

const RUN = '6599d70c-0457-425f-b4cb-215a40e68e1e';

/** The engine's texts, verbatim (base_ref `origin/main`, tip `f57069d`, verified base `1432c96`). */
const ENGINE = {
  // `require_run_branch` — refused before any lift; the whole output is this one line.
  runBranchAttached:
    "deliver: the worktree's HEAD is attached to `refs/heads/main`, not the run branch " +
    `\`wicked/${RUN}\` — nothing was lifted, reset or pushed; the deliver script only pushes the run ` +
    `branch. Switch the worktree back to \`wicked/${RUN}\` and approve to retry.`,
  runBranchDetached:
    `deliver: the worktree's HEAD is detached, not on the run branch \`wicked/${RUN}\` — nothing was ` +
    'lifted, reset or pushed; the deliver script only pushes the run branch. Switch the worktree back ' +
    `to \`wicked/${RUN}\` and approve to retry.`,
  applyFailed:
    'deliver: the lift onto origin/main (f57069d) could not be applied cleanly — read-tree failed: ' +
    'exit 128. Nothing was pushed — the deliver gate never pushes a tree that was not verified. ' +
    'Inspect the worktree (it may hold a partial checkout), restore or fix it, and approve to retry ' +
    'the deliver phase.',
  conflict:
    "deliver: LIFT-CONFLICT — lifting the run's work onto origin/main (f57069d) would conflict in: " +
    'testid-inventory.json. The worktree was left exactly as verified (base 1432c96); nothing was ' +
    'rebased and nothing was pushed. Resolve on the branch (rebase onto origin/main, regenerate any ' +
    "generated files, re-run the repository's checks) and approve to retry the deliver phase.",
  snapshotFailed:
    'deliver: the worktree could not be snapshotted before delivery (git status: exit 128); nothing ' +
    'was pushed — the deliver gate never pushes a tree it cannot identify.',
  // The three `<why>` spellings of the re-verify refusal (F-433-001: it runs whenever the tree is
  // not the recorded verified tree — after a lift, on a retry, after a by-hand rebase, with no verify).
  reverifyFailedAfterLift:
    "deliver: the lift changed the tree, and the repository's own checks FAILED on it: typecheck: " +
    'exit 2. Lockfile drift between the old base and the tip (package-lock.json): dependencies were ' +
    're-installed (frozen lockfile, --ignore-scripts) before the checks. Nothing was pushed — the ' +
    'deliver gate never pushes a tree that was not verified. Fix the worktree (or reject the run) and ' +
    'approve to retry; the checks run again until the tree passes.',
  reverifyFailedUnverifiedTree:
    "deliver: the worktree's tree 598bbb99 is not the tree the run verified (4bffa800), and the " +
    "repository's own checks FAILED on it: test: exit 1. Nothing was pushed — the deliver gate never " +
    'pushes a tree that was not verified. Fix the worktree (or reject the run) and approve to retry; ' +
    'the checks run again until the tree passes.',
  reverifyFailedNoVerify:
    "deliver: the run recorded no verified tree, and the repository's own checks FAILED on it: lint: " +
    'exit 1. Nothing was pushed — the deliver gate never pushes a tree that was not verified. Fix the ' +
    'worktree (or reject the run) and approve to retry; the checks run again until the tree passes.',
  checksMutated:
    "deliver: the repository's checks passed but CHANGED the worktree while running (tree 598bbb99 → " +
    '4bffa800, HEAD f57069d → f57069d) — a check script that edits tracked files or moves HEAD leaves ' +
    "a tree nobody verified. Nothing was pushed. Inspect the worktree, fix or ignore the check's " +
    'writes, and approve to retry.',
  resnapshotFailed:
    "deliver: the repository's checks passed but the worktree could not be re-snapshotted afterwards " +
    '(git status: exit 128); nothing was pushed — the deliver gate never pushes a tree it cannot prove.',
};

/** name → expected kind, the phrase the classifier keys on, and whether that phrase sits in the
 *  HEAD of the line (the run-branch refusal's phrase follows a variable `<why>`, so it is carried by
 *  the tail; the engine's text is the whole output there, well under the 400-char bound). */
const EXPECTED: [keyof typeof ENGINE, DeliverFailureKind, string, 'head' | 'tail'][] = [
  ['runBranchAttached', 'run_branch_refused', ENGINE_RUN_BRANCH_PHRASE, 'tail'],
  ['runBranchDetached', 'run_branch_refused', ENGINE_RUN_BRANCH_PHRASE, 'tail'],
  ['applyFailed', 'lift_apply_failed', ENGINE_LIFT_APPLY_FAILED_PHRASE, 'head'],
  ['conflict', 'lift_conflict', ENGINE_LIFT_CONFLICT_PHRASE, 'head'],
  ['snapshotFailed', 'snapshot_failed', ENGINE_SNAPSHOT_FAILED_PHRASE, 'head'],
  ['reverifyFailedAfterLift', 'reverify_failed', ENGINE_REVERIFY_FAILED_PHRASE, 'head'],
  ['reverifyFailedUnverifiedTree', 'reverify_failed', ENGINE_REVERIFY_FAILED_PHRASE, 'head'],
  ['reverifyFailedNoVerify', 'reverify_failed', ENGINE_REVERIFY_FAILED_PHRASE, 'head'],
  ['checksMutated', 'checks_mutated', ENGINE_CHECKS_MUTATED_PHRASE, 'head'],
  ['resnapshotFailed', 'checks_mutated', ENGINE_CHECKS_MUTATED_PHRASE, 'head'],
];

/** `actor.rs` `bounded_excerpt`: head + tail, elision marked, char-counted. */
function boundedExcerpt(raw: string, head = 150, tail = 250): string {
  const chars = [...raw];
  const n = chars.length;
  if (n <= head + tail) return raw;
  return `${chars.slice(0, head).join('')}\n[… ${n - head - tail} chars elided …]\n${chars.slice(n - tail).join('')}`;
}

/** The unit's `denial_reason` framing: the engine's worker-failure prefix + the bounded excerpt. */
const framed = (text: string): string =>
  `Worker FAILED on unit 5 (triage: the deliver step exited non-zero): ${boundedExcerpt(text)}`;

describe('triageDeliverFailure (wicked-core#431 follow-through)', () => {
  it('recognises every engine-authored deliver refusal as an escalation and says which — only the conflict is recoverable', () => {
    for (const [name, kind] of EXPECTED) {
      expect(triageDeliverFailure(ENGINE[name]), name).toEqual({
        kind,
        author: 'engine',
        disposition: 'escalate',
        recoverable: kind === 'lift_conflict',
      });
    }
  });

  it('survives the engine’s head+tail excerpt and the denial_reason framing', () => {
    for (const [name, kind, phrase, where] of EXPECTED) {
      const text = ENGINE[name];
      // The engine's refusal IS the deliver unit's whole output (the command never ran); the framed
      // denial_reason carries it whole when it is under the 400-char bound, head+tail otherwise.
      expect(triageDeliverFailure(framed(text))?.kind, `${name} (framed)`).toBe(kind);
      if (where === 'head') {
        // Head-anchored phrases also survive a LONG transcript (the text followed by more output):
        // the elision cuts the middle, the head keeps the phrase, the framing does not disturb it.
        expect([...text].slice(0, 150).join(''), `${name}: phrase in head`).toContain(phrase);
        const excerpt = framed(`${text}\n${'-'.repeat(400)}`);
        expect(excerpt, name).toContain('chars elided');
        const t = triageDeliverFailure(excerpt);
        expect(t?.kind, `${name} (elided)`).toBe(kind);
        expect(t?.author, name).toBe('engine');
      } else {
        // The run-branch phrase follows a variable `<why>`; it is carried by the 250-char TAIL even
        // when a long `<why>` pushes the line past the bound.
        expect([...text].slice(-250).join(''), `${name}: phrase in tail`).toContain(phrase);
        const longWhy = text.replace("deliver: the worktree's HEAD", `deliver: the worktree's HEAD (${'x'.repeat(300)})`);
        const excerpt = framed(longWhy);
        expect(excerpt, name).toContain('chars elided');
        expect(triageDeliverFailure(excerpt)?.kind, `${name} (long why)`).toBe(kind);
      }
    }
  });

  it('the engine’s LIFT-CONFLICT carries crew’s own marker as its prefix, so the strand derivation keys on it unchanged', () => {
    expect(ENGINE.conflict.startsWith(DELIVER_LIFT_CONFLICT_MARKER)).toBe(true);
    expect(ENGINE_LIFT_CONFLICT_PHRASE.startsWith(DELIVER_LIFT_CONFLICT_MARKER)).toBe(true);
    expect(ENGINE.conflict).toContain(ENGINE_LIFT_CONFLICT_PHRASE);
  });

  it('recognises crew’s own script refusals — lift conflicts recoverable, everything else not', () => {
    const rebase =
      'Rebasing (1/1)\nCONFLICT (content): Merge conflict in src/thing.ts\n' +
      `${DELIVER_LIFT_CONFLICT_MARKER} — rebase of wicked/x onto origin/main hit conflicts outside the ` +
      'changelog; resolve on the branch and re-run; nothing was pushed';
    expect(triageDeliverFailure(rebase)).toEqual({
      kind: 'lift_conflict',
      author: 'script',
      disposition: 'escalate',
      recoverable: true,
    });
    const push =
      'remote: HTTP 403 authentication failed\ndeliver: git push of wicked/x failed after commit: … ; ' +
      `retry POST /runs/:id/deliver; nothing was pushed; ${DELIVER_LIFT_CONFLICT_MARKER}`;
    expect(triageDeliverFailure(push)).toMatchObject({ kind: 'lift_conflict', author: 'script', recoverable: true });
    const moved =
      `${DELIVER_BASE_MOVED_MARKER} — origin/main is now 9f3c1a2 but the engine verified this work against ` +
      'f57069d; refusing to rebase past the verified base. Nothing was staged, committed or pushed — approve ' +
      'to retry the deliver phase (the engine lifts onto the new tip and re-runs the repository checks before pushing)';
    expect(triageDeliverFailure(moved)).toEqual({
      kind: 'base_moved',
      author: 'script',
      disposition: 'escalate',
      recoverable: false,
    });
    const refusals = [
      'deliver: nothing to deliver — the run produced no committed change (wicked/x is not ahead of origin/main); nothing was pushed',
      "deliver: refusing to push branch 'main' — the deliver phase only pushes run branches, never the default branch",
      'could not compute title or body defaults\ndeliver: gh pr create failed for wicked/x — no PR was opened',
      framed('deliver: gh pr create exited 0 but produced no PR URL for wicked/x — refusing to report a delivery nothing can be pointed at'),
    ];
    for (const refusal of refusals) {
      expect(triageDeliverFailure(refusal), refusal).toEqual({
        kind: 'script_refusal',
        author: 'script',
        disposition: 'escalate',
        recoverable: false,
      });
    }
  });

  it('answers null for a spawn/infra failure, an ordinary worker transcript, exclusion notes alone, and empty input', () => {
    // The crew#400 posture: a markerless infra fault is a genuine failure — nothing to reinterpret.
    expect(triageDeliverFailure('Worker FAILED on unit 5 (triage: spawn failed): bash: gh: command not found')).toBeNull();
    // A seat's own failure (the wrapped runner's message) is a seat fault and stays one.
    expect(triageDeliverFailure('(cli `agy` exited 1) three narration lines and no verdict')).toBeNull();
    // The staging classifier's informational lines are not refusals.
    expect(
      triageDeliverFailure('deliver: EXCLUDED (denylisted-name): bus.db\ndeliver: EXCLUDED (scratch-dir): coverage/lcov.info'),
    ).toBeNull();
    // A worker that merely uses the word mid-sentence is not a refusal line.
    expect(triageDeliverFailure('(cli `codex` exited 1) the agent could not deliver: the tests still fail')).toBeNull();
    expect(triageDeliverFailure('')).toBeNull();
    expect(triageDeliverFailure(null)).toBeNull();
    expect(triageDeliverFailure(undefined)).toBeNull();
  });
});
