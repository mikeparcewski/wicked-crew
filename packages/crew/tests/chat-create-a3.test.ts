// DES-CHAT-ARTIFACTS-001 §4.3, §5.2, §5.3, §6.2 (slice A3): grounded create, filed under the chat, exactly once.
// The durable binding, the source packet (immutable names, containment, hashes), the proxy's `chat_id` grant, the real
// `create` launcher on A2's launch-once registry (double click, lost response, two tabs, a crash between launch and
// record, a crash between create and draft launch, a late bus trigger), retry proposals, one live job per chat and per
// document, the project re-check of a Change something, and the boot reconcile before the resume sweep.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, AuditEntry, ChatTranscriptRecord, CoreEvent, SessionView } from '../src/core/types.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { ChatProposals, foldProposals, LaunchOnceRegistry, proposalRunId, type ChatProposalDeps, type ProposalChat } from '../src/api/chat-proposals.js';
import { DocBindingError, DocBindingStore } from '../src/interactive/doc-binding.js';
import { buildSourcePacket, packetClause, PACKET_FILE_MAX_BYTES, PACKET_MAX_BYTES, type PacketDeps } from '../src/interactive/source-packet.js';
import { boundAttemptKey, isAnotherProjectsDraftKey, packetChanged, removeAttemptDirs, removePacketCopy, writePacketCopy, type BoundDraft } from '../src/interactive/draft-events.js';
import { CreateLauncher, reconcileBoundAttempts, recoveredChatId } from '../src/interactive/proposal-create.js';
import { prepareDocCreate } from '../src/interactive/proxy-routes.js';
import { resumeOrphanedRuns } from '../src/core/run-boot-resume.js';
import { RunTimingIndex, recordRunLaunched } from '../src/api/run-timing-index.js';
import type { CoreAdapter } from '../src/core/adapter.js';

