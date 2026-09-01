// Properties the test suite itself must hold for its results to mean anything (crew#396) —
// crew's mirror of wicked-core's tests/harness_hygiene.rs.
//
// The disease: crew's integration tests boot the REAL engine (CoreAdapter → Core.spawn/spawnStub;
// the Rust actor reads `process.env` at spawn time), and an un-armed engine writes to the
// OPERATOR's real home — junk NDJSON appended to `~/.something-wicked/wicked-apps/
// emit-outbox.ndjson` (227MB accumulated), `~/.wicked-worker/claude/settings.json` rewritten with
// the deny fence (hooks/plugins/commands deleted) on every worker spawn. The cure is ONE shared
// arming point, `tests/setup/hermetic-home.ts`, evaluated before any test code runs.
//
// These guards make the cure self-defending: a NEW test that boots the engine is armed by the
// setup file without knowing it exists, and every way the arming can silently rot — the setup
// file dropped from vitest.config.ts, the env unset at daemon boot, a child spawned with a
// stripped env — fails HERE, loudly, naming the fix.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');

/** True when `p` is inside `root` (or is `root`). */
function isInside(p: string, root: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Assert one armed env var: present, absolute, under the OS temp root, never under `realDir`. */
function expectArmed(name: string, realDir: string): string {
  const armed = process.env[name];
  expect(
    armed,
    `${name} is not set. Every vitest process must be armed by tests/setup/hermetic-home.ts ` +
      `(registered in vitest.config.ts setupFiles) BEFORE any test code runs — un-armed, ` +
      `test-spawned engines write into the operator's real ${realDir} (crew#396).`,
  ).toBeTruthy();
  expect(isAbsolute(armed as string), `${name} must be an absolute path, got: ${armed}`).toBe(true);
  expect(
    isInside(armed as string, realDir),
    `${name} (${armed}) points INTO the operator's real ${realDir} — the arming exists to point ` +
      `AWAY from it (crew#396).`,
  ).toBe(false);
  expect(
    isInside(armed as string, tmpdir()),
    `${name} (${armed}) is not under the OS temp root ${tmpdir()} — the hermetic base must be ` +
      `disposable per process (tests/setup/hermetic-home.ts).`,
  ).toBe(true);
  return armed as string;
}

describe('hermetic env arming (tests/setup/hermetic-home.ts)', () => {
  it('the emit-outbox override is armed away from the real ~/.something-wicked', () => {
    expectArmed('WICKED_APPS_EMIT_DEADLETTER', join(homedir(), '.something-wicked'));
  });

  it('the worker-config home is armed away from the real ~/.wicked-worker', () => {
    expectArmed('WICKED_WORKER_HOME', join(homedir(), '.wicked-worker'));
  });

  it('the bus data dir is armed away from the real ~/.something-wicked', () => {
    expectArmed('WICKED_BUS_DATA_DIR', join(homedir(), '.something-wicked'));
  });

  it('the system settings file is armed away from the real ~/.config/wicked-core', () => {
    // One path segment, not `join('.config', '<name>')` — the core-checkout audit
    // (core-checkout-policy.test.ts) fires on the quoted checkout name, and this is the
    // engine's CONFIG dir, not the sibling checkout it polices.
    expectArmed('WICKED_CREW_SYSTEM_SETTINGS', join(homedir(), '.config/wicked-core'));
  });

  it('the audit log and project-graph root are armed away from the real ~/.wicked-crew', () => {
    expectArmed('WICKED_CREW_AUDIT_LOG', join(homedir(), '.wicked-crew'));
    expectArmed('WICKED_CREW_PROJECT_GRAPH_ROOT', join(homedir(), '.wicked-crew'));
  });

  it('the setup file is registered in vitest.config.ts (the arming has no other entry point)', () => {
    const config = readFileSync(join(PKG_ROOT, 'vitest.config.ts'), 'utf8');
    expect(
      config.includes('tests/setup/hermetic-home.ts'),
      'vitest.config.ts no longer lists tests/setup/hermetic-home.ts in setupFiles — without it ' +
        'every test-spawned engine writes into the operator\'s real home (crew#396).',
    ).toBe(true);
  });
});

describe('the daemon boot unset window (applyWorkerConfigRoot, crew#396)', () => {
  // The regression this pins: `createServer` applies the persisted `worker_config_root` at boot,
  // and an EMPTY settings store used to DELETE `WICKED_WORKER_HOME` — un-arming the process after
  // the harness armed it, so every later worker spawn re-sanitized the operator's REAL
  // ~/.wicked-worker. Every integration test boots exactly this way (fresh temp db, no persisted
  // root); if this test fails, so does the whole hermetic guarantee.
  let dir: string;

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('booting over an empty settings store KEEPS the armed worker home', async () => {
    const armed = process.env['WICKED_WORKER_HOME'];
    expect(armed).toBeTruthy();

    dir = mkdtempSync(join(tmpdir(), 'hygiene-boot-'));
    const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    adapter.getSettings = async () => ({ graphNodeLimit: 150 }); // no worker_config_root persisted
    const app = await createServer(adapter, {
      projectEvents: { disabled: true },
      auditPath: join(dir, 'audit.log'),
      studioRoot: join(dir, 'no-studio'),
    });
    try {
      expect(
        process.env['WICKED_WORKER_HOME'],
        'createServer over an empty settings store un-armed WICKED_WORKER_HOME — the ' +
          'applyWorkerConfigRoot fallback (src/api/seat-signin.ts BOOT_WORKER_HOME) must restore ' +
          'the boot-time env, or every worker spawn after boot lands in the real ~/.wicked-worker ' +
          '(crew#396).',
      ).toBe(armed);
    } finally {
      await app.close();
      adapter.close();
    }
  });
});

// ── Source scan: children must inherit the arming ────────────────────────────────────────────────
//
// Arming `process.env` covers the in-process engine and every child spawned WITHOUT an `env:`
// option (Node children inherit the parent env by default — that is how mcp-server.test.ts's dist
// CLI child stays hermetic). The one way a new test can undo it is spawning a child with a
// STRIPPED env: `spawn(cmd, { env: { ONLY: 'this' } })` drops the arming, and if that child boots
// the engine it writes into the real home again. So: any `env:` handed to a child-process API in
// the tests tree must either spread `...process.env` or re-state the arming explicitly.

/** How much source to inspect after a spawn-ish call before deciding what it passes. */
const WINDOW = 500;

/** Fewest spawn sites the scan must find before its verdict means anything (currently ~9). */
const MIN_SPAWN_SITES = 5;

function testSourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...testSourcesUnder(p));
    } else if (/\.(test\.)?[mc]?ts$/.test(entry) || entry.endsWith('.mjs')) {
      out.push(p);
    }
  }
  return out;
}

