/**
 * Chat attachments (DES-SYSTEM-CHAT "Crew" §2, api-types 0.137.0).
 *
 * `POST /chats/:id/attachments` takes multipart/form-data file parts: images (png, jpeg, gif, webp),
 * UTF-8 text and pdf. Each file's TYPE is decided from its bytes (a declared type that the bytes do
 * not bear out is refused), and each upload is held to a per-file cap and a total cap. The files are
 * stored under the state home (`<state home>/chats/attachments/<chat>/`, 0700 / 0600) and removed
 * with their chat on `DELETE /chats/:id`.
 *
 * A message names attachment ids. Before the seat's turn, each named file is COPIED read-only (0444)
 * into the chat's private scratch root (`<scratch root>/attachments/`, a read root of the chat's run
 * from its launch), and the turn's instructions list each one: its path (an image opens as an image
 * in a CLI that reads images), and for text and pdf the extracted text. The canonical copy under the
 * state home is never handed to a seat.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import type { ChatAttachment, ChatAttachmentKind, ChatAttachmentLimits } from '../core/types.js';
import { crewStateHome } from '../projects/state-home.js';
import { CHAT_ID } from './chat-scope.js';

export const ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 10;
/** Extracted text handed to the seat per file, at most. */
export const ATTACHMENT_TEXT_EXCERPT_CHARS = 16_000;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'] as const;

export const ATTACHMENT_LIMITS: ChatAttachmentLimits = {
  maxFileBytes: ATTACHMENT_MAX_FILE_BYTES,
  maxMessageBytes: ATTACHMENT_MAX_MESSAGE_BYTES,
  maxFiles: ATTACHMENT_MAX_FILES,
  mediaTypes: [...IMAGE_TYPES, ...TEXT_TYPES, 'text/*', 'application/pdf'],
};

const ATTACHMENT_ID = /^att_[0-9a-f]{20}$/;

/** A refusal with its HTTP status and wire code (`ChatAttachmentError`). */
export class AttachmentError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 415,
    readonly code: 'attachment_too_large' | 'attachments_too_large' | 'attachment_type' | 'attachment_unknown' | 'attachment_malformed',
    message: string,
    readonly name_?: string,
    readonly bytes?: number,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }

  body(): Record<string, unknown> {
    return {
      error: this.message,
      code: this.code,
      ...(this.name_ !== undefined ? { name: this.name_ } : {}),
      ...(this.bytes !== undefined ? { bytes: this.bytes } : {}),
      limits: ATTACHMENT_LIMITS,
    };
  }
}

const mib = (n: number): string => `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`;

// ── multipart/form-data ─────────────────────────────────────────────────────

export interface UploadedFile {
  filename: string;
  declaredType: string | null;
  data: Buffer;
}

/** The boundary of a `multipart/form-data` content type, or null. */
export function boundaryOf(contentType: string | undefined): string | null {
  if (contentType === undefined || !/^multipart\/form-data\b/i.test(contentType)) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const b = m?.[1] ?? m?.[2];
  return b !== undefined && b.length > 0 && b.length <= 200 ? b : null;
}

function filenameOf(disposition: string): string | null {
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (star?.[1] !== undefined) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/.exec(disposition);
  const v = plain?.[1] ?? plain?.[2];
  return v !== undefined ? v.replace(/\\(.)/g, '$1').trim() : null;
}

/** Parse a buffered multipart body into its FILE parts (a part with a filename); fields are ignored. */
export function parseMultipart(body: Buffer, boundary: string): UploadedFile[] {
  const delim = Buffer.from(`--${boundary}`);
  const files: UploadedFile[] = [];
  let pos = body.indexOf(delim);
  if (pos < 0) throw new AttachmentError(400, 'attachment_malformed', 'the body is not multipart/form-data with the declared boundary');
  for (;;) {
    pos += delim.length;
    // `--` after a delimiter closes the body.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) throw new AttachmentError(400, 'attachment_malformed', 'a multipart part has no header end');
    const headers = body.subarray(pos, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), dataStart);
    if (next < 0) throw new AttachmentError(400, 'attachment_malformed', 'a multipart part is not terminated');
    const disposition = /^content-disposition:\s*(.+)$/im.exec(headers)?.[1] ?? '';
    const filename = filenameOf(disposition);
    if (filename !== null) {
      const declared = /^content-type:\s*([^;\r\n]+)/im.exec(headers)?.[1]?.trim().toLowerCase() ?? null;
      files.push({ filename, declaredType: declared, data: body.subarray(dataStart, next) });
    }
    pos = next + 2;
  }
  return files;
}

