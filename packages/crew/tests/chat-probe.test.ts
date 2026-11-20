// crew#1497 / plan B4: the chat probe grades answers from disk and a daemon's records. Written from the leak and
// fabrication side: a confident answer citing a file or line that does not exist, a host path, a session-capture row,
// a seat's skill bookkeeping, another project's canary. No daemon, no seat: a fixture HTTP server plays the chat API.

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractCitations, gradeReply, main, parseArgs, resultOf, summarize, turnSettled, type ProbeRepo, type QuestionResult } from '../scripts/chat-probe.js';

let dir: string;
let repos: ProbeRepo[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-probe-'));
  const alpha = join(dir, 'alpha');
  const beta = join(dir, 'beta');
  mkdirSync(join(alpha, 'src'), { recursive: true });
  mkdirSync(join(beta, 'docs'), { recursive: true });
  writeFileSync(join(alpha, 'src', 'lib.rs'), 'fn a() {}\nfn b() {}\nfn c() {}\n');
  writeFileSync(join(alpha, 'CLAUDE.md'), '# Planes\n\nfour planes\n');
  writeFileSync(join(beta, 'docs', 'arch.md'), 'one\ntwo\n');
  writeFileSync(join(dir, 'secret.txt'), 'outside\n');
  repos = [
    { name: 'alpha', rootPath: alpha },
    { name: 'beta', rootPath: beta },
  ];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Make a member repository a git clone of `github.com/<slug>` with everything committed on `main`; returns the commit. */
function cloneOf(root: string, slug: string): string {
  const g = (...args: string[]): string => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', `https://github.com/${slug}.git`);
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture');
  return g('rev-parse', 'HEAD');
}

describe('chat probe: citations', () => {
  it('reads the citation forms answers use, and skips addresses and times', () => {
    const got = extractCitations('See `alpha/src/lib.rs:2`, (CLAUDE.md:3), beta/docs/arch.md:1-2 and lib.rs#L1-L3. Not 127.0.0.1:7741 or 12:30.');
    expect(got.map((c) => [c.file, c.line, c.end])).toEqual([
      ['alpha/src/lib.rs', 2, 2],
      ['CLAUDE.md', 3, 3],
      ['beta/docs/arch.md', 1, 2],
      ['lib.rs', 1, 3],
    ]);
  });

  it('counts a real file and line as valid, with its repository-relative ref', () => {
    const g = gradeReply('It is defined at alpha/src/lib.rs:3 and described in beta/docs/arch.md:2.', repos);
    expect(g.valid).toBe(2);
    expect(g.fabricated).toBe(0);
    expect(g.citations.map((c) => c.ref)).toEqual(['alpha/src/lib.rs', 'beta/docs/arch.md']);
  });

  it('counts a missing file, a line past the end and a reversed range as fabricated', () => {
    const g = gradeReply('alpha/src/main.rs:1, alpha/src/lib.rs:4, alpha/src/lib.rs:3-2, gamma/x.ts:1', repos);
    expect(g.valid).toBe(0);
    expect(g.fabricated).toBe(4);
    expect(g.citations[1]!.why).toContain('outside 1-3');
  });

  it('never reads outside a member repository: traversal and a link out are fabricated, not followed', () => {
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'alpha', 'link.txt'));
    const g = gradeReply('alpha/../secret.txt:1 and alpha/link.txt:1', repos);
    expect(g.fabricated).toBe(2);
    expect(g.valid).toBe(0);
  });

  it('an absolute path is never a repository citation, and the scope\'s own root spelled out is a leak', () => {
    const g = gradeReply(`at ${join(dir, 'alpha', 'src', 'lib.rs')}:1`, repos);
    expect(g.valid).toBe(0);
    expect(g.fabricated).toBe(1);
    expect(g.leaks.map((l) => l.kind)).toContain('scope-root');
    const fake = gradeReply('see /home/someone/repos/alpha/src/lib.rs:1', repos);
    expect(fake.leaks.map((l) => l.kind)).toContain('host-path');
  });

  it('KEY: a citation that names a repository is looked up there only; an unqualified one in two repositories is ambiguous', () => {
    // beta has no src/lib.rs; alpha holds a folder named beta with one: `beta/src/lib.rs` must fail, not fall through.
    mkdirSync(join(dir, 'alpha', 'beta', 'src'), { recursive: true });
    writeFileSync(join(dir, 'alpha', 'beta', 'src', 'lib.rs'), 'x\n');
    const named = gradeReply('beta/src/lib.rs:1', repos);
    expect(named.valid).toBe(0);
    expect(named.fabricated).toBe(1);
    expect(named.citations[0]!.why).toBe('repository beta has no src/lib.rs');
    writeFileSync(join(dir, 'beta', 'CLAUDE.md'), 'one line\n');
    const both = gradeReply('CLAUDE.md:1', repos);
    expect([both.valid, both.fabricated, both.ambiguous]).toEqual([0, 0, 1]);
    expect(resultOf({ id: 'q', q: 'q' }, [{ kind: 'seat', turnId: 't', cliKey: 'c', ok: true, text: 'alpha/src/lib.rs:1 and CLAUDE.md:1' }], 't', repos, []).grounded).toBe(false);
    expect(gradeReply('alpha/CLAUDE.md:3', repos).valid).toBe(1);
  });

  it('takes line numbers whole: a long or huge number is out of range, never truncated', () => {
    for (const c of ['alpha/CLAUDE.md:000000100', 'alpha/CLAUDE.md:1-000000100', 'alpha/CLAUDE.md:99999999999999999999']) {
      expect(gradeReply(c, repos).fabricated, c).toBe(1);
    }
  });

  it('reads dotfiles and bare names as citations, and never a fragment of a longer token', () => {
    writeFileSync(join(dir, 'alpha', '.env'), 'A=1\n');
    writeFileSync(join(dir, 'alpha', 'LICENSE'), 'MIT\n');
    expect(gradeReply('alpha/.env:900 and LICENSE:900 and README:9', repos).fabricated).toBe(3);
    expect(gradeReply('alpha/.env:1 and alpha/LICENSE:1', repos).valid).toBe(2);
    // A non-ASCII letter or a Windows path before the name: the whole token is the citation, not its tail.
    expect(extractCitations('éCLAUDE.md:1').map((c) => c.file)).toEqual(['éCLAUDE.md']);
    const win = gradeReply('C:\\secret\\CLAUDE.md:1', repos);
    expect([win.valid, win.fabricated]).toEqual([0, 1]);
    // A folder that starts with two dots is a name, not a parent step.
    mkdirSync(join(dir, 'alpha', '..fixtures'));
    writeFileSync(join(dir, 'alpha', '..fixtures', 'foo.py'), 'a\nb\nc\n');
    expect(gradeReply('alpha/..fixtures/foo.py:3', repos).valid).toBe(1);
  });

  describe('a GitHub link is checked whole: owner, ref and the line at that ref (coord merge check r2)', () => {
    it("codex's repro: an unrelated owner and a ref that does not exist grade fabricated, though the file is in the checkout", () => {
      cloneOf(join(dir, 'alpha'), 'org/alpha');
      const g = gradeReply('https://github.com/someone-else/alpha/blob/no-such-ref/src/lib.rs#L1', repos);
      expect([g.valid, g.fabricated]).toEqual([0, 1]);
      expect(g.citations[0]!.why).toMatch(/not alpha's remote/);
      const ref = gradeReply('https://github.com/org/alpha/blob/no-such-ref/src/lib.rs#L1', repos);
      expect([ref.valid, ref.fabricated]).toEqual([0, 1]);
      expect(ref.citations[0]!.why).toMatch(/does not exist/);
    });

    it('a correct permalink grades valid: the remote, a commit SHA, and the line in the file at that commit', () => {
      const sha = cloneOf(join(dir, 'alpha'), 'org/alpha');
      const g = gradeReply(`https://github.com/Org/alpha/blob/${sha}/src/lib.rs#L2-L3`, repos);
      expect([g.valid, g.fabricated]).toEqual([1, 0]);
      expect(g.citations[0]!.ref).toBe('alpha/src/lib.rs');
    });

    it('the line is read AT THE REF: a line past that commit\'s file is fabricated though HEAD has it', () => {
      const sha = cloneOf(join(dir, 'alpha'), 'org/alpha');
      // HEAD grows the file to 5 lines; the permalink's commit has 3.
      writeFileSync(join(dir, 'alpha', 'src', 'lib.rs'), 'fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\nfn e() {}\n');
      execFileSync('git', ['-C', join(dir, 'alpha'), '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'grow'], { stdio: 'ignore' });
      const old = gradeReply(`https://github.com/org/alpha/blob/${sha}/src/lib.rs#L5`, repos);
      expect([old.valid, old.fabricated]).toEqual([0, 1]);
      expect(old.citations[0]!.why).toMatch(/outside 1-3/);
      expect(gradeReply('https://github.com/org/alpha/blob/main/src/lib.rs#L5', repos).valid).toBe(1);
    });

    it('a member with no GitHub remote, or a ref shaped as an option, never grades a link valid', () => {
      const g = gradeReply('https://github.com/org/alpha/blob/main/src/lib.rs#L1', repos);
      expect([g.valid, g.fabricated]).toEqual([0, 1]);
      cloneOf(join(dir, 'alpha'), 'org/alpha');
      const opt = gradeReply('https://github.com/org/alpha/blob/--output=x/src/lib.rs#L1', repos);
    expect(opt.valid).toBe(0);
    expect(opt.citations[0]!.why).toMatch(/is not a ref/);
    });
  });

  describe('one pass that claims spans (coord merge check on crew#1615)', () => {
    it('W20: a quoted path with a space that does not exist is fabricated, never its last word', () => {
      writeFileSync(join(dir, 'alpha', 'README.md'), 'readme\n');
      const g = gradeReply('See `alpha/missing README.md:1`.', repos);
      expect([g.valid, g.fabricated]).toEqual([0, 1]);
      expect(g.citations).toHaveLength(1);
      expect(g.citations[0]!.file).toBe('alpha/missing README.md');
    });

    it('a quoted path with a space that exists is valid, whole', () => {
      mkdirSync(join(dir, 'alpha', 'my docs'));
      writeFileSync(join(dir, 'alpha', 'my docs', 'notes.md'), 'a\nb\n');
      const g = gradeReply('See `alpha/my docs/notes.md:2`.', repos);
      expect([g.valid, g.fabricated]).toEqual([1, 0]);
      expect(g.citations[0]!.ref).toBe('alpha/my docs/notes.md');
    });

    it('W12: a permalink with an encoded path is one valid citation; nothing is read from inside the URL', () => {
      const sha = cloneOf(join(dir, 'alpha'), 'org/alpha');
      const g = gradeReply(`https://github.com/org/alpha/blob/${sha}/src/%6cib.rs#L2`, repos);
      expect([g.valid, g.fabricated]).toEqual([1, 0]);
      expect(g.citations).toHaveLength(1);
    });

    it('a quoted link is read as the link, once', () => {
      const sha = cloneOf(join(dir, 'alpha'), 'org/alpha');
      const g = gradeReply(`\`https://github.com/org/alpha/blob/${sha}/src/lib.rs#L3\``, repos);
      expect([g.valid, g.fabricated, g.citations.length]).toEqual([1, 0, 1]);
    });
  });

  describe('fails closed on what it cannot read whole (codex r3 on the probe)', () => {
    it.each([
      ['#1 a suffix of a longer token', 'missing%CLAUDE.md:1'],
      ['#1 a suffix after a bang', 'does-not-exist!CLAUDE.md:1'],
      ['#2 an extensionless name it does not know', 'gradlew:999'],
      ['#2 a numeric extension', 'missing.123:999'],
      ['#3 an upper-case scheme', '[missing](HTTPS://else.invalid/no.ts#L999)'],
      ['#3 an upper-case file scheme', '[x](FILE:///outside/missing.py#L999)'],
      ['#4 a malformed line fragment', 'https://github.com/org/alpha/blob/main/src/lib.rs#L1e999'],
      ['#4 an en-dash range', 'https://github.com/org/alpha/blob/main/src/lib.rs#L1–L999999'],
      ['#4 a range with trailing junk', 'alpha/src/lib.rs:1-99999x'],
    ])('%s grades fabricated beside a valid citation', (_why, bad) => {
      cloneOf(join(dir, 'alpha'), 'org/alpha');
      const g = gradeReply(`alpha/CLAUDE.md:3 and ${bad}`, repos);
      expect(g.fabricated, JSON.stringify(g.citations)).toBeGreaterThanOrEqual(1);
    });

    it('still reads markdown around citations, a column after a line, and skips times and addresses', () => {
      const g = gradeReply('**alpha/src/lib.rs:2**, `beta/docs/arch.md:1`. alpha/src/lib.rs:3:5; at 12:30 on 127.0.0.1:7741.', repos);
      expect([g.valid, g.fabricated]).toEqual([3, 0]);
    });

    it('#5 a URL query is not part of the file name', () => {
      cloneOf(join(dir, 'alpha'), 'org/alpha');
      const g = gradeReply('https://github.com/org/alpha/blob/main/src/lib.rs?plain=1#L2', repos);
      expect([g.valid, g.fabricated]).toEqual([1, 0]);
      expect(g.citations[0]!.file).toBe('src/lib.rs');
    });

    it('#10 a member that is a folder inside another checkout never grades a link valid', () => {
      cloneOf(dir, 'org/alpha');
      const g = gradeReply('https://github.com/org/alpha/blob/main/secret.txt#L1', [{ name: 'alpha', rootPath: join(dir, 'alpha') }]);
      expect([g.valid, g.fabricated]).toEqual([0, 1]);
      expect(g.citations[0]!.why).toMatch(/not a git clone of its own/);
    });

    it('#11 a branch whose name holds a slash resolves', () => {
      cloneOf(join(dir, 'alpha'), 'org/alpha');
      execFileSync('git', ['-C', join(dir, 'alpha'), 'branch', 'fix/x'], { stdio: 'ignore' });
      expect(gradeReply('https://github.com/org/alpha/blob/fix/x/src/lib.rs#L3', repos).valid).toBe(1);
    });

    it('#8 a file URL to a home folder and a Windows path in any script are leaks', () => {
      const kinds = (s: string) => gradeReply(s, repos).leaks.map((l) => l.kind);
      expect(kinds('see file:///home/alice/.ssh/id_ed25519')).toContain('host-path');
      expect(kinds('see C:\\秘密\\credentials.json')).toContain('host-path');
    });

    it('#9 a pretty-printed session row is a leak', () => {
      const row = '{\n  "type": "assistant",\n  "message": {"role": "assistant", "content": "internal session text"}\n}';
      expect(gradeReply(row, repos).leaks.map((l) => l.kind)).toContain('session-capture');
    });
  });

  it('checks the files that links cite, without fetching them', () => {
    cloneOf(join(dir, 'alpha'), 'org/alpha');
    const gh = gradeReply('alpha/CLAUDE.md:3, https://github.com/org/alpha/blob/main/missing.ts#L900', repos);
    expect([gh.valid, gh.fabricated]).toEqual([1, 1]);
    expect(gradeReply('https://github.com/org/alpha/blob/main/src/lib.rs#L1-L3', repos).valid).toBe(1);
    expect(gradeReply('https://github.com/org/elsewhere/blob/main/src/lib.rs#L1', repos).fabricated).toBe(1);
    const file = gradeReply('[alpha/CLAUDE.md:1](file:///outside/missing.py#L999)', repos);
    expect([file.valid, file.fabricated]).toEqual([1, 1]);
  });

  it('an address inside a URL is not a citation; a bare name:number is one, and fails when no file has it (codex r2 #6)', () => {
    expect(extractCitations('see https://api.example.com:443/v1 or http://localhost:8080/x, then 10.0.0.1:8080')).toEqual([]);
    for (const s of ['missing.sh:999', 'missing.test:999']) expect(gradeReply(`alpha/CLAUDE.md:3 and ${s}`, repos)).toMatchObject({ valid: 1, fabricated: 1 });
  });

  it('HIDE: an extensionless file under a directory, a forward-slash UNC path and any unchecked link are citations that fail (codex r2 #9, #10)', () => {
    for (const s of ['crew/bin/no_such_file:999', '//server/share/missing.ts:999', 'https://gitlab.com/org/elsewhere/-/blob/main/missing.ts#L999', 'file://otherhost/outside/missing.ts#L9', 'file://localhost/outside/missing.ts#L999']) {
      expect(gradeReply(`alpha/CLAUDE.md:3 and ${s}`, repos), s).toMatchObject({ valid: 1, fabricated: 1 });
    }
    expect(gradeReply('//server/share/missing.ts:999', repos).leaks.map((l) => l.kind)).toContain('host-path');
  });

  it('a reply citing more than the cap is not graded as grounded', () => {
    const g = gradeReply(Array.from({ length: 201 }, () => 'alpha/CLAUDE.md:3').join(' '), repos);
    expect(g.fabricated).toBe(1);
    expect(g.citations.at(-1)!.why).toMatch(/more than 200/);
  });
});

describe('chat probe: leaks', () => {
  it('catches a reordered session row, a heading with closing hashes and a note about using a skill (codex r2 #12-14)', () => {
    const kinds = (s: string) => gradeReply(s, repos).leaks.map((l) => l.kind);
    expect(kinds('{"message":{"role":"assistant","content":[]},"type":"assistant"}')).toContain('session-capture');
    expect(kinds('## Work State ##\nnotes')).toContain('seat-bookkeeping');
    expect(kinds('I am using the debugging skill.')).toContain('skill-bookkeeping');
  });

  it.each([
    ['session-capture', 'Session goal (turn 1) <task-notification> <task-id>a1</task-id>'],
    ['session-capture', 'done (toolu_01AbCdEfGh)'],
    ['skill-bookkeeping', 'I did not re-invoke the skill, because its rules were already loaded in this session.'],
    ['skill-bookkeeping', 'That answer came through the shim.'],
    ['seat-bookkeeping', 'The answer.\nCounts: 3 files read'],
    ['control-line', 'PLAN+ {"steps":[]}'],
    ['scratch-root', 'I wrote it to /tmp/wicked-crew-chats/123-ab/c1/notes.md'],
    ['host-path', 'the file at /private/var/folders/xy/T/notes'],
    ['host-path', 'kept in /tmp/host-secret'],
    ['host-path', 'C:\\Users\\Alice\\private'],
    ['host-path', 'D:/Work/private'],
    ['host-path', 'C:\\Temp\\wicked-crew-chats\\s\\notes'],
    ['host-path', 'on \\\\server\\share\\x'],
    ['scratch-root', 'C:\\Temp\\wicked-crew-chats\\s\\notes'],
    ['session-capture', '{"type":"assistant","message":{"role":"assistant","content":[]}}'],
    ['session-capture', '{"timestamp":"x","type":"session_meta","payload":{}}'],
    ['skill-bookkeeping', 'I have loaded the skill.'],
    ['skill-bookkeeping', 'Loaded skill: debugging'],
    ['skill-bookkeeping', 'I re-invoked the debugging skill.'],
    ['seat-bookkeeping', 'Answer.\n## Work State\nfine'],
    ['seat-bookkeeping', 'Answer.\n## Next Move'],
    ['seat-bookkeeping', 'Answer.\n**Counts:** 4'],
    ['control-line', '```wicked-make\n{}\n```'],
  ])('flags %s', (kind, text) => {
    expect(gradeReply(text, repos).leaks.map((l) => l.kind)).toContain(kind);
  });

  it('a URL path, code that loads skills and a parser value are not leaks', () => {
    for (const text of ['see https://docs.example.org/home/runner/install', 'The loader loads each skill from disk.', 'the parser emits `neutral-section`']) {
      expect(gradeReply(text, repos).leaks, text).toEqual([]);
    }
  });

  it('a plain answer naming env vars and the estate shim command is not a leak', () => {
    const text = 'Set `WICKED_ESTATE_DB` and run `wicked-garden run scripts/_estate_client.py` (the shim command). See alpha/CLAUDE.md:3.';
    expect(gradeReply(text, repos).leaks).toEqual([]);
  });

  it('a canary planted in another project is a cross-project leak', () => {
    expect(gradeReply('the codename is ZEBRA-7731', repos, ['ZEBRA-7731']).leaks).toEqual([{ kind: 'cross-project-canary', match: 'ZEBRA-7731' }]);
  });
});

describe('chat probe: one turn and the bar', () => {
  const q = { id: 'q1', q: 'what are the planes?', expect: ['alpha/CLAUDE.md'] };

  it('grades the first ok reply as the answer and every reply for fabrications and leaks', () => {
    const records = [
      { kind: 'user', turnId: 't1', text: q.q },
      { kind: 'seat', turnId: 't1', cliKey: 'claude', ok: true, text: 'Four planes: alpha/CLAUDE.md:3.' },
      { kind: 'seat', turnId: 't1', cliKey: 'codex', ok: true, text: 'Agreed, alpha/src/nope.rs:9. I did not re-invoke the skill.' },
      { kind: 'citations', turnId: 't1', cliKey: 'claude', verified: 1, unverifiable: 0, corrected: 0, unchecked: 0, items: [] },
      { kind: 'seat', turnId: 'other', cliKey: 'claude', ok: true, text: '/home/x leak in another turn' },
    ];
    const r = resultOf(q, records, 't1', repos, []);
    expect(r.answered).toBe(true);
    expect(r.answerSeat).toBe('claude');
    expect(r.grounded).toBe(true);
    expect(r.anchorHit).toBe(true);
    expect(r.fabricated).toBe(1);
    expect(r.leaks.map((l) => l.kind)).toEqual(['skill-bookkeeping']);
    expect(r.daemonCitations).toEqual({ verified: 1, unverifiable: 0, corrected: 0 });
  });

  it('an answer with no citation, or one citing a fabricated line, is not grounded', () => {
    const none = resultOf(q, [{ kind: 'seat', turnId: 't', cliKey: 'c', ok: true, text: 'Four planes.' }], 't', repos, []);
    const bad = resultOf(q, [{ kind: 'seat', turnId: 't', cliKey: 'c', ok: true, text: 'alpha/CLAUDE.md:3 and alpha/CLAUDE.md:99' }], 't', repos, []);
    const failed = resultOf(q, [{ kind: 'seat', turnId: 't', cliKey: 'c', ok: false, text: 'alpha/CLAUDE.md:3' }], 't', repos, []);
    expect([none.grounded, bad.grounded, failed.grounded, failed.answered]).toEqual([false, false, false, false]);
    // An anchored question with no answer counts against the anchor rate (codex r2 #8).
    expect(failed.anchorHit).toBe(false);
  });

  it('passes at 18 of 20 grounded with no fabrication and no leak, and fails otherwise', () => {
    const r = (grounded: boolean, fabricated = 0, leaks = 0) =>
      ({ grounded, fabricated, answered: true, error: null, anchorHit: null, leaks: Array.from({ length: leaks }, () => ({ kind: 'k', match: 'm' })) }) as unknown as QuestionResult;
    const base = [...Array.from({ length: 18 }, () => r(true)), r(false), r(false)];
    expect(summarize(base).passed).toBe(true);
    expect(summarize([...base.slice(0, 17), r(false), r(false), r(false)]).passed).toBe(false);
    expect(summarize([...base.slice(0, 19), r(true, 1)]).passed).toBe(false);
    expect(summarize([...base.slice(0, 19), r(true, 0, 1)]).passed).toBe(false);
    expect(summarize([]).passed).toBe(false);
    // codex r3 #6: the bar over fewer than 20 questions is met, never passed.
    expect(summarize(base.slice(0, 1))).toMatchObject({ barMet: true, passed: false });
    expect(summarize(base.slice(0, 19))).toMatchObject({ barMet: true, passed: false });
    // SILENT-OK: a question that errored or got no answer fails the measure; the 10% is for ungrounded answers only.
    const errored = { ...r(false), answered: false, error: 'open 500: x' } as QuestionResult;
    const unanswered = { ...r(false), answered: false } as QuestionResult;
    expect(summarize([...base.slice(0, 19), errored])).toMatchObject({ errors: 1, passed: false });
    expect(summarize([...base.slice(0, 19), unanswered])).toMatchObject({ answered: 19, passed: false });
    expect(summarize([...Array.from({ length: 20 }, () => r(true)).slice(0, 19), { ...r(true), error: 'close 502: x' } as QuestionResult])).toMatchObject({ grounded: 19, passed: false });
  });

  it('reports the anchor hit rate', () => {
    const r = (anchorHit: boolean | null) => ({ grounded: true, fabricated: 0, answered: true, error: null, leaks: [], anchorHit }) as unknown as QuestionResult;
    expect(summarize([r(true), r(false), r(null)])).toMatchObject({ anchored: 2, anchorHits: 1 });
  });

  it('a turn settles only when every seat the send reached has replied (and the answer is cited or waited for)', () => {
    const ok = { kind: 'seat', turnId: 't', cliKey: 'claude', ok: true, text: 'x' };
    const cites = { kind: 'citations', turnId: 't', cliKey: 'claude' };
    expect(turnSettled([ok, cites], 't', ['claude', 'codex'], 0, 1, 1000)).toBe(false);
    expect(turnSettled([ok, cites, { kind: 'seat', turnId: 't', cliKey: 'codex', ok: true, text: 'y' }], 't', ['claude', 'codex'], 0, 1, 1000)).toBe(true);
    expect(turnSettled([ok], 't', ['claude'], 0, 500, 1000)).toBe(false);
    expect(turnSettled([ok], 't', ['claude'], 0, 1500, 1000)).toBe(true);
    // No seat list and no answer: it never settles by itself (the deadline ends it as an error).
    expect(turnSettled([{ ...ok, ok: false }], 't', null, null, 1, 1000)).toBe(false);
    // No seat list from the send: never settled, even with an ok reply and its verdicts (codex r2 #11).
    expect(turnSettled([ok, cites], 't', null, 0, 99_999, 1000)).toBe(false);
    expect(turnSettled([ok, cites], 't', [], 0, 99_999, 1000)).toBe(false);
    expect(turnSettled([null, 7, 'x'], 't', ['claude'], null, 1, 1000)).toBe(false);
  });

  it("refuses the operator's daemons and demands its inputs", () => {
    expect(() => parseArgs(['--base', 'http://127.0.0.1:7701', '--project', 'p', '--questions', 'q.json'])).toThrow(/7701/);
    expect(() => parseArgs(['--base', 'http://127.0.0.1:7721', '--project', 'p', '--questions', 'q.json'])).toThrow(/7721/);
    expect(() => parseArgs(['--base', 'http://127.0.0.1:7741'])).toThrow(/required/);
    expect(parseArgs(['--base', 'http://127.0.0.1:7741/', '--project', 'p', '--questions', 'q.json', '--canary', 'X']).base).toBe('http://127.0.0.1:7741');
  });
});

describe('chat probe: against a fixture chat API', () => {
  let server: Server;
  let base: string;
  const calls: string[] = [];
  /** How the fixture misbehaves, per test. */
  let mode: { scope?: unknown; messagesStatus?: number; lateMs?: number; secondSeat?: string; secondSeatFails?: boolean; noSeats?: boolean; closeStatus?: number; redirectOpen?: string; hangRead?: boolean; badRecords?: boolean; finalDropsSecondSeat?: boolean };

  beforeEach(async () => {
    calls.length = 0;
    mode = {};
    const turns = new Map<string, Array<unknown>>();
    const dropped = new Set<string>();
    let n = 0;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}`);
        const send = (status: number, json: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        };
        const m = /^\/api\/v1\/chats(?:\/([^/]+)(?:\/(messages|close))?)?$/u.exec(req.url ?? '');
        if (m === null) return send(404, { error: 'no' });
        const [, id, sub] = m;
        if (req.method === 'POST' && id === undefined) {
          if (mode.redirectOpen !== undefined) {
            res.writeHead(307, { location: mode.redirectOpen });
            return res.end();
          }
          n += 1;
          turns.set(`c${n}`, []);
          const scope = 'scope' in mode ? mode.scope : { repos: repos.map((r) => ({ ...r, id: r.name })), graph: { bound: true, reason: 'x' } };
          return send(201, { chatId: `c${n}`, seats: [], scope });
        }
        if (req.method === 'POST' && sub === 'messages') {
          const text = (JSON.parse(body) as { text: string }).text;
          const reply = text.includes('planes') ? 'Four planes, alpha/CLAUDE.md:3.' : 'It lives outside any git repo: alpha/missing.md:1';
          const list = turns.get(id!)!;
          list.push({ kind: 'user', turnId: 't1', text });
          const land = () => {
            list.push({ kind: 'seat', turnId: 't1', cliKey: 'claude', ok: true, text: reply });
            if (mode.badRecords === true) list.push(null, 7, { kind: 'seat' });
          };
          if (mode.lateMs !== undefined) setTimeout(land, mode.lateMs);
          else land();
          if (mode.secondSeat !== undefined) {
            setTimeout(() => {
              list.push({ kind: 'seat', turnId: 't1', cliKey: 'codex', ok: mode.secondSeatFails !== true, text: mode.secondSeat });
              // The answer's citation verdicts land with the last seat, so the read that shows it settles the turn.
              if (mode.finalDropsSecondSeat === true) list.push({ kind: 'citations', turnId: 't1', cliKey: 'claude', citations: [] });
            }, 60);
          }
          if (mode.noSeats === true) return send(202, { turnId: 't1' });
          return send(202, { seats: mode.secondSeat !== undefined ? ['claude', 'codex'] : ['claude'], turnId: 't1' });
        }
        if (req.method === 'GET' && sub === 'messages') {
          if (mode.hangRead === true) return; // never answers
          const all = turns.get(id!) ?? [];
          if (mode.finalDropsSecondSeat === true) {
            // Once a read has shown the second seat, later reads lose it (a regressing API).
            if (dropped.has(id!)) return send(200, { chat: {}, messages: all.filter((r) => (r as { cliKey?: string } | null)?.cliKey !== 'codex'), attachments: [] });
            if (all.some((r) => (r as { cliKey?: string } | null)?.cliKey === 'codex')) dropped.add(id!);
          }
          return send(mode.messagesStatus ?? 200, { chat: {}, messages: all, attachments: [] });
        }
        if (req.method === 'POST' && sub === 'close') return send(mode.closeStatus ?? 200, mode.closeStatus !== undefined ? { error: 'cancel failed' } : { ok: true });
        return send(405, { error: 'no' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const run = async (qs: Array<{ q: string }>, extra: string[] = []) => {
    const qfile = join(dir, 'q.json');
    const out = join(dir, 'out.json');
    writeFileSync(qfile, JSON.stringify(qs));
    const code = await main(['--base', base, '--project', 'p1', '--questions', qfile, '--out', out, '--poll-ms', '20', '--timeout-secs', '3', ...extra]);
    const res = JSON.parse(readFileSync(out, 'utf8')) as { summary: Record<string, unknown>; results: QuestionResult[] };
    return { code, ...res };
  };
  const planes = [{ q: 'what are the four planes?' }];

  it('asks each question in its own project chat, closes it, and reports the bar', async () => {
    const { code, summary } = await run([{ q: 'what are the four planes?' }, { q: 'where is the arch doc?' }]);
    expect(code).toBe(1);
    expect(summary).toMatchObject({ questions: 2, answered: 2, errors: 0, grounded: 1, fabricated: 1, leaks: 0, passed: false });
    // Only chats: open, send, read, close. Never a run, a gate or anything else.
    expect(calls.every((c) => /^(POST \/api\/v1\/chats(\/c\d+\/(messages|close))?|GET \/api\/v1\/chats\/c\d+\/messages)$/u.test(c))).toBe(true);
    expect(calls.filter((c) => c.endsWith('/close'))).toHaveLength(2);
  });

  it('a grounded answer meets the bar, and one question is a smoke run, never a B4 pass (codex r3 #6)', async () => {
    const { code, summary } = await run(planes);
    expect(summary).toMatchObject({ grounded: 1, errors: 0, barMet: true, passed: false });
    expect(code).toBe(1);
  });

  it('SILENT-OK: a reply that lands after the deadline fails the question', async () => {
    mode.lateMs = 1500;
    const { code, results } = await run(planes, ['--timeout-secs', '0.5']);
    expect(code).toBe(1);
    expect(results[0]!.error).toMatch(/did not settle/);
    expect(results[0]!.grounded).toBe(false);
  });

  it('SILENT-OK: a failed messages read is never graded, whatever its body says', async () => {
    mode.messagesStatus = 500;
    const { code, results } = await run(planes, ['--timeout-secs', '0.5']);
    expect(code).toBe(1);
    expect(results[0]!.error).toMatch(/read 500/);
  });

  it('HIDE: every seat the send reached is waited for and graded, so a later leaking reply fails the probe', async () => {
    mode.secondSeat = 'Agreed. I have loaded the skill. alpha/src/nope.rs:9';
    const { code, results } = await run(planes);
    expect(code).toBe(1);
    expect(results[0]!.leaks.map((l) => l.kind)).toEqual(['skill-bookkeeping']);
    expect(results[0]!.fabricated).toBe(1);
  });

  it('SILENT-OK: a final read that loses a failed, leaking seat the settling read showed still fails the question (codex r3 #7)', async () => {
    mode.secondSeat = 'failed at /home/alice/x';
    mode.secondSeatFails = true;
    mode.finalDropsSecondSeat = true;
    const { code, results } = await run(planes);
    expect(code).toBe(1);
    expect(results[0]!.error).toMatch(/lost seat codex/);
    expect(results[0]!.leaks.map((l) => l.kind)).toContain('host-path');
  });

  it('SILENT-OK: a seat the send reached that failed fails the question, even beside a grounded answer (codex r2 #5)', async () => {
    mode.secondSeat = 'session timed out';
    mode.secondSeatFails = true;
    const { code, results, summary } = await run(planes);
    expect(code).toBe(1);
    expect(results[0]!.error).toMatch(/seat codex failed/);
    expect(summary).toMatchObject({ errors: 1, passed: false });
  });

  it('SILENT-OK: a send that names no seats fails the question; the turn cannot be known complete (codex r2 #11)', async () => {
    mode.noSeats = true;
    const { code, results } = await run(planes);
    expect(code).toBe(1);
    expect(results[0]!.error).toMatch(/no seat list/);
    expect(calls.filter((c) => c.endsWith('/close'))).toHaveLength(1);
  });

  it('odd shapes fail the question, not the probe, and the chat is still closed', async () => {
    mode.scope = { repos: {} };
    const a = await run(planes);
    expect(a.results[0]!.error).toMatch(/scope\.repos/);
    expect(calls.filter((c) => c.endsWith('/close'))).toHaveLength(1);
    mode = { badRecords: true };
    const b = await run(planes);
    expect(b.summary).toMatchObject({ grounded: 1, errors: 0 });
  });

  it('a chat that cannot be closed fails the measure', async () => {
    mode.closeStatus = 502;
    const { code, results } = await run(planes);
    expect(code).toBe(1);
    expect(results[0]!.error).toMatch(/close 502/);
  });

  it('never follows a redirect (one could point at an operator daemon)', async () => {
    mode.redirectOpen = 'http://127.0.0.1:7701/api/v1/chats';
    const { code, results } = await run(planes);
    expect(code).toBe(1);
    expect(results[0]!.error).toMatch(/redirect/);
    expect(calls).toEqual(['POST /api/v1/chats']);
  });

  it('a read that never answers is cut off by the deadline', async () => {
    mode.hangRead = true;
    const started = Date.now();
    const { code, results } = await run(planes, ['--timeout-secs', '0.5']);
    expect(code).toBe(1);
    expect(results[0]!.error).toMatch(/did not settle/);
    expect(Date.now() - started).toBeLessThan(2900);
  });
});
