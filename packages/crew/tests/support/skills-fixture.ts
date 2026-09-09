/**
 * Shared scaffolding for the skills-store suites: a store over a TEMP root, seeded from the
 * committed fixture plugin root (tests/fixtures/skills-plugin) or from a mutable COPY of it (the
 * refresh tests edit "upstream"). Nothing here reads the developer's installed plugin, HOME, or
 * `~/.wicked-crew`; no venv is ever provisioned (`noVenv`).
 *
 * Fixture facts the suites rely on:
 *   alpha         router, non-portable (`${CLAUDE_PLUGIN_ROOT}` refs), nested child `alpha/nested`
 *   alpha/nested  fork worker (fork-first: `context: fork` + `user-invocable`), links `../SKILL.md`
 *   beta          module, portable; the ONE registered skill_ref → core; mentions gamma (mandate)
 *   gamma         module, portable; core through beta's mention
 *   delta         module, non-portable (`../gamma/SKILL.md` sibling link)
 *   epsilon       module, non-portable (cwd-relative `python3 scripts/…`)
 */

import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pluginSourceAt, type PluginSource } from '../../src/skills/plugin-source.js';
import { SkillsStore, type SkillsStoreOptions } from '../../src/skills/store.js';
import { noVenv } from '../../src/skills/venv.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The committed, READ-ONLY fixture plugin root. */
export const FIXTURE_PLUGIN = resolve(HERE, '..', 'fixtures', 'skills-plugin');

/** The one workflow-registered skill_ref the fixture catalog answers to. */
export const REGISTERED_REFS: ReadonlySet<string> = new Set(['wicked-garden-beta']);

export const CLOCK = '2026-09-08T12:00:00.000Z';

export interface Scaffold {
  /** The temp base every path below lives under — remove it in afterEach. */
  base: string;
  /** The skills root the store is aimed at. */
  root: string;
  /** A writable copy of the fixture plugin — "upstream" for refresh tests. */
  upstream: string;
  /** A temp HOME for mirror tests. */
  home: string;
  store: SkillsStore;
  warnings: string[];
}

/** A store over a temp root, sourced from a writable COPY of the fixture. */
export function scaffold(overrides: Partial<SkillsStoreOptions> = {}): Scaffold {
  const base = mkdtempSync(join(tmpdir(), 'skills-store-'));
  const upstream = join(base, 'upstream');
  cpSync(FIXTURE_PLUGIN, upstream, { recursive: true });
  const warnings: string[] = [];
  const root = join(base, 'root');
  const store = new SkillsStore({
    root,
    registeredSkillRefs: () => REGISTERED_REFS,
    provisionVenv: noVenv,
    source: (): PluginSource | null => pluginSourceAt(upstream),
    now: () => CLOCK,
    warn: (m) => warnings.push(m),
    ...overrides,
  });
  return { base, root, upstream, home: join(base, 'home'), store, warnings };
}
