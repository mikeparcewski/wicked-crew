import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactProposal, ProposalSource } from '../src/core/types.js';
import {
  DocumentsRefused,
  RUN_DOCS_PACKET_MAX_BYTES,
  RUN_DOC_FILE_MAX_BYTES,
  documentsClause,
  stageRunDocuments,
  stagedDocumentsOf,
  type RunDocumentsDeps,
} from '../src/api/run-documents.js';
import { buildSourcePacket, pdfTextDerivative, readStagedAttachment, readStagedDocument, type PacketDeps } from '../src/interactive/source-packet.js';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const made: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
/** The staging makes its tree read-only (0555 dirs, 0444 files): relax it so the test can remove it. */
function relax(p: string): void {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  try {
    chmodSync(p, st.isDirectory() ? 0o755 : 0o644);
  } catch {
    /* best effort */
  }
  if (st.isDirectory()) {
    let ents: string[];
    try {
      ents = readdirSync(p);
    } catch {
      return;
    }
    for (const e of ents) relax(join(p, e));
  }
}
afterEach(() => {
  for (const d of made.splice(0)) {
    relax(d);
    rmSync(d, { recursive: true, force: true });
  }
});

const okAuth = async (_chatId: string, tokens: readonly string[]): Promise<ProposalSource[]> => tokens.map((t) => ({ token: t, label: t, status: 'ok' as const }));

/** A text pdf whose extractable text is exactly `chars` ASCII characters (one `(...) Tj`). */
function textPdf(chars: number): Buffer {
  return Buffer.from(`%PDF-1.4\nstream\nBT (${'A'.repeat(chars)}) Tj ET\nendstream\n%%EOF\n`, 'latin1');
}

