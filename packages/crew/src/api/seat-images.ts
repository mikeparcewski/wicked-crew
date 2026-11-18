/**
 * The seat images row of the Nerve Center (`GET /system` infra key `seat_images`) and its one fix,
 * "Rebuild seat images" (`POST /system/seat-images/rebuild`).
 *
 * Governed seats run in container images the engine builds (wicked-core `container_floor.rs`). A
 * desktop runtime that also runs Kubernetes (Rancher Desktop's k3s) has a kubelet that deletes every
 * image no container references once the VM's image disk passes 85 % (`imageGCHighThresholdPercent`).
 * The engine keeps each seat image with a stopped holder container, so the kubelet cannot delete it
 * (wicked-core#1225); this row says whether the images are there and held, and warns while the VM
 * disk climbs toward that line, BEFORE the cleanup runs.
 *
 * The reading is `wicked-core seat-image status --json` (the engine owns the image tags), run per
 * request under the probe's bound: never a cached "ok".
 */
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

import { execCapped } from '../core/exec.js';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';
import type { SystemInfraRow } from '../core/types.js';
import { loginDetail } from './seat-container-login.js';
import { homeless } from './seat-standing.js';
import { infraRow, PROBE_TIMEOUT_MS, settleWithin } from './system-snapshot.js';
import { plainRuntimeCause } from './ui-text.js';

/** VM disk used, %, from which the row warns (the kubelet starts deleting unheld images at 85). */
export const SEAT_DISK_WARN_PCT = 75;
/** VM disk used, %, from which the row is down: the runtime is close to refusing writes. */
export const SEAT_DISK_DOWN_PCT = 92;
/** How long a rebuild may run: the engine bounds each image build (30 min), so this only catches
 *  an engine that stopped answering. */
export const REBUILD_TIMEOUT_MS = 4 * 60 * 60_000;
/** Lines of a rebuild's output kept for the row. */
const TAIL_LINES = 6;
const LINE_MAX = 240;

export interface SeatImageEntry {
  image: string;
  present: boolean;
  /** Held against image cleanup; `false` when the engine prints no `held` (a current engine holds nothing). */
  held: boolean;
}

export interface SeatImageSeat extends SeatImageEntry {
  cli: string;
  operatorImage: boolean;
}

/** `wicked-core seat-image status --json`. */
export interface SeatImageStatus {
  runtime: string;
  base: SeatImageEntry | null;
  baseRecipe: boolean;
  holdSupported: boolean;
  /** (crew#1526) The engine says anything about holding (`holdSupported` or a `held`); a current engine does not. */
  holdReported: boolean;
  floor: SeatImageEntry;
  seats: SeatImageSeat[];
  disk: { totalBytes: number; availBytes: number; usedPct: number } | null;
  /** (crew#1526) The engine prints a `disk` (read or `null`); a current engine reads no disk. */
  diskReported: boolean;
  imageGcHighPct: number;
}

/** Only the fields this row reads, picked one by one (nothing else the engine prints rides along). `image` and
 *  `present` are required; `held` is optional (crew#1526: the engine's `ImageState` is `{image, present}` since it
 *  stopped holding images, wicked-core `container_floor.rs`), and absent reads as not held. */
function entry(v: unknown): SeatImageEntry | null {
  const o = v as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object' || typeof o['image'] !== 'string' || typeof o['present'] !== 'boolean') return null;
  return { image: o['image'], present: o['present'], held: o['held'] === true };
}

const printsHeld = (v: unknown): boolean => typeof (v as Record<string, unknown> | null)?.['held'] === 'boolean';

/** Parse the engine's answer; `null` when it is not the shape (an older engine prints text). */
export function parseSeatImageStatus(stdout: string): SeatImageStatus | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const o = v as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object' || !Array.isArray(o['seats'])) return null;
  const floor = entry(o['floor']);
  if (floor === null) return null;
  const seats: SeatImageSeat[] = [];
  for (const s of o['seats'] as unknown[]) {
    const e = entry(s);
    const cli = (s as { cli?: unknown } | null)?.cli;
    if (e !== null && typeof cli === 'string') seats.push({ cli, ...e, operatorImage: (s as { operatorImage?: unknown }).operatorImage === true });
  }
  const d = o['disk'] as Record<string, unknown> | null | undefined;
  const disk =
    d !== null && typeof d === 'object' && typeof d['totalBytes'] === 'number' && typeof d['availBytes'] === 'number' && typeof d['usedPct'] === 'number'
      ? { totalBytes: d['totalBytes'], availBytes: d['availBytes'], usedPct: d['usedPct'] }
      : null;
  return {
    runtime: typeof o['runtime'] === 'string' ? homeless(o['runtime']) : '',
    base: entry(o['base']),
    baseRecipe: o['baseRecipe'] === true,
    // An engine that prints `held` but not `holdSupported` held on docker only: supported. One that prints neither
    // (the current engine) holds nothing, and says nothing about it (crew#1526).
    holdSupported: typeof o['holdSupported'] === 'boolean' ? o['holdSupported'] : printsHeld(o['floor']),
    holdReported: typeof o['holdSupported'] === 'boolean' || printsHeld(o['floor']),
    floor,
    seats,
    disk,
    diskReported: Object.hasOwn(o, 'disk'),
    imageGcHighPct: typeof o['imageGcHighPct'] === 'number' ? o['imageGcHighPct'] : 85,
  };
}

