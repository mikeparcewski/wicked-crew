/**
 * The state-home PREFLIGHT (wicked-core#411 / crew#497; acceptance findings F-RC1-011, F-RC2-020,
 * F-032/F-033): say at BOOT — and keep saying, on every `GET /diagnostics`, `GET /health` and
 * `POST /runs` — that the daemon's state home holds an entry the worker Read fence cannot classify,
 * instead of letting every governed run discover it at its first worker.
 *
 * # What happened
 *
 * Core's fence over the state home is an EXPLICIT registry (`tests/fixtures/state-home-subtrees.json`,
 * design v3.1 §1): an entry it does not classify refuses the launch by name, fail closed. Right —
 * but it fired at the run's FIRST WORKER, after a planning council and the intake gate, as a failed
 * unit the failure-triage judge labelled "triage judge errored" and escalated with an "Approve to
 * retry" that could only fail again. The daemon booted GREEN: `/health` ok, `/diagnostics` clean,
 * `recentErrors: []`. Twice in one day that cost every governed run on a host — the acceptance rig's
 * `WICKED_WORKFLOWS_DIR=<state home>/workflows` (crew seeds the interactive-* drop-in defs there at
 * boot), and a `skills.fixture-debris-…` directory left in the operator's live state home.
 *
 * # What this module does
 *
 *   1. {@link assertWickedRootsOutsideStateHome} — the BOOT refusal: a `WICKED_*` root variable
 *      pointed INSIDE the state home is a configuration error `serve` refuses with (the rig's
 *      shape). The defaults all live outside; the variables here are the ones whose target crew
 *      writes into (or spawns a bridge that does). Two classes (crew#569): a FENCED variable's
 *      target is also a registered fixture entry, so a pre-existing placement is denied rather
 *      than refusing every launch; a REFUSE-ONLY variable places a file crew itself never seeds
 *      (`WICKED_CREW_SYSTEM_SETTINGS`) — an existing placement is the configuration error the
 *      boot names, there is nothing to fence, so it has no registry row. Paths are compared by
 *      their REAL spelling (the deepest existing ancestor realpath'd — W1 of crew#555): core's
 *      fence canonicalises, so a symlinked state home must not pass here and refuse at intake.
 *   2. {@link StateHomeWatch} — the SURVEY: which state home the fence classifies and every entry it
 *      cannot classify there. Asked of the engine (`Core.preflightStateHome`, the same code the
 *      fence and core's intake refusal run) when the installed addon carries it; on an older addon
 *      crew classifies with its own copy of the registry's names (`state-home-registry.ts`, held
 *      equal to the fixture by test). Re-run on demand — a `readdir` of two directories — so an
 *      entry that appears AFTER boot (the live daemon's debris did) is reported without a restart.
 *   3. {@link stateHomeBlockerBody} — the `POST /runs` 409: the typed error body, naming every entry
 *      and the remedy, until the entries are gone.
 *
 * The daemon does NOT refuse to serve over an unregistered entry (studio must still load and show
 * the blocker); it refuses to LAUNCH. Every message is in operator terms — the entry, the state
 * home, the variable, what to do — and none cites a repository fixture path (F-033).
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { SKILLS_ROOT_NAMES } from '../skills/root-names.js';
import { SKILLS_DIRNAME, SNAPSHOTS_DIRNAME } from '../skills/store.js';
import { isRegisteredStateHomeEntry } from './state-home-registry.js';

/** The remedy every message ends with — spelled once, operator terms, no repository paths. */
export const STATE_HOME_REMEDY =
  'move each entry out of the state home (or point the WICKED_* variable that created it at a ' +
  'directory OUTSIDE the state home) and restart the daemon; a store crew or the engine is meant to ' +
  'keep there must first be added to the state-home registry that wicked-core and wicked-crew ship, ' +
  'in a release of both';

/** The finding kind `GET /diagnostics.stateHome.findings[]` and `GET /health.warnings[]` carry. */
export const STATE_HOME_FINDING_KIND = 'state-home.unregistered';

/** The machine-readable code on the `POST /runs` 409 body. */
export const STATE_HOME_BLOCKER_CODE = 'state_home_unregistered';

