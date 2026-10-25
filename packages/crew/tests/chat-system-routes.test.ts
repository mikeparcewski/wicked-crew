// DES-SYSTEM-CHAT (crew), through the REAL server assembly over a fake engine: the paged history,
// Close (ends the chat, keeps its history), reopening a chat's messages, attachments (upload, caps,
// read-only delivery to the seat), and DELETE (removes history and attachments). The fake seat is
// the fake engine's `launchRun`: it reads every file the turn's instructions hand it, inside the
// run's read roots, and answers with each file's size — the bytes the seat could actually read.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  ChatAttachmentUploadResponse,
  ChatCloseResponse,
  ChatListResponse,
  ChatMessagesResponse,
  HealthResponse,
} from 'wicked-crew-api-types';

import { createServer } from '../src/api/server.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const armedStateHome = crewStateHome();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1200, 9)]);
const TEXT = Buffer.from('build 42 failed at step lint\nsecond line\n');

function multipart(boundary: string, parts: Array<{ filename: string; type: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`), p.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

describe('system chat: history, close, attachments (server)', () => {
  let scratch: string;
  let home: string;
  let app: FastifyInstance;
  let emit: (frame: CoreEvent) => void;
  let chatCwdParent: string | undefined;
  const launches: LaunchRunInput[] = [];
  /** What the fake seat read: path → bytes. */
  const seatRead = new Map<string, number>();
  /** Runs whose cancel the fake engine refuses. */
  const failCancel = new Set<string>();
  let seq = 0;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'chat-system-routes-'));
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
      ping: async () => 'ok',
      onLaunch: (): (() => void) => () => undefined,
      onEvent: (l: (e: CoreEvent) => void): (() => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      listRepos: async () => [],
      // The fake seat: it reads each file its instructions name, from inside the run's read roots.
      launchRun: async (input: LaunchRunInput) => {
        launches.push(input);
        const step = (input.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!;
        const roots = input.extraReadRoots ?? [];
        for (const m of step.instructions.matchAll(/^- .*sha256 [0-9a-f]+\): (\/\S+)$/gm)) {
          const path = m[1]!;
          if (!roots.some((r) => path.startsWith(`${r}/`))) throw new Error(`seat cannot read ${path}: outside its read roots`);
          seatRead.set(path, readFileSync(path).length);
        }
        return `run-sys-${++seq}`;
      },
      sessionsDetail: async () => launches.map((_, i) => ({ session: { id: `run-sys-${i + 1}`, status: 'awaiting_human', repo_ref: null }, units: [] })),
      workOutput: async () => '',
      proposePlan: async () => ({ ok: true }),
      confirmGate: async () => 'awaiting_human',
      cancelRun: async (runId: string) => {
        if (failCancel.has(runId)) throw new Error('engine busy');
        return 'cancelled';
      },
      chatClose: async () => undefined,
      chatList: async () => [],
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
    setCrewStateHome(armedStateHome);
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

  it('advertises chatList and chatAttachments', async () => {
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect(health.capabilities).toMatchObject({ chatList: true, chatAttachments: true });
  });

  it('uploads an image and a text file, refuses over-cap and a lying type, and the seat reads each file read-only', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/chats',
      payload: { chatId: 'sys-1', clis: ['claude'], scopeKind: 'system', startedOn: { route: '/watch', label: 'Nerve Center' } },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    chatCwdParent = dirname((opened.json() as { scope: { cwd: string } }).scope.cwd);

    const boundary = 'b0undary42';
    const up = await app.inject({
      method: 'POST',
      url: '/api/v1/chats/sys-1/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, [
        { filename: 'screenshot.png', type: 'image/png', data: PNG },
        { filename: 'build.log', type: 'text/plain', data: TEXT },
      ]),
    });
    expect(up.statusCode, up.body).toBe(201);
    const { attachments, limits } = up.json() as ChatAttachmentUploadResponse;
    expect(attachments.map((a) => [a.name, a.kind, a.bytes])).toEqual([
      ['screenshot.png', 'image', PNG.length],
      ['build.log', 'text', TEXT.length],
    ]);
    // Stored under the state home.
    expect(existsSync(join(home, 'chats', 'attachments', 'sys-1'))).toBe(true);

    // Over the per-file cap: a clear 413 naming the file and the limit.
    const big = Buffer.alloc(limits.maxFileBytes + 10, 0x61);
    const over = await app.inject({
      method: 'POST',
      url: '/api/v1/chats/sys-1/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, [{ filename: 'huge.txt', type: 'text/plain', data: big }]),
    });
    expect(over.statusCode).toBe(413);
    expect(over.json()).toMatchObject({ code: 'attachment_too_large', name: 'huge.txt', limits: { maxFileBytes: limits.maxFileBytes } });
    // A file whose bytes deny its declared type: 415.
    const lie = await app.inject({
      method: 'POST',
      url: '/api/v1/chats/sys-1/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, [{ filename: 'x.png', type: 'image/png', data: Buffer.from('plain words') }]),
    });
    expect(lie.statusCode).toBe(415);
    // An unknown id on a message: 404, nothing sent.
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/chats/sys-1/messages', payload: { text: 'see this', attachments: ['att_00000000000000000000'] } });
    expect(unknown.statusCode).toBe(404);
    expect(launches).toHaveLength(0);

    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/chats/sys-1/messages',
      payload: { text: "what's in this screenshot and log?", attachments: attachments.map((a) => a.id) },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await waitFor(() => launches.length === 1, 'the path launch');
    // The fake seat read both files at their staged paths, every byte, inside its read roots.
    expect([...seatRead.values()].sort((a, b) => a - b)).toEqual([TEXT.length, PNG.length].sort((a, b) => a - b));
    const instructions = (launches[0]!.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!.instructions;
    expect(instructions).toContain('build 42 failed at step lint'); // the text, extracted
    for (const path of seatRead.keys()) {
      expect(path.startsWith(join(home, 'chats'))).toBe(false); // never the canonical store
      if (process.platform !== 'win32') expect(() => accessSync(path, fsConstants.W_OK)).toThrow(); // read-only
    }
    // The run's title stays the operator's words.
    expect(launches[0]!.problem).toBe("what's in this screenshot and log?");
    emit({ type: 'chatReply', chat: 'sys-1', cliKey: 'claude', ok: true, text: `read ${[...seatRead.values()].join(' and ')} bytes` } as unknown as CoreEvent);
    await waitFor(() => existsSync(join(home, 'chats', 'sys-1.jsonl')), 'the transcript');
  });

  it('lists the chat newest first with title, page, CLI, count and status; Close keeps it and it reopens', async () => {
    const opened2 = await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId: 'sys-2', clis: ['claude'], scopeKind: 'system' } });
    expect(opened2.statusCode, opened2.body).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    // sys-1 has the newer activity once it is written to again; read page 1 of 1.
    const list = (await app.inject({ method: 'GET', url: '/api/v1/chats?limit=1' })).json() as ChatListResponse;
    expect(list.items).toHaveLength(1);
    expect(typeof list.nextCursor).toBe('string');
    const page2 = (await app.inject({ method: 'GET', url: `/api/v1/chats?limit=1&cursor=${encodeURIComponent(list.nextCursor!)}` })).json() as ChatListResponse;
    expect(page2.items).toHaveLength(1);
    expect(new Set([list.items![0]!.id, page2.items![0]!.id])).toEqual(new Set(['sys-1', 'sys-2']));
    const all = (await app.inject({ method: 'GET', url: '/api/v1/chats' })).json() as ChatListResponse;
    const sys1 = all.items!.find((i) => i.id === 'sys-1')!;
    expect(sys1).toMatchObject({
      title: "what's in this screenshot and log?",
      startedOn: { route: '/watch', label: 'Nerve Center' },
      cli: 'claude',
      status: 'open',
      attachmentCount: 2,
    });
    expect(sys1.messageCount).toBeGreaterThanOrEqual(2);
    // Newest first by activity.
    const times = all.items!.map((i) => Date.parse(i.updatedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const closed = await app.inject({ method: 'POST', url: '/api/v1/chats/sys-1/close' });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((closed.json() as ChatCloseResponse).chat).toMatchObject({ id: 'sys-1', status: 'closed' });
    // The history kept the transcript (the live file follows the chat's own retention).
    expect(existsSync(join(home, 'chats', 'history', 'sys-1.jsonl'))).toBe(true);
    const still = (await app.inject({ method: 'GET', url: '/api/v1/chats?status=closed' })).json() as ChatListResponse;
    expect(still.items!.map((i) => i.id)).toEqual(['sys-1']);
    const reopened = (await app.inject({ method: 'GET', url: '/api/v1/chats/sys-1/messages' })).json() as ChatMessagesResponse;
    expect(reopened.chat.status).toBe('closed');
    const user = reopened.messages.find((m) => m.kind === 'user');
    expect(user).toMatchObject({ text: "what's in this screenshot and log?" });
    expect((user as { attachments?: Array<{ name: string }> }).attachments?.map((a) => a.name)).toEqual(['screenshot.png', 'build.log']);
    expect(reopened.messages.some((m) => m.kind === 'seat')).toBe(true);
    expect(reopened.attachments).toHaveLength(2);
    // Close again: idempotent.
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats/sys-1/close' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/nope/messages' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats?limit=0' })).statusCode).toBe(400);
  });

  it('Close whose run cannot be cancelled says so (502) — the chat is closed and its history kept', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId: 'sys-3', clis: ['claude'], scopeKind: 'system' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats/sys-3/messages', payload: { text: 'hello' } })).statusCode).toBe(202);
    await waitFor(() => launches.length === 2, 'the second launch');
    failCancel.add(`run-sys-${launches.length}`);
    const res = await app.inject({ method: 'POST', url: '/api/v1/chats/sys-3/close' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ runId: `run-sys-${launches.length}`, chat: { id: 'sys-3', status: 'closed' } });
    expect(res.json().error).toMatch(/could not be cancelled/);
  });

  it('DELETE removes the history and the attachments', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/sys-1' })).statusCode).toBe(200);
    expect(existsSync(join(home, 'chats', 'attachments', 'sys-1'))).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/sys-1/messages' })).statusCode).toBe(404);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/chats' })).json() as ChatListResponse;
    expect(list.items!.map((i) => i.id)).not.toContain('sys-1');
    await app.inject({ method: 'DELETE', url: '/api/v1/chats/sys-2' });
    await app.inject({ method: 'DELETE', url: '/api/v1/chats/sys-3' });
  });
});
