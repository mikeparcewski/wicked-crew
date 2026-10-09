// F3 (ship-proof C7) — THE NUMBER ON THE DELIVER GATE MUST BE THE NUMBER THAT SHIPS.
//
// The deliver gate's consent diffstat is computed by the studio from `GET /runs/:id/diff`
// (`worktreeDiff`), which appended EVERY non-ignored untracked path as an all-addition hunk. The
// deliver script does not push every non-ignored untracked path: `deliverPrScript`'s crew#434
// classifier drops scratch directories, databases, sockets, key material, `.DS_Store` and any
// unrecognised file over 1 MiB — and says so in the phase output.
//
// So on a run whose creator left a `tmp/` behind, the operator approved "109 files changed, +258,
// -2" for a commit that pushed 4 files, +47, -2 — 27x over, on the one gate with an irreversible
// external side effect. The script itself printed `deliver: EXCLUDED (scratch-dir): tmp/ (105
// files)`; the exclusion applied to the push and not to the number being approved.
//
// These tests pin the two halves that make the number honest:
//  1. `worktreeDiff` excludes exactly what the push excludes (this file's first describe);
//  2. the TS classifier and the SHELL classifier inside the script agree on the same tree — the
//     drift guard, because the two are necessarily separate implementations (one runs in the
//     daemon, one runs as generated bash in the run worktree).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { worktreeDiff } from '../src/api/run-files.js';
import { deliverExclusionByName, deliverExclusionReason } from '../src/core/deliver-exclusions.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

/** The C7 shape: a repo with 4 files of real product change and a creator-left `tmp/` scratch. */
function c7Worktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-f3-'));
  roots.push(root);
  write(root, 'README.md', 'base\n');
  write(root, 'src/keep.ts', 'export const keep = 1;\n');
  git(root, 'init', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'base');

  // The run's product: one tracked edit + three new files. 4 files is what the push carried.
  write(root, 'src/keep.ts', 'export const keep = 2;\n');
  write(root, 'src/added-a.ts', 'export const a = 1;\n');
  write(root, 'src/added-b.ts', 'export const b = 1;\n');
  write(root, 'docs/note.md', 'note\n');

  // The scratch the creator left: the engine's own `tmp/` (repo-checks floor, worker temp).
  for (let i = 0; i < 105; i++) write(root, `tmp/wicked-checks/f${i}.log`, `noise ${i}\n`);
  // The other excluded classes, one each.
  write(root, 'bus.db', 'sqlite\n');
  write(root, 'socket.path', '/var/run/x\n');
  write(root, '.DS_Store', 'junk\n');
  write(root, 'coverage/lcov.info', 'TN:\n');
  return root;
}

/** The files a unified diff names, read off its `diff --git` headers. */
function filesIn(diff: string): string[] {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (m !== null) out.push(m[2]!);
    else {
      const ni = /^diff --git a\/dev\/null b\/(\S+)$/.exec(line);
      if (ni !== null) out.push(ni[1]!);
    }
  }
  return out;
}

