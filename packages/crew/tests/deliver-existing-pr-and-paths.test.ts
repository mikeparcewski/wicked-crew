// crew#885 + crew#886 — the deliver phase's two dogfood findings (rig run c3aa0bfb):
//   - a re-run deliver whose run branch already has its PR records THAT PR as the run's delivery,
//     including on a run the operator cancelled afterwards (the resolver reads any terminal frame);
//   - the PR title/body/commit text never carries the daemon's home directory: seat reports quoted
//     verbatim are rewritten `<home>/x` → `~/x` through crew#618's rewrite.
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DeliveryResolver, type DeliveryRecord } from '../src/api/delivery-index.js';
import { composeDeliverText, factsFromWorkflow, redactHostPaths } from '../src/core/deliver-text.js';
import type { SessionView } from '../src/core/types.js';

const PR_URL = 'https://github.com/o/r/pull/1';
/** The deliver transcript of a re-run whose PR already exists (core/deliver.ts step e3). */
const EXISTING_PR_TRANSCRIPT = [
  'Everything up-to-date',
  `a pull request for branch "wicked/run-a" into branch "main" already exists:`,
  PR_URL,
  `deliver: pull request ${PR_URL} already exists for wicked/run-a (an earlier attempt of this run opened it); the push updated it with 3 commit(s) on top of main — recorded as this run's delivery`,
  `deliver: run record commented on ${PR_URL}`,
  PR_URL,
].join('\n');

function view(status: string): SessionView {
  return {
    session: { id: 'run-a', status, repo_ref: 'repo-1', workdir: '/w' },
    units: [
      { id: 'run-a:build', ord: 4, status: 'done', tool_cmd: [] },
      { id: 'run-a:deliver', ord: 8, status: 'done', tool_cmd: [] },
      { id: 'run-a:install', ord: 9, status: 'rejected', tool_cmd: [] },
    ],
  } as unknown as SessionView;
}

describe('crew#885: an existing PR for the run branch is the delivery', () => {
  it.each(['completed', 'failed', 'cancelled'])('records it on a %s run', async (status) => {
    const recorded: Array<[string, DeliveryRecord]> = [];
    const resolver = new DeliveryResolver({
      listViews: async () => [view(status)],
      workOutput: async () => EXISTING_PR_TRANSCRIPT,
      isDelivered: () => false,
      record: (runId, record) => recorded.push([runId, record]),
    });
    await resolver.resolve('run-a');
    expect(recorded).toEqual([['run-a', { url: PR_URL }]]);
  });
});

describe('crew#886: deliver text carries no home-directory path', () => {
  const home = homedir().replace(/[\\/]+$/, '');

  it('rewrites the home prefix to ~ and leaves other paths and a longer sibling alone', () => {
    const text = `Worktree: \`${home}/.wicked/repos/petstore/wicked-worktrees/run-a\`; root ${home}. sibling ${home}-old/x; other /srv/x`;
    expect(redactHostPaths(text, home)).toBe(
      `Worktree: \`~/.wicked/repos/petstore/wicked-worktrees/run-a\`; root ~. sibling ${home}-old/x; other /srv/x`,
    );
  });

  it('redacts a bare home followed by more punctuation (compact JSON), never a longer sibling', () => {
    expect(redactHostPaths(`{"home":"${home}","next":1} ${home}.bak`, home)).toBe(`{"home":"~","next":1} ${home}.bak`);
  });

  it('a home path cut by the title width still leaves no part of it (facts redacted before the cut)', () => {
    const intent = `${'x'.repeat(230)} ${home}/work/petstore and more words after it to force the cut`;
    const text = composeDeliverText(factsFromWorkflow({ runId: 'run-a', intent, workflowId: null, repoRef: null, phases: [], runUrl: null }));
    const user = home.split(/[\\/]/).filter(Boolean).pop()!;
    expect(text.title).not.toContain(user);
    expect(text.body).not.toContain(home);
  });

  it('leaves the text alone when there is no usable home', () => {
    expect(redactHostPaths('/srv/x', null)).toBe('/srv/x');
  });

  it('scrubs the composed title and body (the PR body and the commit message both come from it)', () => {
    const facts = {
      ...factsFromWorkflow({ runId: 'run-a', intent: `build it in ${home}/work/petstore`, workflowId: 'mcp-server', repoRef: null, phases: [], runUrl: null }),
      source: 'run' as const,
      reports: [{ phase: 'build', seat: 'claude', role: 'creator' as const, report: `Worktree: \`${home}/.wicked/repos/p/wicked-worktrees/run-a\`` }],
    };
    const text = composeDeliverText(facts);
    expect(text.body).toContain('Worktree: `~/.wicked/repos/p/wicked-worktrees/run-a`');
    expect(text.body).not.toContain(`${home}/`);
    expect(text.title).not.toContain(`${home}/`);
  });
});
