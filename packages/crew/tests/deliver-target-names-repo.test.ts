// R1 + R2 + R3 (ship-prove-3) — every word of the deliver consent names what will really happen.
//
//  - R1: for a github.com origin the gate card said "Pushes the run branch wicked/<run> to origin and
//    opens a pull request" and never named the repository the PR opens on (the engine's next line
//    named crew's REGISTRY label, `shipproof-gh`, not `mikeparcewski/shipproof-scratch-20261001`).
//  - R2: the card printed the literal placeholder `wicked/<run>`, not the branch it pushes.
//  - R3: the launch composer promised "opens a PR on shipproof-local" for a LOCAL origin; the launch
//    wording now comes from the same origin preflight the gate uses (crew#730), served by
//    `GET /repos/:id/deliver-target`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { deliverGateInstructions, deliverRepoFor, githubRepoOf, newPrTargetSentence } from '../src/core/deliver.js';
import { removeScratch } from './setup/scratch.js';

const RUN = 'c2075235-69c5-4d59-9ef4-b23f349f07a0';
const SLUG = 'mikeparcewski/shipproof-scratch-20261001';
/** A push URL carrying userinfo, assembled at runtime so no credential-shaped literal sits in the
 *  source (secret scanners flag `user:pass@host` URLs, fake or not). */
const CRED_URL = ['https://', 'x-access-token', ':', 'FAKE-TOKEN', '@github.com/', SLUG, '.git'].join('');

describe('the deliver card names the GitHub repository and the real branch (R1, R2)', () => {
  it('reads owner/repo off every github.com spelling, and never carries a credential', () => {
    for (const url of [
      `https://github.com/${SLUG}.git`,
      `https://github.com/${SLUG}`,
      CRED_URL,
      `git@github.com:${SLUG}.git`,
      `ssh://git@github.com/${SLUG}`,
    ]) {
      expect(githubRepoOf(url)).toBe(SLUG);
      const s = newPrTargetSentence(url, RUN);
      expect(s).toBe(
        `Pushes branch wicked/${RUN} to ${SLUG} on GitHub and opens a pull request there; merge stays human.`,
      );
      expect(s).not.toMatch(/FAKE-TOKEN|x-access-token|<run>/);
    }
    // GitHub's ssh-over-443 endpoint is a push host too; another *.github.com names no repository.
    expect(githubRepoOf(`ssh://git@ssh.github.com:443/${SLUG}.git`)).toBe(SLUG);
    expect(githubRepoOf(`git@gist.github.com:${SLUG}.git`)).toBeNull();
    // Not github.com, or not an owner/name path: no slug is invented.
    expect(githubRepoOf('git@gitlab.com:group/proj.git')).toBeNull();
    expect(githubRepoOf('/srv/git/repo.git')).toBeNull();
    expect(githubRepoOf('https://github.com/owner')).toBeNull();
  });

  it('the whole card names the branch, on every arm — no `wicked/<run>` placeholder', () => {
    const gh = deliverGateInstructions({ runId: RUN, originUrl: `https://github.com/${SLUG}.git` });
    expect(gh).toContain(`Pushes branch wicked/${RUN} to ${SLUG} on GitHub and opens a pull request there`);
    const local = deliverGateInstructions({ runId: RUN, originUrl: '/srv/remote.git' });
    expect(local).toContain(`Pushes branch wicked/${RUN} to origin (/srv/remote.git) — a local path`);
    const revision = deliverGateInstructions({
      runId: RUN,
      revisesPr: { number: 273, headRef: 'feature/x', url: 'https://github.com/o/r/pull/273' },
    });
    expect(revision).toContain(`Pushes wicked/${RUN} onto pull request #273 (branch feature/x); no new PR.`);
    for (const card of [gh, local, revision]) expect(card).not.toContain('<run>');
  });

  it('a campaign-shaped id takes the engine\'s colon tier; any other unsafe id names no guess (Copilot)', () => {
    expect(newPrTargetSentence(`git@github.com:${SLUG}.git`, 'recon-7:alpha:a0')).toContain('Pushes branch wicked/recon-7-alpha-a0 to');
    expect(newPrTargetSentence(`git@github.com:${SLUG}.git`, 'has space:x')).toContain('Pushes the run branch to');
    // Whitespace is not trimmed away: the engine hashes `" run "`, so no `wicked/run` is announced.
    expect(newPrTargetSentence(`git@github.com:${SLUG}.git`, ' run ')).toContain('Pushes the run branch to');
  });

  it('with no run yet (the launch) it says "the run branch", never a placeholder', () => {
    expect(newPrTargetSentence(`git@github.com:${SLUG}.git`)).toBe(
      `Pushes the run branch to ${SLUG} on GitHub and opens a pull request there; merge stays human.`,
    );
    expect(newPrTargetSentence(null)).toBe('Pushes the run branch to origin and opens a pull request; merge stays human.');
  });
});

