// crew#634 R1 (second half): the server wiring of the two terminal-frame arms that only had
// store-level tests — the `chatClosed` RETENTION arm (a chat whose promoted run is still live keeps
// its transcript; the run's terminal frame then drops it) and the delivered-only `urlFor` guard in
// front of the worktree sweep (an undelivered run's worktree is never removed). Driven through the
// REAL assembly: createServer over a fake adapter whose engine frames this test emits.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../src/api/server.js';
import { setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

describe('crew#634 R1 — chatClosed retention + the delivered-only worktree sweep, at the server', () => {
  let scratch: string;
  let home: string;
  let repoRoot: string;
  let app: FastifyInstance;
  let emit: (frame: CoreEvent) => void;
  let chatCwdParent: string | undefined;
  const launched: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-retention-server-'));
    repoRoot = join(scratch, 'alpha');
    mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoRoot], { stdio: 'ignore' });
    git(repoRoot, 'config', 'user.email', 't@example.invalid');
    git(repoRoot, 'config', 'user.name', 'T');
    writeFileSync(join(repoRoot, 'a.txt'), 'a\n', 'utf8');
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-q', '-m', 'init');
    home = join(scratch, 'state-home');
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
        { id: 'r1', name: 'alpha', root_path: repoRoot, default_branch: 'main', registered_at: 1, code_graph_db: null },
      ],
      // An ask starts a path: each send launches one run on the fake engine, linked to the chat.
      launchRun: async () => {
        const id = `run-ret-${++seq}`;
        launched.push(id);
        return id;
      },
      sessionsDetail: async () => [
        ...launched.map((id) => ({ session: { id, status: 'awaiting_human', repo_ref: 'r1' }, units: [] })),
        { session: { id: 'run-undelivered', status: 'completed', repo_ref: 'r1' }, units: [] },
      ],
      workOutput: async () => '',
      proposePlan: async () => ({ ok: true }),
      confirmGate: async () => 'awaiting_human',
      cancelRun: async () => 'cancelled',
      chatClose: async () => undefined,
      // Not an onboarding run: the capture-learnings chain (crew#552) stays out of the way.
      onboardedRepoOf: () => undefined,
    } as unknown as CoreAdapter;

    app = await createServer(adapter, {
      auth: { mode: 'off' },
      seats: { signedIn: () => true },
      auditPath: join(scratch, 'audit.log'),
      evalStoreRoot: join(scratch, 'evals'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
    });
    await app.ready();
  }, 150_000);

  afterAll(async () => {
    await app.close();
    setCrewStateHome(undefined);
    if (chatCwdParent !== undefined) removeScratch(chatCwdParent);
    removeScratch(scratch);
  });

  const waitFor = async (pred: () => boolean, label: string, ms = 8_000): Promise<void> => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('a closed chat whose promoted run is live keeps its transcript; the run terminal drops it', async () => {
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId: 'ret-1', clis: ['claude'], repoRefs: ['alpha'] } });
    expect(opened.statusCode, opened.body).toBe(201);
    chatCwdParent = dirname((opened.json() as { scope: { cwd: string } }).scope.cwd);
    const sent = await app.inject({ method: 'POST', url: '/api/v1/chats/ret-1/messages', payload: { text: 'what is in a.txt?' } });
    expect(sent.statusCode, sent.body).toBe(202);
    await waitFor(() => launched.length === 1, 'the path run launch');
    const runId = launched[0]!;
    emit({ type: 'chatReply', chat: 'ret-1', cliKey: 'claude', ok: true, text: 'It says a.' } as unknown as CoreEvent);

    const file = join(home, 'chats', 'ret-1.jsonl');
    await waitFor(() => existsSync(file), 'the persisted transcript');

    // The engine closes the chat (idle TTL / pool cap) while the run it promoted is still live.
    emit({ type: 'chatClosed', chat: 'ret-1', reason: 'idle' } as unknown as CoreEvent);
    await settle(150);
    expect(existsSync(file)).toBe(true); // retained: Continue-in-Build still needs it

    // The run terminals: the hold is released and the reclaimed chat's file goes.
    emit({ type: 'sessionCompleted', session: runId } as unknown as CoreEvent);
    await waitFor(() => !existsSync(file), 'the transcript drop on the run terminal');
  });

  it('an UNDELIVERED run that terminals keeps its worktree — the sweep is for delivered runs only', async () => {
    const wt = join(repoRoot, 'wicked-worktrees', 'run-undelivered');
    git(repoRoot, 'worktree', 'add', '-q', '-b', 'wicked/run-undelivered', wt);
    expect(existsSync(wt)).toBe(true);
    emit({ type: 'sessionCompleted', session: 'run-undelivered' } as unknown as CoreEvent);
    // The sweep runs after the delivery read settles; give that chain room, then the tree must stand.
    await settle(1_500);
    expect(existsSync(wt)).toBe(true);
  });
});