/**
 * The `WICKED_*` root variables whose target crew WRITES INTO, with what lands there — the ones an
 * operator can point inside the state home by accident (the rig did). Each default lives outside
 * the state home; the fixture registers the top-level name each would create so a pre-existing
 * placement is fenced, and this module refuses to boot into one.
 *
 * `WICKED_INTERACTIVE_ROOT` is deliberately NOT listed since crew 0.7.35 (D-L7-1 / BC-49): the
 * interactive default now lives INSIDE the state home (`interactive/`, a registered join entry the
 * fence classifies), so the variable may name any path — inside the state home or out.
 */
export const STATE_HOME_ROOT_ENVS: ReadonlyArray<{ variable: string; creates: string; fenced: boolean }> = [
  { variable: 'WICKED_WORKFLOWS_DIR', creates: 'the workflow overlay directory (crew seeds the interactive-* drop-in defs into it at boot)', fenced: true },
  { variable: 'WICKED_STEERING_INBOX_DIR', creates: 'the steering-inbox documents a governed run must READ — unreadable by construction under the fence', fenced: true },
  // crew#569: `PUT /settings` writes this FILE wherever the variable points; under the state home
  // the write lands as an unregistered entry the fence refuses every launch on — while /health
  // stays ok. Refuse-only: crew never seeds the file, so an existing placement is the config
  // error the boot names; nothing to fence, no registry row (rule 6 — one fence change per RC).
  { variable: 'WICKED_CREW_SYSTEM_SETTINGS', creates: 'the system settings file `PUT /settings` writes', fenced: false },
];

/**
 * A `WICKED_*` root variable pointed inside the state home (crew#497). A CONFIGURATION error
 * `serve` refuses with — the same posture as an unshareable bus db or governance store.
 */
export class StateHomePlacementError extends Error {
  readonly variable: string;
  readonly value: string;
  readonly stateHome: string;
  /** The top-level entry the variable's target would create under the state home. */
  readonly entry: string;

  constructor(variable: string, value: string, stateHome: string, entry: string, creates: string) {
    super(
      `${variable}=${value} points inside the daemon's state home ${stateHome} (it would create \`${entry}\` there — ${creates}). ` +
        'The worker Read fence denies every file tool the whole state home except the handed skills snapshot, so a run ' +
        `could never read what lands under \`${entry}\`, and an entry the fence's registry does not classify would refuse EVERY ` +
        `worker launch. Refusing to start. Remedy: point ${variable} at a directory OUTSIDE ${stateHome} (or unset it for the default) and start the daemon again.`,
    );
    this.name = 'StateHomePlacementError';
    this.variable = variable;
    this.value = value;
    this.stateHome = stateHome;
    this.entry = entry;
  }
}

/**
 * The REAL spelling of `p` (W1 residual of crew#555): `resolve` it, realpath the deepest EXISTING
 * ancestor and re-join the rest. `realpathSync` alone throws for a path that does not exist yet —
 * and crew creates `WICKED_WORKFLOWS_DIR` AFTER this preflight (`registerWorkflow` seeds it at
 * boot) — so a naive realpath-else-resolve compares spelled paths again and a symlinked state home
 * boots green, then core's fence (which canonicalises) refuses at intake. Crew's rule ⊇ core's:
 * the one divergence — a symlinked ancestor of a not-yet-existing target — crew refuses at boot
 * where core would refuse at intake once the dir exists; same outcome, earlier. No existing
 * ancestor at all (a bare relative spelling nobody created) ⇒ the resolved spelling.
 */
export function canonicalize(p: string): string {
  const abs = resolve(p);
  let prefix = abs;
  const rest: string[] = [];
  while (!existsSync(prefix)) {
    const parent = dirname(prefix);
    if (parent === prefix) return abs;
    rest.unshift(basename(prefix));
    prefix = parent;
  }
  try {
    return join(realpathSync.native(prefix), ...rest);
  } catch {
    return abs;
  }
}