// ── type decision ───────────────────────────────────────────────────────────

const startsWith = (b: Buffer, sig: number[]): boolean => sig.every((v, i) => b[i] === v);

/** Decide an upload's kind and media type from its bytes. `null`: not an accepted type. */
export function sniffAttachment(data: Buffer, filename: string): { kind: ChatAttachmentKind; mediaType: string } | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mediaType: 'image/png' };
  if (startsWith(data, [0xff, 0xd8, 0xff])) return { kind: 'image', mediaType: 'image/jpeg' };
  if (data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a') return { kind: 'image', mediaType: 'image/gif' };
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', mediaType: 'image/webp' };
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mediaType: 'application/pdf' };
  if (data.includes(0)) return null; // a NUL byte: binary, not text
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
  const mediaType = ext === 'md' || ext === 'markdown' ? 'text/markdown' : ext === 'csv' ? 'text/csv' : ext === 'json' ? 'application/json' : 'text/plain';
  return { kind: 'text', mediaType };
}

/** Whether a declared part type is consistent with what the bytes are (absent / octet-stream = no claim). */
function declaredFits(declared: string | null, sniffed: { kind: ChatAttachmentKind; mediaType: string }): boolean {
  if (declared === null || declared === '' || declared === 'application/octet-stream') return true;
  if (sniffed.kind === 'image') return declared === sniffed.mediaType || (declared === 'image/jpg' && sniffed.mediaType === 'image/jpeg');
  if (sniffed.kind === 'pdf') return declared === 'application/pdf';
  return declared.startsWith('text/') || declared === 'application/json' || declared === 'application/x-ndjson';
}

/** A file name safe to put on disk: no path, no control characters, at most 100 characters. */
export function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  const name = cleaned === '' ? 'file' : cleaned;
  return name.length > 100 ? name.slice(name.length - 100) : name;
}

// ── text extraction ─────────────────────────────────────────────────────────

/** Best-effort text from a pdf: the strings shown by `Tj` / `TJ` in its (Flate or plain) content
 *  streams. Good for the common text pdf; a scanned page has none, and says so. */
export function extractPdfText(data: Buffer, maxChars = ATTACHMENT_TEXT_EXCERPT_CHARS): string {
  const raw = data.toString('latin1');
  const out: string[] = [];
  let total = 0;
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null && total < maxChars) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dict = raw.slice(Math.max(0, m.index - 400), m.index);
    let content = data.subarray(start, end);
    if (/\/FlateDecode/.test(dict.slice(dict.lastIndexOf('<<')))) {
      try {
        content = inflateSync(content);
      } catch {
        streamRe.lastIndex = end;
        continue;
      }
    }
    const text = content.toString('latin1');
    const shown = /\((?:[^()\\]|\\[\s\S])*\)\s*Tj|\[((?:[^\]\\]|\\[\s\S])*)\]\s*TJ/g;
    let t: RegExpExecArray | null;
    while ((t = shown.exec(text)) !== null && total < maxChars) {
      const strings = t[0].match(/\((?:[^()\\]|\\[\s\S])*\)/g) ?? [];
      const piece = strings
        .map((s) =>
          s
            .slice(1, -1)
            .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) =>
              /^[0-7]+$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ({ n: '\n', r: '', t: '\t', b: '', f: '' } as Record<string, string>)[c] ?? c,
            ),
        )
        .join('');
      out.push(piece);
      total += piece.length;
    }
    streamRe.lastIndex = end;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

// ── the store ───────────────────────────────────────────────────────────────

export function defaultChatAttachmentsDir(): string {
  return join(crewStateHome(), 'chats', 'attachments');
}

/** The wire fields of an attachment record (never its stored path). */
export function attachmentWire(m: ChatAttachment): ChatAttachment {
  return { id: m.id, chatId: m.chatId, name: m.name, mediaType: m.mediaType, kind: m.kind, bytes: m.bytes, sha256: m.sha256, createdAt: m.createdAt };
}

interface StoredMeta extends ChatAttachment {
  /** The stored file name under the chat's directory. */
  file: string;
}