const ROOT = mkdtempSync(join(tmpdir(), 'chat-create-a3-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let seq = 0;
const fresh = (name: string): string => {
  const d = join(ROOT, `${name}-${(seq += 1)}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const ME: Actor = { id: 'maria', kind: 'human', trust: 'operator' };

const R1 = '29bbbfb1-157b-4c44-9d0c-aaaaaaaaaaaa';
const R2 = '679ca85b-0000-4000-8000-bbbbbbbbbbbb';
const R3 = '57443b2b-0000-4000-8000-cccccccccccc';
function run(id: string, o: { status?: string; project?: string | null } = {}): SessionView {
  return {
    session: { id, status: o.status ?? 'completed', project_id: o.project ?? null, problem: `run ${id}`, workflow_id: 'wf', repo_ref: null, run_identity: { name: 'wf' } },
    units: [],
  } as unknown as SessionView;
}
/** A brief whose figures come from the run: the "records" the packet must carry. */
const FIGURES: Record<string, string> = { [R1]: '61% (3585 of 5786)', [R2]: '79% (3452 of 4333)', [R3]: '80% (3476 of 4333)' };
const briefOf = async (v: SessionView): Promise<{ runId: string; status: string; title: string; markdown: string; sha256: string }> => {
  const md = `# Run ${v.session.id.slice(0, 8)}\n\nCoverage: ${FIGURES[v.session.id] ?? 'n/a'}\n`;
  return { runId: v.session.id, status: String(v.session.status), title: 't', markdown: md, sha256: sha(md) };
};

const helpers = { seats: ['claude', 'codex'], label: 'Claude Code and Codex: one writes, the other checks' };
function proposal(pid: string, o: Partial<ArtifactProposal> = {}): ArtifactProposal {
  return {
    pid, chatId: pid.split(':')[0]!, turnId: pid.split(':')[1] ?? null, kind: 'create', seat: 'claude',
    what: { entry: 'document-static', title: 'Release note', label: 'Document · Release note', outcome: null },
    brief: 'a one-page release note: requirements coverage 61% to 80%', reason: null,
    sources: [
      { token: 'chat', label: 'this conversation', status: 'ok' },
      { token: `run:${R1}`, label: 'run 29bbbfb1', status: 'ok', projectId: null },
      { token: `run:${R2}`, label: 'run 679ca85b', status: 'ok', projectId: null },
      { token: `run:${R3}`, label: 'run 57443b2b', status: 'ok', projectId: null },
      { token: 'run:deadbeef', label: 'run deadbeef', status: 'struck', reason: 'not named in this chat' },
    ],
    repos: ['wicked-crew'], repoRefs: ['repo-crew'], helpers, time: null, stops: null,
    filedIn: { projectId: null, label: 'Not in a project · this chat' }, blocked: null, ...o,
  };
}

/** A chat's records: the person asks about three runs, an agent answers (its turn was given the three briefs), then
 *  the person asks for the release note. */
function chatRecords(chatId: string): ChatTranscriptRecord[] {
  return [
    { at: 1, turnId: 't1', kind: 'user', text: `What did runs ${R1}, ${R2} and ${R3} measure?`, seats: ['claude'], owner: true },
    { at: 1, turnId: 't1', kind: 'context', runs: [R1, R2, R3].map((id) => ({ id, status: 'completed', brief: `context/run-${id}.md`, sha256: 'x' })), refused: [], page: false, named: { runs: [R1, R2, R3], docs: [] } },
    { at: 2, turnId: 't1', kind: 'seat', cliKey: 'claude', text: 'They took coverage from 61% to 80%.', ok: true, usage: null },
    { at: 3, turnId: 't2', kind: 'user', text: 'Write a release note for that, from those three runs.', seats: ['claude'], owner: true },
    { at: 3, turnId: 't2', kind: 'context', runs: [], refused: [], page: false, named: { runs: [R1, R2, R3], docs: [] } },
    { at: 4, turnId: 't2', kind: 'seat', cliKey: 'claude', text: 'I can make that as a document.', ok: true, usage: null },
    { at: 4, turnId: 't2', kind: 'proposal', proposal: proposal(`${chatId}:t2`) },
  ];
}

const packetDeps = (runs: SessionView[], docsRoot: (p: string) => string | null = () => null, attachments: Record<string, { name: string; path: string }> = {}): PacketDeps => ({
  runs: async () => runs,
  brief: briefOf,
  docsRoot: async (p) => docsRoot(p),
  attachment: (_c, id) => attachments[id] ?? null,
});

// ── the durable binding ──────────────────────────────────────────────────────────────────────────────────────────────

describe('the durable per-document binding (A3)', () => {
  const init = { ref: '_unfiled/release-note-abc12345', mount: '_unfiled', doc: 'release-note-abc12345', projectId: null, owner: 'maria', chatId: 'c1', chatInstance: 'i1', scopeProject: null, proposalId: 'c1:t2', cutoffTurnId: 't2', repos: [{ id: 'repo-crew', name: 'wicked-crew', rootPath: '/r' }], graphDb: null };

  it('records an attempt before anything starts, once per run id; a retry is a second attempt at the same document', () => {
    const dir = fresh('bind');
    const s = new DocBindingStore(dir);
    s.begin(init, { pid: 'c1:t2', runId: 'run-a', base: 0 });
    s.begin(init, { pid: 'c1:t2', runId: 'run-a', base: 0 });
    expect(s.get(init.ref)?.attempts).toHaveLength(1);
    s.begin({ ...init, repos: [] }, { pid: 'c1:retry:run-a', runId: 'run-b', base: 0 });
    const b = new DocBindingStore(dir).get(init.ref)!; // durable: a fresh store reads it back
    expect(b.attempts.map((a) => a.runId)).toEqual(['run-a', 'run-b']);
    expect(b.repos).toEqual(init.repos); // a retry keeps the first attempt's grounding
    expect(new DocBindingStore(dir).isBound('run-b')).toBe(true);
    expect(new DocBindingStore(dir).isBound('run-z')).toBe(false);
  });

  it('busy until an outcome is recorded; only the first outcome counts', () => {
    const s = new DocBindingStore(fresh('bind'));
    s.begin(init, { pid: 'c1:t2', runId: 'run-a', base: 0 });
    expect(s.live('run-a')).toBe(true);
    expect(s.busy(init.ref)?.runId).toBe('run-a');
    expect(s.setOutcome(init.ref, 'run-a', { kind: 'failed', reason: 'interrupted by a restart' })).toBe(true);
    expect(s.setOutcome(init.ref, 'run-a', { kind: 'landed', version: 1 })).toBe(false);
    expect(s.get(init.ref)?.attempts[0]?.outcome).toMatchObject({ kind: 'failed', reason: 'interrupted by a restart' });
    expect(s.live('run-a')).toBe(false);
    expect(s.busy(init.ref)).toBeNull();
  });

  it('packet names are immutable: the same bytes again is a no-op, different bytes under a held name is an error, and a tampered stored copy is refused', () => {
    const s = new DocBindingStore(fresh('bind'));
    s.begin(init, { pid: 'c1:t2', runId: 'run-a', base: 0 });
    s.addPacket(init.ref, [{ name: `run-${R1}-aaaaaaaa.md`, bytes: Buffer.from('one') }], { [`run:${R1}`]: [`run-${R1}-aaaaaaaa.md`] });
    s.addPacket(init.ref, [{ name: `run-${R1}-aaaaaaaa.md`, bytes: Buffer.from('one') }], {});
    expect(() => s.addPacket(init.ref, [{ name: `run-${R1}-aaaaaaaa.md`, bytes: Buffer.from('two') }], {})).toThrow(DocBindingError);
    expect(() => s.addPacket(init.ref, [{ name: '../escape.md', bytes: Buffer.from('x') }], {})).toThrow(/refusing packet file name/);
    expect(s.packetBytes(init.ref, `run-${R1}-aaaaaaaa.md`).toString()).toBe('one');
    writeFileSync(join(s.packetDir(init.ref), `run-${R1}-aaaaaaaa.md`), 'changed');
    expect(() => s.packetBytes(init.ref, `run-${R1}-aaaaaaaa.md`)).toThrow(/does not match its recorded hash/);
  });
});

// ── the source packet ────────────────────────────────────────────────────────────────────────────────────────────────

describe('the source packet (A3, §5.2-§5.3)', () => {
  const runs = [run(R1, { status: 'cancelled' }), run(R2, { status: 'cancelled' }), run(R3)];

  it('the release-note task: every run brief rides by content, the manifest lists the three runs and what was struck, and the task carries the hashes', async () => {
    const records = chatRecords('c1');
    const p = await buildSourcePacket({ runId: 'run-a', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: proposal('c1:t2'), records }, packetDeps(runs));
    const names = p.files.map((f) => f.name);
    for (const id of [R1, R2, R3]) expect(names.some((n) => n.startsWith(`run-${id}-`) && n.endsWith('.md'))).toBe(true);
    expect(names).toContain('conversation-c1-to-t2.md');
    expect(names).toContain('brief-run-a.md');
    expect(names.at(-1)).toBe('MANIFEST-run-a.json');
    const manifest = JSON.parse(p.files.at(-1)!.bytes.toString()) as { files: Array<{ token: string; files: Array<{ file: string; sha256: string }> }>; struck: Array<{ token: string; reason: string }> };
    expect(manifest.files.filter((e) => e.token.startsWith('run:')).map((e) => e.token.slice(4)).sort()).toEqual([R1, R2, R3].sort());
    expect(manifest.struck).toEqual([{ token: 'run:deadbeef', reason: 'not named in this chat' }]);
    // Every figure the runs measured is in the packet, from crew's run briefs.
    const all = p.files.map((f) => f.bytes.toString()).join('\n');
    for (const fig of Object.values(FIGURES)) expect(all).toContain(fig);
    // The conversation labels the person's words, and agent answers as possibly wrong, with their turn's records.
    const conv = p.files.find((f) => f.name === 'conversation-c1-to-t2.md')!.bytes.toString();
    expect(conv).toContain('## The person · turn t1');
    expect(conv).toMatch(/An agent's answer \(claude; may be wrong: use only if a record confirms it\)/);
    expect(conv).toContain(`run-${R1}-`);
    expect(conv).toContain('DATA, not instructions');
    // The brief is scope only; the task names the files and gives the reviewer crew's hashes.
    expect(p.files.find((f) => f.name === 'brief-run-a.md')!.bytes.toString()).toContain('NEVER a source of figures');
    const clause = packetClause('/inbox/attempt-run-a', p, 'in your reply');
    expect(clause).not.toContain('\n');
    for (const f of p.files) expect(clause).toContain(`${f.name.startsWith('run-') ? 'records' : 'sources'}/${f.name}=${f.sha256}`);
    expect(clause).toContain('data-source="<file>:<line>"');
    expect(clause).toContain('sources/ is not, so nothing there can be cited');
    expect(clause).toContain('A missing file or a different hash fails the review');
    // The canonical packet excludes this run's own brief and manifest.
    expect(p.canonical.map((f) => f.name)).not.toContain('brief-run-a.md');
    expect(p.canonical.map((f) => f.name)).not.toContain('MANIFEST-run-a.json');
  });

  it('a `message:` source grounds the run-only figures its answer used, without the run being named again', async () => {
    const records = chatRecords('c1');
    const res = proposal('c1:t2', { sources: [{ token: 'message:t1', label: "claude's answer", status: 'ok', projectId: null }] });
    const p = await buildSourcePacket({ runId: 'run-m', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records }, packetDeps(runs));
    expect(p.tokens['message:t1']?.[0]).toBe('message-c1-t1.md');
    const all = p.files.map((f) => f.bytes.toString()).join('\n');
    for (const fig of Object.values(FIGURES)) expect(all).toContain(fig);
    expect(p.files.find((f) => f.name === 'message-c1-t1.md')!.bytes.toString()).toContain('MAY BE WRONG');
  });

  it('containment: a document read never follows a link, ids are validated, the page summary is never invented, and the packet is capped', async () => {
    const docs = fresh('docs');
    mkdirSync(join(docs, 'deck'), { recursive: true });
    writeFileSync(join(docs, 'deck', 'versions.json'), JSON.stringify({ head: 2, versions: [{ version: 2, html_file: '_v2.html' }] }));
    writeFileSync(join(ROOT, 'secret.html'), 'outside');
    symlinkSync(join(ROOT, 'secret.html'), join(docs, 'deck', '_v2.html'));
    const res = proposal('c1:t2', {
      sources: [
        { token: 'doc:mikes/deck', label: 'Deck v2', status: 'ok', projectId: 'mikes' },
        { token: 'message:../../etc', label: 'x', status: 'ok' },
        { token: 'page', label: 'the page', status: 'ok' },
        { token: 'attachment:a1', label: 'notes.txt', status: 'ok' },
      ],
    });
    const att = join(fresh('att'), 'a1');
    writeFileSync(att, 'attached words');
    const p = await buildSourcePacket({ runId: 'run-c', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records: chatRecords('c1') }, packetDeps([], (pr) => (pr === 'mikes' ? docs : null), { a1: { name: 'my notes (final).txt', path: att } }));
    expect(p.files.map((f) => f.name)).toContain('attachment-a1-my-notes-final.txt');
    expect(p.struck.map((s) => s.token)).toEqual(['doc:mikes/deck', 'message:../../etc', 'page']);
    expect(p.struck.find((s) => s.token === 'page')?.reason).toBe("studio's page summary is not kept after the message");
    expect(p.files.map((f) => f.bytes.toString()).join('')).not.toContain('outside');
    // Over the packet cap: struck with the reason, never truncated silently; the brief and the manifest always fit.
    const big = join(fresh('att'), 'big');
    writeFileSync(big, 'x'.repeat(PACKET_FILE_MAX_BYTES));
    const many = proposal('c1:t2', { sources: ['b1', 'b2', 'b3'].map((id) => ({ token: `attachment:${id}`, label: id, status: 'ok' as const })) });
    const q = await buildSourcePacket({ runId: 'run-d', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: many, records: [] }, packetDeps([], () => null, { b1: { name: 'b', path: big }, b2: { name: 'b', path: big }, b3: { name: 'b', path: big } }));
    expect(q.files.reduce((n, f) => n + f.bytes.length, 0)).toBeLessThanOrEqual(PACKET_MAX_BYTES);
    expect(q.files.map((f) => f.name)).toEqual(['attachment-b1-b', 'brief-run-d.md', 'MANIFEST-run-d.json']);
    expect(q.struck.filter((s) => /packet would pass/.test(s.reason)).map((s) => s.token)).toEqual(['attachment:b2', 'attachment:b3']);
  });

  it('a later attempt reuses the canonical files by token, never rebuilding them under the same name', async () => {
    const records = chatRecords('c1');
    const first = await buildSourcePacket({ runId: 'run-a', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: proposal('c1:t2'), records }, packetDeps(runs));
    const held = new Map(first.canonical.map((f) => [f.name, f.bytes]));
    // The runs' briefs would now read differently: a rebuild would change the conversation's run brief bytes.
    const changed: PacketDeps = { ...packetDeps(runs), brief: async (v) => ({ ...(await briefOf(v)), markdown: 'different', sha256: sha('different') }) };
    const second = await buildSourcePacket(
      { runId: 'run-b', chatId: 'c1', pid: 'c1:retry:run-a', cutoffTurnId: 't2', resolution: proposal('c1:t2'), records, held: { tokens: first.tokens, bytes: (n) => held.get(n)! } },
      changed,
    );
    for (const f of first.canonical) expect(second.files.find((x) => x.name === f.name)?.sha256).toBe(f.sha256);
    expect(second.files.map((f) => f.name)).toContain('MANIFEST-run-b.json');
  });

  it('the inbox copy: an earlier writer\'s link or changed file is replaced with crew\'s bytes; a change during the run is detected', async () => {
    const p = await buildSourcePacket({ runId: 'run-a', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: proposal('c1:t2'), records: chatRecords('c1') }, packetDeps(runs));
    const runDir = fresh('inbox');
    const elsewhere = fresh('elsewhere');
    // An earlier writer planted a link where the attempt folder goes: refused, nothing written through it.
    symlinkSync(elsewhere, join(runDir, 'attempt-run-a'));
    expect(() => writePacketCopy(runDir, 'attempt-run-a', p)).toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(join(runDir, 'attempt-run-a'));
    writePacketCopy(runDir, 'attempt-run-a', p);
    const att = join(runDir, 'attempt-run-a');
    // Records (what a figure may cite) and the rest live apart: the claims floor reads records/ only.
    expect(readdirSync(join(att, 'records')).every((n) => n.startsWith('run-'))).toBe(true);
    expect(readdirSync(join(att, 'sources')).sort()).toEqual(['MANIFEST-run-a.json', 'brief-run-a.md', 'conversation-c1-to-t2.md']);
    const files = p.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes.length }));
    expect(packetChanged(runDir, 'attempt-run-a', files)).toBeNull();
    // A file the writer ADDS to records/ would be a citable "record": it is a change too.
    writeFileSync(join(att, 'records', 'run-fake-00000000.md'), 'Coverage: 99%');
    expect(packetChanged(runDir, 'attempt-run-a', files)).toBe('records/run-fake-00000000.md');
    rmSync(join(att, 'records', 'run-fake-00000000.md'));
    const victim = p.files.find((f) => f.name.startsWith(`run-${R2}`))!.name;
    writeFileSync(join(att, 'records', victim), 'Coverage: 99% (3452 of 4333)');
    expect(packetChanged(runDir, 'attempt-run-a', files)).toBe(victim);
    // A file grown huge, or swapped for a FIFO, is a change: read bounded by the recorded size, never blocking.
    writeFileSync(join(att, 'records', victim), 'x'.repeat(2 * 1024 * 1024));
    expect(packetChanged(runDir, 'attempt-run-a', files)).toBe(victim);
    rmSync(join(att, 'records', victim));
    execFileSync('mkfifo', [join(att, 'records', victim)]);
    expect(packetChanged(runDir, 'attempt-run-a', files)).toBe(victim);
    // The attempt folder swapped for a link (the writer's write root is the run folder): nothing is read through it,
    // and cleanup removes the link, never what it points at.
    const outside = fresh('outside');
    mkdirSync(join(outside, 'sources'));
    writeFileSync(join(outside, 'sources', 'keep.txt'), 'not crew\'s');
    rmSync(att, { recursive: true, force: true });
    symlinkSync(outside, att);
    expect(packetChanged(runDir, 'attempt-run-a', files)).not.toBeNull();
    removePacketCopy(runDir, 'attempt-run-a');
    expect(readFileSync(join(outside, 'sources', 'keep.txt'), 'utf8')).toBe("not crew's");
    // The next attempt starts in a fresh folder: the document's earlier attempts go, never another's.
    mkdirSync(join(runDir, 'attempt-someone-elses'));
    removeAttemptDirs(runDir, ['run-a']);
    expect(existsSync(att)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(join(runDir, 'attempt-someone-elses'))).toBe(true);
    writePacketCopy(runDir, 'attempt-run-b', p);
    expect(packetChanged(runDir, 'attempt-run-b', files)).toBeNull();
    expect(readFileSync(join(runDir, 'attempt-run-b', 'records', victim), 'utf8')).toContain('79%');
  });

  it('a document moved to another project keeps only the answers whose records are all inside it', async () => {
    const records = chatRecords('c1');
    const p = await buildSourcePacket(
      { runId: 'run-p', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: proposal('c1:t2', { sources: [{ token: 'chat', label: 'this conversation', status: 'ok' }] }), records, recheckProject: 'mikes' },
      packetDeps(runs),
    );
    const conv = p.files.find((f) => f.name === 'conversation-c1-to-t2.md')!.bytes.toString();
    expect(conv).toContain('(left out: it used records outside the project');
    expect(conv).not.toContain('They took coverage');
    expect(conv).toContain('Write a release note'); // the person's words stay
    expect(p.struck).toEqual([{ token: 'chat', reason: '1 answer left out: records outside the target project' }]);
  });
});

// ── the proxy grant ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("the proxy's chat_id grant (A3, §5.2)", () => {
  const adapter = { projectMembers: async () => [], listRepos: async () => [] } as unknown as CoreAdapter;
  const grant = { doc: 'release-note-abc12345', projectId: 'default', repos: [{ id: 'repo-crew', name: 'wicked-crew' }] };
  const body = (o: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify({ name: 'release-note-abc12345', kind: 'source', brief: 'x', ...o }));

  it('a bare chat_id (or proposal_id) grants nothing: refused, never ignored', async () => {
    for (const extra of [{ chat_id: 'c1' }, { proposal_id: 'c1:t2' }, { chat_id: 'c1', proposal_id: 7 }]) {
      const out = await prepareDocCreate(body({ ...extra, repo_refs: ['wicked-crew'] }), 'application/json', adapter, 'default', undefined, () => grant);
      expect(out.refusal?.code).toBe('proposal_grant_refused');
    }
  });

  it('lifts unfiled_doc_repo ONLY through a matching accepted record: same doc, same mount, every repo listed', async () => {
    // Without a record (or for another actor) the Unfiled rule holds.
    expect((await prepareDocCreate(body({ chat_id: 'c1', proposal_id: 'c1:t2', repo_refs: ['wicked-crew'] }), 'application/json', adapter, 'default', undefined, () => null)).refusal?.code).toBe('proposal_grant_refused');
    expect((await prepareDocCreate(body({ repo_refs: ['wicked-crew'] }), 'application/json', adapter, 'default', undefined, () => grant)).refusal?.code).toBe('unfiled_doc_repo');
    // Another document, another mount, an unlisted repository: refused.
    expect((await prepareDocCreate(body({ name: 'other-doc', chat_id: 'c1', proposal_id: 'c1:t2' }), 'application/json', adapter, 'default', undefined, () => grant)).refusal?.code).toBe('proposal_grant_refused');
    expect((await prepareDocCreate(body({ chat_id: 'c1', proposal_id: 'c1:t2' }), 'application/json', adapter, 'mikes', undefined, () => grant)).refusal?.code).toBe('proposal_grant_refused');
    expect((await prepareDocCreate(body({ chat_id: 'c1', proposal_id: 'c1:t2', repo_refs: ['wicked-core'] }), 'application/json', adapter, 'default', undefined, () => grant)).refusal?.code).toBe('proposal_grant_refused');
    // The grant: allowed, resolved to the registry id, and neither field reaches the bridge.
    const ok = await prepareDocCreate(body({ chat_id: 'c1', proposal_id: 'c1:t2', repo_refs: ['wicked-crew'] }), 'application/json', adapter, 'default', undefined, () => grant);
    expect(ok.refusal).toBeUndefined();
    expect(ok.binding?.repoRefs).toEqual(['repo-crew']);
    expect(ok.proposal).toEqual({ chatId: 'c1', proposalId: 'c1:t2' });
    expect(Object.keys(ok.normalized!)).not.toContain('chat_id');
    expect(ok.body.toString()).not.toContain('proposal_id');
  });
});