/** Is `p` inside `root` (or `root` itself)? Pure over the filesystem's spelling of both. */
function isInside(p: string, root: string): boolean {
  const rel = relative(canonicalize(root), canonicalize(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The first path segment of `p` below `root` — the top-level entry it would create there. */
function topLevelUnder(p: string, root: string): string {
  const rel = relative(canonicalize(root), canonicalize(p));
  return rel === '' ? '' : (rel.split(/[\\/]/)[0] as string);
}

/**
 * Refuse a `WICKED_*` root pointed inside `stateHome` (the rig's F-RC1-011 shape). Pure over `env`
 * so the boot and the tests spell the rule once; throws {@link StateHomePlacementError} naming the
 * variable, its value, the entry it would create and the remedy. An unset or empty variable is
 * fine (the default lives outside the state home). A FILE value's entry is its first segment
 * below the state home (the file itself when placed at the top level — crew#569).
 */
export function assertWickedRootsOutsideStateHome(env: NodeJS.ProcessEnv, stateHome: string): void {
  for (const { variable, creates } of STATE_HOME_ROOT_ENVS) {
    const value = env[variable];
    if (value === undefined || value === '') continue;
    if (!isInside(value, stateHome)) continue;
    const entry = topLevelUnder(value, stateHome);
    throw new StateHomePlacementError(variable, value, stateHome, entry === '' ? '(the state home itself)' : entry, creates);
  }
}

/** One entry the registry cannot classify (mirrors core's `UnregisteredEntry`). */
export interface UnregisteredStateHomeEntry {
  name: string;
  path: string;
  /** `state-home` — a top-level entry; `skills-root` — a child of `<state home>/skills` that is
   *  neither the read slot nor a registered denied child. */
  level: 'state-home' | 'skills-root';
}

export interface StateHomeFinding {
  kind: typeof STATE_HOME_FINDING_KIND;
  severity: 'error';
  message: string;
}

/**
 * What `GET /diagnostics` reports as `stateHome` (additive; the next `wicked-crew-api-types` cut
 * declares it). Honest throughout: a field the daemon cannot answer is `null`, never invented.
 */
export interface StateHomeHealth {
  /** The state home surveyed (the fence's, derived from the handed snapshot; else the db parent). */
  stateHome: string | null;
  /** `snapshot` — derived from the handed `WICKED_SKILLS_SNAPSHOT` (the directory the fence
   *  classifies); `db` — the core db's parent, surveyed for information when no snapshot is handed. */
  derivedFrom: 'snapshot' | 'db' | null;
  /** Who classified: the engine (`Core.preflightStateHome`), crew's own registry copy on an older
   *  addon, or nobody (no db path and no snapshot — a library boot). */
  source: 'engine' | 'crew' | 'unavailable';
  unregistered: UnregisteredStateHomeEntry[];
  /** `true` exactly when a HANDED snapshot derives a state home with unregistered entries — the
   *  condition core's intake fence refuses every launch on, and what `POST /runs` answers 409 for. */
  refusesLaunches: boolean;
  findings: StateHomeFinding[];
  remedy: string;
  /** Why the survey could not run, or `null`. */
  error: string | null;
  /** When this survey was taken (unix ms). */
  checkedAt: number;
}

/** The engine's `Core.preflightStateHome` static, as the adapter exposes it (or `null` on an older addon). */
export type EnginePreflight = (snapshotPath: string | null, dbPath: string) => Promise<string>;

/** The JSON shape `Core.preflightStateHome` resolves to (wicked-core `StateHomePreflight`, camelCase). */
interface EnginePreflightJson {
  stateHome: string | null;
  derivedFrom: 'snapshot' | 'db' | null;
  unregistered: UnregisteredStateHomeEntry[];
  refusesLaunches: boolean;
  error: string | null;
  remedy: string;
}

/** Does a skills-root child name match one of the store's registered patterns (exact or `stem*`)? */
function skillsChildRegistered(name: string): boolean {
  if (name === SNAPSHOTS_DIRNAME) return true;
  return SKILLS_ROOT_NAMES.some(({ pattern }) => {
    if (pattern.includes('/')) return false; // a pattern below the slot, not a root child
    return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
  });
}

/**
 * Crew's own survey of `stateHome` — the fallback classification for an addon without
 * `Core.preflightStateHome`: every top-level entry `state-home-registry.ts` does not classify, and
 * every child of the skills root that is neither the read slot nor a registered name
 * (`skills/root-names.ts`). Sorted as listed. Throws when a directory cannot be listed.
 */
export function surveyStateHome(stateHome: string): UnregisteredStateHomeEntry[] {
  const out: UnregisteredStateHomeEntry[] = [];
  for (const name of readdirSync(stateHome).sort()) {
    if (!isRegisteredStateHomeEntry(name)) {
      out.push({ name, path: join(stateHome, name), level: 'state-home' });
    }
  }
  const skillsDir = join(stateHome, SKILLS_DIRNAME);
  let skillsIsDir = false;
  try {
    skillsIsDir = lstatSync(skillsDir).isDirectory();
  } catch {
    skillsIsDir = false; // absent, or a link — nothing to classify here (the launch refuses a link as a kind mismatch)
  }
  if (skillsIsDir) {
    for (const name of readdirSync(skillsDir).sort()) {
      if (!skillsChildRegistered(name)) {
        out.push({ name, path: join(skillsDir, name), level: 'skills-root' });
      }
    }
  }
  return out;
}

/**
 * The state home a handed snapshot derives (core's `state_home::of_snapshot`, by SHAPE alone):
 * `<state home>/skills/snapshots/<gen>` — three components up when the parent is the read slot,
 * the grandparent the skills root and the last component a generation (decimal digits). `null`
 * for any other spelling.
 */
export function stateHomeOfSnapshot(snapshotPath: string): string | null {
  const gen = snapshotPath.split(/[\\/]/).filter((s) => s !== '').at(-1) ?? '';
  if (!/^\d+$/.test(gen)) return null;
  const slot = dirname(snapshotPath);
  const skills = dirname(slot);
  if (slot.split(/[\\/]/).at(-1) !== SNAPSHOTS_DIRNAME) return null;
  if (skills.split(/[\\/]/).at(-1) !== SKILLS_DIRNAME) return null;
  const home = dirname(skills);
  return home === skills ? null : home;
}

function findingsFor(unregistered: UnregisteredStateHomeEntry[], stateHome: string | null, refuses: boolean): StateHomeFinding[] {
  return unregistered.map((u) => ({
    kind: STATE_HOME_FINDING_KIND,
    severity: 'error' as const,
    message:
      `\`${u.name}\`${u.level === 'skills-root' ? ' (under the skills root)' : ''} at ${u.path} is not in the state-home registry, so the worker Read fence cannot classify it` +
      (refuses
        ? ` — EVERY worker launch from this daemon is refused until it is gone (state home ${stateHome ?? '?'})`
        : ` — the fence would refuse every worker launch the moment a skills snapshot is handed from this state home (${stateHome ?? '?'})`) +
      `. Remedy: ${STATE_HOME_REMEDY}`,
  }));
}

export interface StateHomeWatchOptions {
  /** The core db the engine was spawned over (`CoreAdapter.dbPath`), or `null` (a stub route set). */
  dbPath: string | null;
  /** What `WICKED_SKILLS_SNAPSHOT` is exported as right now — read at each refresh so a later
   *  publish is judged against the generation it hands. */
  snapshotPath: () => string | null;
  /** The engine binding, or `null` on an addon without it (crew classifies then). */
  engine: EnginePreflight | null;
  /** Crew's fallback survey — injectable for tests. */
  survey?: (stateHome: string) => UnregisteredStateHomeEntry[];
  now?: () => number;
}

/**
 * The daemon's live state-home classification: {@link refresh} re-runs the survey (engine first,
 * crew's copy on an older addon) and {@link last} is the most recent answer — what the routes
 * report and gate on. Never throws: a survey that cannot run is an answer with `error` set.
 */
export class StateHomeWatch {
  private readonly opts: StateHomeWatchOptions;
  private lastHealth: StateHomeHealth;

  constructor(opts: StateHomeWatchOptions) {
    this.opts = opts;
    this.lastHealth = {
      stateHome: null,
      derivedFrom: null,
      source: 'unavailable',
      unregistered: [],
      refusesLaunches: false,
      findings: [],
      remedy: STATE_HOME_REMEDY,
      error: null,
      checkedAt: (opts.now ?? Date.now)(),
    };
  }

  /** The most recent survey (the boot's until {@link refresh} runs again). */
  get last(): StateHomeHealth {
    return this.lastHealth;
  }

  /** Re-survey now and return the answer. */
  async refresh(): Promise<StateHomeHealth> {
    const now = (this.opts.now ?? Date.now)();
    const snapshotPath = this.opts.snapshotPath();
    const dbPath = this.opts.dbPath;
    if (snapshotPath === null && dbPath === null) {
      this.lastHealth = { ...this.lastHealth, source: 'unavailable', checkedAt: now };
      return this.lastHealth;
    }
    let health: StateHomeHealth;
    if (this.opts.engine !== null) {
      health = await this.fromEngine(this.opts.engine, snapshotPath, dbPath ?? ':memory:', now);
    } else {
      health = this.fromCrew(snapshotPath, dbPath, now);
    }
    this.lastHealth = health;
    return health;
  }

  private async fromEngine(engine: EnginePreflight, snapshotPath: string | null, dbPath: string, now: number): Promise<StateHomeHealth> {
    try {
      const parsed = JSON.parse(await engine(snapshotPath, dbPath)) as Partial<EnginePreflightJson>;
      const unregistered = Array.isArray(parsed.unregistered) ? parsed.unregistered : [];
      const stateHome = typeof parsed.stateHome === 'string' ? parsed.stateHome : null;
      const refuses = parsed.refusesLaunches === true;
      return {
        stateHome,
        derivedFrom: parsed.derivedFrom === 'snapshot' || parsed.derivedFrom === 'db' ? parsed.derivedFrom : null,
        source: 'engine',
        unregistered,
        refusesLaunches: refuses,
        findings: findingsFor(unregistered, stateHome, refuses),
        remedy: typeof parsed.remedy === 'string' && parsed.remedy !== '' ? parsed.remedy : STATE_HOME_REMEDY,
        error: typeof parsed.error === 'string' ? parsed.error : null,
        checkedAt: now,
      };
    } catch (err) {
      // The engine could not answer (a rejected task, malformed JSON): say so and fall back to
      // crew's own classification rather than report a clean state home nobody checked.
      const crew = this.fromCrew(snapshotPath, this.opts.dbPath, now);
      return { ...crew, error: `engine preflight failed (${err instanceof Error ? err.message : String(err)})${crew.error === null ? '' : `; ${crew.error}`}` };
    }
  }

  private fromCrew(snapshotPath: string | null, dbPath: string | null, now: number): StateHomeHealth {
    let stateHome: string | null = null;
    let derivedFrom: 'snapshot' | 'db' | null = null;
    let error: string | null = null;
    if (snapshotPath !== null) {
      stateHome = stateHomeOfSnapshot(snapshotPath);
      if (stateHome === null) {
        error = `the handed snapshot \`${snapshotPath}\` does not have the shape <state home>/skills/snapshots/<gen>, so no state home derives from it`;
      } else {
        derivedFrom = 'snapshot';
      }
    } else if (dbPath !== null && dbPath !== ':memory:' && !dbPath.includes('://')) {
      stateHome = dirname(canonicalize(dbPath));
      derivedFrom = 'db';
    }
    let unregistered: UnregisteredStateHomeEntry[] = [];
    if (stateHome !== null) {
      try {
        unregistered = (this.opts.survey ?? surveyStateHome)(stateHome);
      } catch (err) {
        error = `cannot list ${stateHome} to classify it (${err instanceof Error ? err.message : String(err)})`;
      }
    }
    const refuses = derivedFrom === 'snapshot' && unregistered.length > 0;
    return {
      stateHome,
      derivedFrom,
      source: 'crew',
      unregistered,
      refusesLaunches: refuses,
      findings: findingsFor(unregistered, stateHome, refuses),
      remedy: STATE_HOME_REMEDY,
      error,
      checkedAt: now,
    };
  }
}

/** The `POST /runs` 409 body while the state home refuses launches: the typed error, as fields. */
export function stateHomeBlockerBody(health: StateHomeHealth): {
  error: string;
  code: typeof STATE_HOME_BLOCKER_CODE;
  stateHome: string | null;
  unregistered: UnregisteredStateHomeEntry[];
  remedy: string;
} {
  const named = health.unregistered
    .map((u) => `\`${u.name}\`${u.level === 'skills-root' ? ' (under the skills root)' : ''}`)
    .join(', ');
  return {
    error:
      `configuration error: the daemon's state home ${health.stateHome ?? '?'} holds ${health.unregistered.length} ` +
      `${health.unregistered.length === 1 ? 'entry' : 'entries'} the worker Read fence cannot classify — ${named} — so every worker ` +
      `launch from this daemon would be refused; the run was not started. Remedy: ${health.remedy}`,
    code: STATE_HOME_BLOCKER_CODE,
    stateHome: health.stateHome,
    unregistered: health.unregistered,
    remedy: health.remedy,
  };
}

/** Does an engine launch rejection carry core's own intake refusal (`StateHomeConfigError`)? */
export function isEngineStateHomeRefusal(message: string): boolean {
  return /configuration error: the daemon's state home .* the worker Read fence cannot classify/.test(message);
}
