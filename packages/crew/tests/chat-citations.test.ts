// crew#561 — chat citations are VERIFIED before a reader sees them, and what cannot be verified is
// marked. Three halves:
//
//  1. Extraction (pure): which tokens in a reply are citations at all — and which prose-shaped
//     look-alikes are deliberately NOT (`e.g`, a word that happens to be hex, a version number).
//  2. Verification against REAL repos (two mkdtemp git repos, two commits): the RC1 Phase 6 defect
//     reproduced — a fabricated SHA reads `unverified`, an off-by line ref reads `corrected` with
//     the actual line, a symbol that is not in the file reads `unverified`, and every real path,
//     real line and real SHA reads `verified` (0 false positives). Plus the bounds: an over-budget
//     pass reports `unchecked`, never a guess.
//  3. The server wiring (createServer + a fake adapter + a real /ws client): a `chatReply` on the
//     daemon's relay produces exactly ONE `chatCitations` frame, stamped with the reply's own
//     `turn_id`, AFTER the reply frame itself — and that reply frame is the crew#618-rewritten one
//     (repo-relative paths), which is what the broadcast rewrite was missing a server-level test
//     for (crew#634 R1).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';

import {
  chatCitationDeps,
  citationsFrame,
  extractCitations,
  verifyCitations,
  type ChatCitationDeps,
  type ChatCitationItem,
  type ChatCitationsFrame,
  type CitationRoot,
} from '../src/api/chat-citations.js';
import { createServer } from '../src/api/server.js';
import { setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

/**
 * A git repo with one file and one commit; returns the commit sha.
 *
 * The commit is AMENDED until its 7-character prefix carries BOTH a digit and an `a-f` letter,
 * because that is exactly what `SHA_RE`'s guard requires of a citation ("a word, a date or a
 * number is not a SHA") and every test here cites `sha.slice(0, 7)`. A random sha whose prefix is
 * all decimal digits is ~3.7 % of commits, and it made this suite red on CI for a reason that had
 * nothing to do with the change under test — the extractor was right and the fixture was unlucky.
 */
function initRepo(root: string, file: string, body: string): string {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body, 'utf8');
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' });
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  const citable = (sha: string): boolean => {
    const head = sha.slice(0, 7);
    return /[0-9]/.test(head) && /[a-f]/.test(head);
  };
  let sha = git('rev-parse', 'HEAD').trim();
  for (let n = 0; n < 50 && !citable(sha); n++) {
    git('commit', '-q', '--amend', '-m', `one ${n}`);
    sha = git('rev-parse', 'HEAD').trim();
  }
  if (!citable(sha)) throw new Error(`could not mint a citable commit sha in this repo (last: ${sha})`);
  return sha;
}

const itemOf = (items: readonly ChatCitationItem[], raw: string): ChatCitationItem | undefined =>
  items.find((i) => i.raw === raw);

/** The deterministic verdicts, with a budget no loaded CI host can exhaust: these tests are about
 *  WHAT the pass decides, and the bound has its own tests below. */
const BIG_BUDGET = { budgetMs: 600_000 } as const;

describe('extractCitations — what is a citation, and what is prose', () => {
  const roots: CitationRoot[] = [
    { name: 'wicked-crew', absRoot: '/srv/repos/wicked-crew' },
    { name: 'wicked-estate', absRoot: '/srv/repos/wicked-estate' },
  ];

  it('finds paths, line refs, symbol refs and SHAs, and keeps the raw token', () => {
    const text =
      'The reply cites `wicked-crew/src/api/routes.ts`, `acceptance.ts:80`, ' +
      '`execute_wrapped.rs:build_worker_command` and crew `6d77153`.';
    const got = extractCitations(text, roots);
    expect(got.map((c) => [c.kind, c.raw])).toEqual([
      ['path', 'wicked-crew/src/api/routes.ts'],
      ['line', 'acceptance.ts:80'],
      ['symbol', 'execute_wrapped.rs:build_worker_command'],
      ['sha', '6d77153'],
    ]);
    expect(got[1]?.line).toBe(80);
    expect(got[2]?.symbol).toBe('build_worker_command');
    // The repo the sentence NAMED rides along, by alias: "crew" is `wicked-crew`.
    expect(got[3]?.repo).toBe('wicked-crew');
  });

  it('reads the symbol a line ref is introduced by, so the ref can be corrected against it', () => {
    const got = extractCitations('`build_worker_command` is at `execute_wrapped.rs:2086`', roots);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'line', line: 2086, symbol: 'build_worker_command' });
  });

  it('is not fooled by prose, versions, dates or hex-looking words', () => {
    const text =
      'e.g. the crew 0.7.33 release of 20260929 effaced the old behaviour; i.e. nothing changed. ' +
      'The colour #abc1234 stays.';
    expect(extractCitations(text, roots)).toEqual([]);
  });

  it('deduplicates by kind and raw token, and keeps text order', () => {
    const got = extractCitations('`a.ts:10` then `6d77153` then `a.ts:10` again', roots);
    expect(got.map((c) => c.raw)).toEqual(['a.ts:10', '6d77153']);
  });
});