describe('test-spawned children keep the hermetic env (source scan)', () => {
  it('every child-process env: override spreads process.env or re-states the arming', () => {
    const sources = testSourcesUnder(join(PKG_ROOT, 'tests')).filter(
      // This file quotes the very patterns it looks for, so scanning it flags itself.
      (p) => !p.endsWith('harness-hygiene.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(10);

    let spawnSites = 0;
    const stripped: string[] = [];

    for (const path of sources) {
      const src = readFileSync(path, 'utf8');
      const file = relative(PKG_ROOT, path);
      // Bare-identifier child_process calls only (`spawn(`, `fork(`, `execFile(`) — the way this
      // suite invokes them. Member calls like `regex.exec(` or `pool.spawn(` are other APIs, and
      // identifier tails like `respawn(` are not calls to these; both are excluded by requiring a
      // non-word, non-dot character before the match.
      for (const call of ['spawn(', 'fork(', 'execFile(']) {
        for (let idx = src.indexOf(call); idx !== -1; idx = src.indexOf(call, idx + 1)) {
          const before = idx === 0 ? ' ' : src[idx - 1]!;
          if (/[\w.$]/.test(before)) continue;
          spawnSites += 1;
          const window = src.slice(idx, idx + WINDOW);
          if (!window.includes('env:')) continue; // inherits the parent env — armed by setup
          const keepsArming =
            window.includes('...process.env') ||
            (window.includes('WICKED_APPS_EMIT_DEADLETTER') && window.includes('WICKED_WORKER_HOME'));
          if (!keepsArming) {
            const line = src.slice(0, idx).split('\n').length;
            stripped.push(`${file}:${line}`);
          }
        }
      }
    }

    expect(
      spawnSites,
      `scanned only ${spawnSites} child-process call sites — the scan is not finding them, so a ` +
        `pass here would be vacuous`,
    ).toBeGreaterThanOrEqual(MIN_SPAWN_SITES);
    expect(
      stripped,
      `these test child-process calls pass an env: that DROPS the hermetic arming ` +
        `(tests/setup/hermetic-home.ts) — a child that boots the engine with that env writes into ` +
        `the operator's real ~/.something-wicked and ~/.wicked-worker (crew#396). Spread ` +
        `\`...process.env\` into the env, or re-state WICKED_APPS_EMIT_DEADLETTER and ` +
        `WICKED_WORKER_HOME explicitly: ${JSON.stringify(stripped)}`,
    ).toEqual([]);
  });
});