describe('deliverRepoFor — id, then name, then checkout basename, as passes (codex review, MEDIUM)', () => {
  it('an exact id wins over an EARLIER repo whose name or basename collides with it', () => {
    const repos = [
      { id: 'r-1', name: 'widgets', root_path: '/srv/a/r-2' },
      { id: 'r-2', name: 'other', root_path: '/srv/b/x' },
      { id: 'r-3', name: 'r-2b', root_path: '/srv/c/widgets' },
    ];
    expect(deliverRepoFor(repos, 'r-2')?.id).toBe('r-2');
    expect(deliverRepoFor(repos, 'widgets')?.id).toBe('r-1');
    expect(deliverRepoFor(repos, 'x')?.id).toBe('r-2');
    expect(deliverRepoFor(repos, 'nope')).toBeUndefined();
  });
});

describe('GET /repos/:id/deliver-target — the launch reads the gate\'s own preflight (R3)', () => {
  let base: string;
  let app: FastifyInstance;
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'crew-deliver-target-'));
    const mk = (name: string, origin: string | null): string => {
      const root = join(base, name);
      mkdirSync(root);
      git(root, 'init', '-q');
      if (origin !== null) git(root, 'remote', 'add', 'origin', origin);
      return root;
    };
    const repos = [
      { id: 'r-local', name: 'shipproof-local', root_path: mk('local', join(base, 'remote.git')) },
      { id: 'r-gh', name: 'shipproof-gh', root_path: mk('gh', CRED_URL) },
      { id: 'r-none', name: 'no-origin', root_path: mk('none', null) },
    ];
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      { listRepos: vi.fn().mockResolvedValue(repos) } as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    removeScratch(base);
  });

  it('a LOCAL origin: the launch says no pull request can be opened, naming the path', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/repos/r-local/deliver-target' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { repo: string; origin: string; githubRepo: string | null; sentence: string };
    expect(body.repo).toBe('r-local');
    expect(body.origin).toBe('local');
    expect(body.githubRepo).toBeNull();
    expect(body.sentence).toContain(`Pushes the run branch to origin (${join(base, 'remote.git')}) — a local path, so no pull request can be opened against it`);
    expect(body.sentence).not.toMatch(/opens a pull request[;.]/);
  });

  it('a GITHUB origin: names owner/repo; the credential in the URL never reaches the wire', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/repos/r-gh/deliver-target' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      repo: 'r-gh',
      origin: 'github',
      githubRepo: SLUG,
      sentence: `Pushes the run branch to ${SLUG} on GitHub and opens a pull request there; merge stays human.`,
    });
    expect(res.body).not.toMatch(/FAKE-TOKEN|x-access-token/);
  });

  it('NO origin: the push will fail; an unknown repo is a 404', async () => {
    const none = await app.inject({ method: 'GET', url: '/api/v1/repos/r-none/deliver-target' });
    expect((none.json() as { origin: string }).origin).toBe('none');
    expect((none.json() as { sentence: string }).sentence).toContain('the push will fail');
    const missing = await app.inject({ method: 'GET', url: '/api/v1/repos/nope/deliver-target' });
    expect(missing.statusCode).toBe(404);
  });

  it('a repo named by its registry NAME resolves the same way a launch\'s repoRef does', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/repos/shipproof-local/deliver-target' });
    expect((res.json() as { origin: string; repo: string })).toMatchObject({ origin: 'local', repo: 'r-local' });
  });
});