// ── the launcher, end to end over the accept flow ────────────────────────────────────────────────────────────────────

interface World {
  svc: ChatProposals;
  records: Map<string, ChatTranscriptRecord[]>;
  bindings: DocBindingStore;
  registry: LaunchOnceRegistry;
  docs: string;
  creates: Array<Record<string, unknown>>;
  launches: BoundDraft[];
  engine: Set<string>;
  grantsAtCreate: Array<unknown>;
  failLaunch: number;
  chats: Map<string, ProposalChat>;
  frames: CoreEvent[];
}

function world(o: { bindingsDir?: string; records?: Map<string, ChatTranscriptRecord[]>; engine?: Set<string>; docs?: string } = {}): World {
  const w = {
    records: o.records ?? new Map<string, ChatTranscriptRecord[]>(),
    bindings: new DocBindingStore(o.bindingsDir ?? fresh('bindings')),
    registry: new LaunchOnceRegistry(),
    docs: o.docs ?? fresh('docs'),
    creates: [],
    launches: [],
    engine: o.engine ?? new Set<string>(),
    grantsAtCreate: [],
    failLaunch: 0,
    chats: new Map<string, ProposalChat>(),
    frames: [],
  } as unknown as World;
  const roots: Record<string, string> = { default: join(w.docs, '_unfiled'), mikes: join(w.docs, 'mikes') };
  for (const r of Object.values(roots)) mkdirSync(r, { recursive: true });
  const docsRoot = async (p: string): Promise<string | null> => roots[p] ?? null;
  const runs = [run(R1), run(R2), run(R3)];
  w.registry.register('create', new CreateLauncher({
    bindings: w.bindings,
    runExists: async (id) => w.engine.has(id),
    docsRoot,
    createDoc: async (projectId, body, actorId) => {
      w.grantsAtCreate.push(w.svc.grantFor(String(body['chat_id']), String(body['proposal_id']), actorId));
      w.creates.push(body);
      const dir = join(roots[projectId]!, String(body['name']));
      if (existsSync(dir)) return { status: 409, body: { error: 'exists' } };
      mkdirSync(dir);
      writeFileSync(join(dir, 'versions.json'), JSON.stringify({ head: 0, kind: 'doc', versions: [{ version: 0 }] }));
      return { status: 200, body: { name: body['name'], head: 0, generating: true, projectId } };
    },
    launchBound: async (spec) => {
      if (w.failLaunch > 0) {
        w.failLaunch -= 1;
        throw new Error('the engine is restarting');
      }
      w.launches.push(spec);
      w.engine.add(spec.runId);
      w.bindings.markLaunched(spec.artifactRef, spec.runId);
    },
    records: (c) => w.records.get(c) ?? [],
    instanceOf: (c) => (w.records.has(c) ? 'i1' : null),
    chatIdOf: (c, instance) => (w.records.has(c) && (instance === null || instance === 'i1') ? c : w.records.has(`${c}--1`) ? `${c}--1` : null),
    repos: async () => [{ id: 'repo-crew', name: 'wicked-crew', rootPath: '/repos/wicked-crew' }],
    graphFor: async () => null,
    clisJsonFor: (seats) => JSON.stringify(seats.map((key) => ({ key }))),
    styleOf: () => 'doc',
    packetDeps: packetDeps(runs),
  }));
  const deps: ChatProposalDeps = {
    flags: () => ({ context: true, proposals: true, create: true, refine: false, theme: false, demo: false }),
    catalog: CATALOG_SEEDS,
    records: (c) => [...(w.records.get(c) ?? [])],
    append: (c, rec) => {
      const list = w.records.get(c);
      if (list === undefined) return false;
      list.push(rec);
      return true;
    },
    instanceOf: (c) => (w.records.has(c) ? 'i1' : null),
    projectOf: (c) => w.chats.get(c)?.projectId ?? null,
    chat: (c) => w.chats.get(c) ?? null,
    rosterEligible: () => [{ key: 'claude', name: 'Claude Code' }, { key: 'codex', name: 'Codex' }],
    runs: async () => runs,
    chatOfRun: () => undefined,
    isAskPath: () => false,
    docsRoot,
    projectName: async (p) => (p === 'mikes' ? 'Mikes' : null),
    attachments: () => [],
    workflowSteps: async () => 3,
    runCostUsd: async () => null,
    registry: w.registry,
    broadcast: (f) => w.frames.push(f),
    audit: () => undefined,
    now: () => 5_000,
  };
  w.svc = new ChatProposals(deps);
  return w;
}

