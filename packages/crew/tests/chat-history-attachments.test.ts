// DES-SYSTEM-CHAT (crew): the chat history store and the attachments store, as units.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_FILES,
  AttachmentError,
  ChatAttachmentStore,
  attachmentsBlock,
  boundaryOf,
  extractPdfText,
  parseMultipart,
  safeName,
  sniffAttachment,
  stageForSeat,
} from '../src/api/chat-attachments.js';
import { ChatHistoryStore, titleOf } from '../src/api/chat-history.js';
import { removeScratch } from './setup/scratch.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 7)]);

/** A minimal one-page pdf whose content stream (Flate) shows `text`. */
function pdfWith(text: string): Buffer {
  const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 712 Td (${text}) Tj ET`, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Length ' + content.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    content,
    Buffer.from('\nendstream\nendobj\ntrailer << >>\n%%EOF\n', 'latin1'),
  ]);
}

function multipart(boundary: string, parts: Array<{ name: string; filename?: string; type?: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}\r\n${p.type !== undefined ? `Content-Type: ${p.type}\r\n` : ''}\r\n`));
    chunks.push(p.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-chat-hist-att-'));
});
afterAll(() => removeScratch(scratch));

describe('multipart and types', () => {
  it('parses file parts (fields ignored) with binary bytes intact', () => {
    const b = 'XyZ123';
    const body = multipart(b, [
      { name: 'note', data: Buffer.from('a field') },
      { name: 'file', filename: 'shot.png', type: 'image/png', data: PNG },
      { name: 'file', filename: 'notes.txt', type: 'text/plain', data: Buffer.from('hello\r\n--not a boundary\r\n') },
    ]);
    expect(boundaryOf(`multipart/form-data; boundary=${b}`)).toBe(b);
    expect(boundaryOf('application/json')).toBeNull();
    const files = parseMultipart(body, b);
    expect(files.map((f) => f.filename)).toEqual(['shot.png', 'notes.txt']);
    expect(files[0]!.data.equals(PNG)).toBe(true);
    expect(files[1]!.data.toString()).toBe('hello\r\n--not a boundary\r\n');
  });

  it('decides the type from the bytes: images, pdf, UTF-8 text; binary is refused', () => {
    expect(sniffAttachment(PNG, 'x.png')).toEqual({ kind: 'image', mediaType: 'image/png' });
    expect(sniffAttachment(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'a.jpg')?.mediaType).toBe('image/jpeg');
    expect(sniffAttachment(Buffer.from('GIF89a....'), 'a.gif')?.mediaType).toBe('image/gif');
    expect(sniffAttachment(Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'a.webp')?.mediaType).toBe('image/webp');
    expect(sniffAttachment(pdfWith('x'), 'a.pdf')?.kind).toBe('pdf');
    expect(sniffAttachment(Buffer.from('# Title\n'), 'readme.md')).toEqual({ kind: 'text', mediaType: 'text/markdown' });
    expect(sniffAttachment(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), 'a.out')).toBeNull();
    expect(sniffAttachment(Buffer.from([0xc3, 0x28]), 'bad.txt')).toBeNull(); // invalid UTF-8
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('a\u0000b c.png')).toBe('ab c.png');
  });

  it('extracts the shown text of a Flate pdf', () => {
    expect(extractPdfText(pdfWith('Quarterly numbers \\(draft\\)'))).toBe('Quarterly numbers (draft)');
  });
});

