// F2 half (a) (ship-proof C7) — THE CONSENT LINE NAMES THE ORIGIN THE PUSH WILL ACTUALLY GO TO.
//
// The deliver gate card promised "Pushes the run branch wicked/<run> to origin and opens a pull
// request" whatever `origin` was. In C7 `origin` was a FILE PATH, so the operator consented to a
// pull request that could not exist — and got an irreversible push plus a run that could not reach
// a terminal state (the push-only success path in `deliver-script-exec.test.ts` fixes the outcome;
// this fixes the consent).
//
// A GitHub Enterprise Server install is an arbitrary hostname and `gh` — which resolves the remote
// itself — is the only authority on whether it can open a pull request there. So an unrecognised
// HOST is never told "no pull request"; it is told the condition. A local path is different: gh
// cannot open a pull request against a filesystem path and never will.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifyDeliverOrigin,
  deliverGateInstructions,
  newPrTargetSentence,
  originRemoteHost,
  readDeliverOriginUrl,
} from '../src/core/deliver.js';

describe('the deliver gate names the real origin (F2)', () => {
  it('a LOCAL origin is told there will be no pull request, and the branch is the delivery', () => {
    for (const url of [
      '/var/folders/x/crew-deliver-abc/origin.git',
      'file:///var/folders/x/crew-deliver-abc/origin.git',
      '../sibling-checkout/.git',
      'C:\\repos\\ship-proof-kit',
    ]) {
      expect(classifyDeliverOrigin(url)).toBe('local');
      const s = newPrTargetSentence(url);
      expect(s).toContain('a local path, so no pull request can be opened against it');
      // NOT a flat "no pull request is opened": `gh pr create` resolves every configured remote,
      // not only origin, so this read establishes the push DESTINATION and states the pull
      // request as the condition it is (codex review, MEDIUM).
      expect(s).toContain('unless another remote in this checkout is a GitHub repository gh resolves');
      expect(s).toContain('the pushed branch IS the delivery');
      // The exact over-claim C7 caught must be gone.
      expect(s).not.toContain('opens a pull request;');
    }
  });

  it('a scp-style remote with an ABSOLUTE path is a HOST, not a local path (codex review, LOW)', () => {
    // `git@example.com:/srv/git/repo.git` is valid scp syntax; an earlier `(?!\/)` guard rejected
    // it and called a real remote a local path. A single-letter host is a host too.
    expect(originRemoteHost('git@example.com:/srv/git/repo.git')).toBe('example.com');
    expect(classifyDeliverOrigin('git@example.com:/srv/git/repo.git')).toBe('other');
    expect(originRemoteHost('h:path/to/repo.git')).toBe('h');
    // A Windows drive is still a PATH, excluded by shape rather than by host length.
    expect(originRemoteHost('C:\\repos\\x')).toBeNull();
    expect(originRemoteHost('C:/repos/x')).toBeNull();
    // `file:///p` has an EMPTY authority: it names no host, and must not be read as a host named
    // `file` (which is what dropping the old `(?!\/)` guard exposed).
    expect(originRemoteHost('file:///var/tmp/origin.git')).toBeNull();
    expect(classifyDeliverOrigin('file:///var/tmp/origin.git')).toBe('local');
    expect(classifyDeliverOrigin('C:\\repos\\x')).toBe('local');
  });

  it('a GITHUB origin keeps the promise it can keep', () => {
    for (const url of [
      'https://github.com/owner/repo.git',
      'git@github.com:owner/repo.git',
      'ssh://git@github.com/owner/repo',
      'https://user@github.com/owner/repo',
    ]) {
      expect(classifyDeliverOrigin(url)).toBe('github');
      expect(newPrTargetSentence(url)).toBe(
        'Pushes the run branch wicked/<run> to origin and opens a pull request; merge stays human.',
      );
    }
  });

  it('another HOST is told the condition, never "no pull request" — GHES is an arbitrary hostname', () => {
    for (const [url, host] of [
      ['git@gitlab.com:group/proj.git', 'gitlab.com'],
      ['https://dev.azure.com/org/proj/_git/repo', 'dev.azure.com'],
      ['ssh://git@gitea.internal:2222/team/repo.git', 'gitea.internal'],
      ['https://github.acme.example/owner/repo.git', 'github.acme.example'],
    ] as const) {
      expect(classifyDeliverOrigin(url)).toBe('other');
      expect(originRemoteHost(url)).toBe(host);
      const s = newPrTargetSentence(url);
      expect(s).toContain(`opens a pull request only if gh resolves ${host} as a GitHub host`);
      expect(s).toContain('otherwise no pull request is opened and the pushed branch IS the delivery');
    }
  });

  it('NO origin remote at all says the push will fail — read and absent is the one claim it licenses', () => {
    expect(classifyDeliverOrigin('')).toBe('none');
    const s = newPrTargetSentence('');
    expect(s).toContain('no `origin` remote, so the push will fail and nothing will be delivered');
  });

  it('an origin that could NOT be read claims nothing either way — the card keeps its old sentence', () => {
    const generic = 'Pushes the run branch wicked/<run> to origin and opens a pull request; merge stays human.';
    expect(newPrTargetSentence(null)).toBe(generic);
    expect(newPrTargetSentence(undefined)).toBe(generic);
  });

  it('the whole card carries it: origin sentence + identity + the credential cross-check', () => {
    const card = deliverGateInstructions({ originUrl: '/tmp/origin.git', ghAccount: 'release-bot', ghTokenPinned: true });
    expect(card).toContain('a local path, so no pull request can be opened against it');
    expect(card).toContain('Push identity: release-bot (GH_ACCOUNT), pinned by GH_TOKEN');
    expect(card).toContain("It refuses if gh's login and git's credential for the remote disagree.");
  });

  it('REVISION mode is untouched — the pull request it pushes onto already exists', () => {
    const card = deliverGateInstructions({
      revisesPr: { number: 273, headRef: 'feature/x', url: 'https://github.com/o/r/pull/273' },
      originUrl: '/tmp/origin.git',
    });
    expect(card).toContain('Pushes wicked/<run> onto pull request #273 (branch feature/x); no new PR.');
    expect(card).not.toContain('a local path');
  });
});

