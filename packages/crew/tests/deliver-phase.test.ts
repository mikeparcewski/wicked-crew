// crew#293 — the first-class deliver phase, pure half: the script generator, the PhaseDef
// shape, and per-run composition. The launch threading lives in deliver-launch.test.ts
// (adapter) and deliver-route.test.ts (HTTP).
//
// The script assertions pin the FIELD-PROVEN hardening, not the wording: the refuse-main
// guard, the rebase-before-push step, and — the one deliberate change from the field overlay —
// no gh account name baked into crew code (the env-driven GH_ACCOUNT guard replaces it).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELIVER_LIFT_CONFLICT_MARKER as LIFT_CONFLICT_MARKER,
  DELIVER_PHASE_ID,
  DELIVER_TEXT_HEREDOC,
  EVIDENCE_FLOOR_PIN,
  composeDeliverWorkflow,
  deliverPrPhase,
  deliverPrScript,
} from '../src/core/deliver.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { WorkflowDef } from '../src/core/types.js';
import { SKIP_CORE_CHECKS, requireCoreDir } from './support/core-checkout.js';

describe('deliverPrScript (the hardened field script)', () => {
  const script = deliverPrScript();

  it('derives the branch from the worktree run-id with a current-branch fallback', () => {
    expect(script).toContain('R=$(basename "$PWD")');
    expect(script).toContain('B="wicked/$R"');
    expect(script).toContain('git branch --show-current');
  });

  it('REFUSES to push main/master (and a detached-HEAD empty name)', () => {
    expect(script).toMatch(/case "\$B" in ""\|main\|master\|"\$DEF"\)/);
    expect(script).toContain('refusing to push');
    // The refusal exits non-zero — a printed warning that still pushes is no guard at all.
    expect(script).toMatch(/refusing to push[^\n]*"; exit 1;;/);
  });

  it('rebases onto origin’s default branch before pushing, failing visibly on conflict', () => {
    expect(script).toContain('git fetch origin');
    expect(script).toMatch(/git rebase /);
    // origin/HEAD resolution with the origin/main fallback the task names.
    expect(script).toContain('refs/remotes/origin/HEAD');
    expect(script).toContain('origin/main');
    // A conflict the changelog union merge cannot clear aborts the rebase and exits non-zero
    // carrying the LIFT-CONFLICT marker + "nothing was pushed" — the loud refusal, before any
    // push runs. (The union merge that PRECEDES this abort is asserted in the crew#418 block.)
    expect(script).toMatch(/git rebase --abort[^\n]*LIFT-CONFLICT[^\n]*nothing was pushed[^\n]*exit 1/);
    const rebaseAt = script.indexOf('git rebase');
    const pushAt = script.indexOf('git push -u origin');
    expect(rebaseAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(rebaseAt);
  });

  // crew#418 B — the CHANGELOG collision magnet: a rebase conflict whose conflicted paths are all
  // CHANGELOG.md is union-merged (keep BOTH sides' additive lines) and the rebase continues; ONLY
  // a conflict outside the changelog aborts loudly and strands. Pinned as script properties; the
  // behaviour is driven for real against temp git repos in deliver-script-exec.test.ts.
  it('union-merges a CHANGELOG-only rebase conflict, aborting loudly only outside the changelog', () => {
    // The scope gate: any conflicted path that is NOT a CHANGELOG.md stops the auto-resolve.
    expect(script).toContain('git diff --name-only --diff-filter=U');
    expect(script).toContain('grep -qvE "(^|/)CHANGELOG\\.md$"');
    // The union merge keeps both sides; the rebase then continues.
    expect(script).toContain('git merge-file -q --union');
    expect(script).toContain('git -c core.editor=true rebase --continue');
    // The union step precedes the loud abort — a real (non-changelog) conflict still strands.
    expect(script.indexOf('git merge-file')).toBeLessThan(script.indexOf('git rebase --abort'));
    expect(script).toContain(`${LIFT_CONFLICT_MARKER} — rebase`);
  });

  // crew#418/#432 — a rejected push happens after the run work was committed. Both a remote
  // branch race and auth/transport/hook failures must strand recoverably for a post-hoc retry.
  it('marks every push failure as a recoverable LIFT-CONFLICT', () => {
    expect(script).toContain('if PUSHOUT=$(git push -u origin "$B" 2>&1); then');
    expect(script).toMatch(/\*non-fast-forward\*[^\n]*LIFT-CONFLICT[^\n]*non-fast-forward[^\n]*nothing was pushed/);
    // The catch-all carries the same marker — auth/network/hook failures preserve committed work.
    const plainArm = script.split('\n').find((l) => l.includes('deliver: git push of $B failed'))!;
    expect(plainArm).toContain('LIFT-CONFLICT');
    expect(plainArm).toContain('PUSHERR="${PUSHOUT:0:96}');
    expect(plainArm).toContain(': > "$S"');
    expect(plainArm).toContain('retry POST /runs/:id/deliver');
  });

  it('pushes -u and opens the PR with gh, URL as the last line', () => {
    expect(script).toContain('git push -u origin "$B"');
    expect(script).toContain('gh pr create --head "$B" --title "$TITLE" --body-file "$TD/body"');
    const lines = script.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('echo "$URL"');
  });

  // crew#317 — the three defects, pinned as script properties. The BEHAVIOUR of each is driven
  // for real against temp git repos in deliver-script-exec.test.ts; these keep the shape from
  // regressing without paying for a git repo per assertion.
  it('stages tracked work then classifies untracked paths before it pushes anything (crew#434)', () => {
    // Tracked changes always ride; the blanket `git add -A` is gone.
    expect(script).toContain('git add -u');
    expect(script).not.toContain('git add -A');
    expect(script).toContain('S=.wicked-crew-delivery-stranded');
    // Untracked candidates are enumerated per-file (gitignore honored, NUL-delimited) and staged
    // individually — not swept.
    expect(script).toContain('git ls-files --others --exclude-standard -z');
    expect(script).toContain('git add -- "$F"');
    // The scratch/key-material denylist, the socket-name rule, the scratch dirs, and the size cap.
    expect(script).toContain('*.db|*.db-wal|*.db-shm|*.sqlite');
    expect(script).toContain('.envrc');
    expect(script).toContain('*.pem|*.key|*.p12|*.pfx|id_rsa*|*credentials*');
    expect(script).toContain('*socket*'); // matched against the lowercased basename
    expect(script).toContain('tr "[:upper:]" "[:lower:]"');
    expect(script).toContain('*/tmp/*|*/.tmp/*|*/scratch/*|*/.cache/*|*/coverage/*');
    expect(script).toContain('-gt 1048576');
    // A GUARD, NOT A SILENT DROP: every exclusion is reported with its reason.
    expect(script).toContain('deliver: EXCLUDED ($RN): $F');
    expect(script).toContain('git diff --cached --quiet || git commit -q -F "$TD/text"');
    // The commit precedes both the rebase (which refuses a dirty tree) and the push.
    expect(script.indexOf('git add -u')).toBeLessThan(script.indexOf('git rebase'));
    expect(script.indexOf('git commit')).toBeLessThan(script.indexOf('git push -u origin'));
    // Author identity is the repo's own — crew never bakes one in.
    expect(script).not.toContain('user.email');
    expect(script).not.toContain('user.name');
  });

  // crew#524 / F-3R2-014 — the commit message and the PR title/body are COMPOSED from the run
  // (`core/deliver-text.ts`), never `--fill`: the script asks the launching daemon for the
  // run-derived text and falls back to the launch-time composition it carries in a QUOTED heredoc.
  it('composes the PR/commit text from the intent — title as line 1, fetched from the daemon first, embedded fallback second', () => {
    const withIntent = deliverPrScript('add the attention-reason helper', {
      runId: 'run-1',
      apiOrigin: 'http://127.0.0.1:7701',
    });
    // The callback to THIS daemon for the run-derived text, then the embedded fallback.
    expect(withIntent).toContain("API='http://127.0.0.1:7701'");
    expect(withIntent).toContain('"$API/api/v1/runs/$RUNID/deliver-text"');
    // The LAUNCH run id rides pre-encoded as one path segment; the branch-derived id is only the
    // fallback, percent-encoded byte-wise by the script (Copilot on #525).
    expect(withIntent).toContain("RUNID='run-1'");
    expect(withIntent).toContain('[ -n "$RUNID" ] || RUNID=$(_urlenc "${B#wicked/}")');
    expect(deliverPrScript('x', { runId: "run/../../etc:passwd#1?q='z'" })).toContain(
      "RUNID='run%2F..%2F..%2Fetc%3Apasswd%231%3Fq%3D%27z%27'",
    );
    expect(script).toContain("RUNID=''"); // no launch id known ⇒ derived + encoded at run time
    // The fetched text is used ONLY when it is framed (title / blank / body) — a 200 that is not
    // the run record falls back (Copilot on #525).
    expect(withIntent).toContain('&& _framed "$TD/text"; then');
    expect(withIntent).toMatch(/_framed\(\) \{ \[ -s "\$1" \] && \[ -n "\$\(sed -n 1p "\$1"\)" \] && \[ -z "\$\(sed -n 2p "\$1"\)" \]/);
    expect(withIntent).toContain('using the launch-time PR text');
    expect(withIntent).toContain(`cat > "$TD/text" <<'${DELIVER_TEXT_HEREDOC}'`);
    // Both carriers are FRAMED the same and parsed once: line 1 title, line 2 blank, then body.
    expect(withIntent).toContain('TITLE=$(sed -n 1p "$TD/text")');
    expect(withIntent).toContain(`sed '1,2d' "$TD/text" > "$TD/body"`);
    const lines = withIntent.split('\n');
    const open = lines.indexOf(`  cat > "$TD/text" <<'${DELIVER_TEXT_HEREDOC}'`);
    expect(open).toBeGreaterThan(-1);
    expect(lines[open + 1]).toBe('add the attention-reason helper'); // the title, whole
    expect(lines[open + 2]).toBe('');
    expect(lines.slice(open + 3, lines.indexOf(DELIVER_TEXT_HEREDOC, open)).join('\n')).toContain(
      'Delivered by [wicked-crew](https://wc.wickedagile.com) run `run-1`.',
    );
    // The commit message IS that text (git takes the first paragraph as the subject).
    expect(withIntent).toContain('git commit -q -F "$TD/text"');
    // No origin ⇒ no callback is even attempted, and the output SAYS which text is used (Copilot
    // on #525) — every branch names its reason.
    expect(script).toContain("API=''");
    expect(script).toContain('no daemon origin was known when this run launched — using the launch-time PR text');
    expect(script).toContain('curl is not available in this shell — using the launch-time PR text');
    expect(script).toContain('did not answer with the run record — using the launch-time PR text');
    expect(script).toContain('deliver: PR text composed from the run record ($API)');
    // A hostile intent cannot break out of the quoted heredoc: no expansion happens inside it, CR
    // and control characters are removed, and a line equal to the base delimiter is NOT dropped —
    // the delimiter moves instead (Copilot on #525: dropping it could delete the title line).
    const hostile = deliverPrScript(
      `x'; rm -rf /; echo '$(id) \`id\`\r\n${DELIVER_TEXT_HEREDOC}\nsecond line`,
      { runId: 'run-1' },
    );
    const hl = hostile.split('\n');
    const hOpen = hl.findIndex((l) => l.startsWith(`  cat > "$TD/text" <<'`));
    const chosen = /<<'([^']+)'$/.exec(hl[hOpen]!)![1]!;
    expect(chosen).toBe(`${DELIVER_TEXT_HEREDOC}_1`); // suffixed away from the colliding line
    const hClose = hl.indexOf(chosen, hOpen + 1);
    expect(hClose).toBeGreaterThan(hOpen);
    expect(hl.slice(hOpen + 1, hClose)).toContain(DELIVER_TEXT_HEREDOC); // the intent's line rides verbatim
    expect(hl.indexOf(chosen, hClose + 1)).toBe(-1); // exactly one closing delimiter
    expect(hostile).not.toContain('\r');
    // Anything after the heredoc is the script's own text again.
    expect(hl[hClose + 1]).toBe('fi');
    // The degenerate case Copilot named: the intent's FIRST line is the base delimiter — it is the
    // title, it stays line 1 of the heredoc, and the framing is intact.
    const titled = deliverPrScript(`${DELIVER_TEXT_HEREDOC}\n\nbody`, { runId: 'run-1' }).split('\n');
    const tOpen = titled.findIndex((l) => l.startsWith(`  cat > "$TD/text" <<'`));
    expect(titled[tOpen]).toBe(`  cat > "$TD/text" <<'${DELIVER_TEXT_HEREDOC}_1'`);
    expect(titled[tOpen + 1]).toBe(DELIVER_TEXT_HEREDOC);
    expect(titled[tOpen + 2]).toBe('');
    // …and when the text ALSO carries the first suffix, the delimiter keeps moving.
    const twice = deliverPrScript(`${DELIVER_TEXT_HEREDOC}\n${DELIVER_TEXT_HEREDOC}_1\nbody`, { runId: 'run-1' });
    expect(twice).toContain(`<<'${DELIVER_TEXT_HEREDOC}_2'`);
    // An origin that is not a plain http(s) origin is never spliced in.
    expect(deliverPrScript('x', { apiOrigin: "http://h'; rm -rf /; echo '" })).toContain("API=''");
    expect(deliverPrScript('x', { apiOrigin: 'ftp://h:1' })).toContain("API=''");
    expect(deliverPrScript('x', { apiOrigin: 'http://[::1]:7701/' })).toContain("API='http://[::1]:7701'");
  });

  it('FAILS LOUDLY with nothing pushed when there is nothing to deliver', () => {
    expect(script).toContain('deliver: nothing to deliver — the run produced no committed change');
    // The refusal is asserted BEFORE the push, and it exits non-zero.
    const nothing = script.indexOf('nothing to deliver');
    expect(nothing).toBeGreaterThan(-1);
    expect(nothing).toBeLessThan(script.indexOf('git push -u origin'));
    expect(script).toMatch(/nothing to deliver[^\n]*nothing was pushed"; exit 1; \}/);
  });

  it('captures gh’s output and status separately — no `| tail -1` verdict laundering', () => {
    expect(script).toContain(
      'if ! OUT=$(gh pr create --head "$B" --title "$TITLE" --body-file "$TD/body" 2>&1); then',
    );
    expect(script).not.toContain('--fill');
    expect(script).toContain('deliver: gh pr create failed for $B — no PR was opened');
    // The gh invocation must not be piped at all: the phase's verdict is gh's own status.
    const ghLine = script.split('\n').find((l) => l.includes('gh pr create'))!;
    expect(ghLine).not.toContain('| tail');
  });

  it('RE-DERIVES done: a real PR URL and a branch ahead of the remote default', () => {
    expect(script).toContain("grep -Eo 'https://[^[:space:]]+/pull/[0-9]+'");
    expect(script).toContain('exited 0 but produced no PR URL');
    expect(script).toContain('P=$(git rev-list --count "$D..origin/$B")');
    expect(script).toContain('is not ahead of $D on the remote after the push');
    // Both assertions gate the final URL line.
    const lines = script.split('\n');
    expect(lines.indexOf('echo "$URL"')).toBe(lines.length - 1);
  });

  it('bakes NO account name into crew code — the guard is env-driven (GH_ACCOUNT)', () => {
    // The field overlay guarded a personal account by name; that must never ship in crew.
    expect(script).not.toContain('mikeparcewski');
    expect(script).toContain('GH_ACCOUNT');
    // The switch only runs when GH_ACCOUNT is set AND differs from the current login.
    expect(script).toContain('gh api user -q .login');
    expect(script).toContain('gh auth switch --hostname github.com --user "$GH_ACCOUNT"');
    expect(script).toMatch(/if \[ -n "\$\{GH_ACCOUNT:-\}" \]/);
  });

  // crew#317: the overlay def that shipped run d1bc72c2 began `set -e` with NO pipefail, which
  // is why its `gh … | tail -1` reported tail's status and the phase passed on a failed PR. This
  // script has always carried pipefail; it keeps it, and no longer depends on it for the verdict.
  it('keeps `set -euo pipefail` as line 1 — the overlay that lost a gh failure had only `set -e`', () => {
    expect(script.split('\n')[0]).toBe('set -euo pipefail');
  });
});

describe('deliverPrPhase (the PhaseDef shape core accepts)', () => {
  it('is a neutral auto-gated build Tool phase running the hardened script', () => {
    const phase = deliverPrPhase(['review']);
    expect(phase).toMatchObject({
      id: DELIVER_PHASE_ID,
      kind: 'build',
      gate: 'auto',
      executes_code: false,
      role: 'neutral',
      depends_on: ['review'],
    });
    expect(phase.executor).toEqual({ type: 'tool', cmd: ['bash', '-lc', deliverPrScript()] });
    // The fields core's serde would default are spelled out so the def satisfies crew's own
    // WorkflowDef type without casts.
    expect(phase.gate_type).toBeNull();
    expect(phase.required_deliverables).toEqual([]);
    expect(phase.skill_ref).toBeNull();
    expect(phase.allowed_skills).toEqual([]);
  });

  // crew#317 — the delivering phase was the one phase nothing re-derived (`verified_evidence:
  // false`, `validator_pin: null`, `governed=false`). It declares verified_evidence AND pins the
  // built-in evidence floor explicitly (EVIDENCE_FLOOR_PIN — "the run left a change in its
  // worktree"): since wicked-core#414 the engine judges a def as authored and REFUSES a flagged
  // phase with no pin, and the floor is the one pin that always resolves (seeded on core's plan
  // path) — crew still mints no pin of its own.
  it('declares verified_evidence and pins the built-in evidence floor explicitly', () => {
    const phase = deliverPrPhase(['review']);
    expect(phase.verified_evidence).toBe(true);
    expect(phase.validator_pin).toBe(EVIDENCE_FLOOR_PIN);
    expect(EVIDENCE_FLOOR_PIN).toBe('e2e7af1db9e48454');
  });

  it('threads the run intent into the script it carries', () => {
    const phase = deliverPrPhase(['review'], 'ship the deliver fix');
    expect(phase.executor).toEqual({
      type: 'tool',
      cmd: ['bash', '-lc', deliverPrScript('ship the deliver fix')],
    });
    // The intent is the title (heredoc line 1) — the F-3R2-014 headline never comes back.
    const cmd = (phase.executor as { cmd: string[] }).cmd[2]!.split('\n');
    expect(cmd[cmd.indexOf(`  cat > "$TD/text" <<'${DELIVER_TEXT_HEREDOC}'`) + 1]).toBe('ship the deliver fix');
    expect(cmd.join('\n')).not.toContain('wicked-crew run $R:');
  });
});

describe('composeDeliverWorkflow (per-run composition)', () => {
  const feature = BUILTIN_WORKFLOWS.find((w) => w.id === 'feature')!;

  it('appends deliver exactly once, last, depending on the base’s last phase', () => {
    const composed = composeDeliverWorkflow(feature, 'run-123');
    expect(composed.phases).toHaveLength(feature.phases.length + 1);
    const delivers = composed.phases.filter((p) => p.id === DELIVER_PHASE_ID);
    expect(delivers).toHaveLength(1);
    expect(composed.phases[composed.phases.length - 1]!.id).toBe(DELIVER_PHASE_ID);
    expect(delivers[0]!.depends_on).toEqual(['review']);
  });

  it('mints a run-scoped id and never mutates the shared def', () => {
    const before = JSON.stringify(feature);
    const composed = composeDeliverWorkflow(feature, 'run-123');
    expect(composed.id).toBe('feature-deliver-run-123');
    // The SHARED def must be byte-identical afterwards — per-run composition, not mutation.
    expect(JSON.stringify(feature)).toBe(before);
    expect(feature.phases.some((p) => p.id === DELIVER_PHASE_ID)).toBe(false);
    // And the composed def is register-input, not catalog data: no is_system field, which
    // core's overlay schema rejects as unknown.
    expect('is_system' in composed).toBe(false);
  });

  it('keeps the composed id inside registerWorkflow’s safe charset', () => {
    const composed = composeDeliverWorkflow(feature, 'run/../../etc:passwd');
    expect(composed.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  });

  it('bakes the daemon origin, the run link, the repo and the phase list into the deliver phase (crew#524)', () => {
    const composed = composeDeliverWorkflow(feature, 'run-123', 'ship it (fixes #9)', {
      repoRef: 'wicked-crew',
      apiOrigin: 'http://127.0.0.1:7701',
    });
    const deliver = composed.phases[composed.phases.length - 1]!;
    const cmd = (deliver.executor as { cmd: string[] }).cmd[2]!;
    expect(cmd).toContain("API='http://127.0.0.1:7701'");
    expect(cmd).toContain('- Run: [`run-123`](http://127.0.0.1:7701/runs/run-123)');
    expect(cmd).toContain('workflow `feature` · repo `wicked-crew`');
    expect(cmd).toContain('Fixes #9');
    for (const p of feature.phases) expect(cmd).toContain(`| \`${p.id}\` | ${p.kind} | ${p.role} |`);
    // Without a daemon (CLI-driven launch): no callback, no link, still a full fallback text.
    const bare = (composeDeliverWorkflow(feature, 'run-123', 'ship it').phases.at(-1)!.executor as { cmd: string[] }).cmd[2]!;
    expect(bare).toContain("API=''");
    expect(bare).toContain('- Run: `run-123`');
  });

  it('refuses a def that already delivers — the caller launches it as-is instead', () => {
    const alreadyDelivering: WorkflowDef = {
      id: 'feature-pr',
      phases: [...feature.phases, deliverPrPhase(['review'])],
    };
    expect(() => composeDeliverWorkflow(alreadyDelivering, 'run-123')).toThrow(/already has/);
  });
});


describe('deliver review follow-ups (#303)', () => {
  it('refuses the derived default branch, not only main/master', () => {
    const script = deliverPrScript();
    expect(script).toContain('DEF="${D#origin/}"');
    expect(script).toContain('"$DEF"');
    // derivation must precede the refusal so $DEF is bound when the case runs
    expect(script.indexOf('DEF=')).toBeLessThan(script.indexOf('case "$B"'));
  });
  it('caps the composed workflow id at 128 chars', () => {
    const base = { id: 'feature', phases: [{ id: 'build' }] } as never;
    const longRun = 'r'.repeat(300);
    const composed = composeDeliverWorkflow(base, longRun);
    expect(composed.id.length).toBeLessThanOrEqual(128);
    expect(composed.id.startsWith('feature-deliver-')).toBe(true);
  });
});

// crew#317 → wicked-core#414 — the deliver phase's governance is a CROSS-REPO claim: crew pins a
// floor and relies on wicked-core to run it. Transcribing that belief into a comment is the drift
// this repo keeps paying for (FINDING-049/-084/-088), so it is DERIVED from core's own source, in
// the established style of the sibling drift guards.
//
// The mechanism, in core's `workflow.rs`: `WorkflowRegistry::register` — the choke point every def
// crosses, including crew's per-run `registerWorkflow` — judges the def AS AUTHORED and REFUSES a
// `verified_evidence` phase that names no validator (`refuse_unpinned_verified_evidence`). Nothing
// is armed on crew's behalf any more (the old `enforce_verified_evidence` is gone), which is why
// `deliverPrPhase` pins `EVIDENCE_FLOOR_PIN` itself — the one pin that always resolves — and why
// that pin must equal core's constant.
describe.skipIf(SKIP_CORE_CHECKS)('the engine refuses an unpinned verified_evidence phase as authored (cross-repo)', () => {
  const workflowRs = (): string => {
    const path = join(requireCoreDir(), 'src', 'workflow.rs');
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(
        `cannot read core's src/workflow.rs at ${path}: ${e instanceof Error ? e.message : String(e)}\n` +
          "  The deliver phase's ONLY governance is the evidence floor it pins, which core runs " +
          'because it is pinned. If registration moved, follow it — do not delete this guard.',
      );
    }
  };

  it('register() refuses a flagged phase with no pin — and no longer arms one', () => {
    const src = workflowRs();
    expect(src).toContain('refuse_unpinned_verified_evidence(&def)?;');
    expect(src).toContain(
      'fn refuse_unpinned_verified_evidence(def: &WorkflowDef) -> Result<(), WorkflowDefError> {',
    );
    expect(src).toContain('.find(|p| p.verified_evidence && p.validator_pin.is_none())');
    // The arming pass is gone: a def is what it says it is.
    expect(src).not.toContain('fn enforce_verified_evidence(');
    expect(src).not.toContain('fn carry_shadowed_pins(');
  });

  it("crew's pin IS core's built-in evidence floor", () => {
    const floors = readFileSync(join(requireCoreDir(), 'src', 'builtin_floors.rs'), 'utf8');
    expect(floors).toContain(`pub const EVIDENCE_FLOOR_PIN: &str = "${EVIDENCE_FLOOR_PIN}";`);
  });

  it('the floor it arms re-derives done from the worktree, committed work included', () => {
    const floors = readFileSync(join(requireCoreDir(), 'src', 'builtin_floors.rs'), 'utf8');
    // The criterion the deliver phase inherits — the product thesis stated as a check.
    expect(floors).toContain(
      'the run left a change in its worktree (done is re-derived from the diff, never asserted)',
    );
    // Clause 2 (core#280) is the one that matters here: the deliver phase COMMITS the run's work,
    // so a floor reading `git status --porcelain` alone would deny every delivered run.
    expect(floors).toContain("git log --oneline HEAD --not --exclude='wicked/*' --branches");
  });
});