/** What a rebuild is doing, or did last. */
export interface RebuildState {
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** The engine's exit code; `null` while running. */
  rc: number | null;
  /** The last lines it printed (bounded, home paths spelled `~`), live while it runs. */
  tail: string[];
  /** The last line that reads as a failure (`failed`, `error`, `denied`…), kept apart from the
   *  tail so a later seat's success never stands in for it; `null` when none. */
  error: string | null;
  clis: string[];
}

export interface SeatImagesProbeInput {
  containerFloor: boolean;
  /** The roster's seat CLIs; `null` when the roster could not be read. */
  clis: string[] | null;
  /** The roster CLIs no seat of which is signed in (operator 2026-11-05: a CLI someone never set up is
   *  not a problem), read AFTER the status settles (the route also waits for the broker's sign-in refresh). Their
   *  images are not needed until one is signed in: a missing one is said, never degraded. */
  idle?: () => readonly string[] | Promise<readonly string[]>;
  /** A fresh `seat-image status --json` read. */
  status: () => Promise<SeatImageStatus | null>;
  /** The rebuild, read AFTER the status settles (a rebuild that ends during the read is seen). */
  rebuild: () => RebuildState | null;
  timeoutMs?: number;
}

/** The CLIs none of whose roster seats is signed in (`claude` and `claude#2` are one CLI's seats). */
export function idleClis(roster: ReadonlyArray<{ key: string; auth?: string; signed_in?: boolean | null }>): string[] {
  const out = (r: { auth?: string; signed_in?: boolean | null }): boolean => r.auth === 'signed_out' || (r.auth === undefined && r.signed_in === false);
  const cliOf = (k: string): string => k.split('#', 1)[0] ?? k;
  const clis = [...new Set(roster.map((r) => cliOf(r.key)))];
  return clis.filter((c) => roster.filter((r) => cliOf(r.key) === c).every(out));
}

/** Why a seat's image cannot be had: `operator` (the operator names it and the engine never builds it), `base`
 *  (the engine builds it on the operator's base, which is gone with no recipe to rebuild it). */
export interface UnbuildableSeatImage {
  kind: 'operator' | 'base';
  /** The cause and its remedy, in the words the roster and the row carry. */
  reason: string;
}

/**
 * (crew#1097) The ONE rule for a seat image that is missing and cannot be built: the `seat_images` row reads `down`
 * for these, and the roster marks their seats unusable so the engine keeps work off them. CLI → why; a seat whose
 * image is present, or that the next unit builds, is absent.
 */
export function unbuildableSeatImages(st: SeatImageStatus): Map<string, UnbuildableSeatImage> {
  const out = new Map<string, UnbuildableSeatImage>();
  const baseUnbuildable = st.base !== null && !st.base.present && !st.baseRecipe;
  for (const s of st.seats) {
    if (s.present) continue;
    if (s.operatorImage) {
      out.set(s.cli, {
        kind: 'operator',
        reason: `seat image cannot be had: the operator's own image ${s.image} is missing (WICKED_SEAT_IMAGE_${s.cli.toUpperCase()}; the engine never builds it); pull or build it`,
      });
    } else if (baseUnbuildable) {
      out.set(s.cli, {
        kind: 'base',
        reason: `seat image cannot be built: the seat base ${st.base!.image} is missing and nothing can rebuild it; rebuild it or unset WICKED_SEAT_BASE_IMAGE`,
      });
    }
  }
  return out;
}

/** `wicked-core seat-image status --json`, through the engine CLI `coreExe` names (the row, the rebuild and the
 *  roster's reading all read it this way). */