// The IO half: what git actually answers, against real checkouts. The whole preflight fails OPEN
// (an unreadable origin keeps the generic sentence), so a reader that never returns a URL would be
// silently indistinguishable from "no repos registered" — which is why this is driven for real.
describe('readDeliverOriginUrl — git is the authority (F2)', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  function repo(remote: string | null): string {
    const root = mkdtempSync(join(tmpdir(), 'crew-f2-origin-'));
    roots.push(root);
    execFileSync('git', ['init', '-b', 'main', root]);
    if (remote !== null) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    return root;
  }

  // 30 s, not vitest's default 5 s: these cases fork `git init` + `git config` + `git remote add`
  // over three temp checkouts, and on a loaded host (a CI runner sharing a box, a developer running
  // several suites at once) that has been measured past the default and failed for the clock rather
  // than for the behaviour. The assertions are unchanged.
  const IO_TIMEOUT_MS = 30_000;

  it('answers the configured URL', async () => {
    await expect(readDeliverOriginUrl(repo('https://github.com/owner/repo.git'))).resolves.toBe(
      'https://github.com/owner/repo.git',
    );
    // The PUSH url wins where one is configured (codex review, HIGH): `git push origin` uses
    // `remote.origin.pushurl`, so a card about the push must read the push url.
    const split = repo('https://github.com/owner/repo.git');
    execFileSync('git', ['config', 'remote.origin.pushurl', 'ssh://git@gitlab.example/owner/repo.git'], { cwd: split });
    await expect(readDeliverOriginUrl(split)).resolves.toBe('ssh://git@gitlab.example/owner/repo.git');
    expect(classifyDeliverOrigin(await readDeliverOriginUrl(split))).toBe('other');
    const local = repo('/var/tmp/origin.git');
    await expect(readDeliverOriginUrl(local)).resolves.toBe('/var/tmp/origin.git');
    expect(classifyDeliverOrigin(await readDeliverOriginUrl(local))).toBe('local');
  }, IO_TIMEOUT_MS);

  it("answers '' — read and ABSENT — for a repo with no origin remote", async () => {
    await expect(readDeliverOriginUrl(repo(null))).resolves.toBe('');
  }, IO_TIMEOUT_MS);

  it('answers null when git could not say: a directory that is no checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-f2-origin-'));
    roots.push(root);
    mkdirSync(join(root, 'plain'));
    await expect(readDeliverOriginUrl(join(root, 'plain'))).resolves.toBeNull();
  }, IO_TIMEOUT_MS);
});