describe('verifyCitations — against two real repos (the RC1 Phase 6 defect)', () => {
  let scratch: string;
  let roots: CitationRoot[];
  let alphaSha: string;
  let betaSha: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-citations-'));
    const alpha = join(scratch, 'alpha');
    const beta = join(scratch, 'beta');
    alphaSha = initRepo(
      alpha,
      'src/foo.ts',
      ['// header', 'export function build_worker_command() {', '  return 1;', '}', ''].join('\n'),
    );
    betaSha = initRepo(beta, 'README.md', '# beta\n');
    roots = [
      { name: 'alpha', absRoot: alpha },
      { name: 'beta', absRoot: beta },
    ];
    // Two real `git init` + commit pairs: seconds on a loaded host, so the hook says so rather
    // than tripping vitest's 10 s default.
  }, 60_000);

  afterAll(() => {
    removeScratch(scratch);
  });

  it('marks a fabricated SHA unverified and names what it checked, while every real SHA verifies', async () => {
    const text = `alpha ${alphaSha.slice(0, 7)} landed it; beta ${betaSha.slice(0, 7)} followed. ` +
      'The deliver gate now defaults on: crew `6d77153`.';
    const got = await verifyCitations(text, roots, undefined, BIG_BUDGET);
    expect(itemOf(got.items, alphaSha.slice(0, 7))).toMatchObject({ status: 'verified', resolved: 'alpha' });
    expect(itemOf(got.items, betaSha.slice(0, 7))).toMatchObject({ status: 'verified', resolved: 'beta' });
    const fabricated = itemOf(got.items, '6d77153');
    expect(fabricated?.status).toBe('unverified');
    expect(fabricated?.note).toMatch(/no such commit/);
    expect(got.verified).toBe(2);
    expect(got.unverifiable).toBe(1);
  });

  it('corrects a SHA attributed to the wrong repo instead of calling it fake', async () => {
    const got = await verifyCitations(`beta ${alphaSha.slice(0, 8)}`, roots, undefined, BIG_BUDGET);
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({ status: 'corrected', resolved: 'alpha' });
    expect(got.items[0]?.note).toMatch(/is in alpha, not beta/);
  });

  it('verifies real paths and real line refs, and corrects an off-by line ref to the actual line', async () => {
    const text =
      'See `alpha/src/foo.ts`. `build_worker_command` is at `alpha/src/foo.ts:4`, and line ' +
      '`alpha/src/foo.ts:3` is the body.';
    const got = await verifyCitations(text, roots, undefined, BIG_BUDGET);
    expect(itemOf(got.items, 'alpha/src/foo.ts')).toMatchObject({ status: 'verified' });
    // The symbol the sentence named is on line 2, not the cited 4 — a correction, not a verdict on
    // the whole answer, and never an edit of the seat's text.
    expect(itemOf(got.items, 'alpha/src/foo.ts:4')).toMatchObject({
      status: 'corrected',
      resolved: 'alpha/src/foo.ts:2',
    });
    // A line ref with no symbol named before it is verified on existence alone.
    expect(itemOf(got.items, 'alpha/src/foo.ts:3')).toMatchObject({ status: 'verified' });
  });

  it('resolves a bare file name through the repo index, and marks a line past the end', async () => {
    const got = await verifyCitations('`foo.ts:3` holds it, not `foo.ts:900`', roots, undefined, BIG_BUDGET);
    expect(itemOf(got.items, 'foo.ts:3')).toMatchObject({ status: 'verified' });
    expect(itemOf(got.items, 'foo.ts:900')).toMatchObject({ status: 'unverified' });
    expect(itemOf(got.items, 'foo.ts:900')?.note).toMatch(/5 lines/);
  });

  it('marks a path that is in no repo, and a symbol the cited file does not contain', async () => {
    const got = await verifyCitations('`alpha/src/nope.ts` and `alpha/src/foo.ts:ghost_symbol`', roots, undefined, BIG_BUDGET);
    expect(itemOf(got.items, 'alpha/src/nope.ts')).toMatchObject({ status: 'unverified' });
    expect(itemOf(got.items, 'alpha/src/foo.ts:ghost_symbol')).toMatchObject({ status: 'unverified' });
    expect(itemOf(got.items, 'alpha/src/foo.ts:ghost_symbol')?.note).toMatch(/does not contain ghost_symbol/);
  });

  it('drops a bare prose look-alike rather than marking it — a false mark is worse than a miss', async () => {
    const got = await verifyCitations('nothing.here resolves anywhere', roots, undefined, BIG_BUDGET);
    expect(got.items).toEqual([]);
    expect(citationsFrame({ chat: 'c', cliKey: 'claude' }, got)).toBeNull();
  });

  it('reports the remainder as unchecked when the budget runs out — never as verified', async () => {
    // A clock that jumps past the budget after the first check, and deps that never touch disk.
    let ticks = 0;
    const deps: ChatCitationDeps = {
      ...chatCitationDeps(),
      now: () => (ticks++ < 2 ? 0 : 10_000),
    };
    const got = await verifyCitations(
      `\`alpha/src/foo.ts\` \`alpha/src/foo.ts:3\` ${alphaSha.slice(0, 7)}`,
      roots,
      deps,
      { budgetMs: 100 },
    );
    expect(got.items.map((i) => i.status)).toEqual(['verified', 'unchecked', 'unchecked']);
    expect(got.unchecked).toBe(2);
  });

  it('never resolves out of the read roots — a `..` into a look-alike sibling is unverified', async () => {
    // `/…/alpha-secrets/private.ts` starts with the string `/…/alpha`, so a prefix check would have
    // admitted it (independent review of #722, HIGH). The roots ARE the scope.
    const sibling = join(scratch, 'alpha-secrets');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'private.ts'), 'const secret = 1;\n', 'utf8');
    const got = await verifyCitations('see `alpha/../alpha-secrets/private.ts:1`', roots, undefined, BIG_BUDGET);
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({ status: 'unverified' });
    expect(got.items[0]?.note).toMatch(/no such file/);
  });

  it('a tracked file that is gone from the working tree is not "verified"', async () => {
    // `git ls-files` lists what is TRACKED; the bare-name index must not confirm a file that is not
    // there (independent review of #722).
    const alpha = roots[0]!.absRoot;
    rmSync(join(alpha, 'src/foo.ts'));
    try {
      const got = await verifyCitations('`foo.ts:3` is where it lives', roots, undefined, BIG_BUDGET);
      expect(got.items[0]).toMatchObject({ status: 'unverified' });
    } finally {
      writeFileSync(
        join(alpha, 'src/foo.ts'),
        ['// header', 'export function build_worker_command() {', '  return 1;', '}', ''].join('\n'),
        'utf8',
      );
    }
  });

  it('a SHA whose sweep ran out of budget mid-repos is unchecked, never "in no repo"', async () => {
    let ticks = 0;
    const deps: ChatCitationDeps = {
      ...chatCitationDeps(),
      // Start and the candidate check are inside the budget; the first between-roots read is not.
      now: () => (ticks++ < 2 ? 0 : 10_000),
    };
    const got = await verifyCitations('beta 6d77153 maybe', roots, deps, { budgetMs: 100 });
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({ kind: 'sha', status: 'unchecked' });
    expect(got.items[0]?.note).toMatch(/could not all be checked/);
    expect(got.unverifiable).toBe(0);
  });

  it('a git check that FAILED is unchecked, never a fabrication — a real SHA is never branded', async () => {
    // The worst failure this feature could have: a slow or broken `git cat-file` marking a REAL
    // commit UNVERIFIED. An error is an error (independent review of #722 follow-up).
    const deps: ChatCitationDeps = {
      ...chatCitationDeps(),
      commitExists: async () => 'error',
    };
    const got = await verifyCitations(`alpha ${alphaSha.slice(0, 7)}`, roots, deps, BIG_BUDGET);
    expect(got.items[0]).toMatchObject({ kind: 'sha', status: 'unchecked' });
    expect(got.items[0]?.note).toMatch(/could not all be checked/);
    expect(got.unverifiable).toBe(0);
  });

  it('a repository that could not be LISTED leaves a bare name unchecked, not missing', async () => {
    const deps: ChatCitationDeps = { ...chatCitationDeps(), listFiles: async () => null };
    const got = await verifyCitations('`foo.ts:3` is where it lives', roots, deps, BIG_BUDGET);
    expect(got.items[0]).toMatchObject({ status: 'unchecked' });
    expect(got.items[0]?.note).toMatch(/could not be listed/);
  });

  it('honours the item cap', async () => {
    const got = await verifyCitations('`alpha/src/foo.ts` `foo.ts:3` `alpha/README.md`', roots, undefined, {
      maxItems: 1,
    });
    expect(got.items.filter((i) => i.status === 'unchecked')).toHaveLength(2);
  });
});