export function seatImageStatusVia(coreExe: () => string | null): () => Promise<SeatImageStatus | null> {
  return async () => {
    const exe = coreExe();
    if (exe === null) throw new Error('WICKED_CORE_EXE is not set');
    try {
      const out = await execCapped(exe, ['seat-image', 'status', '--json'], { timeout: PROBE_TIMEOUT_MS });
      return parseSeatImageStatus(out.stdout);
    } catch (err) {
      const e = err as { stderr?: unknown; message?: string };
      throw new Error(loginDetail(typeof e.stderr === 'string' && e.stderr !== '' ? e.stderr : (e.message ?? 'failed')));
    }
  };
}

/** How old the roster's seat image reading may be and still be served. The daemon's reading refreshes at half that. */
export const SEAT_IMAGE_READING_TTL_MS = 60_000;

/**
 * (crew#1097) The roster's seat image reading: {@link unbuildableSeatImages} of the last status, read off the request
 * path (one read at a time). A reading older than the TTL is never served (codex merge check r3): a stale "cannot be
 * built" would keep refusing a seat repaired since, so a stale read answers `null` and starts a fresh read. No reading
 * yet, a failed one, or a stale one is `null`: nothing is marked (an unknown image never benches a seat). The daemon
 * `start`s it, so the reading refreshes every half TTL and a repair is seen within that, with or without requests.
 */