describe('the attachments store', () => {
  it('stores under its dir (0700/0600), lists, resolves, and removes with the chat', () => {
    const store = new ChatAttachmentStore({ dir: join(scratch, 'att') });
    const [img, txt] = store.add('chat-1', [
      { filename: 'shot.png', declaredType: 'image/png', data: PNG },
      { filename: 'notes.txt', declaredType: 'text/plain', data: Buffer.from('line one\nline two\n') },
    ]);
    expect(img).toMatchObject({ chatId: 'chat-1', name: 'shot.png', kind: 'image', mediaType: 'image/png', bytes: PNG.length });
    expect(txt).toMatchObject({ kind: 'text', bytes: 18 });
    expect(store.list('chat-1').map((a) => a.id).sort()).toEqual([img!.id, txt!.id].sort());
    const dir = join(scratch, 'att', 'chat-1');
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    const resolved = store.resolve('chat-1', [txt!.id]);
    expect(resolved[0]!.path.startsWith(dir)).toBe(true);
    expect(() => store.resolve('chat-1', ['att_00000000000000000000'])).toThrow(AttachmentError);
    store.removeChat('chat-1');
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses over the per-file cap, over the per-message total, over the file count, and a type its bytes deny — storing nothing', () => {
    const store = new ChatAttachmentStore({ dir: join(scratch, 'att2') });
    const big = Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES + 1, 0x61);
    const one = (() => { try { store.add('c', [{ filename: 'big.txt', declaredType: 'text/plain', data: big }]); } catch (e) { return e as AttachmentError; } return null; })();
    expect(one).toMatchObject({ status: 413, code: 'attachment_too_large' });
    expect(one!.body()).toMatchObject({ code: 'attachment_too_large', name: 'big.txt', limits: { maxFileBytes: ATTACHMENT_MAX_FILE_BYTES } });
    const nine = Buffer.alloc(9 * 1024 * 1024, 0x61);
    expect(() => store.add('c', [nine, nine, nine].map((data, i) => ({ filename: `f${i}.txt`, declaredType: null, data })))).toThrow(/limit per message/);
    const many = Array.from({ length: ATTACHMENT_MAX_FILES + 1 }, (_, i) => ({ filename: `f${i}.txt`, declaredType: null, data: Buffer.from('x') }));
    expect(() => store.add('c', many)).toThrow(/per message/);
    const lie = (() => { try { store.add('c', [{ filename: 'x.png', declaredType: 'image/png', data: Buffer.from('not a png') }]); } catch (e) { return e as AttachmentError; } return null; })();
    expect(lie).toMatchObject({ status: 415, code: 'attachment_type' });
    expect(store.list('c')).toEqual([]);
  });

  it('stages read-only copies for the seat and lists them with their text', () => {
    const store = new ChatAttachmentStore({ dir: join(scratch, 'att3') });
    const [txt, pdf, img] = store.add('c3', [
      { filename: 'notes.txt', declaredType: 'text/plain', data: Buffer.from('the answer is 42\n') },
      { filename: 'report.pdf', declaredType: 'application/pdf', data: pdfWith('Revenue rose') },
      { filename: 'shot.png', declaredType: null, data: PNG },
    ]);
    const staging = join(scratch, 'scratch-root', 'attachments');
    const staged = stageForSeat(store.resolve('c3', [txt!.id, pdf!.id, img!.id]), staging);
    for (const s of staged) {
      expect(s.seatPath.startsWith(staging)).toBe(true);
      if (process.platform !== 'win32') expect(statSync(s.seatPath).mode & 0o777).toBe(0o444);
    }
    const block = attachmentsBlock(staged);
    expect(block).toContain(staged[0]!.seatPath);
    expect(block).toContain('the answer is 42');
    expect(block).toContain('Revenue rose');
    expect(block).toMatch(/An image: open the file/);
    expect(block).not.toContain(join(scratch, 'att3')); // never the canonical path
  });
});