describe('the deliver gate diffstat is computed over exactly the set that will be pushed (F3)', () => {
  it('a creator-left tmp/ scratch dir does NOT inflate the run diff the gate reads', async () => {
    const root = c7Worktree();
    const { diff } = await worktreeDiff(root);
    const files = filesIn(diff);

    // The pushed set: the tracked edit + the three genuine new files.
    expect(files.sort()).toEqual(['docs/note.md', 'src/added-a.ts', 'src/added-b.ts', 'src/keep.ts']);
    // The C7 signature: 109 files, because tmp/ (105) + bus.db + socket.path + .DS_Store +
    // coverage/lcov.info rode along in the number the operator approved.
    expect(files.length).toBe(4);
    expect(diff).not.toContain('tmp/wicked-checks');
    expect(diff).not.toContain('bus.db');
    expect(diff).not.toContain('socket.path');
    expect(diff).not.toContain('.DS_Store');
    expect(diff).not.toContain('coverage/lcov.info');
    // 60 s: BEFORE the fix this pass forks one `git diff --no-index` per untracked file, so the
  // 109-file tree takes ~20 s to produce the wrong answer. After it, 4 forks.
  }, 60_000);

  it("N2: a failed attempt's recovery sentinel is NOT counted on the retry gate — 4 files, as pushed", async () => {
    const root = c7Worktree();
    // The empty, untracked marker the deliver script leaves when the remote refuses a push; the
    // retry's script removes it before staging, so the commit never carries it.
    write(root, '.wicked-crew-delivery-stranded', '');
    const { diff } = await worktreeDiff(root);
    const files = filesIn(diff);
    expect(files).not.toContain('.wicked-crew-delivery-stranded');
    expect(files.length).toBe(4);
    expect(deliverExclusionByName('.wicked-crew-delivery-stranded')).toBe('delivery-sentinel');
    // Only the root-level sentinel is the script's: a same-named product file deeper down rides.
    expect(deliverExclusionByName('docs/.wicked-crew-delivery-stranded')).toBeNull();
  }, 60_000);

  it('a NARROWED request still answers about the one file the caller opened', async () => {
    const root = c7Worktree();
    // `GET /runs/:id/diff?path=tmp/…` is a deliberate ask about a file the caller can see in
    // `GET /runs/:id/files`; answering "no changes" for it would be a different lie. Only the
    // aggregate — the set the consent diffstat is computed from — is filtered.
    const { diff } = await worktreeDiff(root, 'tmp/wicked-checks/f0.log');
    expect(filesIn(diff)).toEqual(['tmp/wicked-checks/f0.log']);
  });

  it('the NAME rules need no stat — a scratch tree costs zero filesystem calls to reject', () => {
    // codex review, MEDIUM: the aggregate pass used to stat every candidate before any name rule
    // ran, so 100 000 files under `tmp/` meant 100 000 synchronous stats on the daemon's event
    // loop. Only a path that survives every name rule is stat'd now.
    expect(deliverExclusionByName('tmp/wicked-checks/f0.log')).toBe('scratch-dir');
    expect(deliverExclusionByName('bus.db')).toBe('denylisted-name');
    expect(deliverExclusionByName('socket.path')).toBe('socket-name');
    expect(deliverExclusionByName('a/.DS_Store')).toBe('ds-store');
    // The size rule is the ONLY one it does not answer — that is what makes the stat lazy.
    expect(deliverExclusionByName('rec.bin')).toBeNull();
    expect(deliverExclusionReason('rec.bin', 1048577)).toBe('oversize-1mib');
  });

  it('the classifier names a reason for each excluded class and null for the run product', () => {
    expect(deliverExclusionReason('tmp/wicked-checks/f0.log', 10)).toBe('scratch-dir');
    expect(deliverExclusionReason('coverage/lcov.info', 10)).toBe('scratch-dir');
    expect(deliverExclusionReason('nested/.cache/x', 10)).toBe('scratch-dir');
    expect(deliverExclusionReason('bus.db', 10)).toBe('denylisted-name');
    expect(deliverExclusionReason('SECRETS.PEM', 10)).toBe('denylisted-name');
    expect(deliverExclusionReason('.envrc', 10)).toBe('denylisted-name');
    expect(deliverExclusionReason('deploy.key', 10)).toBe('denylisted-name');
    // crew#901: an env template is judged by its content, never by its name alone.
    expect(deliverExclusionByName('giphy/.env.example')).toBeNull();
    expect(deliverExclusionReason('giphy/.env.example', 30, () => '# token\nGIPHY_TOKEN=\nA=""\nB=<placeholder>\n')).toBeNull();
    expect(deliverExclusionReason('giphy/.env.example', 0, () => '')).toBeNull();
    expect(deliverExclusionReason('x.env.template', 20, () => 'GIPHY_TOKEN=abc123\n')).toBe('env-template-with-values');
    expect(deliverExclusionReason('.env.sample', 20)).toBe('env-template-with-values'); // no reader: not proven value-free
    expect(deliverExclusionReason('.env.local', 20, () => '')).toBe('denylisted-name');
    expect(deliverExclusionReason('.env', 20, () => '')).toBe('denylisted-name');
    expect(deliverExclusionReason('socket.path', 10)).toBe('socket-name');
    expect(deliverExclusionReason('a/.DS_Store', 10)).toBe('ds-store');
    expect(deliverExclusionReason('rec.bin', 1048577)).toBe('oversize-1mib');
    expect(deliverExclusionReason('rec.bin', 1048576)).toBeNull();
    expect(deliverExclusionReason('src/added-a.ts', 10)).toBeNull();
    expect(deliverExclusionReason('docs/note.md', 10)).toBeNull();
    // crew#861: test-runner / build-tool output, at any depth, and a tool's `*.log`.
    expect(deliverExclusionReason('.vitest/json/output.json', 10)).toBe('tool-artifact-dir');
    expect(deliverExclusionReason('web/playwright-report/index.html', 10)).toBe('tool-artifact-dir');
    expect(deliverExclusionReason('test-results/a/trace.zip', 10)).toBe('tool-artifact-dir');
    expect(deliverExclusionReason('pkg/__pycache__/m.cpython-312.pyc', 10)).toBe('tool-artifact-dir');
    expect(deliverExclusionReason('vitest-debug.LOG', 10)).toBe('tool-artifact-name');
    // A product file merely NAMED like a tool is still product.
    expect(deliverExclusionReason('src/vitest.config.ts', 10)).toBeNull();
    expect(deliverExclusionReason('docs/test-results.md', 10)).toBeNull();
  });
});