function withChat(w: World, chatId: string): void {
  w.records.set(chatId, chatRecords(chatId));
  w.chats.set(chatId, { projectId: null, repos: [{ id: 'repo-crew', name: 'wicked-crew' }], lead: 'claude', seats: ['claude', 'codex'], analysis: false });
}

describe('Go creates one grounded document and one run, exactly once (A3, §4.3)', () => {
  it('zero creator dispatch before Go; Go records accepting, creates the derived document through the grant, and launches with the derived run id', async () => {
    const w = world();
    withChat(w, 'c1');
    expect(w.launches).toHaveLength(0);
    expect(w.creates).toHaveLength(0);
    const out = await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    expect(out.code).toBe(200);
    const runId = proposalRunId('c1:t2');
    expect(w.launches.map((l) => l.runId)).toEqual([runId]);
    expect(w.creates).toHaveLength(1);
    expect(w.creates[0]).toMatchObject({ chat_id: 'c1', proposal_id: 'c1:t2', repo_refs: ['repo-crew'], kind: 'source' });
    expect(w.grantsAtCreate[0]).toMatchObject({ projectId: 'default', repos: [{ id: 'repo-crew', name: 'wicked-crew' }] });
    const launched = w.launches[0]!;
    expect(launched.chatId).toBe('c1');
    expect(launched.proposalId).toBe('c1:t2');
    expect(launched.artifactRef).toMatch(/^_unfiled\/release-note-[0-9a-f]{8}$/);
    // An Unfiled document is grounded on the chat's repository.
    expect(launched.repos).toEqual([{ repoRef: 'repo-crew', name: 'wicked-crew', rootPath: '/repos/wicked-crew' }]);
    // The manifest lists the three runs; the struck run never reaches the draft.
    const manifest = JSON.parse(launched.packet.files.at(-1)!.bytes.toString()) as { files: Array<{ token: string }>; struck: Array<{ token: string }> };
    expect(manifest.files.map((e) => e.token).filter((t) => t.startsWith('run:')).sort()).toEqual([`run:${R1}`, `run:${R2}`, `run:${R3}`].sort());
    expect(manifest.struck.map((s) => s.token)).toEqual(['run:deadbeef']);
    const kinds = (w.records.get('c1') ?? []).map((r) => r.kind).filter((k) => k.startsWith('proposal'));
    expect(kinds).toEqual(['proposal', 'proposal_accepting', 'proposal_decided']);
  });

  it('a double click, a lost response with a retry, and two tabs give one document and one run', async () => {
    const w = world();
    withChat(w, 'c1');
    const [a, b] = await Promise.all([
      w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1'),
      w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1'),
    ]);
    const again = await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1'); // the retry after a lost response
    expect([a.code, b.code, again.code]).toEqual([200, 200, 200]);
    expect(w.launches).toHaveLength(1);
    expect(w.creates).toHaveLength(1);
  });

  it('a crash between launch and record: the run exists, the proposal is still accepting — Go again adopts it, no second run', async () => {
    const first = world();
    withChat(first, 'c1');
    // The crash: accepting recorded, the launcher ran, `decided` never written.
    const f = foldProposals(first.records.get('c1')!).get('c1:t2')!;
    const identity = first.svc.identityOf(f.proposal);
    first.records.get('c1')!.push({ at: 6, turnId: 't2', kind: 'proposal_accepting', pid: 'c1:t2', actor: 'maria', edits: null, resolution: f.proposal, identity });
    await first.registry.launchOnce({ kind: 'create', pid: 'c1:t2', chatId: 'c1', actor: ME, identity, resolution: f.proposal });
    expect(first.launches).toHaveLength(1);
    // The daemon restarts: a fresh service over the same records, bindings, documents and engine.
    const w = world({ records: first.records, bindingsDir: (first.bindings as unknown as { dir: string }).dir, engine: first.engine, docs: first.docs });
    w.chats.set('c1', first.chats.get('c1')!);
    const out = await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    expect(out.code).toBe(200);
    expect((out.body as { view: { result: { adopted: boolean } } }).view.result.adopted).toBe(true);
    expect(w.launches).toHaveLength(0);
    expect(w.creates).toHaveLength(0);
  });

  it('a crash between create and draft launch: Go again launches exactly one draft into the same document, and a late bus trigger launches nothing', async () => {
    const w = world();
    withChat(w, 'c1');
    w.failLaunch = 1;
    const out = await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    expect(out.code).toBe(502);
    expect(foldProposals(w.records.get('c1')!).get('c1:t2')?.state).toBe('accepting');
    expect(w.creates).toHaveLength(1); // the document exists, no run yet
    // Busy is only a run that exists: the interrupted card can still be answered.
    const again = await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    expect(again.code).toBe(200);
    expect(w.creates).toHaveLength(1);
    expect(w.launches).toHaveLength(1);
    // The document's late `doc.created` goes through the same launcher: it adopts.
    const acc = w.svc.acceptedOf('c1', 'c1:t2')!;
    const late = await w.registry.launchOnce({ kind: 'create', pid: 'c1:t2', chatId: 'c1', actor: ME, identity: acc.identity, resolution: acc.resolution });
    expect(late.adopted).toBe(true);
    expect(w.launches).toHaveLength(1);
  });

  it('one live job per chat until the attempt\'s outcome is recorded; a failure releases it and appends Try again into the same document', async () => {
    const w = world();
    withChat(w, 'c1');
    await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    const first = w.launches[0]!;
    // A second proposal in the chat is refused while the first attempt has no outcome (the engine run may have ended).
    w.records.get('c1')!.push({ at: 7, turnId: 't3', kind: 'user', text: 'and a deck', seats: ['claude'], owner: true });
    w.records.get('c1')!.push({ at: 8, turnId: 't3', kind: 'proposal', proposal: proposal('c1:t3', { what: { entry: 'document-static', title: 'Other', label: 'Document · Other', outcome: null } }) });
    expect((await w.svc.decide('c1', 'c1:t3', { decision: 'go' }, ME, 'i1')).body).toMatchObject({ code: 'chat_busy' });
    expect(w.launches).toHaveLength(1);
    // The landing failed: released, and the retry card names the same document.
    w.bindings.setOutcome(first.artifactRef, first.runId, { kind: 'failed', reason: 'the run was stopped' });
    const retryPid = await w.svc.appendRetry('c1', 'c1:t2', first.runId, first.artifactRef, 'the run was stopped');
    expect(retryPid).toBe(`c1:retry:${first.runId}`);
    expect(await w.svc.appendRetry('c1', 'c1:t2', first.runId, first.artifactRef, 'the run was stopped')).toBe(retryPid); // once
    const retry = foldProposals(w.records.get('c1')!).get(retryPid!)!;
    expect(retry.proposal).toMatchObject({ turnId: null, sourceRunId: first.runId, artifactRef: first.artifactRef, kind: 'create' });
    expect(retry.proposal.sources).toEqual(proposal('c1:t2').sources); // the failed attempt's effective choices
    const out = await w.svc.decide('c1', retryPid!, { decision: 'go' }, ME, 'i1');
    expect(out.code).toBe(200);
    expect(w.launches).toHaveLength(2);
    expect(w.launches[1]!.artifactRef).toBe(first.artifactRef); // one document…
    expect(w.launches[1]!.runId).toBe(proposalRunId(retryPid!)); // …two attempts
    expect(w.creates).toHaveLength(1);
    // The retry reuses the first attempt's conversation snapshot (cut at the first proposal's turn).
    expect(w.launches[1]!.packet.files.map((f) => f.name)).toContain('conversation-c1-to-t2.md');
    expect(w.bindings.get(first.artifactRef)?.attempts.map((a) => a.pid)).toEqual(['c1:t2', retryPid]);
  });

  it('one live job per document: a retry is refused while another attempt at the same document has no outcome', async () => {
    const w = world();
    withChat(w, 'c1');
    await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    const first = w.launches[0]!;
    // A stale retry card for the same document, while the first attempt is still live.
    const pid = `c1:retry:${first.runId}`;
    w.records.get('c1')!.push({ at: 9, turnId: 't2', kind: 'proposal', proposal: { ...proposal(pid), turnId: null, sourceRunId: first.runId, artifactRef: first.artifactRef } });
    const out = await w.svc.decide('c1', pid, { decision: 'go' }, ME, 'i1');
    expect(out.code).toBe(409);
    expect(['chat_busy', 'document_busy']).toContain((out.body as { code: string }).code);
    expect(w.launches).toHaveLength(1);
  });

  it('the grant is the accepted record of THIS actor for a create; nothing else grants', async () => {
    const w = world();
    withChat(w, 'c1');
    expect(w.svc.grantFor('c1', 'c1:t2', 'maria')).toBeNull(); // open: not accepted yet
    await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    expect(w.svc.grantFor('c1', 'c1:t2', 'maria')).not.toBeNull();
    expect(w.svc.grantFor('c1', 'c1:t2', 'mallory')).toBeNull();
    expect(w.svc.grantFor('c1', 'c1:nope', 'maria')).toBeNull();
  });
});