export class SeatImageReading {
  private last: Map<string, UnbuildableSeatImage> | null = null;
  private at = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly status: () => Promise<SeatImageStatus | null>,
    private readonly opts: { ttlMs?: number; timeoutMs?: number; nowMs?: () => number } = {},
  ) {}

  /** The last reading while it is fresh; a stale one is not served (`null`) and starts a refresh. */
  unbuildable(): Map<string, UnbuildableSeatImage> | null {
    if (this.now() - this.at < this.ttl()) return this.last;
    void this.refresh();
    return null;
  }

  /** Refresh now and every half TTL (the daemon's reading), so a served reading is never older than the TTL. */
  start(): this {
    if (this.timer === undefined) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), Math.max(1, Math.floor(this.ttl() / 2)));
      this.timer.unref?.();
    }
    return this;
  }

  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private ttl(): number {
    return this.opts.ttlMs ?? SEAT_IMAGE_READING_TTL_MS;
  }

  /** Read now (one at a time: a refresh in flight is the one awaited). */
  refresh(): Promise<void> {
    this.pending ??= (async () => {
      // One status read at a time: a read past its deadline publishes "unknown" then, and keeps the slot until it ends.
      const op = this.status();
      const settled = await settleWithin(() => op, this.opts.timeoutMs ?? PROBE_TIMEOUT_MS);
      this.note(settled.kind === 'ok' ? settled.value : null);
      await op.then(() => undefined, () => undefined);
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** A status read elsewhere (the row, a rebuild's end) is the reading too; `null` = unknown. */
  note(st: SeatImageStatus | null): void {
    this.last = st === null ? null : unbuildableSeatImages(st);
    this.at = this.now();
  }

  private now(): number {
    return (this.opts.nowMs ?? Date.now)();
  }
}

const gib = (n: number): string => `${Math.round((n / 2 ** 30) * 10) / 10} GiB`;

/**
 * The `seat_images` row: `down` when a missing image cannot be built (the operator's base is gone
 * with no recipe, or an operator image is missing) or the VM disk is nearly full; `degraded` when
 * roster images are missing (the next unit builds each first, minutes), not yet held, or the VM
 * disk is past the warning line; `unknown` with no reading (of the images, the roster or the disk);
 * `ok` otherwise. `off` on the host floor.
 */
export async function probeSeatImages(input: SeatImagesProbeInput): Promise<SystemInfraRow> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (!input.containerFloor) return infraRow('seat_images', 'off', 'not used: seats run on the host floor, not in containers', null, started);
  const settled = await settleWithin(input.status, timeoutMs);
  const rebuild = input.rebuild();
  if (settled.kind === 'timeout') {
    return infraRow('seat_images', 'unknown', `the engine's seat image status did not answer within ${Math.round(timeoutMs / 1000)} s`, 'Re-check; a container runtime under load answers late.', started, { rebuild }, timeoutMs);
  }
  if (settled.kind === 'error' || settled.value === null) {
    // A container runtime that is down reads as a plain cause (`settled.error` is already scrubbed of
    // any home path by errText; `homeless` is belt-and-suspenders for the daemon's own home).
    const plain = settled.kind === 'error' ? plainRuntimeCause(settled.full ?? settled.error) : null;
    if (plain !== null) {
      return infraRow('seat_images', 'unknown', plain.cause, plain.fix, started, { rebuild }, timeoutMs);
    }
    const why = settled.kind === 'error' ? homeless(settled.error) : 'the engine gave no status (an engine older than wicked-core#1225 prints none)';
    return infraRow('seat_images', 'unknown', `the seat images could not be read: ${why}`, 'Re-check; if it persists, the engine binary (WICKED_CORE_EXE) may be missing or older.', started, { rebuild }, timeoutMs);
  }
  if (input.clis === null) {
    return infraRow('seat_images', 'unknown', 'the roster could not be read, so which seat images matter is not known', 'Re-check.', started, { rebuild }, timeoutMs);
  }
  const st = settled.value;
  const idleSet = new Set((await input.idle?.()) ?? []);
  const roster = new Set(input.clis.filter((c) => !idleSet.has(c)));
  const seats = st.seats.filter((s) => roster.has(s.cli));
  // Not set up: its image is needed only once it is signed in (the engine builds its own on the
  // first unit; an operator image is the operator's to pull).
  const idleMissing = st.seats.filter((s) => idleSet.has(s.cli) && !s.present).map((s) => s.cli);
  const idleWords = idleMissing.length > 0 ? `; not needed until signed in: ${idleMissing.join(', ')}` : '';
  const missing = seats.filter((s) => !s.present && !s.operatorImage).map((s) => s.cli);
  const cannot = unbuildableSeatImages(st);
  const operatorMissing = seats.filter((s) => cannot.get(s.cli)?.kind === 'operator').map((s) => s.cli);
  // The operator base matters only to a seat the engine builds (an operator image does not build
  // on it).
  const base = seats.some((s) => !s.operatorImage) ? st.base : null;
  const baseGone = base !== null && !base.present;
  const unheld = st.holdSupported
    ? [
        ...(base !== null && base.present && !base.held ? ['base'] : []),
        ...(st.floor.present && !st.floor.held ? ['floor'] : []),
        ...seats.filter((s) => s.present && !s.held).map((s) => s.cli),
      ]
    : [];
  const disk = st.disk;
  const details: Record<string, unknown> = {
    images: { base, baseRecipe: st.baseRecipe, holdSupported: st.holdSupported, floor: st.floor, seats },
    disk,
    missing,
    idleMissing,
    unheld,
    imageGcHighPct: st.imageGcHighPct,
    rebuild,
  };
  const diskWords = disk === null ? null : `runtime VM disk ${disk.usedPct}% used (${gib(disk.availBytes)} free of ${gib(disk.totalBytes)})`;
  const rebuilding = rebuild?.running === true;
  const rebuildWords = rebuilding
    ? `; rebuilding since ${rebuild.startedAt}`
    : rebuild !== null && rebuild.rc !== null && rebuild.rc !== 0
      ? `; the last rebuild failed (exit ${rebuild.rc})${rebuild.error !== null ? `: ${rebuild.error}` : ''}`
      : '';
  const problems: string[] = [];
  let state: 'ok' | 'degraded' | 'down' = 'ok';
  const worse = (s: 'degraded' | 'down'): void => {
    if (s === 'down' || state === 'ok') state = s;
  };
  // Something must be built: a missing engine seat image, or the floor image.
  const mustBuild = missing.length > 0 || !st.floor.present;
  if (baseGone) {
    if (st.baseRecipe) {
      worse('degraded');
      problems.push(`the seat base ${base!.image} is missing; it is rebuilt from its Dockerfile before the next seat image`);
    } else if (missing.length > 0) {
      worse('down');
      problems.push(`the seat base ${base!.image} is missing and nothing can rebuild it, so the missing seat images cannot be built`);
    } else {
      worse('degraded');
      problems.push(`the seat base ${base!.image} is missing and nothing can rebuild it: the seats run on the images they have, but a seat image deleted now could not be rebuilt`);
    }
  }
  if (missing.length > 0) {
    const unbuildable = missing.some((c) => cannot.get(c)?.kind === 'base');
    worse(unbuildable ? 'down' : 'degraded');
    problems.push(`seat images missing: ${missing.join(', ')}${unbuildable ? '' : ' (the next unit on each builds it first, minutes)'}`);
  }
  if (operatorMissing.length > 0) {
    worse('down');
    problems.push(`the operator's own seat image is missing for ${operatorMissing.join(', ')} (WICKED_SEAT_IMAGE_<CLI>; the engine never builds it)`);
  }
  if (!st.floor.present) {
    worse('degraded');
    problems.push(`the floor image ${st.floor.image} is missing (built on the next seat)`);
  }
  if (unheld.length > 0) {
    worse('degraded');
    problems.push(`not held against image cleanup: ${unheld.join(', ')} (the engine holds them on the next seat)`);
  }
  if (disk !== null && disk.usedPct >= SEAT_DISK_DOWN_PCT) {
    worse('down');
    problems.push(`${diskWords}: the container runtime is close to refusing writes`);
  } else if (disk !== null && disk.usedPct >= SEAT_DISK_WARN_PCT) {
    worse('degraded');
    problems.push(`${diskWords}: from ${st.imageGcHighPct}% a kubelet's image cleanup deletes every image no container holds`);
  }
  if (state === 'ok') {
    // A current engine reads no disk (crew#1526): the images are the reading, and nothing is unknown.
    if (disk === null && !st.diskReported) {
      const n = seats.length + 1 + (base !== null ? 1 : 0);
      const word = !st.holdReported ? 'present' : st.holdSupported ? 'present and held' : 'present (this runtime cannot hold them against image cleanup)';
      return infraRow('seat_images', 'ok', `${n} seat image(s) ${word}${idleWords}${rebuilding ? rebuildWords : ''}`, null, started, details, timeoutMs);
    }
    if (disk === null) {
      return infraRow('seat_images', 'unknown', `the seat images are present${st.holdSupported ? ' and held' : ''}, but the runtime VM disk could not be read`, 'Re-check; the disk is read in a throwaway floor container.', started, details, timeoutMs);
    }
    const n = seats.length + 1 + (base !== null ? 1 : 0);
    const heldWord = st.holdSupported ? 'present and held' : 'present (this runtime cannot hold them against image cleanup)';
    return infraRow('seat_images', 'ok', `${n} seat image(s) ${heldWord}; ${diskWords}${idleWords}${rebuilding ? rebuildWords : ''}`, null, started, details, timeoutMs);
  }
  const diskPressed = disk !== null && disk.usedPct >= SEAT_DISK_WARN_PCT;
  // Every image the seats use is there and held: only then do they survive the cleanup.
  const allHeld = st.holdSupported && unheld.length === 0 && !mustBuild && !baseGone && operatorMissing.length === 0;
  // The runtime the engine reads (its CLI), so the cleanup goes to the right one.
  const rt = basename(st.runtime) || 'docker';
  // docker's `volume prune` removes only anonymous volumes no container uses; podman's removes every
  // unused volume, named ones too, so it is never suggested there.
  const volumes = rt === 'docker'
    ? 'dangling volumes (`docker volume prune` removes anonymous volumes no container uses) and build cache (`docker builder prune`)'
    : `the dangling volumes you no longer need (\`${rt} volume ls --filter dangling=true\`, then remove them by name) and its build cache`;
  const freeDisk = `Free space in the container runtime VM first: ${volumes}.${allHeld ? ' The seat images are held and survive the cleanup.' : ''}`;
  const fix = rebuilding
    ? 'Wait for the running rebuild to finish, then re-check.'
    : operatorMissing.length > 0
      ? 'Rebuild or re-pull your own seat image (WICKED_SEAT_IMAGE_<CLI>), then re-check.'
      : baseGone && !st.baseRecipe
        ? `Rebuild ${base!.image} from its Dockerfile (or set WICKED_SEAT_BASE_DOCKERFILE so the engine rebuilds it)${missing.length > 0 ? ', then Rebuild seat images' : ''}.`
        : mustBuild || unheld.length > 0 || baseGone
          ? `Rebuild seat images now, or let the next unit ${st.holdSupported ? 'build or hold' : 'build'} each on first use.`
          : '';
  // A pressed disk comes first: building onto it makes it worse.
  const remedy = diskPressed ? `${freeDisk}${fix !== '' ? ` Then: ${fix}` : ''}` : fix || 'Re-check.';
  return infraRow('seat_images', state, `${problems.join('; ')}${idleWords}${rebuildWords}`, remedy, started, details, timeoutMs);
}

/** A running rebuild: `onLine` per output line; `started` settles once the engine process exists
 *  (rejects when it cannot be started); `done` resolves with its exit code. */
export type SpawnLines = (
  file: string,
  args: string[],
  opts: { timeout: number; onLine: (line: string) => void; killAfterMs?: number },
) => { started: Promise<void>; done: Promise<number> };

/** The real runner: `spawn`, lines as they come (stdout and stderr), killed at `timeout`. */
export const spawnLines: SpawnLines = (file, args, opts) => {
  // The daemon's boot governance store, never one a caller exported (crew#495).
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnvWithBootEstateDb(process.env) });
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const done = new Promise<number>((resolve) => {
    // Past the bound: SIGTERM, then SIGKILL if it is still there 10 s later.
    let kill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs ?? 10_000);
      kill.unref?.();
    }, opts.timeout);
    timer.unref?.();
    const feed = (stream: NodeJS.ReadableStream | null): void => {
      let buf = '';
      let dropping = false;
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          if (!dropping) opts.onLine(buf.slice(0, i));
          dropping = false;
          buf = buf.slice(i + 1);
        }
        // An overlong line keeps its start (what names it) and drops the rest until its end.
        if (buf.length > LINE_MAX) {
          if (!dropping) opts.onLine(buf.slice(0, LINE_MAX));
          dropping = true;
          buf = '';
        }
      });
      stream?.on('end', () => {
        if (buf !== '' && !dropping) opts.onLine(buf);
      });
    };
    feed(child.stdout);
    feed(child.stderr);
    const end = (rc: number): void => {
      clearTimeout(timer);
      if (kill !== undefined) clearTimeout(kill);
      resolve(rc);
    };
    child.once('error', () => end(127));
    // `exit`, not `close`: a descendant still holding the pipes cannot keep the slot taken.
    child.once('exit', (code) => end(typeof code === 'number' ? code : 1));
  });
  return { started, done };
};