describe('the history store', () => {
  const setup = (name: string) => {
    const live = join(scratch, name, 'live');
    mkdirSync(live, { recursive: true });
    let t = 1_000_000;
    const att = new ChatAttachmentStore({ dir: join(scratch, name, 'att') });
    const history = new ChatHistoryStore({ pathOf: (id) => join(live, `${id}.jsonl`) }, att, { dir: join(scratch, name, 'history'), now: () => t });
    const say = (id: string, kind: 'user' | 'seat', text: string) =>
      writeFileSync(join(live, `${id}.jsonl`), `${JSON.stringify(kind === 'user' ? { at: t, turnId: 't', kind, text, seats: [] } : { at: t, turnId: 't', kind, cliKey: 'claude', text, ok: true, usage: null })}\n`, { flag: 'a' });
    return { live, history, att, say, tick: (ms: number) => { t += ms; } };
  };

  it('titles from the first message; counts messages; keeps the transcript when closed', () => {
    const { live, history, say } = setup('h1');
    history.opened('c1', { startedOn: { route: '/runs/9b43', label: 'Run 9b43' }, cli: 'claude', actorId: null });
    expect(history.entry('c1')).toMatchObject({ title: 'New chat', messageCount: 0, status: 'open', startedOn: { route: '/runs/9b43', label: 'Run 9b43' }, cli: 'claude' });
    say('c1', 'user', '  Why is   this run held,\nand what should I do?  ');
    say('c1', 'seat', 'Because its floor failed.');
    history.closed('c1');
    // The live file goes with the chat; the history keeps it.
    writeFileSync(join(live, 'c1.jsonl'), '');
    const e = history.entry('c1')!;
    expect(e).toMatchObject({ title: 'Why is this run held, and what should I do?', messageCount: 2, status: 'closed' });
    expect(typeof e.closedAt).toBe('string');
    expect(history.messages('c1')!.map((r) => r.kind)).toEqual(['user', 'seat']);
    expect(titleOf([{ at: 1, turnId: 't', kind: 'user', text: 'x'.repeat(200), seats: [] }]).length).toBe(80);
  });

  it('lists newest first, pages with a cursor, filters by status and actor', () => {
    const { history, say, tick } = setup('h2');
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      history.opened(id, { cli: null, actorId: id === 'e' ? 'someone-else' : 'me' });
      tick(10);
    }
    say('a', 'user', 'most recent'); // a's transcript is written now: newest activity
    history.closed('b');
    const p1 = history.list({ limit: 2, actorId: 'me' });
    expect(p1.items.map((i) => i.id)).toEqual(['a', 'd']);
    const p2 = history.list({ limit: 2, actorId: 'me', cursor: p1.nextCursor });
    expect(p2.items.map((i) => i.id)).toEqual(['c', 'b']);
    expect(p2.nextCursor).toBeNull();
    expect(history.list({ status: 'closed' }).items.map((i) => i.id)).toEqual(['b']);
    expect(history.list({ actorId: null }).items).toHaveLength(5);
  });

  it('a reused id keeps the earlier conversation under its own id; remove deletes entry, transcript and attachments', () => {
    const { history, say, att, tick } = setup('h3');
    history.opened('re', { cli: null, actorId: null });
    say('re', 'user', 'first conversation');
    att.add('re', [{ filename: 'n.txt', declaredType: null, data: Buffer.from('x') }]);
    history.closed('re');
    tick(5);
    history.opened('re', { cli: null, actorId: null });
    const ids = history.list({}).items.map((i) => i.id);
    expect(ids).toHaveLength(2);
    const kept = ids.find((i) => i !== 're')!;
    expect(kept).toMatch(/^re--\d+$/);
    expect(history.messages(kept)!.map((r) => (r.kind === 'user' ? r.text : ''))).toEqual(['first conversation']);
    expect(att.count(kept)).toBe(1);
    history.remove(kept);
    expect(history.entry(kept)).toBeNull();
    expect(att.count(kept)).toBe(0);
  });

  it('under auth: required an entry is visible to its opener only; local mode sees all', () => {
    const { history } = setup('h5');
    history.opened('mine', { cli: null, actorId: 'alice' });
    expect(history.visibleTo('mine', 'alice')).toBe(true);
    expect(history.visibleTo('mine', 'bob')).toBe(false);
    expect(history.visibleTo('mine', null)).toBe(true);
    expect(history.visibleTo('nope', null)).toBe(false);
  });

  it('boot closes what the previous process left open, keeping the transcript', () => {
    const { history, say } = setup('h4');
    history.opened('left-open', { cli: null, actorId: null });
    say('left-open', 'user', 'before the restart');
    expect(history.closeOrphaned()).toBe(1);
    expect(history.entry('left-open')).toMatchObject({ status: 'closed', messageCount: 1 });
  });
});