describe('Change something on a create: the project and the repositories (A3, §4.2)', () => {
  it('the project changes only in a chat filed in no project; sources from elsewhere are struck, a message whose records are elsewhere is struck whole', async () => {
    const w = world();
    withChat(w, 'c1');
    const recs = w.records.get('c1')!;
    recs.push({ at: 9, turnId: 't2', kind: 'proposal', proposal: proposal('c1:t2', { sources: [...proposal('c1:t2').sources, { token: 'message:t1', label: "claude's answer", status: 'ok', projectId: null }] }) });
    const out = await w.svc.decide('c1', 'c1:t2', { decision: 'go', edits: { project: 'mikes' } }, ME, 'i1');
    expect(out.code).toBe(200);
    const acc = w.svc.acceptedOf('c1', 'c1:t2')!;
    expect(acc.resolution.filedIn).toEqual({ projectId: 'mikes', label: 'Mikes' });
    expect(acc.identity.artifactRef).toMatch(/^mikes\//);
    const struck = acc.resolution.sources.filter((s) => s.status === 'struck').map((s) => s.token);
    expect(struck).toEqual(expect.arrayContaining([`run:${R1}`, `run:${R2}`, `run:${R3}`, 'message:t1']));
    // The repository is not a member of Mikes: cut, so the draft is grounded on nothing outside it.
    expect(acc.resolution.repos).toEqual([]);
  });

  it('a project chat cannot move its document, and a repository outside the chat\'s scope is refused', async () => {
    const w = world();
    withChat(w, 'c1');
    w.chats.set('c1', { ...w.chats.get('c1')!, projectId: 'mikes' });
    expect((await w.svc.decide('c1', 'c1:t2', { decision: 'go', edits: { project: null } }, ME, 'i1')).body).toMatchObject({ code: 'edits_invalid' });
    w.chats.set('c1', { ...w.chats.get('c1')!, projectId: null });
    expect((await w.svc.decide('c1', 'c1:t2', { decision: 'go', edits: { repos: ['wicked-core'] } }, ME, 'i1')).body).toMatchObject({ code: 'edits_invalid' });
    expect(w.launches).toHaveLength(0);
  });
});

describe('the boot reconcile, before the resume sweep (A3, §6.2)', () => {
  const init = (ref: string, doc: string) => ({ ref, mount: '_unfiled', doc, projectId: null, owner: 'maria', chatId: 'c1', chatInstance: 'i1', scopeProject: null, proposalId: 'c1:t2', cutoffTurnId: 't2', repos: [], graphDb: null });
  const versions = (head: number, byRun: Record<string, number> = {}, provenance = false) => ({ head, byRun: new Map(Object.entries(byRun)), provenance });

  it('a live run is cancelled to a confirmed terminal state, then released with "interrupted by a restart"; a landed one stays landed; an unlaunched one is left to Go again', async () => {
    const s = new DocBindingStore(fresh('bind'));
    s.begin(init('_unfiled/a', 'a'), { pid: 'c1:t2', runId: 'run-live', base: 0 });
    s.markLaunched('_unfiled/a', 'run-live');
    s.begin(init('_unfiled/b', 'b'), { pid: 'c1:t3', runId: 'run-done', base: 0 });
    s.markEmitted('_unfiled/b', 'run-done');
    s.begin(init('_unfiled/c', 'c'), { pid: 'c1:t4', runId: 'run-completed-not-announced', base: 0 });
    s.begin(init('_unfiled/d', 'd'), { pid: 'c1:t5', runId: 'run-never', base: 0 });
    const status = new Map<string, string>([['run-live', 'executing'], ['run-done', 'completed'], ['run-completed-not-announced', 'completed']]);
    const cancelled: string[] = [];
    const outcomes: Array<[string, string]> = [];
    const settled: string[] = [];
    const recorded: string[] = [];
    await reconcileBoundAttempts({
      bindings: s,
      sessions: async () => [...status].map(([id, st]) => run(id, { status: st })),
      cancelRun: async (id) => {
        cancelled.push(id);
        status.set(id, 'cancelled');
      },
      docVersions: (_p, doc) => (doc === 'b' ? versions(1) : versions(0)),
      chatIdOf: (c) => c,
      settleAccepting: async (_c, pid) => {
        settled.push(pid);
        return true;
      },
      ensureLaunchRecord: (_b, a) => recorded.push(a.runId),
      hasLandingFailed: () => true,
      linkDocument: () => undefined,
      onOutcome: (ref, runId, o) => outcomes.push([runId, o.kind === 'failed' ? o.reason : `landed v${o.version}`]),
      log: () => undefined,
      sleep: async () => undefined,
    });
    expect(cancelled).toEqual(['run-live']); // only the live one; never a redispatch
    expect(outcomes).toEqual(expect.arrayContaining([
      ['run-live', 'interrupted by a restart'],
      ['run-done', 'landed v1'],
      ['run-completed-not-announced', 'interrupted by a restart'],
    ]));
    expect(outcomes.some(([r]) => r === 'run-never')).toBe(false);
    expect(settled).toEqual(expect.arrayContaining(['c1:t2', 'c1:t3', 'c1:t4']));
    // A crash after the engine accepted a run but before crew recorded it: its launch facts are recorded from the binding.
    expect(recorded.sort()).toEqual(['run-completed-not-announced', 'run-done', 'run-live']);
    expect(s.busy('_unfiled/a')).toBeNull();
    expect(s.busy('_unfiled/d')?.runId).toBe('run-never');
  });

  it('a run that will not stop keeps its document busy (released only after a confirmed terminal state)', async () => {
    const s = new DocBindingStore(fresh('bind'));
    s.begin(init('_unfiled/a', 'a'), { pid: 'c1:t2', runId: 'run-stuck', base: 0 });
    const outcomes: string[] = [];
    await reconcileBoundAttempts({
      bindings: s,
      sessions: async () => [run('run-stuck', { status: 'executing' })],
      cancelRun: async () => 'cancelling',
      docVersions: () => versions(0),
      chatIdOf: (c) => c,
      settleAccepting: async () => false,
      ensureLaunchRecord: () => undefined,
      hasLandingFailed: () => true,
      linkDocument: () => undefined,
      onOutcome: (_r, id) => outcomes.push(id),
      log: () => undefined,
      waitMs: 0,
      sleep: async () => undefined,
    });
    expect(outcomes).toEqual([]);
    expect(s.busy('_unfiled/a')?.runId).toBe('run-stuck');
  });

  it('the resume sweep skips proposal-bound runs', async () => {
    const resumed: string[] = [];
    const adapter = {
      sessionsDetail: async () => [run('run-bound', { status: 'executing' }), run('run-plain', { status: 'executing' })],
      runEvents: async () => [{ seq: 1, type: 'runOrphaned', ord: 1 }],
      resumeRun: async (id: string) => {
        resumed.push(id);
        return 'executing';
      },
    };
    const audit = { record: () => 1 };
    await resumeOrphanedRuns(adapter as never, audit as never, ME, () => undefined, (id) => id === 'run-bound');
    expect(resumed).toEqual(['run-plain']);
  });
});

describe('the run DTO and run.launched carry the proposal (A3)', () => {
  it('chatId, proposalId and artifactRef ride run.launched; landing_failed is read back after a restart', () => {
    const entries: AuditEntry[] = [];
    const audit = { record: (action: string, actor: Actor, e: { runId: string; detail: Record<string, unknown> }) => { entries.unshift({ ts: 1000 + entries.length, action, actor, runId: e.runId, detail: e.detail } as unknown as AuditEntry); return 1000; } };
    const idx = new RunTimingIndex();
    recordRunLaunched(audit as never, idx, ME, 'run-a', { chatId: 'c1', proposalId: 'c1:t2', artifactRef: '_unfiled/rn-1' });
    expect(idx.chatIdFor('run-a')).toBe('c1');
    expect(idx.proposalOf('run-a')).toEqual({ proposalId: 'c1:t2', artifactRef: '_unfiled/rn-1' });
    const after = new RunTimingIndex();
    after.hydrateFromLaunchEntries(entries);
    after.hydrateLandingFailed([{ ts: 2000, action: 'run.landing_failed', runId: 'run-a', detail: { reason: 'interrupted by a restart' } } as unknown as AuditEntry]);
    expect(after.proposalOf('run-a')).toEqual({ proposalId: 'c1:t2', artifactRef: '_unfiled/rn-1' });
    expect(after.landingFailedOf('run-a')).toEqual({ reason: 'interrupted by a restart', at: 2000 });
    expect(after.proposalOf('run-b')).toBeUndefined();
  });
});


describe('xreview r1 folds (A3)', () => {
  const runs = [run(R1, { status: 'cancelled' }), run(R2, { status: 'cancelled' }), run(R3)];

  it('a source joins the packet only whole: a conversation over its cap is struck WITH the briefs it would have brought', async () => {
    const records = chatRecords('c1');
    (records[2] as { text: string }).text = 'y'.repeat(PACKET_FILE_MAX_BYTES + 10); // the answer alone is over the cap
    const res = proposal('c1:t2', { sources: [{ token: 'chat', label: 'this conversation', status: 'ok' }] });
    const p = await buildSourcePacket({ runId: 'run-s', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records }, packetDeps(runs));
    expect(p.struck.map((s) => s.token)).toEqual(['chat']);
    expect(p.files.map((f) => f.name)).toEqual(['brief-run-s.md', 'MANIFEST-run-s.json']); // no orphan run brief
  });

  it("an answer's briefs are the ones it was GIVEN (recovered by hash); when they are gone, crew's current brief is used and the file says so", async () => {
    const records = chatRecords('c1');
    const given = Buffer.from('# Run 29bbbfb1\n\nCoverage then: 61% (3585 of 5786)\n');
    const ctx = records[1] as { runs: Array<{ id: string; brief: string; sha256: string }> };
    ctx.runs = [{ id: R1, brief: `context/run-${R1}-${sha(given).slice(0, 8)}.md`, sha256: sha(given) }, { id: R2, brief: 'context/run-gone.md', sha256: 'f'.repeat(64) }];
    const deps: PacketDeps = { ...packetDeps(runs), contextBrief: (_c, rel, s) => (rel.includes(R1) && s === sha(given) ? given : null) };
    const res = proposal('c1:t2', { sources: [{ token: 'message:t1', label: "claude's answer", status: 'ok', projectId: null }] });
    const p = await buildSourcePacket({ runId: 'run-g', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records }, deps);
    expect(p.files.find((f) => f.name === `run-${R1}-${sha(given).slice(0, 8)}.md`)?.bytes.equals(given)).toBe(true);
    const msg = p.files.find((f) => f.name === 'message-c1-t1.md')!.bytes.toString();
    expect(msg).toContain(`run-${R1}-${sha(given).slice(0, 8)}.md`);
    expect(msg).toMatch(/1 of them this answer was given are no longer on this daemon: these are crew's current briefs/);
  });

  it('an everything chat moved into a project: the launcher re-checks the packet against it (the chat’s own project was none)', async () => {
    const w = world();
    withChat(w, 'c1');
    const out = await w.svc.decide('c1', 'c1:t2', { decision: 'go', edits: { project: 'mikes' } }, ME, 'i1');
    expect(out.code).toBe(200);
    const launched = w.launches[0]!;
    expect(w.bindings.get(launched.artifactRef)).toMatchObject({ scopeProject: null, projectId: 'mikes' });
    const conv = launched.packet.files.find((f) => f.name.startsWith('conversation-'))!.bytes.toString();
    expect(conv).toContain('(left out: it used records outside the project');
    expect(conv).not.toContain('They took coverage');
  });

  it('a reused chat id is another chat: a retry is never appended to it, and the launcher reads the archived chat', async () => {
    const w = world();
    withChat(w, 'c1');
    await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    const first = w.launches[0]!;
    // The id is reused: the archived chat moves to c1--1; c1 is now someone else's (instance i2).
    w.records.set('c1--1', w.records.get('c1')!);
    w.records.set('c1', [{ at: 9, turnId: 'x1', kind: 'user', text: 'someone else', seats: ['claude'], owner: true }]);
    (w.svc as unknown as { deps: ChatProposalDeps }).deps.instanceOf = (c) => (c === 'c1' ? 'i2' : c === 'c1--1' ? 'i1' : null);
    await expect(w.svc.appendRetry('c1', 'c1:t2', first.runId, first.artifactRef, 'the run was stopped', 'i1')).rejects.toThrow(/no longer the chat/);
    expect(w.records.get('c1')!.some((r) => r.kind === 'proposal')).toBe(false);
    expect(await w.svc.appendRetry('c1--1', 'c1:t2', first.runId, first.artifactRef, 'the run was stopped', 'i1')).toBe(`c1:retry:${first.runId}`);
  });

  it('attempt rows carry the project partition: deleting a same-named document elsewhere keeps them', () => {
    expect(boundAttemptKey('note', 'mikes', 'r1')).toBe('note:attempt:p-mikes:r1');
    expect(boundAttemptKey('note', undefined, 'r1')).toBe('note:attempt:_unfiled:r1');
    expect(isAnotherProjectsDraftKey('note:attempt:p-mikes:r1', 'note', 'other')).toBe(true);
    expect(isAnotherProjectsDraftKey('note:attempt:p-mikes:r1', 'note', 'mikes')).toBe(false);
    expect(isAnotherProjectsDraftKey('note:attempt:_unfiled:r1', 'note', undefined)).toBe(false);
  });

  it('the boot reconcile: a landing is proven by the run on the version (I1) when the manifest records runs; a failure a crash left unpublished is published again', async () => {
    const s = new DocBindingStore(fresh('bind'));
    const b = (ref: string, doc: string) => ({ ref, mount: '_unfiled', doc, projectId: null, owner: 'maria', chatId: 'c1', chatInstance: 'i1', scopeProject: null, proposalId: 'c1:t2', cutoffTurnId: 't2', repos: [], graphDb: null });
    s.begin(b('_unfiled/a', 'a'), { pid: 'c1:t2', runId: 'run-a', base: 0 });
    s.markEmitted('_unfiled/a', 'run-a');
    s.begin(b('_unfiled/b', 'b'), { pid: 'c1:t3', runId: 'run-b', base: 0 });
    s.markEmitted('_unfiled/b', 'run-b');
    s.begin(b('_unfiled/c', 'c'), { pid: 'c1:t4', runId: 'run-c', base: 0 });
    s.setOutcome('_unfiled/c', 'run-c', { kind: 'failed', reason: 'the run was stopped' }); // published never ran
    s.begin(b('_unfiled/d', 'd'), { pid: 'c1:t5', runId: 'run-d', base: 0 });
    s.setOutcome('_unfiled/d', 'run-d', { kind: 'failed', reason: 'the run failed' });
    s.markPublished('_unfiled/d', 'run-d');
    s.begin(b('_unfiled/e', 'e'), { pid: 'c1:t6', runId: 'run-e', base: 0 });
    s.markLaunching('_unfiled/e', 'run-e'); // a crash before the engine ever had it
    const outcomes: Array<[string, string]> = [];
    const linked: string[] = [];
    await reconcileBoundAttempts({
      bindings: s,
      sessions: async () => [run('run-a'), run('run-b')],
      cancelRun: async () => 'cancelled',
      // a: the head moved (a hand edit), but the manifest names no version by run-a; b: v1 is run-b's.
      docVersions: (_p, doc) => (doc === 'a' ? { head: 1, byRun: new Map([['someone-else', 1]]), provenance: true } : { head: 1, byRun: new Map([['run-b', 1]]), provenance: true }),
      chatIdOf: (c) => c,
      settleAccepting: async () => false,
      ensureLaunchRecord: () => undefined,
      // run-d's binding says published, but its audit append was lost in a crash: published again.
      hasLandingFailed: (id) => id !== 'run-d',
      linkDocument: (id, doc) => linked.push(`${id}>${doc}`),
      onOutcome: (_ref, runId, o) => outcomes.push([runId, o.kind === 'failed' ? o.reason : `landed v${o.version}`]),
      log: () => undefined,
      sleep: async () => undefined,
    });
    expect(outcomes).toEqual(expect.arrayContaining([['run-c', 'the run was stopped'], ['run-d', 'the run failed'], ['run-a', 'interrupted by a restart'], ['run-b', 'landed v1']]));
    expect(outcomes).toHaveLength(4);
    // Every attempt's document link, every boot; a launch that never reached the engine is no longer busy.
    expect(linked.sort()).toEqual(['run-a>a', 'run-b>b', 'run-c>c', 'run-d>d', 'run-e>e']);
    expect(s.get('_unfiled/e')?.attempts[0]?.launchingAt).toBeUndefined();
  });
});

describe('xreview r2 folds (A3)', () => {
  const runs = [run(R1, { status: 'cancelled' }), run(R2, { status: 'cancelled' }), run(R3)];

  it('the manifest is budgeted with the files it lists: many briefs strike a source, never make the packet unlaunchable', async () => {
    const many = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    const records: ChatTranscriptRecord[] = [];
    for (let i = 0; i < 60; i += 1) {
      records.push({ at: i, turnId: `t${i}`, kind: 'user', text: `q${i}`, seats: ['claude'], owner: true });
      records.push({ at: i, turnId: `t${i}`, kind: 'context', runs: many.slice((i * 8) % 392, ((i * 8) % 392) + 8).map((id) => ({ id, status: 'completed', brief: `context/run-${id}.md`, sha256: 'x' })), refused: [], page: false, named: { runs: [], docs: [] } });
      records.push({ at: i, turnId: `t${i}`, kind: 'seat', cliKey: 'claude', text: 'a', ok: true, usage: null });
    }
    const res = proposal('c1:t59', { sources: [{ token: 'chat', label: 'this conversation', status: 'ok' }] });
    const p = await buildSourcePacket({ runId: 'run-m', chatId: 'c1', pid: 'c1:t59', cutoffTurnId: 't59', resolution: res, records }, packetDeps(many.map((id) => run(id))));
    expect(p.files.reduce((n, f) => n + f.bytes.length, 0)).toBeLessThanOrEqual(PACKET_MAX_BYTES);
    expect(p.files.at(-1)!.name).toBe('MANIFEST-run-m.json');
  });

  it('packet file names stay inside their grammar whatever the ids: a long mount, a long attachment name', async () => {
    const mount = `m${'x'.repeat(127)}`;
    const docs = fresh('docs');
    mkdirSync(join(docs, 'd'.repeat(64)), { recursive: true });
    writeFileSync(join(docs, 'd'.repeat(64), 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0 }] }));
    writeFileSync(join(docs, 'd'.repeat(64), '_v0.html'), '<p>placeholder</p>');
    const att = join(fresh('att'), 'a');
    writeFileSync(att, 'words');
    const res = proposal('c1:t2', { sources: [
      { token: `doc:${mount}/${'d'.repeat(64)}`, label: 'doc', status: 'ok', projectId: mount },
      { token: `attachment:${'a'.repeat(120)}`, label: 'a', status: 'ok' },
    ] });
    const p = await buildSourcePacket({ runId: 'run-n', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records: [] }, packetDeps([], (pr) => (pr === mount ? docs : null), { ['a'.repeat(120)]: { name: 'n'.repeat(150), path: att } }));
    expect(p.struck).toEqual([]);
    for (const f of p.files) expect(f.name.length).toBeLessThanOrEqual(208);
  });

  it('attachments and context briefs are read where the chat is kept NOW (an archived chat), names keep the chat\'s own id', async () => {
    const att = join(fresh('att'), 'a1');
    writeFileSync(att, 'archived words');
    const seen: string[] = [];
    const deps: PacketDeps = { ...packetDeps(runs), attachment: (c, id) => { seen.push(c); return c === 'c1--1' && id === 'a1' ? { name: 'n.txt', path: att } : null; } };
    const res = proposal('c1:t2', { sources: [{ token: 'attachment:a1', label: 'n.txt', status: 'ok' }] });
    const p = await buildSourcePacket({ runId: 'run-x', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records: [], storageChatId: 'c1--1' }, deps);
    expect(seen).toEqual(['c1--1']);
    expect(p.files.map((f) => f.name)).toContain('attachment-a1-n.txt');
  });

  it('Change something: a source the proposal held that is outside the target project is struck; one the person ADDS outside it is refused', async () => {
    const w = world();
    withChat(w, 'c1');
    // Retained (already on the card) + project change: struck, Go proceeds.
    const keep = await w.svc.decide('c1', 'c1:t2', { decision: 'go', edits: { project: 'mikes', sources: ['chat', `run:${R1}`] } }, ME, 'i1');
    expect(keep.code).toBe(200);
    expect(w.svc.acceptedOf('c1', 'c1:t2')!.resolution.sources.find((s) => s.token === `run:${R1}`)).toMatchObject({ status: 'struck', reason: 'not in Mikes' });
    // Added (not on the card) outside the target: refused, nothing recorded.
    const w2 = world();
    withChat(w2, 'c2');
    const r2 = proposal('c2:t2', { sources: [{ token: 'chat', label: 'this conversation', status: 'ok' }] });
    w2.records.get('c2')!.push({ at: 9, turnId: 't2', kind: 'proposal', proposal: r2 });
    const add = await w2.svc.decide('c2', 'c2:t2', { decision: 'go', edits: { project: 'mikes', sources: ['chat', 'message:t1'] } }, ME, 'i1');
    expect(add.code).toBe(400);
    expect(w2.launches).toHaveLength(0);
  });

  it('a work launch filed under the chat sees its live artifact job (one live job per chat)', async () => {
    const w = world();
    withChat(w, 'c1');
    expect(await w.svc.liveJobOf('c1')).toBeNull();
    await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    expect(await w.svc.liveJobOf('c1')).toBe('Document · Release note');
    const first = w.launches[0]!;
    w.bindings.setOutcome(first.artifactRef, first.runId, { kind: 'landed', version: 1 });
    expect(await w.svc.liveJobOf('c1')).toBeNull();
  });
});

