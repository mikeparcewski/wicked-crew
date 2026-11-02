import { describe, expect, it } from 'vitest';
import { reassignRefusedSeats } from '../src/core/reassign-refusal.js';
import type { SessionView } from '../src/core/types.js';

// artifact-runs-fix: crew serves the seats the ENGINE refuses as a reassign target
// (`WorkUnit.reassign_refused`), and studio never offers one. The mirror must match wicked-core's
// `work_authors` exactly: a guarded read-only recon step (the run's pa-scope) authored nothing, so
// its seat stays a valid reviewer — the engine accepts that reassign, and crew must not refuse it.
function view(units: Array<Record<string, unknown>>): SessionView {
  return { session: { id: 'r', status: 'awaiting_human', assurance: { mode: 'full', required: ['distinct_evaluator', 'judge'] } }, units } as unknown as SessionView;
}
const scope = { ord: 1, stage: 'recon', role: 'neutral', assigned_cli: 'claude', worktree_guarded: true };
const build = { ord: 2, stage: 'build', role: 'creator', assigned_cli: 'codex' };
const review = { ord: 3, stage: 'review', role: 'evaluator', assigned_cli: 'pi' };

describe('reassign_refused mirrors the engine', () => {
  it('a guarded read-only recon step does not make its seat an author', () => {
    expect(reassignRefusedSeats(view([scope, build, review]), 3)).toEqual(['codex']);
  });
  it('a read step that recorded an author counts that author, never its own seat; one that kept a tree change counts', () => {
    expect(reassignRefusedSeats(view([{ ...scope, assigned_cli: 'pi2', authored_by: ['claude'] }, build, review]), 3)).toEqual(['claude', 'codex']);
    expect(reassignRefusedSeats(view([{ ...scope, worktree_mutation: { restored: false } }, build, review]), 3)).toEqual(['claude', 'codex']);
  });
  it('a restored mutation, or a team member read step, is still a read step', () => {
    expect(reassignRefusedSeats(view([{ ...scope, worktree_mutation: { restored: true } }, build, review]), 3)).toEqual(['codex']);
    expect(reassignRefusedSeats(view([{ ...scope, worktree_guarded: false, owner: 'team' }, build, review]), 3)).toEqual(['codex']);
  });
  it('an unguarded or code-running recon step is an author', () => {
    expect(reassignRefusedSeats(view([{ ...scope, worktree_guarded: false }, build, review]), 3)).toEqual(['claude', 'codex']);
    expect(reassignRefusedSeats(view([{ ...scope, executes_code: true }, build, review]), 3)).toEqual(['claude', 'codex']);
  });
  it('a creator whose earlier attempt ran on another seat counts both (968e8c7c: claude then codex)', () => {
    expect(reassignRefusedSeats(view([scope, { ...build, authored_by: ['claude', 'codex'] }, review]), 3)).toEqual(['codex', 'claude']);
  });
});