export class ChatAttachmentStore {
  readonly dir: string;
  private readonly now: () => number;

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? defaultChatAttachmentsDir();
    this.now = opts.now ?? Date.now;
  }

  private chatDir(chatId: string): string {
    if (!CHAT_ID.test(chatId) || chatId === '.' || chatId === '..') throw new AttachmentError(400, 'attachment_malformed', `chat id ${JSON.stringify(chatId)} cannot name an attachments directory`);
    return join(this.dir, chatId);
  }

  private ensureDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(path, 0o700);
  }

  /** Validate every file first (all or nothing), then store them. */
  add(chatId: string, files: UploadedFile[]): ChatAttachment[] {
    if (files.length === 0) throw new AttachmentError(400, 'attachment_malformed', 'no file part in the upload');
    if (files.length > ATTACHMENT_MAX_FILES) {
      throw new AttachmentError(413, 'attachments_too_large', `${files.length} files is over the limit of ${ATTACHMENT_MAX_FILES} per message`);
    }
    let total = 0;
    const checked = files.map((f) => {
      const name = safeName(f.filename);
      if (f.data.length > ATTACHMENT_MAX_FILE_BYTES) {
        throw new AttachmentError(413, 'attachment_too_large', `${name} is ${mib(f.data.length)}, over the ${mib(ATTACHMENT_MAX_FILE_BYTES)} limit per file`, name, f.data.length);
      }
      if (f.data.length === 0) throw new AttachmentError(415, 'attachment_type', `${name} is empty`, name, 0);
      total += f.data.length;
      const sniffed = sniffAttachment(f.data, name);
      if (sniffed === null) {
        throw new AttachmentError(415, 'attachment_type', `${name} is not an image (png, jpeg, gif, webp), UTF-8 text or a pdf`, name, f.data.length);
      }
      if (!declaredFits(f.declaredType, sniffed)) {
        throw new AttachmentError(415, 'attachment_type', `${name} was sent as ${f.declaredType} but its bytes are ${sniffed.mediaType}`, name, f.data.length);
      }
      return { f, name, sniffed };
    });
    if (total > ATTACHMENT_MAX_MESSAGE_BYTES) {
      throw new AttachmentError(413, 'attachments_too_large', `the files total ${mib(total)}, over the ${mib(ATTACHMENT_MAX_MESSAGE_BYTES)} limit per message`, undefined, total);
    }
    const dir = this.chatDir(chatId);
    this.ensureDir(this.dir);
    this.ensureDir(dir);
    return checked.map(({ f, name, sniffed }) => {
      const id = `att_${randomBytes(10).toString('hex')}`;
      const file = `${id}-${name}`;
      writeFileSync(join(dir, file), f.data, { mode: 0o600 });
      const meta: StoredMeta = {
        id,
        chatId,
        name,
        mediaType: sniffed.mediaType,
        kind: sniffed.kind,
        bytes: f.data.length,
        sha256: createHash('sha256').update(f.data).digest('hex'),
        createdAt: new Date(this.now()).toISOString(),
        file,
      };
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
      return attachmentWire(meta);
    });
  }

  private readMeta(chatId: string, id: string): StoredMeta | null {
    if (!ATTACHMENT_ID.test(id)) return null;
    try {
      return JSON.parse(readFileSync(join(this.chatDir(chatId), `${id}.json`), 'utf8')) as StoredMeta;
    } catch {
      return null;
    }
  }

  /** The chat's attachments, oldest first. */
  list(chatId: string): ChatAttachment[] {
    let dir: string;
    try {
      dir = this.chatDir(chatId);
    } catch {
      return [];
    }
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => this.readMeta(chatId, n.slice(0, -5)))
      .filter((m): m is StoredMeta => m !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(attachmentWire);
  }

  /** The named attachments of the chat, in the order named — refused when one is unknown or the set
   *  is over the per-message caps. */
  resolve(chatId: string, ids: readonly string[]): Array<ChatAttachment & { path: string }> {
    if (ids.length > ATTACHMENT_MAX_FILES) {
      throw new AttachmentError(413, 'attachments_too_large', `${ids.length} attachments is over the limit of ${ATTACHMENT_MAX_FILES} per message`);
    }
    const out: Array<ChatAttachment & { path: string }> = [];
    let total = 0;
    for (const id of [...new Set(ids)]) {
      const meta = this.readMeta(chatId, id);
      if (meta === null) throw new AttachmentError(404, 'attachment_unknown', `chat ${chatId} has no attachment ${id}`);
      total += meta.bytes;
      out.push({ ...attachmentWire(meta), path: join(this.chatDir(chatId), meta.file) });
    }
    if (total > ATTACHMENT_MAX_MESSAGE_BYTES) {
      throw new AttachmentError(413, 'attachments_too_large', `the attachments total ${mib(total)}, over the ${mib(ATTACHMENT_MAX_MESSAGE_BYTES)} limit per message`, undefined, total);
    }
    return out;
  }

  count(chatId: string): number {
    return this.list(chatId).length;
  }

  /** The chat is deleted: its attachments go with it. */
  removeChat(chatId: string): void {
    let dir: string;
    try {
      dir = this.chatDir(chatId);
    } catch {
      return;
    }
    rmSync(dir, { recursive: true, force: true });
  }

  /** Move a chat's attachments to another id (an archived history entry the id was reused over). */
  rename(fromChatId: string, toChatId: string): void {
    const from = this.chatDir(fromChatId);
    if (!existsSync(from)) return;
    const to = this.chatDir(toChatId);
    this.ensureDir(this.dir);
    rmSync(to, { recursive: true, force: true });
    // Rewrite each meta's chatId as it moves.
    this.ensureDir(to);
    for (const n of readdirSync(from)) {
      if (n.endsWith('.json')) {
        const meta = JSON.parse(readFileSync(join(from, n), 'utf8')) as StoredMeta;
        writeFileSync(join(to, n), JSON.stringify({ ...meta, chatId: toChatId }), { mode: 0o600 });
      } else {
        copyFileSync(join(from, n), join(to, n));
      }
    }
    rmSync(from, { recursive: true, force: true });
  }
}