describe('xreview r3 folds (A3)', () => {
  const runs = [run(R1, { status: 'cancelled' }), run(R2, { status: 'cancelled' }), run(R3)];

  it('near the budget boundary a source is struck whole, never an over-budget packet', async () => {
    for (const size of [1600, 1650, 1705, 1715, 1725, 1800]) {
      const ids = Array.from({ length: 480 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
      const records: ChatTranscriptRecord[] = [];
      for (let i = 0; i < 60; i += 1) {
        records.push({ at: i, turnId: `t${i}`, kind: 'user', text: `q${i}`, seats: ['claude'], owner: true });
        records.push({ at: i, turnId: `t${i}`, kind: 'context', runs: ids.slice(i * 8, i * 8 + 8).map((id) => ({ id, status: 'completed', brief: `context/run-${id}.md`, sha256: 'x' })), refused: [], page: false, named: { runs: [], docs: [] } });
        records.push({ at: i, turnId: `t${i}`, kind: 'seat', cliKey: 'claude', text: 'a', ok: true, usage: null });
      }
      const deps: PacketDeps = { ...packetDeps(ids.map((id) => run(id))), brief: async (v) => { const md = `# ${v.session.id}\n${'y'.repeat(size)}`; return { runId: v.session.id, status: 'completed', title: 't', markdown: md, sha256: sha(md) }; } };
      const res = proposal('c1:t59', { sources: [{ token: 'chat', label: 'this conversation', status: 'ok' }, { token: `run:${ids[0]}`, label: 'r', status: 'ok' }] });
      const p = await buildSourcePacket({ runId: 'run-b', chatId: 'c1', pid: 'c1:t59', cutoffTurnId: 't59', resolution: res, records }, deps);
      expect(p.files.reduce((n, f) => n + f.bytes.length, 0), String(size)).toBeLessThanOrEqual(PACKET_MAX_BYTES);
    }
  });

  it("an answer's open document rides with it (the version it was looking at), or the file says why not", async () => {
    const docs = fresh('docs');
    mkdirSync(join(docs, 'deck'), { recursive: true });
    writeFileSync(join(docs, 'deck', 'versions.json'), JSON.stringify({ head: 3, versions: [{ version: 2 }, { version: 3 }] }));
    writeFileSync(join(docs, 'deck', '_v2.html'), '<p>slide 4: 61% of 5786</p>');
    writeFileSync(join(docs, 'deck', '_v3.html'), '<p>later</p>');
    const records = chatRecords('c1');
    (records[1] as Record<string, unknown>)['artifact'] = { ref: 'mikes/deck', title: 'Deck', kind: 'slides', viewed: 2, head: 3, projectId: 'mikes', copies: [], anchors: [] };
    const res = proposal('c1:t2', { sources: [{ token: 'message:t1', label: "claude's answer", status: 'ok', projectId: null }] });
    const p = await buildSourcePacket({ runId: 'run-o', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records }, packetDeps(runs, (pr) => (pr === 'mikes' ? docs : null)));
    const doc = p.files.find((f) => f.name.startsWith('doc-') && f.name.endsWith('-deck-v2.html'));
    expect(doc?.bytes.toString()).toContain('61% of 5786');
    expect(p.tokens['message:t1']).toContain(doc!.name);
  });

  it('a fence that cannot remove an earlier attempt folder refuses the new attempt (never a silent success)', () => {
    const runDir = fresh('fence');
    mkdirSync(join(runDir, 'attempt-old', 'sources'), { recursive: true });
    writeFileSync(join(runDir, 'attempt-old', 'sources', 'f'), 'x');
    execFileSync('chmod', ['0500', join(runDir, 'attempt-old')]);
    try {
      expect(removeAttemptDirs(runDir, ['old'])).toEqual(['attempt-old']);
    } finally {
      execFileSync('chmod', ['0700', join(runDir, 'attempt-old')]);
    }
    expect(removeAttemptDirs(runDir, ['old', 'never-made'])).toEqual([]);
  });

  it('a document moved out of the chat’s scope gets no project graph (it would reach the repositories the move cut)', async () => {
    const w = world();
    withChat(w, 'c1');
    ((w.registry as unknown as { dispatchers: Map<string, { deps: { graphFor: unknown } }> }).dispatchers.get('create')!.deps).graphFor = async () => '/graphs/mikes.db';
    await w.svc.decide('c1', 'c1:t2', { decision: 'go', edits: { project: 'mikes' } }, ME, 'i1');
    expect(w.launches[0]!.graphDb).toBeNull();
    const w2 = world();
    withChat(w2, 'c2');
    ((w2.registry as unknown as { dispatchers: Map<string, { deps: { graphFor: unknown } }> }).dispatchers.get('create')!.deps).graphFor = async () => '/graphs/chat.db';
    await w2.svc.decide('c2', 'c2:t2', { decision: 'go' }, ME, 'i1');
    expect(w2.launches[0]!.graphDb).toBe('/graphs/chat.db');
  });

  it('Change something refuses what could never reach the draft: an outside message on a retry filed elsewhere, an attachment over the cap, an unregistered repository', async () => {
    // A retry already filed in Mikes (the chat is in no project): an added message whose records are elsewhere is refused.
    const w = world();
    withChat(w, 'c1');
    const pid = 'c1:retry:old';
    w.records.get('c1')!.push({ at: 9, turnId: 't2', kind: 'proposal', proposal: { ...proposal(pid, { filedIn: { projectId: 'mikes', label: 'Mikes' }, sources: [{ token: 'chat', label: 'this conversation', status: 'ok' }] }), turnId: null, sourceRunId: 'old', artifactRef: 'mikes/release-note-00000000' } });
    expect((await w.svc.decide('c1', pid, { decision: 'go', edits: { sources: ['chat', 'message:t1'] } }, ME, 'i1')).code).toBe(400);
    // An attachment over the packet's per-file cap is struck at resolution (so an added one is refused).
    const w2 = world();
    withChat(w2, 'c2');
    (w2.svc as unknown as { deps: ChatProposalDeps }).deps.attachments = () => [{ id: 'a1', name: 'huge.pdf', bytes: 600 * 1024 }];
    const r = await w2.svc.decide('c2', 'c2:t2', { decision: 'go', edits: { sources: ['chat', 'attachment:a1'] } }, ME, 'i1');
    expect(r.code).toBe(400);
    expect(JSON.stringify(r.body)).toContain('over 512 KB');
    // A repository the card names that is no longer registered refuses Go, before anything is recorded.
    const w3 = world();
    withChat(w3, 'c3');
    (w3.svc as unknown as { deps: ChatProposalDeps }).deps.repoIds = async () => new Set(['something-else']);
    const g = await w3.svc.decide('c3', 'c3:t2', { decision: 'go' }, ME, 'i1');
    expect(g.code).toBe(409);
    expect(g.body).toMatchObject({ code: 'source_gone' });
    expect(w3.records.get('c3')!.some((x) => x.kind === 'proposal_accepting')).toBe(false);
  });
});

describe('xreview r4 folds (A3)', () => {
  const runs = [run(R1, { status: 'cancelled' }), run(R2, { status: 'cancelled' }), run(R3)];

  it('Try again into a document that was deleted meanwhile refuses (it would never land), keeping the card answerable', async () => {
    const w = world();
    withChat(w, 'c1');
    await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    const first = w.launches[0]!;
    w.bindings.setOutcome(first.artifactRef, first.runId, { kind: 'failed', reason: 'the run was stopped' });
    const retryPid = (await w.svc.appendRetry('c1', 'c1:t2', first.runId, first.artifactRef, 'the run was stopped'))!;
    const docDir = join(w.docs, '_unfiled', first.artifactRef.split('/')[1]!);
    writeFileSync(join(docDir, 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0 }], retired_at: '2026-11-02T12:00:00Z' }));
    const out = await w.svc.decide('c1', retryPid, { decision: 'go' }, ME, 'i1');
    expect(out.code).toBe(502);
    expect(JSON.stringify(out.body)).toContain('was deleted');
    expect(w.launches).toHaveLength(1);
  });

  it("a message source brings the files attached to its turn (the answer's evidence)", async () => {
    const att = join(fresh('att'), 'rep');
    writeFileSync(att, 'measured: 3585 of 5786');
    const records = chatRecords('c1');
    (records[0] as Record<string, unknown>)['attachments'] = [{ id: 'rep1', chatId: 'c1', name: 'report.txt', mediaType: 'text/plain', kind: 'text', bytes: 22, sha256: 'x', createdAt: '' }];
    const res = proposal('c1:t2', { sources: [{ token: 'message:t1', label: "claude's answer", status: 'ok', projectId: null }] });
    const p = await buildSourcePacket({ runId: 'run-at', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records }, packetDeps(runs, () => null, { rep1: { name: 'report.txt', path: att } }));
    expect(p.tokens['message:t1']).toContain('attachment-rep1-report.txt');
    expect(p.files.find((f) => f.name === 'attachment-rep1-report.txt')?.bytes.toString()).toBe('measured: 3585 of 5786');
  });

  it('an archived chat’s retry is filed under the chat as it is kept now, never the chat that reused the id', async () => {
    const w = world();
    withChat(w, 'c1');
    await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    const first = w.launches[0]!;
    w.bindings.setOutcome(first.artifactRef, first.runId, { kind: 'failed', reason: 'the run was stopped' });
    w.records.set('c1--1', w.records.get('c1')!);
    w.records.set('c1', [{ at: 9, turnId: 'x1', kind: 'user', text: 'someone else', seats: ['claude'], owner: true }]);
    w.chats.set('c1--1', w.chats.get('c1')!);
    (w.svc as unknown as { deps: ChatProposalDeps }).deps.instanceOf = (c) => (c === 'c1' ? 'i2' : c === 'c1--1' ? 'i1' : null);
    // The history moved instance i1 to its archive id.
    ((w.registry as unknown as { dispatchers: Map<string, { deps: { chatIdOf: unknown } }> }).dispatchers.get('create')!.deps).chatIdOf = (c: string, inst: string | null) => (c === 'c1' && inst === 'i1' ? 'c1--1' : c);
    const retryPid = (await w.svc.appendRetry('c1--1', 'c1:t2', first.runId, first.artifactRef, 'the run was stopped', 'i1'))!;
    expect((await w.svc.decide('c1--1', retryPid, { decision: 'go' }, ME, 'i1')).code).toBe(200);
    expect(w.launches[1]!.chatId).toBe('c1--1');
  });

  it('a person who cleared the repositories gets no graph either; attachments over the packet together are refused', async () => {
    const w = world();
    withChat(w, 'c1');
    ((w.registry as unknown as { dispatchers: Map<string, { deps: { graphFor: unknown } }> }).dispatchers.get('create')!.deps).graphFor = async () => '/graphs/chat.db';
    await w.svc.decide('c1', 'c1:t2', { decision: 'go', edits: { repos: [] } }, ME, 'i1');
    expect(w.launches[0]!.graphDb).toBeNull();
    expect(w.launches[0]!.repos).toEqual([]);
    const w2 = world();
    withChat(w2, 'c2');
    (w2.svc as unknown as { deps: ChatProposalDeps }).deps.attachments = () => [{ id: 'a1', name: 'a.txt', bytes: 500 * 1024 }, { id: 'a2', name: 'b.txt', bytes: 500 * 1024 }];
    const r = await w2.svc.decide('c2', 'c2:t2', { decision: 'go', edits: { sources: ['chat', 'attachment:a1', 'attachment:a2'] } }, ME, 'i1');
    expect(r.code).toBe(400);
    expect(JSON.stringify(r.body)).toContain('768 KB');
  });

  it('packet cleanup removes records/ even when sources/ is already gone', () => {
    const runDir = fresh('clean');
    mkdirSync(join(runDir, 'attempt-x', 'records'), { recursive: true });
    writeFileSync(join(runDir, 'attempt-x', 'records', 'run-a-00000000.md'), 'x');
    removePacketCopy(runDir, 'attempt-x');
    expect(existsSync(join(runDir, 'attempt-x', 'records'))).toBe(false);
  });
});

