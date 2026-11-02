// DES-CHAT-ARTIFACTS-001 §4.3, §5.2, §5.3, §6.2 (slice A3): grounded create, filed under the chat, exactly once.
// The durable binding, the source packet (immutable names, containment, hashes), the proxy's `chat_id` grant, the real
// `create` launcher on A2's launch-once registry (double click, lost response, two tabs, a crash between launch and
// record, a crash between create and draft launch, a late bus trigger), retry proposals, one live job per chat and per
// document, the project re-check of a Change something, and the boot reconcile before the resume sweep.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Actor, ArtifactProposal, AuditEntry, ChatTranscriptRecord, CoreEvent, SessionView } from '../src/core/types.js';
import { CATALOG_SEEDS } from '../src/workflow-catalog/catalog-data.js';
import { ChatProposals, foldProposals, LaunchOnceRegistry, proposalRunId, type ChatProposalDeps, type ProposalChat } from '../src/api/chat-proposals.js';
import { DocBindingError, DocBindingStore } from '../src/interactive/doc-binding.js';
import { buildSourcePacket, packetClause, PACKET_MAX_BYTES, type PacketDeps } from '../src/interactive/source-packet.js';
import { packetChanged, writePacketCopy, type BoundDraft } from '../src/interactive/draft-events.js';
import { CreateLauncher, reconcileBoundAttempts } from '../src/interactive/proposal-create.js';
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
  const init = { ref: '_unfiled/release-note-abc12345', mount: '_unfiled', doc: 'release-note-abc12345', projectId: null, owner: 'maria', chatId: 'c1', proposalId: 'c1:t2', cutoffTurnId: 't2', repos: [{ id: 'repo-crew', name: 'wicked-crew', rootPath: '/r' }], graphDb: null };

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
    const clause = packetClause('/inbox/sources', p, 'in your reply');
    expect(clause).not.toContain('\n');
    for (const f of p.files) expect(clause).toContain(`${f.name}=${f.sha256}`);
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
    // Over the packet cap: struck with the reason, never truncated silently.
    const big = join(fresh('att'), 'big');
    writeFileSync(big, 'x'.repeat(400 * 1024));
    const many = proposal('c1:t2', { sources: ['b1', 'b2', 'b3'].map((id) => ({ token: `attachment:${id}`, label: id, status: 'ok' as const })) });
    const q = await buildSourcePacket({ runId: 'run-d', chatId: 'c1', pid: 'c1:t2', cutoffTurnId: 't2', resolution: many, records: [] }, packetDeps([], () => null, { b1: { name: 'b', path: big }, b2: { name: 'b', path: big }, b3: { name: 'b', path: big } }));
    expect(q.files.reduce((n, f) => n + f.bytes.length, 0)).toBeLessThanOrEqual(PACKET_MAX_BYTES + 64 * 1024);
    expect(q.struck.some((s) => /packet would pass/.test(s.reason))).toBe(true);
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
    const inbox = fresh('inbox');
    const elsewhere = fresh('elsewhere');
    symlinkSync(elsewhere, join(inbox, 'sources'));
    writePacketCopy(join(inbox, 'sources'), p);
    expect(existsSync(join(elsewhere, 'brief-run-a.md'))).toBe(false); // never written through the link
    const hashes = Object.fromEntries(p.files.map((f) => [f.name, f.sha256]));
    expect(packetChanged(join(inbox, 'sources'), hashes)).toBeNull();
    const victim = p.files.find((f) => f.name.startsWith(`run-${R2}`))!.name;
    writeFileSync(join(inbox, 'sources', victim), 'Coverage: 99%');
    expect(packetChanged(join(inbox, 'sources'), hashes)).toBe(victim);
    // The next attempt's copy restores crew's bytes.
    writePacketCopy(join(inbox, 'sources'), p);
    expect(packetChanged(join(inbox, 'sources'), hashes)).toBeNull();
    expect(readFileSync(join(inbox, 'sources', victim), 'utf8')).toContain('79%');
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
  const init = (ref: string, doc: string) => ({ ref, mount: '_unfiled', doc, projectId: null, owner: 'maria', chatId: 'c1', proposalId: 'c1:t2', cutoffTurnId: 't2', repos: [], graphDb: null });

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
    await reconcileBoundAttempts({
      bindings: s,
      sessions: async () => [...status].map(([id, st]) => run(id, { status: st })),
      cancelRun: async (id) => {
        cancelled.push(id);
        status.set(id, 'cancelled');
      },
      docHead: (_p, doc) => (doc === 'b' ? 1 : 0),
      settleAccepting: async (_c, pid) => {
        settled.push(pid);
        return true;
      },
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
      docHead: () => 0,
      settleAccepting: async () => false,
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

