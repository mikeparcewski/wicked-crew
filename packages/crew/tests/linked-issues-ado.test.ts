// crew#1838 — a launch on an Azure DevOps repository whose intent names AB#<id> reads that work item into the run's
// linked-issues block, with the daemon's Azure DevOps credential; a GitHub repository never hands AB#<id> to gh, and a
// pull request named as one ("Revise PR #1") is not read as an issue (crew#1840's W2).
//
// The work item is served by a loopback mock of the Azure DevOps REST API that refuses any request without the PAT's
// Basic header. Its body is the REST answer the live proof captured (`GET …/_apis/wit/workitems/1?$expand=all`, HTTP
// 200, ado-proof lane 2026-11-23) with the identity fields scrubbed to fixture values: tests/fixtures/ado/wi-1-get.json.
// The real deliver helper runs (`node ado.mjs workitem …`), so the header is minted where production mints it.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAdoHelperExec, type AdoHelperExec, type GhExec } from '../src/core/deliver.js';
import { htmlText, normalizeIssueRef, resolveLinkedIssues } from '../src/core/linked-issues.js';

const PAT = 'pat-SECRET-0123456789abcdef'; // ggignore: a made-up test value, never a real token
const BASIC = `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`;
const WI_1 = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ado', 'wi-1-get.json'), 'utf8')) as { fields: Record<string, unknown> };
const TITLE = 'Bug: sum() drops the first element, so sum([1,2,3]) returns 5 and mean() is wrong';
const ADO_ORIGIN = 'https://dev.azure.com/org/proj/_git/repo';
/** The intent the live proof launched (leg 2). */
const LEG2_INTENT = 'In the wicked repo, fix AB#1: sum() in src/math.js returns the wrong total. The work item has the repro and the acceptance criteria.';
/** The revision launch body's problem the live proof sent (leg 3, notes/leg3-api-body.json). */
const LEG3_PROBLEM = 'Revise PR #1: add a test in test/math.test.js that sum([0, 2, 3]) is 5 and sum([-1, 1]) is 0 (refs AB#1). Keep src/math.js as it is.';

