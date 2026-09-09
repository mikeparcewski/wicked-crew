// Design v3.2 §1 — wicked's skill management never writes into the user's own CLI configuration.
//
// The v3 additive mirror (portable skills copied into `~/.codex/skills`, `~/.pi/agent/skills`,
// `~/.config/opencode/skills`, `~/.copilot/skills`; an adoption ledger over the user's entries) is
// WITHDRAWN. This suite is the fence: with HOME pointed at a fake home holding populated CLI dirs,
// the whole store lifecycle — seed → publish → enable/disable → edit → reset → replace → add →
// publish → refresh → analyze — leaves every byte under that home (and under the plugin source)
// exactly as it was, and creates nothing under the temp base but the skills root itself. A static
// guard closes the other door: no skills module but the read-only plugin discovery touches
// `homedir()` at all.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_SRC = resolve(HERE, '..', 'src', 'skills');

/** The user-level CLI locations wicked must never write (design v3.2 §1), relative to HOME. */
const USER_CLI_DIRS: ReadonlyArray<ReadonlyArray<string>> = [
  ['.codex', 'skills'],
  ['.pi', 'agent', 'skills'],
  ['.copilot', 'skills'],
  ['.config', 'opencode', 'skills'],
  ['.claude', 'plugins', 'cache', 'wicked-garden', 'wicked-garden', '1.0.0', 'skills'],
];

/** A byte-exact fingerprint of a tree: every entry's type, mode, size, mtime, link target, content digest. */
function fingerprint(root: string): string {
  const lines: string[] = [];
  const visit = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, entry.name);
      const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const st = lstatSync(abs);
      if (entry.isSymbolicLink()) lines.push(`L ${r} -> ${readlinkSync(abs)}`);
      else if (entry.isDirectory()) {
        lines.push(`D ${r} ${st.mode & 0o777}`);
        visit(abs, r);
      } else lines.push(`F ${r} ${st.mode & 0o777} ${st.size} ${st.mtimeMs} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  visit(root, '');
  return lines.join('\n');
}

let s: Scaffold;
const savedHome = process.env['HOME'];
const savedProfile = process.env['USERPROFILE'];

beforeEach(() => {
  s = scaffold();
  for (const rel of USER_CLI_DIRS) {
    const dir = join(s.home, ...rel);
    mkdirSync(join(dir, 'wicked-garden-beta'), { recursive: true });
    writeFileSync(join(dir, 'wicked-garden-beta', 'SKILL.md'), "---\nname: wicked-garden-beta\n---\n\nthe user's own copy\n");
    mkdirSync(join(dir, 'something-else'), { recursive: true });
    writeFileSync(join(dir, 'something-else', 'SKILL.md'), '---\nname: something-else\n---\n');
  }
  writeFileSync(join(s.home, '.claude', 'settings.json'), '{"theme":"dark"}\n');
  // Point HOME at the fake home for the duration: `os.homedir()` reads it on POSIX (USERPROFILE on Windows).
  process.env['HOME'] = s.home;
  process.env['USERPROFILE'] = s.home;
  expect(homedir()).toBe(s.home);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  if (savedProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = savedProfile;
  removeScratch(s.base);
});

describe('no code path writes outside the skills root (design v3.2 §1)', () => {
  it('seed → publish → enable/disable → edit → reset → replace → add → publish → refresh → analyze leave HOME and the plugin source byte-identical, and create nothing but the root', async () => {
    const homeBefore = fingerprint(s.home);
    const upstreamBefore = fingerprint(s.upstream);

    s.store.seed();
    let r = (await s.store.publish(1)).revision;
    const off = s.store.disable('wicked-garden-delta', r);
    expect(off.verdict).toBe('clear');
    const on = s.store.enable('wicked-garden-delta', off.revision);
    expect(on.verdict).toBe('clear');
    const edit = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nedited\n', on.revision);
    expect(edit.verdict).toBe('clear');
    const reset = s.store.reset('wicked-garden-gamma', edit.revision);
    expect(reset.verdict).toBe('clear');
    const replaced = s.store.replace('wicked-garden-alpha', { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n\nportable now\n' }, reset.revision);
    expect(replaced.verdict).toBe('clear');
    const added = s.store.add('wicked-garden-zeta', { 'SKILL.md': '---\nname: wicked-garden-zeta\n---\n\nnew\n' }, replaced.revision);
    expect(added.verdict).toBe('clear');
    const support = s.store.writeSupport('scripts/_python.sh', '#!/bin/sh\nexec python3 "$@"\n', added.revision);
    expect(support.verdict).toBe('warnings');
    const published = await s.store.publish(support.revision);
    expect(published.verdict).toBe('clear');
    r = published.revision;
    expect(s.store.refreshBaseline(r).verdict).toBe('clear');
    expect(s.store.analyze().verdict).toBe('clear');
    s.store.reapStale();

    expect(fingerprint(s.home)).toBe(homeBefore);
    expect(fingerprint(s.upstream)).toBe(upstreamBefore);
    // The temp base holds exactly: the fake home, the skills root, the upstream copy — nothing appeared beside them.
    expect(readdirSync(s.base).sort()).toEqual(['home', 'root', 'upstream']);
    // …and the copilot view the non-Claude delivery uses lives INSIDE the snapshot, not in the home.
    const current = s.store.currentSnapshot();
    expect(current).not.toBeNull();
    expect(readdirSync(join((current as { path: string }).path, 'views'))).toEqual(['copilot']);
  });

  it('static guard: no skills module but the read-only plugin discovery touches homedir()', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SKILLS_SRC).filter((f) => f.endsWith('.ts')).sort()) {
      if (file === 'plugin-source.ts') continue; // reads `<home>/.claude/plugins/cache` to DISCOVER the installed plugin; never writes
      const text = readFileSync(join(SKILLS_SRC, file), 'utf8');
      if (/\bhomedir\b/.test(text)) offenders.push(file);
      if (/\.codex|\.pi\/agent|\.copilot\/skills|opencode\/skills/.test(text.replace(/^\s*(\/\/|\*|\/\*\*?).*$/gm, ''))) offenders.push(`${file} (names a user CLI dir outside a comment)`);
    }
    expect(offenders).toEqual([]);
  });
});