// ── handing them to the seat ────────────────────────────────────────────────

export interface StagedAttachment extends ChatAttachment {
  /** The read-only copy the seat reads. */
  seatPath: string;
  /** Extracted text for text and pdf (bounded); `null` for images. */
  text: string | null;
  truncated: boolean;
}

/**
 * Copy the named attachments read-only (0444) into `stagingDir` (the chat's scratch root's
 * `attachments/`, a read root of its run) and extract their text. The seat never gets the
 * canonical path under the state home.
 */
export function stageForSeat(atts: ReadonlyArray<ChatAttachment & { path: string }>, stagingDir: string): StagedAttachment[] {
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  return atts.map((a) => {
    const seatPath = join(stagingDir, `${a.id}-${a.name}`);
    if (!existsSync(seatPath)) {
      copyFileSync(a.path, seatPath);
      if (process.platform !== 'win32') chmodSync(seatPath, 0o444);
    }
    let text: string | null = null;
    let truncated = false;
    if (a.kind === 'text') {
      const all = readFileSync(a.path, 'utf8');
      truncated = all.length > ATTACHMENT_TEXT_EXCERPT_CHARS;
      text = all.slice(0, ATTACHMENT_TEXT_EXCERPT_CHARS);
    } else if (a.kind === 'pdf') {
      text = extractPdfText(readFileSync(a.path));
      truncated = text.length >= ATTACHMENT_TEXT_EXCERPT_CHARS;
    }
    return { ...attachmentWire(a), seatPath, text, truncated };
  });
}

/** The block a turn's instructions carry for its attachments. */
export function attachmentsBlock(staged: readonly StagedAttachment[]): string {
  if (staged.length === 0) return '';
  const lines = ['', '## Attached files (read-only)', '', 'The operator attached these files to this message. Read them at their paths; do not modify them.', ''];
  for (const a of staged) {
    lines.push(`- ${a.name} (${a.mediaType}, ${a.bytes} bytes, sha256 ${a.sha256.slice(0, 12)}): ${a.seatPath}`);
    if (a.kind === 'image') lines.push('  An image: open the file to view it.');
    if (a.text !== null) {
      if (a.text === '') {
        lines.push(`  No text could be extracted${a.kind === 'pdf' ? ' (a scanned or image-only pdf)' : ''}; open the file.`);
      } else {
        const fence = a.text.includes('```') ? '~~~~' : '```';
        lines.push(`  Extracted text${a.truncated ? ` (first ${ATTACHMENT_TEXT_EXCERPT_CHARS} characters)` : ''}:`, `  ${fence}`, ...a.text.split('\n').map((l) => `  ${l}`), `  ${fence}`);
      }
    }
  }
  return lines.join('\n');
}