describe('xreview r5 folds (A3)', () => {
  const runs = [run(R1, { status: 'cancelled' }), run(R2, { status: 'cancelled' }), run(R3)];

  it('the conversation brings the files of a turn whose answer failed, once each, named in the snapshot', async () => {
    const att = join(fresh('att5'), 'rep');
    writeFileSync(att, 'measured: 3476 of 4333');
    const records = chatRecords('c1');
    // Turn t1's answer failed: no ok seat record. Its attachment is the person's own evidence all the same.
    (records[0] as Record<string, unknown>)['attachments'] = [{ id: 'rep1', chatId: 'c1', name: 'report.txt', mediaType: 'text/plain', kind: 'text', bytes: 22, sha256: 'x', createdAt: '' }];
    (records[2] as Record<string, unknown>)['ok'] = false;
    const res = proposal('c1:t2', { sources: [{ token: 'chat', label: 'this conversation', status: 'ok', projectId: null }] });
    const p = await buildSourcePacket({ runId: 'run-c5', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records }, packetDeps(runs, () => null, { rep1: { name: 'report.txt', path: att } }));
    expect(p.struck).toEqual([]);
    expect(p.tokens['chat']).toContain('attachment-rep1-report.txt');
    expect(p.tokens['chat']!.filter((n) => n === 'attachment-rep1-report.txt')).toHaveLength(1);
    const convo = p.files.find((f) => f.name.startsWith('conversation-'))!.bytes.toString();
    expect(convo).toContain('Files attached to this turn: `attachment-rep1-report.txt`');
  });

  it('a file of the conversation that cannot join is named in the snapshot, not dropped silently', async () => {
    const records = chatRecords('c1');
    (records[0] as Record<string, unknown>)['attachments'] = [{ id: 'gone1', chatId: 'c1', name: 'gone.txt', mediaType: 'text/plain', kind: 'text', bytes: 5, sha256: 'x', createdAt: '' }];
    const res = proposal('c1:t2', { sources: [{ token: 'chat', label: 'this conversation', status: 'ok', projectId: null }] });
    const p = await buildSourcePacket({ runId: 'run-c6', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: res, records }, packetDeps(runs));
    const convo = p.files.find((f) => f.name.startsWith('conversation-'))!.bytes.toString();
    expect(convo).toContain('the file gone.txt attached to that turn is not in the packet: no longer attached');
  });
  it('a document someone else created meanwhile and retired is refused, not adopted and drafted', async () => {
    const w = world();
    withChat(w, 'c1');
    const deps = (w.registry as unknown as { dispatchers: Map<string, { deps: { createDoc: unknown } }> }).dispatchers.get('create')!.deps;
    deps.createDoc = async (projectId: string, body: Record<string, unknown>) => {
      const dir = join(w.docs, projectId === 'default' ? '_unfiled' : projectId, String(body['name']));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'versions.json'), JSON.stringify({ head: 0, kind: 'doc', versions: [{ version: 0 }], retired_at: '2026-11-02T12:00:00Z' }));
      return { status: 409, body: { error: 'exists' } };
    };
    const out = await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    expect(out.code).toBe(502);
    expect(JSON.stringify(out.body)).toContain('was deleted');
    expect(w.launches).toHaveLength(0);
  });

  it('a document retired while its packet is built is refused before the draft launches', async () => {
    const w = world();
    withChat(w, 'c1');
    const launcher = (w.registry as unknown as { dispatchers: Map<string, { deps: { packetDeps: PacketDeps } }> }).dispatchers.get('create')!.deps;
    const before = launcher.packetDeps.runs;
    launcher.packetDeps = {
      ...launcher.packetDeps,
      runs: async () => {
        // The person retires the new document in another tab while crew reads the run briefs.
        for (const name of readdirSync(join(w.docs, '_unfiled'))) {
          writeFileSync(join(w.docs, '_unfiled', name, 'versions.json'), JSON.stringify({ head: 0, kind: 'doc', versions: [{ version: 0 }], retired_at: '2026-11-02T12:00:00Z' }));
        }
        return before();
      },
    };
    const out = await w.svc.decide('c1', 'c1:t2', { decision: 'go' }, ME, 'i1');
    expect(out.code).toBe(502);
    expect(JSON.stringify(out.body)).toContain('was deleted');
    expect(w.launches).toHaveLength(0);
  });

  it('boot files a recovered run under the chat as kept now, and under none when that chat is gone (never a reuser)', () => {
    const history = { idOfInstance: (id: string, inst: string | null) => (inst === 'i1' ? `${id}--1` : null) };
    expect(recoveredChatId(history, { chatId: 'c1', chatInstance: 'i1' })).toBe('c1--1');
    expect(recoveredChatId(history, { chatId: 'c1', chatInstance: 'i9' })).toBeNull();
    expect(recoveredChatId(history, { chatId: 'c1', chatInstance: null })).toBe('c1');
  });
});