const servers: Server[] = [];
const ENV = ['AZURE_DEVOPS_EXT_PAT', 'CREW_ADO_TENANT_ID', 'CREW_ADO_CLIENT_ID', 'CREW_ADO_CLIENT_SECRET'];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  // Every ADO credential the helper could read is pinned (a configured machine's service principal must never reach
  // the loopback), then the PAT is set.
  saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));
  for (const n of ENV) delete process.env[n];
  process.env['AZURE_DEVOPS_EXT_PAT'] = PAT;
});
afterEach(async () => {
  for (const n of ENV) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

interface Mock {
  url: string;
  seen: Array<{ path: string; auth: string }>;
}

/** A loopback Azure DevOps: work items by id under /org/proj, comments when asked. */
async function mockAdo(items: Record<string, unknown>, comments?: unknown): Promise<Mock> {
  const seen: Mock['seen'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const auth = String(req.headers['authorization'] ?? '');
    seen.push({ path: `${u.pathname}${u.search}`, auth });
    if (auth !== BASIC) {
      // Azure DevOps answers a bad PAT with 203 and its sign-in page.
      res.writeHead(203, { 'content-type': 'text/html' });
      res.end('<html>sign in</html>');
      return;
    }
    const c = /^\/org\/proj\/_apis\/wit\/workItems\/(\d+)\/comments$/.exec(u.pathname);
    if (c !== null && comments !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(comments));
      return;
    }
    const m = /^\/org\/proj\/_apis\/wit\/workitems\/(\d+)$/.exec(u.pathname);
    const item = m === null ? undefined : items[m[1]!];
    if (item === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'TF401232: Work item 9 does not exist, or you do not have permissions to read it.' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(item));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

/** The real helper, its project base re-pointed at the loopback (the production one is https://dev.azure.com/org/proj). */
function helperAt(mock: Mock, calls: string[][] = []): AdoHelperExec {
  return (args, opts) => {
    calls.push(args);
    expect(args.slice(0, 3)).toEqual(['workitem', 'https://login.microsoftonline.com', 'https://dev.azure.com/org/proj']);
    return defaultAdoHelperExec(['workitem', mock.url, `${mock.url}/org/proj`, ...args.slice(3)], opts);
  };
}

/** A gh that must not be asked for anything but the listed refs. */
function gh(answers: Record<string, string> = {}): { exec: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GhExec = async (args) => {
    calls.push(args);
    const key = args.slice(2, args.indexOf('--json')).join(' ');
    const out = answers[key];
    return out === undefined ? { stdout: '', stderr: 'none of the git remotes configured for this repository point to a known GitHub host.', code: 1 } : { stdout: out, stderr: '', code: 0 };
  };
  return { exec, calls };
}

describe('crew#1838 AB#<id> on an Azure DevOps repository', () => {
  it('the live proof\'s intent reads work item 1 into the block: title, type and state, the description as text; gh is never asked', async () => {
    const mock = await mockAdo({ '1': WI_1 });
    const g = gh();
    const calls: string[][] = [];
    const r = await resolveLinkedIssues(LEG2_INTENT, '/srv/wicked', 'wicked', g.exec, [], undefined, { origin: async () => ADO_ORIGIN, exec: helperAt(mock, calls) });
    expect(g.calls).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(r.issues).toEqual([{ ref: 'AB#1', resolved: true, title: TITLE, chars: expect.any(Number) }]);
    expect(r.block).toContain(`### AB#1: ${TITLE} (Issue, To Do)`);
    expect(r.block).toContain('https://dev.azure.com/example-org/00000000-0000-0000-0000-0000000000aa/_workitems/edit/1');
    expect(r.block).toContain('Repro: in src/math.js, sum([1,2,3]) returns 5 instead of 6.');
    expect(r.block).toContain('Acceptance: sum adds every element; an empty array still sums to 0;');
    expect(r.block).not.toMatch(/<p>|<code>|<b>/);
    // The item has no comments (System.CommentCount 0): none are asked for.
    expect(mock.seen.map((s) => s.path)).toEqual(['/org/proj/_apis/wit/workitems/1?$expand=all&api-version=7.1']);
    // The credential rode the request, never the block.
    expect(mock.seen[0]!.auth).toBe(BASIC);
    expect(r.block).not.toContain(PAT);
    expect(r.block).not.toContain(Buffer.from(`:${PAT}`).toString('base64'));
    expect(r.block).not.toContain('test.person@example.com');
  }, 30_000);

  it('a work item with comments carries them, as text, under their authors', async () => {
    const withComments = { ...WI_1, fields: { ...WI_1.fields, 'System.CommentCount': 1 } };
    // The comments API's shape (wit/workItems/{id}/comments, api-version 7.1-preview.4): `comments[].text` is HTML.
    const mock = await mockAdo({ '1': withComments }, { totalCount: 1, count: 1, comments: [{ workItemId: 1, commentId: 7, version: 1, text: '<div>Also <b>mean([])</b> should be 0.</div>', createdBy: { displayName: 'Test Reviewer' } }] });
    const r = await resolveLinkedIssues('fix AB#1', '/srv/wicked', 'wicked', gh().exec, [], undefined, { origin: async () => ADO_ORIGIN, exec: helperAt(mock) });
    expect(r.issues[0]).toMatchObject({ ref: 'AB#1', resolved: true });
    expect(r.block).toContain('Comments (1):');
    expect(r.block).toContain('- Test Reviewer: Also mean([]) should be 0.');
  }, 30_000);

  it('cannot read it: says why in Azure DevOps terms (no credential, no such item, a refused credential)', async () => {
    const mock = await mockAdo({ '1': WI_1 });
    delete process.env['AZURE_DEVOPS_EXT_PAT'];
    const none = await resolveLinkedIssues('fix AB#1', '/srv/wicked', 'wicked', gh().exec, [], undefined, { origin: async () => ADO_ORIGIN, exec: helperAt(mock) });
    expect(none.issues).toEqual([{ ref: 'AB#1', resolved: false, error: expect.stringContaining('this daemon holds no Azure DevOps credential: set AZURE_DEVOPS_EXT_PAT') }]);
    expect(mock.seen).toEqual([]);
    process.env['AZURE_DEVOPS_EXT_PAT'] = PAT;
    const missing = await resolveLinkedIssues('fix AB#9', '/srv/wicked', 'wicked', gh().exec, [], undefined, { origin: async () => ADO_ORIGIN, exec: helperAt(mock) });
    expect(missing.issues).toEqual([{ ref: 'AB#9', resolved: false, error: expect.stringContaining('Azure DevOps has no work item 9') }]);
    expect(missing.block).toContain('### AB#9: could not be read (Azure DevOps has no work item 9');
    process.env['AZURE_DEVOPS_EXT_PAT'] = 'pat-wrong-0123456789'; // ggignore: a made-up test value
    const refused = await resolveLinkedIssues('fix AB#1', '/srv/wicked', 'wicked', gh().exec, [], undefined, { origin: async () => ADO_ORIGIN, exec: helperAt(mock) });
    expect(refused.issues[0]).toMatchObject({ ref: 'AB#1', resolved: false, error: expect.stringContaining("Azure DevOps refused the daemon's credential for work item 1") });
    expect(JSON.stringify(refused)).not.toContain('pat-wrong-0123456789');
  }, 30_000);

  it('a bare #N on an Azure DevOps repository is not handed to gh; it says how to name a work item', async () => {
    const g = gh();
    const r = await resolveLinkedIssues('fix #2', '/srv/wicked', 'wicked', g.exec, [], undefined, { origin: async () => ADO_ORIGIN, exec: async () => ({ stdout: '', stderr: '', code: 1 }) });
    expect(g.calls).toEqual([]);
    expect(r.issues).toEqual([{ ref: '#2', resolved: false, error: 'this repository is on Azure DevOps: name a work item as AB#<id>' }]);
  });

  it('the live proof\'s revision launch: "Revise PR #1 … (refs AB#1)" reads AB#1 and never reads PR #1 as an issue', async () => {
    const mock = await mockAdo({ '1': WI_1 });
    const g = gh();
    const r = await resolveLinkedIssues(LEG3_PROBLEM, '/srv/wicked', 'wicked', g.exec, [], undefined, { origin: async () => ADO_ORIGIN, exec: helperAt(mock) });
    expect(g.calls).toEqual([]);
    expect(r.issues.map((i) => i.ref)).toEqual(['AB#1']);
    expect(r.issues[0]!.resolved).toBe(true);
  }, 30_000);

  it('an exclusion spelled ab#1 leaves AB#1 out', async () => {
    expect(normalizeIssueRef('ab#01')).toBe('AB#1');
    const calls: string[][] = [];
    const r = await resolveLinkedIssues('fix ab#1', '/srv/wicked', 'wicked', gh().exec, ['ab#1'], undefined, { origin: async () => ADO_ORIGIN, exec: async (a) => (calls.push(a), { stdout: '', stderr: '', code: 1 }) });
    expect(calls).toEqual([]);
    expect(r.issues).toEqual([{ ref: 'AB#1', resolved: false, excluded: true, error: 'left out by the launch (excludeLinkedIssues)' }]);
  });
});

describe('crew#1838 AB#<id> and PR #N on a GitHub repository', () => {
  const GH_ISSUE = JSON.stringify({ title: 'Crash on empty input', state: 'OPEN', body: 'b', comments: [] });

  it('AB#<id> is never read through gh: it is named as not read; a GitHub #N beside it is read as before', async () => {
    const g = gh({ '541': GH_ISSUE });
    const helper: string[][] = [];
    const r = await resolveLinkedIssues('fix #541 (also tracked as AB#1)', '/srv/repo', 'repo', g.exec, [], undefined, { origin: async () => 'https://github.com/o/repo.git', exec: async (a) => (helper.push(a), { stdout: '', stderr: '', code: 1 }) });
    expect(g.calls.map((c) => c.slice(0, 3))).toEqual([['issue', 'view', '541']]);
    expect(helper).toEqual([]);
    expect(r.issues).toEqual([
      { ref: '#541', resolved: true, title: 'Crash on empty input', chars: expect.any(Number) },
      { ref: 'AB#1', resolved: false, error: "an Azure Boards work item, and this run's repository is not on Azure DevOps" },
    ]);
  });

  it('"Revise PR #1" names a pull request, not issue #1; "PR#1" too; a #1 also named on its own is still read', async () => {
    const g = gh({ '1': GH_ISSUE });
    const origin = { origin: async () => 'https://github.com/o/repo.git' };
    expect((await resolveLinkedIssues('Revise PR #1: add a test', '/srv/repo', 'repo', g.exec, [], undefined, origin)).issues).toEqual([]);
    expect((await resolveLinkedIssues('Update pull request #1 and PR#1', '/srv/repo', 'repo', g.exec, [], undefined, origin)).issues).toEqual([]);
    expect(g.calls).toEqual([]);
    const both = await resolveLinkedIssues('Revise PR #1 so it also fixes #1', '/srv/repo', 'repo', g.exec, [], undefined, origin);
    expect(both.issues.map((i) => i.ref)).toEqual(['#1']);
  });
});

describe('htmlText', () => {
  it('turns an Azure Boards description into lines of text, entities decoded', () => {
    expect(htmlText('<p><b>Repro:</b> a &lt; b &amp;&amp; c</p><ul><li>one</li><li>two</li></ul><div>x<br>y&nbsp;z &#39;q&#39;</div>')).toBe(
      "Repro: a < b && c\n\n- one\n- two\nx\ny z 'q'",
    );
  });
});
