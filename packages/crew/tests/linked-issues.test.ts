// crew#627 — the daemon reads the issues a launch's intent links, under its own gh identity, and
// hands their text to the run; what it could not read is said, never skipped.
import { describe, expect, it } from 'vitest';

import type { GhExec } from '../src/core/deliver.js';
import {
  LINKED_ISSUES_CLOSE,
  LINKED_ISSUES_OPEN,
  MAX_LINKED_ISSUES,
  resolveLinkedIssues,
  stripLinkedIssues,
} from '../src/core/linked-issues.js';

/** A stub gh that answers `issue view <n>` from a table and records every call. */
function stubGh(answers: Record<string, { stdout?: string; stderr?: string; code?: number | null }>): { exec: GhExec; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const exec: GhExec = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const key = args.slice(2, args.indexOf('--json')).join(' ');
    const a = answers[key] ?? { stderr: 'To get started with GitHub CLI, please run: gh auth login', code: 4 };
    return { stdout: a.stdout ?? '', stderr: a.stderr ?? '', code: a.code === undefined ? 0 : a.code };
  };
  return { exec, calls };
}

const ISSUE_541 = JSON.stringify({
  title: 'Gate hook records a path as the tool name',
  state: 'OPEN',
  body: 'Steps:\n1. run a unit\n2. see `(unknown)`',
  url: 'https://github.com/o/r/issues/541',
  comments: [{ author: { login: 'reviewer' }, body: 'Also happens on retries.' }],
});

describe('resolveLinkedIssues', () => {
  it('"fix #541" reaches the run with the issue title, body and comments', async () => {
    const { exec, calls } = stubGh({ '541': { stdout: ISSUE_541 } });
    const r = await resolveLinkedIssues('fix #541', '/srv/repo', 'repo', exec);
    expect(calls).toEqual([{ args: ['issue', 'view', '541', '--json', 'title,state,body,url,comments'], cwd: '/srv/repo' }]);
    expect(r.issues).toEqual([{ ref: '#541', resolved: true, title: 'Gate hook records a path as the tool name' }]);
    expect(r.block).not.toBeNull();
    expect(r.block!.startsWith(LINKED_ISSUES_OPEN)).toBe(true);
    expect(r.block!.endsWith(LINKED_ISSUES_CLOSE)).toBe(true);
    expect(r.block).toContain('### #541: Gate hook records a path as the tool name (OPEN)');
    expect(r.block).toContain('2. see `(unknown)`');
    expect(r.block).toContain('- reviewer: Also happens on retries.');
  });

  it('a failed read is disclosed in the block and in the answer — never silent', async () => {
    const { exec } = stubGh({});
    const r = await resolveLinkedIssues('fix #540', '/srv/repo', 'repo', exec);
    expect(r.issues).toEqual([{ ref: '#540', resolved: false, error: 'gh exit 4: To get started with GitHub CLI, please run: gh auth login' }]);
    expect(r.block).toContain('### #540: could not be read (gh exit 4: To get started with GitHub CLI');
  });

  it('reads an `owner/repo#N` with -R; an owner-less other-repo ref cannot be read and says why', async () => {
    const { exec, calls } = stubGh({ '7 -R o/other': { stdout: JSON.stringify({ title: 'Other', state: 'CLOSED', body: '', comments: [] }) } });
    const r = await resolveLinkedIssues('see o/other#7 and elsewhere#3', undefined, 'repo', exec);
    expect(calls.map((c) => c.args.slice(0, 5))).toEqual([['issue', 'view', '7', '-R', 'o/other']]);
    expect(r.issues).toEqual([
      { ref: 'o/other#7', resolved: true, title: 'Other' },
      { ref: 'elsewhere#3', resolved: false, error: 'no owner/repo to read it from' },
    ]);
    // A same-repo `#N` on a repo-less run has nowhere to read from.
    const none = await resolveLinkedIssues('fix #1', undefined, undefined, exec);
    expect(none.issues[0]).toEqual({ ref: '#1', resolved: false, error: 'the run has no repository to read it from' });
  });

  it('no issue named ⇒ nothing read, no block', async () => {
    const { exec, calls } = stubGh({});
    expect(await resolveLinkedIssues('tidy the README', '/srv/repo', 'repo', exec)).toEqual({ issues: [], block: null });
    expect(calls).toEqual([]);
  });

  it(`reads at most ${MAX_LINKED_ISSUES} and names the rest as not read`, async () => {
    const { exec, calls } = stubGh({});
    const r = await resolveLinkedIssues('fix #1 #2 #3 #4 #5 #6 #7', '/srv/repo', 'repo', exec);
    expect(calls).toHaveLength(MAX_LINKED_ISSUES);
    expect(r.issues).toHaveLength(7);
    expect(r.issues.slice(MAX_LINKED_ISSUES).every((i) => !i.resolved && /at most 5/.test(i.error ?? ''))).toBe(true);
    expect(r.block).toContain('Not read (a launch reads at most 5 issues): #6, #7');
  });

  it('stripLinkedIssues takes the block back out, and a re-resolve never reads the block’s own mentions', async () => {
    const problem = `fix #541\n\n${LINKED_ISSUES_OPEN}\n### #541: x\nmentions #9\n${LINKED_ISSUES_CLOSE}`;
    expect(stripLinkedIssues(problem)).toBe('fix #541');
    expect(stripLinkedIssues('no block')).toBe('no block');
    const { exec, calls } = stubGh({});
    await resolveLinkedIssues(problem, '/srv/repo', 'repo', exec);
    expect(calls.map((c) => c.args[2])).toEqual(['541']);
  });
});