/**
 * One rebuild at a time: `wicked-core seat-image build <clis…>` (builds the floor and each seat
 * image, rebuilding a missing base from its recipe; holds them, and an operator's own image). Its
 * state is kept for the row, its output read live into a bounded tail.
 */
export class SeatImageRebuilder {
  private state: RebuildState | null = null;

  constructor(
    private readonly exe: () => string | null,
    private readonly run: SpawnLines = spawnLines,
    private readonly now: () => Date = () => new Date(),
  ) {}

  current(): RebuildState | null {
    return this.state === null ? null : { ...this.state, tail: [...this.state.tail], clis: [...this.state.clis] };
  }

  /** Start a rebuild of `clis`; `started: false` with why when one runs, no engine binary is set or
   *  it cannot be started, or there is nothing to rebuild. */
  async start(clis: string[]): Promise<{ started: true; state: RebuildState } | { started: false; reason: string; state: RebuildState | null }> {
    if (this.state?.running === true) return { started: false, reason: 'a rebuild is already running', state: this.current() };
    const exe = this.exe();
    if (exe === null) return { started: false, reason: 'WICKED_CORE_EXE is not set: crew cannot reach the engine binary', state: this.current() };
    const wanted = [...new Set(clis)].filter((c) => /^[a-z][a-z0-9-]{0,31}$/.test(c));
    if (wanted.length === 0) return { started: false, reason: 'no container seat on the roster has an engine seat image', state: this.current() };
    const state: RebuildState = { running: true, startedAt: this.now().toISOString(), finishedAt: null, rc: null, tail: [], error: null, clis: wanted };
    // Taken before the spawn settles: a second press in that moment is refused, never a second run.
    this.state = state;
    const onLine = (raw: string): void => {
      const line = raw.trim();
      // Buildkit's step frames are noise for a person; the engine's own lines are kept.
      if (line === '' || /^#\d+ /.test(line) || /^=>/.test(line)) return;
      const l = homeless(line);
      const kept = l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l;
      state.tail.push(kept);
      if (state.tail.length > TAIL_LINES) state.tail.splice(0, state.tail.length - TAIL_LINES);
      if (/\b(fail(ed|s)?|error|denied|missing|cannot|refused)\b/i.test(kept)) state.error = kept;
    };
    const finish = (rc: number): void => {
      state.running = false;
      state.rc = rc;
      state.finishedAt = this.now().toISOString();
    };
    let h: ReturnType<SpawnLines>;
    try {
      h = this.run(exe, ['seat-image', 'build', ...wanted], { timeout: REBUILD_TIMEOUT_MS, onLine });
      await h.started;
    } catch (e) {
      const why = homeless(e instanceof Error ? e.message : String(e));
      onLine(why);
      finish(127);
      return { started: false, reason: `the engine could not be started: ${why}`, state: this.current() };
    }
    void h.done.then(finish, () => finish(1));
    return { started: true, state: this.current()! };
  }
}
