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
import {
  DELIVER_BASE_MOVED_MARKER,
  DELIVER_LIFT_CONFLICT_MARKER,
  DELIVER_PREFLIGHT_CHANGED_MARKER,
} from '../src/core/deliver.js';
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
    '4bffa800, HEAD f57069d → f57069d, HEAD ref Some("refs/heads/wicked/run-1") → Some("refs/heads/main")) — ' +
    'a check script that edits tracked files, moves HEAD or switches the branch leaves a tree nobody ' +
    "verified. Nothing was pushed. Inspect the worktree, fix or ignore the check's writes, and approve to retry.",
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
      'deliver: the engine verified this work against f57069d but origin/main is now 9f3c1a2 — refusing to rebase past ' +
      'the verified base; approve to retry the deliver phase (the engine lifts onto the new tip and re-runs the repository ' +
      `checks before pushing). Nothing was staged, committed or pushed; ${DELIVER_BASE_MOVED_MARKER} (origin/main now 9f3c1a2, verified f57069d)`;
    expect(triageDeliverFailure(moved)).toEqual({
      kind: 'base_moved',
      author: 'script',
      disposition: 'escalate',
      recoverable: false,
    });
    const regenerated =
      'deliver: the crew#426 lockfile/codegen re-sync CHANGED the worktree after the engine verified it — refusing to push a tree ' +
      `the engine did not verify. … Nothing was staged, committed or pushed; ${DELIVER_PREFLIGHT_CHANGED_MARKER}: packages/crew/endpoint-manifest.json `;
    expect(triageDeliverFailure(regenerated)).toEqual({
      kind: 'preflight_changed',
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

  it('the script’s BASE MOVED and PREFLIGHT CHANGED markers survive the excerpt after real fetch/npm chatter (review F-527-001)', () => {
    // What precedes the refusal in a real Tool output: the fetch, the account guard, npm's install
    // and codegen lines — hundreds of chars the head-150 keeps INSTEAD of the refusal's start. The
    // markers trail the refusal, so the tail-250 carries them.
    const chatter =
      'From /srv/git/wicked-studio\n * branch            main       -> FETCH_HEAD\n   1432c96..f57069d  main       -> origin/main\n' +
      'deliver: PR text composed from the run record (http://127.0.0.1:7701)\n';
    const baseMoved =
      chatter +
      'deliver: the engine verified this work against 1432c96b8d3f4e2a9c7d6e5f0a1b2c3d4e5f6a7b but origin/main is now ' +
      'f57069d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7 — refusing to rebase past the verified base; approve to retry the deliver ' +
      'phase (the engine lifts onto the new tip and re-runs the repository checks before pushing). Nothing was staged, ' +
      `committed or pushed; ${DELIVER_BASE_MOVED_MARKER} (origin/main now f57069d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7, verified 1432c96b8d3f4e2a9c7d6e5f0a1b2c3d4e5f6a7b)`;
    const npmChatter =
      chatter +
      '\nadded 481 packages in 23s\n\n> wicked-crew@0.7.28 manifest:endpoints\n> tsx scripts/generate-endpoint-manifest.ts\n\n' +
      'wrote packages/crew/endpoint-manifest.json: 126 endpoints (wicked-crew-api-types 0.33.0)\n\n> wicked-crew@0.7.28 generate:api-tests\n' +
      '> tsx scripts/generate-api-tests.ts\n\nwrote packages/crew/tests/generated/api-sample.generated.test.ts (8 sampled endpoints)\n';
    const preflight =
      npmChatter +
      'deliver: the crew#426 lockfile/codegen re-sync CHANGED the worktree after the engine verified it — refusing to push a tree ' +
      'the engine did not verify. The regenerated files are left in the worktree (unstaged); approve to retry the deliver phase: ' +
      'the engine re-verifies the changed tree first and this script then delivers it (a second regeneration changes nothing). ' +
      `Nothing was staged, committed or pushed; ${DELIVER_PREFLIGHT_CHANGED_MARKER}: package-lock.json packages/crew/endpoint-manifest.json packages/crew/tests/generated/api-sample.generated.test.ts `;
    for (const [text, kind] of [
      [baseMoved, 'base_moved'],
      [preflight, 'preflight_changed'],
    ] as const) {
      expect([...text].length, kind).toBeGreaterThan(400);
      const excerpt = framed(text);
      expect(excerpt, kind).toContain('chars elided');
      // The head is chatter, not the refusal — the marker must come from the tail.
      expect([...excerpt].slice(0, 220).join(''), kind).not.toContain('deliver: the ');
      expect(triageDeliverFailure(excerpt), kind).toMatchObject({ kind, author: 'script', disposition: 'escalate', recoverable: false });
    }
    // And the existing LIFT-CONFLICT push-failure line, which trails its marker the same way.
    const pushFail =
      chatter +
      'remote: HTTP 403 authentication failed\ndeliver: git push of wicked/x failed after commit: remote: HTTP 403 ... authentication failed; ' +
      `retry POST /runs/:id/deliver; nothing was pushed; ${DELIVER_LIFT_CONFLICT_MARKER}`;
    expect(triageDeliverFailure(framed(`${'-'.repeat(300)}\n${pushFail}`))?.kind).toBe('lift_conflict');
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

// ── DES-L9 (FIX-IT-ALL row 0.11, PR-L9-crew-0 — tests FIRST, mirror-first for the engine arm) ────
//
// PR-L9-crew adds two refusal families to the deliver script: REVISION mode (`revisesPr` — the run
// pushes onto an open PR's branch: the branch may have moved or vanished since the run based on it,
// or the run may have added no commit) and IDENTITY (D-18: with `GH_ACCOUNT` set, a gh login that
// differs or cannot be read REFUSES — the `gh auth switch` is deleted). Every one of them is an
// operator decision the engine parks at an `escalation` gate (DES-L9 §4) — never a seat fault, never
// a post-hoc lift: `script_refusal`, `author: 'script'`, `recoverable: false`, exactly like the
// script's existing refusals. Pinned here BEFORE the script grows them, against the DES §4 texts
// verbatim, so PR-L9-crew's wording must keep the classifier's `deliver: ` line contract.
describe('DES-L9 deliver refusals — revision + identity classify as script refusals (PR-L9-crew-0)', () => {
  const PR_BRANCH = 'wicked/cd3ea61d-9f4f-406d-972b-13ace3a87595';
  const RUN_BRANCH = `wicked/${RUN}`;
  /** DES-L9 §4, the script's own texts with the placeholders filled. */
  const L9 = {
    identityMismatch:
      "deliver: identity mismatch — GH_ACCOUNT is release-bot but gh's active login is someone-else; nothing was " +
      "staged, committed or pushed. Fix the daemon's gh login (gh auth switch, or GH_TOKEN in the daemon environment) " +
      'and approve to retry the deliver phase',
    identityUnreadable:
      "deliver: identity mismatch — GH_ACCOUNT is release-bot but gh's active login is unreadable; nothing was " +
      "staged, committed or pushed. Fix the daemon's gh login (gh auth switch, or GH_TOKEN in the daemon environment) " +
      'and approve to retry the deliver phase',
    branchGone:
      `deliver: pull request #273's branch origin/${PR_BRANCH} no longer exists on the remote; nothing was staged, ` +
      'committed or pushed',
    branchMoved:
      `deliver: pull request #273's branch moved since this run based on it (origin/${PR_BRANCH} is no longer an ` +
      `ancestor of ${RUN_BRANCH}); nothing was staged, committed or pushed — launch a new revision on the current head, ` +
      `or rebase ${RUN_BRANCH} onto origin/${PR_BRANCH} by hand and approve to retry`,
    nothingOnTop: 'deliver: nothing to deliver — the run added no commit on top of PR #273',
  };
  const SCRIPT_REFUSAL = { kind: 'script_refusal', author: 'script', disposition: 'escalate', recoverable: false } as const;

  it('every DES-L9 refusal text classifies script_refusal — an escalation, never recoverable by a post-hoc lift', () => {
    for (const [name, text] of Object.entries(L9)) {
      expect(triageDeliverFailure(text), name).toEqual(SCRIPT_REFUSAL);
      // The engine's `denial_reason` framing (`deliver refused on unit N: <excerpt>` under the F1 arm, or
      // today's `Worker FAILED on unit N (…): <excerpt>`) keeps the `deliver: ` line intact.
      expect(triageDeliverFailure(framed(text)), `${name} (framed)`).toEqual(SCRIPT_REFUSAL);
    }
  });

  // FOUND BY THIS PIN (mirror-first): DES-L9 §5 frames the F1 arm's `unit.denial_reason` as
  // `deliver refused on unit {ord}: {snippet}` — but the classifier's line rule accepts `deliver: `
  // only at the start, after a newline, or after the engine's `): ` framing. Today the classifier's
  // one crew consumer is `seat-health.ts:246` over `stepFailed.detail` — which the arm serves as the
  // BARE snippet, so seat health is unaffected (pinned in seat-health.test.ts). But PR-L9-crew's
  // post-hoc reading and `deliver-text.ts` classify the UNIT's `denial_reason` (DES-L9 §5), and the
  // studio's delivery card mirrors it — there this framing answers null. ONE character settles it on
  // either side: the engine frames with `(deliver): ` or a newline before the snippet (PR-L9-core), or
  // PR-L9-crew widens SCRIPT_REFUSAL to accept `: deliver: `. NOT_FIXED_YET until one lands — flip
  // to `it` there.
  it.fails('NOT_FIXED_YET (DES-L9 §5 framing ↔ the deliver-triage line rule): the F1 arm’s `deliver refused on unit N: …` denial_reason classifies script_refusal', () => {
    for (const [name, text] of Object.entries(L9)) {
      expect(triageDeliverFailure(`deliver refused on unit 5: ${boundedExcerpt(text)}`), `${name} (F1 arm framing)`).toEqual(SCRIPT_REFUSAL);
    }
  });

  it('the identity refusal is the WHOLE output (it runs before `git fetch`), so it is carried by the head', () => {
    // DES-L9 §5: the identity block replaces the `gh auth switch` guard at the very top of the script —
    // nothing precedes it, so the head-150 of the excerpt is the refusal's own first line.
    for (const text of [L9.identityMismatch, L9.identityUnreadable]) {
      expect([...text].slice(0, 150).join('')).toMatch(/^deliver: identity mismatch — GH_ACCOUNT is release-bot but gh's active login is /);
      expect(triageDeliverFailure(framed(`${text}\n${'-'.repeat(400)}`))).toEqual(SCRIPT_REFUSAL);
    }
  });

  it('the revision-mode refusals are NOT marker-bearing: none of them may read as a lift conflict, a moved base or a preflight change', () => {
    for (const [name, text] of Object.entries(L9)) {
      expect(text, name).not.toContain(DELIVER_LIFT_CONFLICT_MARKER);
      expect(text, name).not.toContain(DELIVER_BASE_MOVED_MARKER);
      expect(text, name).not.toContain(DELIVER_PREFLIGHT_CHANGED_MARKER);
      expect(triageDeliverFailure(text)?.recoverable, name).toBe(false);
    }
  });

  // The revision refusals run AFTER `git fetch origin` (the moved-head check needs the fresh
  // `origin/<pr-branch>`), so real fetch chatter precedes them in the Tool output and the engine's
  // head-150 keeps the chatter, not the refusal — only the tail-250 is the script's (review
  // F-527-001, the same trap the BASE MOVED / PREFLIGHT CHANGED markers were moved to the tail for).
  // The DES §4 moved-head text is LONGER than 250 chars once the two branch names are filled in, so
  // its `deliver: ` line start falls into the elided middle and the classifier answers null.
  // NOT_FIXED_YET: PR-L9-crew must make the refusal survive the excerpt — a short trailing
  // `deliver: …` line (the marker idiom, without a marker) or an equivalent — and flip this to `it`.
  it.fails('NOT_FIXED_YET (DES-L9 PR-L9-crew): the moved-head refusal survives the head+tail excerpt after fetch chatter', () => {
    const chatter =
      'From /srv/git/wicked-studio\n * branch            main       -> FETCH_HEAD\n' +
      `   1432c96..f57069d  ${PR_BRANCH} -> origin/${PR_BRANCH}\n` +
      'deliver: PR text composed from the run record (http://127.0.0.1:7701)\n';
    expect([...L9.branchMoved].length).toBeGreaterThan(250);
    const excerpt = framed(chatter + L9.branchMoved);
    expect(excerpt).toContain('chars elided');
    expect(triageDeliverFailure(excerpt)).toEqual(SCRIPT_REFUSAL);
  });
});
