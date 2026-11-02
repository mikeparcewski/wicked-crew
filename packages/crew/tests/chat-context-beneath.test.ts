// crew#1274 (DES-CHAT-ARTIFACTS-001 §5.3): every file the chat's per-turn block reads or writes is opened BENEATH its
// root with no link followed in any folder below it. These tests swap a folder for a link to an outside folder
// between the check (the listing, the folder's proof) and the open, through `beneathTestHooks.beforeOpen`: the exact
// window a run or a seat would race. Each fails if the open goes back to a path open that follows ancestor links
// (`O_NOFOLLOW` alone covers only the last component).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { beneathMode, beneathTestHooks, createBeneath, listBeneath, openBeneath, readBeneath } from '../src/api/beneath.js';
import { buildTurnContext, type ChatContextDeps } from '../src/api/chat-context.js';
import { buildRunBrief } from '../src/api/run-brief.js';
import type { ChatTranscriptRecord, SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const supported = beneathMode() !== 'unsupported';

/** Swap `dir` for a link to `target` the first time an open's path ends with `suffix`. */
function swapOnOpen(suffix: string, dir: string, target: string): () => boolean {
  let swapped = false;
  beneathTestHooks.beforeOpen = (abs) => {
    if (swapped || !abs.endsWith(suffix)) return;
    swapped = true;
    renameSync(dir, `${dir}-moved`);
    symlinkSync(target, dir);
  };
  return () => swapped;
}

function view(id: string, over: Record<string, unknown> = {}): SessionView {
  return {
    session: { id, workflow_id: 'wf', problem: 'p', status: 'completed', repo_ref: null, clis: [], unit_ix: 0, attempt: 0, workdir: null, extra_write_roots: [], archived_at: null, archive_note: null, entity_mode: 'none', collection_scope: null, human_confirm: 'none', ...over },
    units: [],
  } as unknown as SessionView;
}

describe.skipIf(!supported)('opening beneath a root (crew#1274)', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'beneath-')));
    mkdirSync(join(scratch, 'outside'));
    writeFileSync(join(scratch, 'outside', 'proof.txt'), 'SECRET-OUTSIDE');
    writeFileSync(join(scratch, 'outside', 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
    writeFileSync(join(scratch, 'outside', '_v1.html'), '<h1>SECRET-OUTSIDE</h1>');
  });
  afterEach(() => {
    delete beneathTestHooks.beforeOpen;
    removeScratch(scratch);
  });

  it('refuses a link in any folder below the root, and paths that leave it, while reading what is really inside', () => {
    const root = join(scratch, 'root');
    mkdirSync(join(root, 'a'), { recursive: true });
    writeFileSync(join(root, 'a', 'f'), 'INSIDE');
    expect(readBeneath(root, 'a/f', 100).data.toString()).toBe('INSIDE');
    symlinkSync(join(scratch, 'outside'), join(root, 'b'));
    expect(() => openBeneath(root, 'b/proof.txt')).toThrow(expect.objectContaining({ code: 'ELOOP' }));
    for (const bad of ['../outside/proof.txt', 'a/../../outside/proof.txt', '', 'a//f', '/etc/passwd', 'a/./f']) {
      expect(() => openBeneath(root, bad), bad).toThrow();
    }
    createBeneath(root, 'a/new', Buffer.from('x'), 0o444);
    expect(() => createBeneath(root, 'a/new', Buffer.from('y'), 0o444)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(() => createBeneath(root, 'b/planted', Buffer.from('y'), 0o444)).toThrow(expect.objectContaining({ code: 'ELOOP' }));
    expect(existsSync(join(scratch, 'outside', 'planted'))).toBe(false);
    expect(listBeneath(root, 'b', 10)).toBeNull();
    expect(listBeneath(root, 'a', 10)?.names.sort()).toEqual(['f', 'new']);
  });

  it('a run brief never reads evidence through a folder swapped for a link after it was listed', async () => {
    const ev = join(scratch, 'evidence');
    mkdirSync(join(ev, 'author'), { recursive: true });
    writeFileSync(join(ev, 'author', 'proof.txt'), 'IN-ROOT-PROOF');
    const swapped = swapOnOpen('author/proof.txt', join(ev, 'author'), join(scratch, 'outside'));
    const md = (await buildRunBrief(view('aaaaaaaa-0000-4000-8000-0000000000a1', { evidence_root: ev }), { workOutput: async () => null })).markdown;
    expect(swapped()).toBe(true);
    expect(md).not.toContain('SECRET-OUTSIDE');
  });

  it('an artifact copy never reads a document through a folder swapped for a link after it was proven real', async () => {
    const docs = join(scratch, 'docs');
    mkdirSync(join(docs, 'deck'), { recursive: true });
    writeFileSync(join(docs, 'deck', 'versions.json'), JSON.stringify({ head: 1, versions: [{ version: 1 }] }));
    writeFileSync(join(docs, 'deck', '_v1.html'), '<h1>Mine</h1>');
    const chatRoot = join(scratch, 'chat');
    mkdirSync(chatRoot);
    const deps: ChatContextDeps = { docsRoot: async () => docs, runs: async () => [], workOutput: async () => null };
    const swapped = swapOnOpen('deck/_v1.html', join(docs, 'deck'), join(scratch, 'outside'));
    const ctx = await buildTurnContext({ chatId: 'c', scratchRoot: chatRoot, projectId: 'mikes', text: 'x', context: { artifact: { ref: 'mikes/deck', version: 1 } }, records: [], attachmentIds: [] }, deps);
    expect(swapped()).toBe(true);
    expect(JSON.stringify(ctx)).not.toContain('SECRET-OUTSIDE');
    expect(ctx.binding?.refused[0]?.reason).toMatch(/version 1 is a link/);
  });

  it('publication never writes through a scratch folder swapped for a link after it was proven real', async () => {
    const chatRoot = join(scratch, 'chat');
    mkdirSync(chatRoot);
    const deps: ChatContextDeps = { docsRoot: async () => null, runs: async () => [view('bbbbbbbb-0000-4000-8000-0000000000b1')], workOutput: async () => null };
    const ctx = await buildTurnContext({ chatId: 'c', scratchRoot: chatRoot, projectId: null, text: 'run bbbbbbbb', records: [], attachmentIds: [] }, deps);
    const target = join(scratch, 'elsewhere');
    mkdirSync(target);
    const swapped = swapOnOpen('.md', join(chatRoot, 'context'), target);
    // The folder exists before the swap (publication proves it real, then creates the brief beneath it).
    mkdirSync(join(chatRoot, 'context'));
    expect(() => ctx.publish()).toThrow();
    expect(swapped()).toBe(true);
    expect(readdirSync(target)).toEqual([]);
  });

  it('a follow-up never offers an earlier brief read through a scratch folder swapped for a link', async () => {
    const chatRoot = join(scratch, 'chat');
    mkdirSync(chatRoot);
    const run = view('cccccccc-0000-4000-8000-0000000000c1');
    const deps: ChatContextDeps = { docsRoot: async () => null, runs: async () => [run], workOutput: async () => null };
    const first = await buildTurnContext({ chatId: 'c', scratchRoot: chatRoot, projectId: null, text: 'run cccccccc', records: [], attachmentIds: [] }, deps);
    first.publish();
    const b = first.binding!.runs[0]!;
    // The same brief, byte for byte, sits outside: a read through the link would match its sha256.
    const target = join(scratch, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, b.brief.slice('context/'.length)), readBeneath(chatRoot, b.brief, 1 << 20).data);
    const records = [{ at: 1, turnId: 't1', kind: 'user', text: 'x', seats: [] }, { at: 2, turnId: 't1', kind: 'context', ...first.binding! }] as unknown as ChatTranscriptRecord[];
    const swapped = swapOnOpen(b.brief.slice('context/'.length), join(chatRoot, 'context'), target);
    const next = await buildTurnContext({ chatId: 'c', scratchRoot: chatRoot, projectId: null, text: 'and then?', records, attachmentIds: [] }, deps);
    expect(swapped()).toBe(true);
    expect(next.block).not.toContain('Briefs written earlier');
    expect(next.binding?.refused).toContainEqual({ token: `brief:${run.session.id}`, reason: expect.stringMatching(/no longer holds what crew wrote/) });
  });
});