describe('the server wiring: one chatCitations frame per reply, after the rewritten reply', () => {
  let scratch: string;
  let app: FastifyInstance;
  let port: number;
  let ws: WebSocket;
  let received: CoreEvent[];
  let emit: (frame: CoreEvent) => void;
  let repoRoot: string;
  let sha: string;
  let chatCwdParent: string | undefined;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-citations-server-'));
    repoRoot = join(scratch, 'alpha');
    sha = initRepo(repoRoot, 'src/foo.ts', ['// a', 'const x = 1;', ''].join('\n'));
    const home = join(scratch, 'state-home');
    mkdirSync(home);
    setCrewStateHome(home);

    const listeners = new Set<(e: CoreEvent) => void>();
    emit = (frame) => {
      for (const l of listeners) l(frame);
    };
    const adapter = {
      dbPath: join(home, 'core.db'),
      projectsSupported: () => false,
      getSettings: async () => ({}),
      onLaunch: (): (() => void) => () => undefined,
      onEvent: (l: (e: CoreEvent) => void): (() => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      listRepos: async () => [
        {
          id: 'r1',
          name: 'alpha',
          root_path: repoRoot,
          default_branch: 'main',
          registered_at: 1,
          code_graph_db: null,
        },
      ],
      // ASK-C1: an ask starts a path — the send launches one run on the fake engine.
      launchRun: async () => 'run-cite',
      sessionsDetail: async () => [{ session: { id: 'run-cite', status: 'awaiting_human' }, units: [] }],
      proposePlan: async () => ({ ok: true }),
      confirmGate: async () => 'awaiting_human',
      cancelRun: async () => 'cancelled',
      chatClose: async () => undefined,
    } as unknown as CoreAdapter;

    app = await createServer(adapter, {
      auth: { mode: 'off' },
      auditPath: join(scratch, 'audit.log'),
      evalStoreRoot: join(scratch, 'evals'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    received = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data: Buffer | string) => received.push(JSON.parse(data.toString()) as CoreEvent));
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
    });
  }, 60_000);

  afterAll(async () => {
    ws.close();
    await app.close();
    setCrewStateHome(undefined);
    // The chat scratch namespace this daemon minted for itself (under the OS temp dir).
    if (chatCwdParent !== undefined) removeScratch(chatCwdParent);
    removeScratch(scratch);
  });

  afterEach(() => {
    received.length = 0;
  });

  const waitFor = async (pred: () => boolean, label: string, ms = 8_000): Promise<void> => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('verifies the reply of a scoped chat and publishes the verdicts, after the rewritten reply frame', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/chats',
      payload: { chatId: 'cite-1', clis: ['claude'], repoRefs: ['alpha'] },
    });
    expect(opened.statusCode).toBe(201);
    chatCwdParent = dirname((opened.json() as { scope: { cwd: string } }).scope.cwd);

    // A REAL send, so the turn index opens a turn and the reply below is stamped the way the
    // daemon stamps it — which is also what lets the verdicts be recorded on the transcript.
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/chats/cite-1/messages',
      payload: { text: 'summarize the last commits' },
    });
    expect(sent.statusCode).toBe(202);
    const turnId = (sent.json() as { turnId?: string }).turnId;
    expect(typeof turnId).toBe('string');

    // The seat answers with a host-absolute path (crew#618 rewrites it), a real SHA and a
    // fabricated one — the RC1 Phase 6 shape.
    emit({
      type: 'chatReply',
      chat: 'cite-1',
      cliKey: 'claude',
      ok: true,
      text: `I read ${join(repoRoot, 'src/foo.ts')} — landed in ${sha.slice(0, 7)}, reverted in 6d77153.`,
    } as unknown as CoreEvent);

    await waitFor(() => received.some((f) => f.type === 'chatCitations'), 'the chatCitations frame');
    const reply = received.find((f) => f.type === 'chatReply') as (CoreEvent & { text: string }) | undefined;
    const frames = received.filter((f) => f.type === 'chatCitations') as unknown as ChatCitationsFrame[];
    // ONE frame per reply, and it comes after the reply itself.
    expect(frames).toHaveLength(1);
    expect(received.findIndex((f) => f.type === 'chatReply')).toBeLessThan(
      received.findIndex((f) => f.type === 'chatCitations'),
    );
    // crew#634 R1: the reply that reached the socket is the REWRITTEN one — no host path on the wire.
    expect(reply?.text).toContain('alpha/src/foo.ts');
    expect(reply?.text).not.toContain(repoRoot);

    const frame = frames[0]!;
    expect(frame.chat).toBe('cite-1');
    expect(frame.cliKey).toBe('claude');
    expect(frame.turn_id).toBe(turnId); // stamped with the turn it verified
    expect(frame.verified).toBe(2); // the rewritten path and the real sha
    expect(frame.unverifiable).toBe(1);
    expect(itemOf(frame.items, '6d77153')).toMatchObject({ kind: 'sha', status: 'unverified' });
    expect(itemOf(frame.items, 'alpha/src/foo.ts')).toMatchObject({ kind: 'path', status: 'verified' });

    // ...and the verdicts are in the transcript, so a reload still shows the marks (crew#561 /
    // api-types 0.68.0). The reply record carries the turn; the citations record folds onto it.
    const detail = await app.inject({ method: 'GET', url: '/api/v1/chats/cite-1' });
    const records = (detail.json() as { messages: Record<string, unknown>[] }).messages;
    const cited = records.find((r) => r['kind'] === 'citations');
    expect(cited).toMatchObject({ kind: 'citations', cliKey: 'claude', verified: 2, unverifiable: 1 });
    const replyRecord = records.find((r) => r['kind'] === 'seat');
    expect(cited?.['turnId']).toBe(replyRecord?.['turnId']);

    await app.inject({ method: 'DELETE', url: '/api/v1/chats/cite-1' });
  }, 30_000);

  it('says nothing for a reply that cites nothing, and nothing for a failed reply', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/chats',
      payload: { chatId: 'cite-2', clis: ['claude'], repoRefs: ['alpha'] },
    });
    expect(opened.statusCode).toBe(201);

    emit({ type: 'chatReply', chat: 'cite-2', cliKey: 'claude', ok: true, text: 'Nothing to cite here.' } as unknown as CoreEvent);
    emit({
      type: 'chatReply',
      chat: 'cite-2',
      cliKey: 'claude',
      ok: false,
      text: 'the seat exceeded the 600 s turn budget; 6d77153 was never checked',
    } as unknown as CoreEvent);
    // Both replies are on the wire; neither may carry a verdict.
    await waitFor(() => received.filter((f) => f.type === 'chatReply').length === 2, 'both replies');
    await new Promise((r) => setTimeout(r, 300));
    expect(received.filter((f) => f.type === 'chatCitations')).toEqual([]);

    await app.inject({ method: 'DELETE', url: '/api/v1/chats/cite-2' });
  }, 30_000);
});