describe('xreview r1 on #1140', () => {
  const setup = (name: string) => {
    const live = join(scratch, name, 'live');
    mkdirSync(live, { recursive: true });
    let t = 1_000_000;
    const att = new ChatAttachmentStore({ dir: join(scratch, name, 'att') });
    const history = new ChatHistoryStore({ pathOf: (id) => join(live, `${id}.jsonl`) }, att, { dir: join(scratch, name, 'history'), now: () => t });
    const say = (id: string, text: string) =>
      writeFileSync(join(live, `${id}.jsonl`), `${JSON.stringify({ at: t, turnId: 't', kind: 'user', text, seats: [] })}\n`, { flag: 'a' });
    return { live, history, att, say, setNow: (v: number) => { t = v; } };
  };

  it('an archive id never overwrites a chat that already holds that id', () => {
    const { history, say, setNow } = setup('x1');
    history.opened('x--1000', { cli: null, actorId: 'bob' }); // a client chose this id itself
    say('x--1000', 'bob speaks');
    history.opened('x', { cli: null, actorId: 'alice' });
    say('x', 'alice speaks');
    setNow(1000);
    history.closed('x');
    history.opened('x', { cli: null, actorId: 'alice' });
    const ids = history.list({}).items.map((i) => i.id).sort();
    expect(ids).toEqual(['x', 'x--1000', 'x--1000-1']);
    expect(history.messages('x--1000')!.map((r) => (r.kind === 'user' ? r.text : ''))).toEqual(['bob speaks']);
    expect(history.messages('x--1000-1')!.map((r) => (r.kind === 'user' ? r.text : ''))).toEqual(['alice speaks']);
  });

  it('reopening over a stale open entry keeps the earlier conversation', () => {
    const { history, say } = setup('x2');
    history.opened('stale', { cli: null, actorId: null });
    say('stale', 'earlier');
    history.opened('stale', { cli: null, actorId: null }); // the fold never closed it
    const kept = history.list({}).items.map((i) => i.id).find((i) => i !== 'stale')!;
    expect(history.messages(kept)!.map((r) => (r.kind === 'user' ? r.text : ''))).toEqual(['earlier']);
  });

  it('closing keeps the last-activity time; the status filter uses the effective status', () => {
    const { live, history, say } = setup('x3');
    history.opened('old', { cli: null, actorId: null });
    say('old', 'long ago');
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(live, 'old.jsonl'), past, past);
    history.closed('old');
    expect(Math.abs(Date.parse(history.entry('old')!.updatedAt) - past.getTime())).toBeLessThan(1000);
    history.opened('ghost', { cli: null, actorId: null });
    const isLive = (id: string) => id !== 'ghost';
    expect(history.list({ status: 'open', isLive }).items.map((i) => i.id)).toEqual([]);
    expect(history.list({ status: 'closed', isLive }).items.map((i) => i.id).sort()).toEqual(['ghost', 'old']);
  });

  it('moving attachments copies an uploaded .json payload byte for byte', () => {
    const { history, att } = setup('x4');
    history.opened('j', { cli: null, actorId: null });
    const payload = Buffer.from('[1, 2, 3]\n');
    const [a] = att.add('j', [{ filename: 'list.json', declaredType: 'application/json', data: payload }]);
    history.closed('j');
    history.opened('j', { cli: null, actorId: null });
    const kept = history.list({}).items.map((i) => i.id).find((i) => i !== 'j')!;
    const moved = att.resolve(kept, [a!.id])[0]!;
    expect(readFileSync(moved.path).equals(payload)).toBe(true);
    expect(att.list(kept)[0]).toMatchObject({ chatId: kept, sha256: a!.sha256 });
  });

  it('a pdf decompression bomb is bounded, never inflated whole', () => {
    const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024, 0));
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), bomb, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    expect(pdf.length).toBeLessThan(ATTACHMENT_MAX_FILE_BYTES);
    expect(extractPdfText(pdf)).toBe('');
  });

  it('a payload line that merely starts with the delimiter is data', () => {
    const b = 'BND';
    const data = Buffer.from('before\r\n--BNDnot-a-boundary\r\nafter');
    const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="f"; filename="t.txt"\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]);
    expect(parseMultipart(body, b)[0]!.data.equals(data)).toBe(true);
  });
});