describe('CS4 slice A: stage a job\'s documents into the run', () => {
  it('stages two attachment tokens under records/ with a matching MANIFEST, files 0444, dirs 0555, MANIFEST 0444', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'a1'), 'first file');
    writeFileSync(join(attDir, 'a2'), 'second file');
    const deps: RunDocumentsDeps = {
      authorize: okAuth,
      attachment: (_c, id) => (id === 'a1' ? { name: 'notes.txt', path: join(attDir, 'a1') } : id === 'a2' ? { name: 'plan.md', path: join(attDir, 'a2') } : null),
      docsRoot: async () => null,
      stateRoot,
    };
    const staged = await stageRunDocuments('run-1', 'c1', ['attachment:a1', 'attachment:a2'], deps);
    expect(staged.files.map((f) => f.file).sort()).toEqual(['attachment-a1-notes.txt', 'attachment-a2-plan.md']);
    const onDisk = readdirSync(staged.records);
    expect(onDisk).toContain('attachment-a1-notes.txt');
    expect(onDisk).toContain('MANIFEST.json');
    for (const f of staged.files) {
      const bytes = readFileSync(join(staged.records, f.file));
      expect(sha(bytes)).toBe(f.sha256);
      expect(statSync(join(staged.records, f.file)).mode & 0o777).toBe(0o444);
    }
    // Guard: the defence-in-depth chmods (0555 dirs, 0444 MANIFEST).
    expect(statSync(staged.root).mode & 0o777).toBe(0o555);
    expect(statSync(staged.records).mode & 0o777).toBe(0o555);
    expect(statSync(join(staged.records, 'MANIFEST.json')).mode & 0o777).toBe(0o444);
    const manifest = JSON.parse(readFileSync(join(staged.records, 'MANIFEST.json'), 'utf8')) as { run: string; chat: string; files: unknown[] };
    expect(manifest.run).toBe('run-1');
    expect(manifest.chat).toBe('c1');
    expect(manifest.files).toHaveLength(2);
  });

  // Guard: the all-or-nothing authorise gate for attachments.
  it('refuses the whole launch and writes nothing when a token is struck as another chat\'s file', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'a1'), 'ok file');
    const attachment = vi.fn((_c: string, id: string) => (id === 'a1' ? { name: 'ok.txt', path: join(attDir, 'a1') } : null));
    const authorize = async (_c: string, tokens: readonly string[]): Promise<ProposalSource[]> =>
      tokens.map((t) => (t === 'attachment:a2' ? { token: t, label: t, status: 'struck' as const, reason: 'not a file attached to this chat' } : { token: t, label: t, status: 'ok' as const }));
    await expect(stageRunDocuments('run-2', 'c1', ['attachment:a1', 'attachment:a2'], { authorize, attachment, docsRoot: async () => null, stateRoot })).rejects.toMatchObject({
      refused: [{ token: 'attachment:a2', reason: 'not a file attached to this chat' }],
    });
    expect(existsSync(join(stateRoot, 'run-2'))).toBe(false);
    expect(attachment).not.toHaveBeenCalled();
  });

  // Guard: the same authorise gate for doc: tokens.
  it('refuses a doc: token the chat never named', async () => {
    const stateRoot = tmp('cs4-state-');
    const docsRoot = vi.fn(async () => null);
    const authorize = async (_c: string, tokens: readonly string[]): Promise<ProposalSource[]> =>
      tokens.map((t) => ({ token: t, label: t, status: 'struck' as const, reason: 'not open or named in this chat' }));
    await expect(stageRunDocuments('run-3', 'c1', ['doc:mikes/deck'], { authorize, attachment: () => null, docsRoot, stateRoot })).rejects.toMatchObject({
      refused: [{ token: 'doc:mikes/deck', reason: 'not open or named in this chat' }],
    });
    expect(docsRoot).not.toHaveBeenCalled();
  });

  // Guard: a valid doc: token is staged; a doc:default/<doc> is canonicalised to Unfiled (_unfiled) and staged.
  it('stages a valid doc: token, and canonicalises doc:default/<doc> to Unfiled', async () => {
    const stateRoot = tmp('cs4-state-');
    const docs = tmp('cs4-docs-');
    mkdirSync(join(docs, 'deck'));
    writeFileSync(join(docs, 'deck', 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, html_file: '_v0.html' }] }));
    writeFileSync(join(docs, 'deck', '_v0.html'), '<p>slides</p>');
    const authorize = vi.fn(okAuth);
    const docsRoot = vi.fn(async (pid: string) => (pid === 'default' ? docs : null));
    const deps: RunDocumentsDeps = { authorize, attachment: () => null, docsRoot, stateRoot };
    const staged = await stageRunDocuments('run-doc', 'c1', ['doc:default/deck'], deps);
    // The token is canonical (_unfiled) both to authorise and in the manifest.
    expect(authorize).toHaveBeenCalledWith('c1', ['doc:_unfiled/deck']);
    expect(staged.files).toHaveLength(1);
    expect(staged.files[0]!.token).toBe('doc:_unfiled/deck');
    expect(staged.files[0]!.file).toMatch(/^doc-[0-9a-f]{12}-deck-v0\.html$/);
    expect(readFileSync(join(staged.records, staged.files[0]!.file), 'utf8')).toBe('<p>slides</p>');
    expect(docsRoot).toHaveBeenCalledWith('default');
  });

  // Guard (P2 #3): a present but non-array `versions` (object/string/null) is refused; an absent field keeps the
  // head-only legacy read. Without the guard a non-array value is coerced to [] and the head file is staged anyway.
  it('readStagedDocument refuses a non-array versions field and reads a head-only legacy manifest', async () => {
    const docs = tmp('cs4-docs-');
    const docsRoot = async (pid: string) => (pid === 'default' ? docs : null);
    const mk = (name: string, manifest: unknown) => {
      mkdirSync(join(docs, name));
      writeFileSync(join(docs, name, 'versions.json'), JSON.stringify(manifest));
      writeFileSync(join(docs, name, '_v0.html'), `<p>${name}</p>`);
    };
    mk('obj', { head: 0, versions: {} });
    mk('str', { head: 0, versions: 'x' });
    mk('nul', { head: 0, versions: null });
    mk('legacy', { head: 0 }); // no versions field at all
    for (const name of ['obj', 'str', 'nul']) {
      await expect(readStagedDocument(`_unfiled/${name}`, null, docsRoot, 1 << 20)).rejects.toMatchObject({ message: 'its versions.json is not readable' });
    }
    const legacy = await readStagedDocument('_unfiled/legacy', null, docsRoot, 1 << 20);
    expect(legacy.bytes.toString('utf8')).toBe('<p>legacy</p>');
  });

  // Guard (P3 #8): buildSourcePacket validates an attachment id BEFORE the lookup, so an invalid id is struck and the
  // attachment lookup is never called. Reintroducing an eager `deps.attachment` lookup would make the lookup throw here.
  it('buildSourcePacket strikes an invalid attachment id without calling the attachment lookup', async () => {
    const attachment = vi.fn((): { name: string; path: string } | null => {
      throw new Error('the attachment lookup must not run for an invalid id');
    });
    const deps: PacketDeps = {
      runs: async () => [],
      brief: async () => {
        throw new Error('no brief expected');
      },
      docsRoot: async () => null,
      attachment,
    };
    const resolution = {
      pid: 'c1:t2', chatId: 'c1', turnId: 't2', kind: 'create', seat: 'claude',
      what: { entry: 'document-static', title: 'T', label: 'Document · T', outcome: null },
      brief: 'b', reason: null,
      sources: [{ token: 'attachment:bad id!', label: 'bad', status: 'ok' }],
      repos: [], repoRefs: [], helpers: [], time: null, stops: null,
      filedIn: { projectId: null, label: 'x' }, blocked: null,
    } as unknown as ArtifactProposal;
    const packet = await buildSourcePacket({ runId: 'run-inv', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution, records: [] }, deps);
    expect(packet.struck).toContainEqual({ token: 'attachment:bad id!', reason: 'not an attachment id' });
    expect(attachment).not.toHaveBeenCalled();
  });

  // Guard: token-kind validation refuses anything but attachment:/doc: without touching the reader or authorise.
  it('refuses a token of another kind without calling the file reader', async () => {
    const stateRoot = tmp('cs4-state-');
    const attachment = vi.fn(() => null);
    const docsRoot = vi.fn(async () => null);
    const authorize = vi.fn(okAuth);
    await expect(stageRunDocuments('run-4', 'c1', ['run:x', 'chat'], { authorize, attachment, docsRoot, stateRoot })).rejects.toBeInstanceOf(DocumentsRefused);
    expect(attachment).not.toHaveBeenCalled();
    expect(docsRoot).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(existsSync(join(stateRoot, 'run-4'))).toBe(false);
  });

  // Guard: readStagedAttachment reads beneath the folder with no link at the leaf, so a symlink is refused.
  it('refuses a symlinked attachment file', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    const outside = tmp('cs4-outside-');
    writeFileSync(join(outside, 'secret'), 'secret bytes');
    symlinkSync(join(outside, 'secret'), join(attDir, 'a1'));
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: (_c, id) => (id === 'a1' ? { name: 'linked.txt', path: join(attDir, 'a1') } : null), docsRoot: async () => null, stateRoot };
    await expect(stageRunDocuments('run-5', 'c1', ['attachment:a1'], deps)).rejects.toBeInstanceOf(DocumentsRefused);
    expect(existsSync(join(stateRoot, 'run-5'))).toBe(false);
  });

  // Guard: readStagedAttachment validates the id BEFORE the lazy lookup (an invalid id never touches the shared reader).
  it('validates an attachment id before the lazy lookup runs', () => {
    let looked = false;
    expect(() =>
      readStagedAttachment('bad id!', () => {
        looked = true;
        throw new Error('the lookup must not run for an invalid id');
      }, 10),
    ).toThrow(/not an attachment id/);
    expect(looked).toBe(false);
  });

  // Guard: a long attachment name keeps its extension when shortened (a long x.pdf stays .pdf).
  it('keeps the extension when shortening a long staged attachment name', () => {
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'a'), 'x');
    const got = readStagedAttachment('id1', () => ({ name: `${'r'.repeat(200)}.pdf`, path: join(attDir, 'a') }), 10);
    expect(got.name.startsWith('attachment-id1-')).toBe(true);
    expect(got.name.endsWith('.pdf')).toBe(true);
  });

  // Guard: a pdf is staged with a labelled .pdf.txt derivative; a scan gets no derivative and a note.
  it('stages a pdf with a labelled .pdf.txt derivative, and a scanned pdf with no derivative and a note', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    const text = Buffer.from('%PDF-1.4\nstream\nBT (Hello world) Tj ET\nendstream\n%%EOF\n', 'latin1');
    const scanPdf = Buffer.from('%PDF-1.4\nstream\njust an image blob with no text operators\nendstream\n%%EOF\n', 'latin1');
    writeFileSync(join(attDir, 'p1'), text);
    writeFileSync(join(attDir, 'p2'), scanPdf);
    const deps: RunDocumentsDeps = {
      authorize: okAuth,
      attachment: (_c, id) => (id === 'p1' ? { name: 'report.pdf', path: join(attDir, 'p1') } : id === 'p2' ? { name: 'scan.pdf', path: join(attDir, 'p2') } : null),
      docsRoot: async () => null,
      stateRoot,
    };
    const staged = await stageRunDocuments('run-6', 'c1', ['attachment:p1', 'attachment:p2'], deps);
    const deriv = staged.files.find((f) => f.file === 'attachment-p1-report.pdf.txt');
    expect(deriv?.derived).toBe('pdf-text');
    const body = readFileSync(join(staged.records, 'attachment-p1-report.pdf.txt'), 'utf8');
    expect(body.split('\n')[0]).toBe("Extracted text of attachment-p1-report.pdf (may be lossy or incomplete; quote the original's page when a figure matters).");
    expect(body).toContain('Hello world');
    expect(staged.files.some((f) => f.file === 'attachment-p2-scan.pdf')).toBe(true);
    expect(staged.files.some((f) => f.file === 'attachment-p2-scan.pdf.txt')).toBe(false);
    expect(staged.notes).toContainEqual({ token: 'attachment:p2', note: 'no extractable text found (a scan?)' });
  });

  // Guard: pdfTextDerivative budgets the label + UTF-8 body in bytes, detects a cut reliably, and distinguishes a scan
  // from no room for even the label.
  it('pdfTextDerivative: cut when the text does not fit, scan when empty, no-room when the label will not fit', () => {
    const big = textPdf(400);
    const cut = pdfTextDerivative(big, 'x', 2000, 50);
    expect(cut.kind).toBe('text');
    if (cut.kind === 'text') {
      expect(cut.cut).toBe(true);
      expect(cut.chars).toBeLessThanOrEqual(50);
      expect(cut.bytes.length).toBeLessThanOrEqual(2000);
      expect(cut.bytes.toString('utf8').split('\n')[0]).toBe("Extracted text of x (may be lossy or incomplete; quote the original's page when a figure matters).");
    }
    const scan = Buffer.from('%PDF-1.4\nstream\nno operators here\nendstream\n%%EOF\n', 'latin1');
    expect(pdfTextDerivative(scan, 'x', 2000, 2000).kind).toBe('scan');
    // No byte room for even the label: the pdf is never scanned, so "no room", never "no extractable text".
    expect(pdfTextDerivative(big, 'x', 10, 2000).kind).toBe('no-room');
  });

  // Guard (P2 #2): extractPdfText counts raw pieces before collapsing whitespace, so a whitespace-heavy early piece
  // could stop extraction before a later text operator and claim the (short) result was whole. Extracting with a raw
  // cap well above the room captures the later text instead of silently dropping it.
  it('pdfTextDerivative does not silently drop later text behind a whitespace-heavy piece', () => {
    // `(A<50 spaces>) Tj (B) Tj`: the first raw piece is 51 chars; with a cap of 50 the old `cap + 1` extraction stops
    // before `(B) Tj`. The full normalised text is `A B` and fits in the room, so B must be present.
    const pdf = Buffer.from(`%PDF-1.4\nstream\nBT (A${' '.repeat(50)}) Tj (B) Tj ET\nendstream\n%%EOF\n`, 'latin1');
    const res = pdfTextDerivative(pdf, 'x', 2000, 50);
    expect(res.kind).toBe('text');
    if (res.kind === 'text') {
      const body = res.bytes.toString('utf8').split('\n').slice(1).join('\n');
      expect(body).toContain('A');
      expect(body).toContain('B');
    }
  });

  // Guard (P3 #6): the byte-trim shortens multibyte text to the byte room without splitting a UTF-8 sequence.
  it('pdfTextDerivative byte-trims multibyte text to the byte room, valid UTF-8, with a cut flag', () => {
    const LABEL = "Extracted text of x (may be lossy or incomplete; quote the original's page when a figure matters).";
    const labelBytes = Buffer.byteLength(`${LABEL}\n`, 'utf8');
    const pdf = Buffer.from(`%PDF-1.4\nstream\nBT (${'\u00e9'.repeat(200)}) Tj ET\nendstream\n%%EOF\n`, 'latin1');
    const maxBytes = labelBytes + 25; // room for 12 two-byte chars (24 bytes), not 13 (26)
    const res = pdfTextDerivative(pdf, 'x', maxBytes, 1_000_000); // a large char cap, so only the byte room cuts it
    expect(res.kind).toBe('text');
    if (res.kind === 'text') {
      expect(res.cut).toBe(true);
      expect(res.bytes.length).toBeLessThanOrEqual(maxBytes);
      expect(res.chars).toBe(12);
      expect(res.bytes.toString('utf8')).toBe(`${LABEL}\n${'\u00e9'.repeat(12)}`);
      // Valid UTF-8: re-encoding the decoded string yields the identical bytes (no split sequence left behind).
      expect(Buffer.from(res.bytes.toString('utf8'), 'utf8')).toEqual(res.bytes);
    }
  });

  // Guard (P3 #7): with no byte room for the label the extractor is never called (cheap work bound); with room it runs once.
  it('pdfTextDerivative skips extraction when the label will not fit, and runs it once when it will', () => {
    const pdf = textPdf(100);
    const extract = vi.fn(() => 'hello world');
    const none = pdfTextDerivative(pdf, 'n'.repeat(200), 10, 2000, extract);
    expect(none.kind).toBe('no-room');
    expect(extract).not.toHaveBeenCalled();
    const ok = pdfTextDerivative(pdf, 'x', 4000, 2000, extract);
    expect(ok.kind).toBe('text');
    expect(extract).toHaveBeenCalledTimes(1);
  });

  // Guard: a pdf's derivative is cut at the character cap, with a "text cut" note and the final char count.
  it('cuts a pdf text derivative at the cap, with the text-cut note', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    const pdf = textPdf(4_000_050); // over PDF_DERIVATIVE_MAX_CHARS (4,000,000)
    writeFileSync(join(attDir, 'p'), pdf);
    const deps: RunDocumentsDeps = {
      authorize: okAuth,
      attachment: (_c, id) => (id === 'p' ? { name: 'big.pdf', path: join(attDir, 'p') } : null),
      docsRoot: async () => null,
      stateRoot,
    };
    const staged = await stageRunDocuments('run-cut', 'c1', ['attachment:p'], deps);
    expect(staged.files.some((f) => f.file === 'attachment-p-big.pdf.txt')).toBe(true);
    expect(staged.notes.some((n) => n.token === 'attachment:p' && /text cut at 4000000 characters/.test(n.note))).toBe(true);
    const body = readFileSync(join(staged.records, 'attachment-p-big.pdf.txt'), 'utf8');
    expect(body.split('\n')[0]).toBe("Extracted text of attachment-p-big.pdf (may be lossy or incomplete; quote the original's page when a figure matters).");
  });

  // Guard: when there is no room for the derivative, the note says "no room", never "no extractable text".
  it('leaves a pdf\'s text out with a no-room note when the packet has no room for it', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    const tenMiB = join(attDir, 'ten');
    writeFileSync(tenMiB, Buffer.alloc(10 * 1024 * 1024, 0x61)); // one 10 MiB file, read by four filler ids
    const pdfName = `${'s'.repeat(80)}.pdf`; // a long name widens the no-room window (the label is longer)
    const pdf = Buffer.from('%PDF-1.4\nstream\nBT (hi there) Tj ET\nendstream\n%%EOF\n', 'latin1');
    const pdfPath = join(attDir, 'p');
    writeFileSync(pdfPath, pdf);
    // Fill the packet so the pdf original still fits but there is no room for even its derivative's label.
    const filler5Size = RUN_DOCS_PACKET_MAX_BYTES - 1500 - 4 * 10 * 1024 * 1024 - pdf.length;
    const f5 = join(attDir, 'f5');
    writeFileSync(f5, Buffer.alloc(filler5Size, 0x62));
    const deps: RunDocumentsDeps = {
      authorize: okAuth,
      attachment: (_c, id) =>
        id === 'f5'
          ? { name: 'f5.bin', path: f5 }
          : /^f[1-4]$/.test(id)
            ? { name: 'big.bin', path: tenMiB }
            : id === 'p'
              ? { name: pdfName, path: pdfPath }
              : null,
      docsRoot: async () => null,
      stateRoot,
    };
    const tokens = ['attachment:f1', 'attachment:f2', 'attachment:f3', 'attachment:f4', 'attachment:f5', 'attachment:p'];
    const staged = await stageRunDocuments('run-noroom', 'c1', tokens, deps);
    expect(staged.files.some((f) => f.token === 'attachment:p' && f.derived === undefined)).toBe(true);
    expect(staged.files.some((f) => f.file.endsWith('.pdf.txt'))).toBe(false);
    expect(staged.notes).toContainEqual({ token: 'attachment:p', note: 'its extracted text is left out: no room in the packet' });
  });

  // Guard (P2 #1): a pdf derivative, its manifest entry and its cut note are admitted together by serialised bytes, so a
  // derivative that fits with its note is shortened to fit and NOT refused. Without the fix the note (added after the
  // entry-only reservation) pushes the final manifest over the cap and the whole launch is refused.
  it('shortens a pdf derivative so its bytes, entry and cut note all fit (a note never turns a fitting packet into a refusal)', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    const tenMiB = join(attDir, 'ten');
    writeFileSync(tenMiB, Buffer.alloc(10 * 1024 * 1024, 0x61));
    const pdf = textPdf(200_000); // ~200 KB of extractable text, far larger than the room left for its derivative
    const pdfPath = join(attDir, 'p');
    writeFileSync(pdfPath, pdf);
    // Four 10 MiB fillers + f5 + the pdf original fill the packet to within a few KB: enough for the label and some
    // text (so a derivative is made and byte-cut), far less than the 200 KB of text, and tight enough that the old
    // entry-only reservation would admit the body then overflow when its cut note is added.
    const slack = 4096;
    const filler5Size = RUN_DOCS_PACKET_MAX_BYTES - slack - 4 * 10 * 1024 * 1024 - pdf.length;
    const f5 = join(attDir, 'f5');
    writeFileSync(f5, Buffer.alloc(filler5Size, 0x62));
    const deps: RunDocumentsDeps = {
      authorize: okAuth,
      attachment: (_c, id) =>
        id === 'f5'
          ? { name: 'f5.bin', path: f5 }
          : /^f[1-4]$/.test(id)
            ? { name: 'big.bin', path: tenMiB }
            : id === 'p'
              ? { name: 'r.pdf', path: pdfPath }
              : null,
      docsRoot: async () => null,
      stateRoot,
    };
    const tokens = ['attachment:f1', 'attachment:f2', 'attachment:f3', 'attachment:f4', 'attachment:f5', 'attachment:p'];
    const staged = await stageRunDocuments('run-notefit', 'c1', tokens, deps);
    const deriv = staged.files.find((f) => f.file === 'attachment-p-r.pdf.txt');
    expect(deriv?.derived).toBe('pdf-text');
    expect(staged.notes.some((n) => n.token === 'attachment:p' && /^text cut at \d+ characters$/.test(n.note))).toBe(true);
    // The whole packet (every file plus the real on-disk manifest) is within the cap: the note did not push it over.
    const manifestBytes = statSync(join(staged.records, 'MANIFEST.json')).size;
    const fileBytes = staged.files.reduce((s, f) => s + f.bytes, 0);
    expect(fileBytes + manifestBytes).toBeLessThanOrEqual(RUN_DOCS_PACKET_MAX_BYTES);
  });

  // Guard: the whole-packet cap by exact accounting; the token that crosses it is refused by name.
  it('refuses over the packet cap, naming the exact token that crossed it', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    const big = join(attDir, 'big');
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024, 0x61)); // 10 MiB, the per-file cap
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: (_c, id) => ({ name: `${id}.bin`, path: big }), docsRoot: async () => null, stateRoot };
    const tokens = ['b1', 'b2', 'b3', 'b4', 'b5'].map((i) => `attachment:${i}`);
    let err: unknown;
    await stageRunDocuments('run-7', 'c1', tokens, deps).catch((e) => (err = e));
    expect(err).toBeInstanceOf(DocumentsRefused);
    expect((err as DocumentsRefused).refused).toEqual([{ token: 'attachment:b5', reason: 'the documents would pass 50 MB' }]);
    expect(existsSync(join(stateRoot, 'run-7'))).toBe(false);
    expect(RUN_DOCS_PACKET_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  // Guard: the per-file cap (RUN_DOC_FILE_MAX_BYTES). Exactly at it passes; one byte over is refused.
  it('stages a file exactly at the per-file cap and refuses one a byte over it', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'ok'), Buffer.alloc(RUN_DOC_FILE_MAX_BYTES, 0x61));
    writeFileSync(join(attDir, 'big'), Buffer.alloc(RUN_DOC_FILE_MAX_BYTES + 1, 0x61));
    const deps: RunDocumentsDeps = {
      authorize: okAuth,
      attachment: (_c, id) => (id === 'ok' ? { name: 'ok.bin', path: join(attDir, 'ok') } : id === 'big' ? { name: 'big.bin', path: join(attDir, 'big') } : null),
      docsRoot: async () => null,
      stateRoot,
    };
    const staged = await stageRunDocuments('run-fit', 'c1', ['attachment:ok'], deps);
    expect(staged.files).toHaveLength(1);
    await expect(stageRunDocuments('run-over', 'c1', ['attachment:big'], deps)).rejects.toBeInstanceOf(DocumentsRefused);
    expect(existsSync(join(stateRoot, 'run-over'))).toBe(false);
  });

  // Guard: the token-count cap (RUN_DOCS_TOKENS_MAX). 20 distinct tokens stage; 21 are refused.
  it('stages 20 distinct tokens and refuses 21', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'f'), 'tiny');
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: () => ({ name: 'f.txt', path: join(attDir, 'f') }), docsRoot: async () => null, stateRoot };
    const t20 = Array.from({ length: 20 }, (_, i) => `attachment:a${i}`);
    const staged = await stageRunDocuments('run-20', 'c1', t20, deps);
    expect(staged.files).toHaveLength(20);
    const t21 = Array.from({ length: 21 }, (_, i) => `attachment:a${i}`);
    await expect(stageRunDocuments('run-21', 'c1', t21, deps)).rejects.toThrow(/at most 20/);
    expect(existsSync(join(stateRoot, 'run-21'))).toBe(false);
  });

  // Guard: a records/ name collision is a plain refusal, not an EEXIST crash from the exclusive create.
  it('refuses a name collision in records/ with a plain reason', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'x'), 'one');
    writeFileSync(join(attDir, 'y'), 'two');
    // id "a-b" + name "c" and id "a" + name "b-c" both name `attachment-a-b-c`.
    const deps: RunDocumentsDeps = {
      authorize: okAuth,
      attachment: (_c, id) => (id === 'a-b' ? { name: 'c', path: join(attDir, 'x') } : id === 'a' ? { name: 'b-c', path: join(attDir, 'y') } : null),
      docsRoot: async () => null,
      stateRoot,
    };
    await expect(stageRunDocuments('run-clash', 'c1', ['attachment:a-b', 'attachment:a'], deps)).rejects.toMatchObject({
      refused: [{ token: 'attachment:a', reason: 'another document is already staged under attachment-a-b-c' }],
    });
    expect(existsSync(join(stateRoot, 'run-clash'))).toBe(false);
  });

  // Guard: stagedDocumentsOf verifies every file's sha256 (a same-length tamper must be caught, not just a size change).
  it('reads a staging back, and returns null after a staged file is changed with the same length', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'a1'), 'original bytes');
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: (_c, id) => (id === 'a1' ? { name: 'notes.txt', path: join(attDir, 'a1') } : null), docsRoot: async () => null, stateRoot };
    const staged = await stageRunDocuments('run-8', 'c1', ['attachment:a1'], deps);
    expect(stagedDocumentsOf('run-8', stateRoot)).not.toBeNull();
    const target = join(staged.records, 'attachment-a1-notes.txt');
    chmodSync(staged.records, 0o755);
    chmodSync(target, 0o644);
    // Same byte length (14), different content: only the sha256 check can tell.
    expect('original bytes'.length).toBe('modified bytez'.length);
    writeFileSync(target, 'modified bytez');
    expect(stagedDocumentsOf('run-8', stateRoot)).toBeNull();
  });

  // Guard: stagedDocumentsOf validates the manifest shape and returns null (never throws) for a malformed one.
  it('stagedDocumentsOf returns null for a null manifest and for an extra unmanifested file', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'a1'), 'bytes');
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: (_c, id) => (id === 'a1' ? { name: 'n.txt', path: join(attDir, 'a1') } : null), docsRoot: async () => null, stateRoot };
    const staged = await stageRunDocuments('run-bad', 'c1', ['attachment:a1'], deps);
    chmodSync(staged.records, 0o755);
    // An extra, unmanifested file in records/.
    writeFileSync(join(staged.records, 'extra.txt'), 'surprise');
    expect(stagedDocumentsOf('run-bad', stateRoot)).toBeNull();
    rmSync(join(staged.records, 'extra.txt'));
    // A malformed manifest (null) returns null, never a thrown TypeError.
    const man = join(staged.records, 'MANIFEST.json');
    chmodSync(man, 0o644);
    writeFileSync(man, 'null');
    expect(() => stagedDocumentsOf('run-bad', stateRoot)).not.toThrow();
    expect(stagedDocumentsOf('run-bad', stateRoot)).toBeNull();
  });

  // Guard (P2 #4): recovery reads beneath the real stateRoot and follows NO link at the run dir OR the records dir, even
  // when the manifest identity would otherwise match. Same run basename in two roots, one linked to the other, so a
  // run-name mismatch cannot be the reason: only the no-follow protection makes it null. Removing it would return the
  // staging (the manifest.run matches).
  it('stagedDocumentsOf refuses a linked run dir and a linked records dir whose manifest identity matches', async () => {
    const root1 = tmp('cs4-state-');
    const root2 = tmp('cs4-state2-');
    const root3 = tmp('cs4-state3-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'a1'), 'bytes');
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: (_c, id) => (id === 'a1' ? { name: 'n.txt', path: join(attDir, 'a1') } : null), docsRoot: async () => null, stateRoot: root1 };
    const staged = await stageRunDocuments('shared-run', 'c1', ['attachment:a1'], deps);
    // The real staging reads back (its manifest.run === 'shared-run'), so the ONLY thing that can null a link is no-follow.
    expect(stagedDocumentsOf('shared-run', root1)).not.toBeNull();
    // A linked run dir in another root with the same basename: following the link would succeed; no-follow makes it null.
    symlinkSync(staged.root, join(root2, 'shared-run'));
    expect(stagedDocumentsOf('shared-run', root2)).toBeNull();
    // A real run dir whose records/ is a link to the real staging's records: following would succeed; no-follow -> null.
    mkdirSync(join(root3, 'shared-run'));
    symlinkSync(staged.records, join(root3, 'shared-run', 'records'));
    expect(stagedDocumentsOf('shared-run', root3)).toBeNull();
  });

  // Guard: the idempotency check keys on the run id and its token set.
  it('is idempotent for the same run id and tokens, and refuses a different set', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'a1'), 'first file');
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: (_c, id) => (id === 'a1' ? { name: 'notes.txt', path: join(attDir, 'a1') } : null), docsRoot: async () => null, stateRoot };
    await stageRunDocuments('run-9', 'c1', ['attachment:a1'], deps);
    const again = await stageRunDocuments('run-9', 'c1', ['attachment:a1'], deps);
    expect(again.files.map((f) => f.file)).toEqual(['attachment-a1-notes.txt']);
    await expect(stageRunDocuments('run-9', 'c1', ['attachment:a2'], deps)).rejects.toThrow(/different set/);
  });

  // Guard: authorise runs on EVERY call, before a cached staging is reused — a now-struck token refuses the retry.
  it('refuses a retry whose token is now struck, even though the earlier staging is cached', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    writeFileSync(join(attDir, 'a1'), 'first file');
    const attachment = (_c: string, id: string) => (id === 'a1' ? { name: 'notes.txt', path: join(attDir, 'a1') } : null);
    await stageRunDocuments('run-cache', 'c1', ['attachment:a1'], { authorize: okAuth, attachment, docsRoot: async () => null, stateRoot });
    const strike = async (_c: string, tokens: readonly string[]): Promise<ProposalSource[]> =>
      tokens.map((t) => ({ token: t, label: t, status: 'struck' as const, reason: 'no longer in this chat' }));
    await expect(stageRunDocuments('run-cache', 'c1', ['attachment:a1'], { authorize: strike, attachment, docsRoot: async () => null, stateRoot })).rejects.toBeInstanceOf(DocumentsRefused);
    // The earlier, authorised staging is untouched.
    expect(stagedDocumentsOf('run-cache', stateRoot)).not.toBeNull();
  });

  // Guard (P2 #5): staging is serialised per run id. A deferred `docsRoot` (a `doc:` token) holds the first call inside
  // its critical section; the second same-run call cannot enter while the first is held (docsRoot called exactly once),
  // and once the first publishes the second reuses it. Without the lock both would interleave and call docsRoot twice.
  it('serialises same-run staging: the second cannot enter while the first holds the lock, then both complete', async () => {
    const stateRoot = tmp('cs4-state-');
    const docs = tmp('cs4-docs-');
    mkdirSync(join(docs, 'deck'));
    writeFileSync(join(docs, 'deck', 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, html_file: '_v0.html' }] }));
    writeFileSync(join(docs, 'deck', '_v0.html'), '<p>slides</p>');
    let docsCalls = 0;
    let release!: (v: string | null) => void;
    const gate = new Promise<string | null>((r) => (release = r));
    const docsRoot = async (): Promise<string | null> => {
      docsCalls += 1;
      return gate; // the first call awaits here, inside the per-run critical section
    };
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: () => null, docsRoot, stateRoot };
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
    const p1 = stageRunDocuments('run-serial', 'c1', ['doc:default/deck'], deps);
    await tick(); // p1 acquires the lock, authorises, and reaches docsRoot (awaiting the gate)
    const p2 = stageRunDocuments('run-serial', 'c1', ['doc:default/deck'], deps);
    await tick(); // p2 is blocked on the per-run lock, so it never reaches docsRoot
    expect(docsCalls).toBe(1);
    release(docs); // p1 finishes and publishes; p2 then enters and reuses the published staging
    const [a, b] = await Promise.all([p1, p2]);
    expect(docsCalls).toBe(1); // p2 reused the published staging, never reading the doc again
    expect(a.files.map((f) => f.file)).toEqual(b.files.map((f) => f.file));
    expect(a.files[0]!.sha256).toBe(b.files[0]!.sha256);
  });

  // Guard (P2 #5): when the destination appears between the fast-path check and the publish, the build falls back to
  // reuse (idempotent publish) instead of throwing. Forced by dropping an identical staging into finalRoot mid-build.
  it('publishes idempotently when the destination appears at publish time', async () => {
    const stateRoot = tmp('cs4-state-');
    const other = tmp('cs4-other-');
    const docs = tmp('cs4-docs-');
    mkdirSync(join(docs, 'deck'));
    writeFileSync(join(docs, 'deck', 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, html_file: '_v0.html' }] }));
    writeFileSync(join(docs, 'deck', '_v0.html'), '<p>slides</p>');
    // An identical staging built elsewhere, to drop into finalRoot while the real build is mid-flight.
    const built = await stageRunDocuments('run-pub', 'c1', ['doc:default/deck'], { authorize: okAuth, attachment: () => null, docsRoot: async () => docs, stateRoot: other });
    let injected = false;
    const docsRoot = async (): Promise<string | null> => {
      if (!injected) {
        injected = true;
        relax(built.root); // the staging is read-only (0555); relax it so the test can move it into place
        renameSync(built.root, join(stateRoot, 'run-pub')); // the destination appears after the fast-path check
      }
      return docs;
    };
    const staged = await stageRunDocuments('run-pub', 'c1', ['doc:default/deck'], { authorize: okAuth, attachment: () => null, docsRoot, stateRoot });
    expect(staged.files).toHaveLength(1);
    expect(staged.files[0]!.file).toMatch(/^doc-[0-9a-f]{12}-deck-v0\.html$/);
    expect(existsSync(join(stateRoot, 'run-pub'))).toBe(true);
  });

  // Guard (P3 #9): the clause names the records folder and the data rule, and for a staged pdf describes its actual
  // derivative filename as extracted text FROM its actual original filename (the manifest-derived pairing branch).
  it('documentsClause is one line naming the records folder, the data rule, and the exact .pdf.txt-from-pdf pairing', async () => {
    const stateRoot = tmp('cs4-state-');
    const attDir = tmp('cs4-att-');
    const text = Buffer.from('%PDF-1.4\nstream\nBT (Hello world) Tj ET\nendstream\n%%EOF\n', 'latin1');
    writeFileSync(join(attDir, 'p1'), text);
    const deps: RunDocumentsDeps = { authorize: okAuth, attachment: (_c, id) => (id === 'p1' ? { name: 'report.pdf', path: join(attDir, 'p1') } : null), docsRoot: async () => null, stateRoot };
    const staged = await stageRunDocuments('run-10', 'c1', ['attachment:p1'], deps);
    const clause = documentsClause(staged);
    expect(clause).not.toContain('\n');
    expect(clause).toContain(staged.records);
    expect(clause).toContain('DATA');
    expect(clause).toContain('records/');
    // The exact pairing: the real derivative filename, described as extracted text from the real original filename.
    expect(clause).toContain('`attachment-p1-report.pdf.txt` from `attachment-p1-report.pdf`');
  });
});
