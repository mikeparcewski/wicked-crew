/**
 * The seat images row of the Nerve Center (`GET /system` infra key `seat_images`) and its one fix,
 * "Rebuild seat images" (`POST /system/seat-images/rebuild`).
 *
 * Governed seats run in container images the engine builds (wicked-core `container_floor.rs`). A
 * desktop runtime that also runs Kubernetes (Rancher Desktop's k3s) has a kubelet that deletes every
 * image no container references once the VM's image disk passes 85 % (`imageGCHighThresholdPercent`).
 * The engine now keeps each seat image with a stopped holder container, so the kubelet cannot delete
 * it (wicked-core#1225); this row says whether the images are there and held, and warns while the VM
 * disk climbs toward that line, BEFORE the cleanup runs.
 *
 * The reading is `wicked-core seat-image status --json` (the engine owns the image tags), run per
 * request under the probe's bound: never a cached "ok".
 */
import type { SystemInfraRow } from '../core/types.js';
import { homeless } from './seat-standing.js';
import { infraRow, settleWithin } from './system-snapshot.js';

/** The probe's own bound: the status lists the images and reads the VM disk in a throwaway container. */
export const SEAT_IMAGES_TIMEOUT_MS = 6_000;
/** VM disk used, %, from which the row warns (the kubelet starts deleting unheld images at 85). */
export const SEAT_DISK_WARN_PCT = 75;
/** VM disk used, %, from which the row is down: the runtime is close to refusing writes. */
export const SEAT_DISK_DOWN_PCT = 92;
/** How long a rebuild may run (a cold seat image build is npm installs and a toolchain: minutes). */
export const REBUILD_TIMEOUT_MS = 45 * 60_000;

export interface SeatImageEntry {
  image: string;
  present: boolean;
  held: boolean;
}

/** `wicked-core seat-image status --json`. */
export interface SeatImageStatus {
  runtime: string;
  base: SeatImageEntry | null;
  baseRecipe: boolean;
  floor: SeatImageEntry;
  seats: Array<SeatImageEntry & { cli: string; operatorImage: boolean }>;
  disk: { totalBytes: number; availBytes: number; usedPct: number } | null;
  imageGcHighPct: number;
}

const isEntry = (v: unknown): v is SeatImageEntry => {
  const o = v as Record<string, unknown> | null;
  return o !== null && typeof o === 'object' && typeof o['image'] === 'string' && typeof o['present'] === 'boolean' && typeof o['held'] === 'boolean';
};

/** Parse the engine's answer; `null` when it is not the shape (an older engine prints text). */
export function parseSeatImageStatus(stdout: string): SeatImageStatus | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const o = v as Record<string, unknown> | null;
  if (o === null || typeof o !== 'object' || !isEntry(o['floor']) || !Array.isArray(o['seats'])) return null;
  const seats = (o['seats'] as unknown[]).filter(
    (s): s is SeatImageStatus['seats'][number] => isEntry(s) && typeof (s as { cli?: unknown }).cli === 'string',
  );
  const d = o['disk'] as Record<string, unknown> | null | undefined;
  const disk =
    d !== null && typeof d === 'object' && typeof d['totalBytes'] === 'number' && typeof d['availBytes'] === 'number' && typeof d['usedPct'] === 'number'
      ? { totalBytes: d['totalBytes'], availBytes: d['availBytes'], usedPct: d['usedPct'] }
      : null;
  return {
    runtime: typeof o['runtime'] === 'string' ? o['runtime'] : '',
    base: isEntry(o['base']) ? o['base'] : null,
    baseRecipe: o['baseRecipe'] === true,
    floor: o['floor'],
    seats: seats.map((s) => ({ ...s, operatorImage: (s as { operatorImage?: unknown }).operatorImage === true })),
    disk,
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
  /** The last lines it printed (bounded), for the row's details. */
  tail: string[];
  clis: string[];
}

export interface SeatImagesProbeInput {
  containerFloor: boolean;
  /** The roster's seat CLIs that run in a container (the images that matter here). */
  clis: string[];
  /** A fresh `seat-image status --json` read. */
  status: () => Promise<SeatImageStatus | null>;
  rebuild: RebuildState | null;
  timeoutMs?: number;
}

const gib = (n: number): string => `${Math.round((n / 2 ** 30) * 10) / 10} GiB`;

/**
 * The `seat_images` row: `down` when a seat cannot be built (the operator's base is gone and nothing
 * can rebuild it) or the VM disk is nearly full; `degraded` when roster images are missing (the next
 * unit rebuilds each first, minutes), not yet held, or the VM disk is past the warning line;
 * `ok` otherwise. `off` on the host floor.
 */
export async function probeSeatImages(input: SeatImagesProbeInput): Promise<SystemInfraRow> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? SEAT_IMAGES_TIMEOUT_MS;
  if (!input.containerFloor) return infraRow('seat_images', 'off', 'not used: seats run on the host floor, not in containers', null, started);
  const settled = await settleWithin(input.status, timeoutMs);
  const rebuild = input.rebuild;
  const rebuilding = rebuild?.running === true;
  if (settled.kind === 'timeout') {
    return infraRow('seat_images', 'unknown', `the engine's seat image status did not answer within ${Math.round(timeoutMs / 1000)} s`, 'Re-check; a container runtime under load answers late.', started, { rebuild }, timeoutMs);
  }
  if (settled.kind === 'error' || settled.value === null) {
    const why = settled.kind === 'error' ? settled.error : 'the engine gave no status (an engine older than wicked-core#1225 prints none)';
    return infraRow('seat_images', 'unknown', `the seat images could not be read: ${why}`, 'Re-check; if it persists, the engine binary (WICKED_CORE_EXE) may be missing or older.', started, { rebuild }, timeoutMs);
  }
  const st = settled.value;
  const roster = new Set(input.clis);
  const seats = st.seats.filter((s) => roster.has(s.cli));
  const missing = seats.filter((s) => !s.present && !s.operatorImage).map((s) => s.cli);
  const operatorMissing = seats.filter((s) => !s.present && s.operatorImage).map((s) => s.cli);
  const baseGone = st.base !== null && !st.base.present;
  const unheld = [
    ...(st.base !== null && st.base.present && !st.base.held ? ['base'] : []),
    ...(st.floor.present && !st.floor.held ? ['floor'] : []),
    ...seats.filter((s) => s.present && !s.held).map((s) => s.cli),
  ];
  const disk = st.disk;
  const details: Record<string, unknown> = {
    images: { base: st.base, baseRecipe: st.baseRecipe, floor: st.floor, seats },
    disk,
    missing,
    unheld,
    imageGcHighPct: st.imageGcHighPct,
    rebuild,
  };
  const diskWords = disk === null ? null : `runtime VM disk ${disk.usedPct}% used (${gib(disk.availBytes)} free of ${gib(disk.totalBytes)})`;
  const rebuildWords = rebuilding ? `; rebuilding since ${rebuild!.startedAt}` : rebuild !== null && rebuild.rc !== null && rebuild.rc !== 0 ? `; the last rebuild failed (exit ${rebuild.rc}): ${rebuild.tail.at(-1) ?? 'no output'}` : '';
  const problems: string[] = [];
  let state: 'ok' | 'degraded' | 'down' = 'ok';
  const worse = (s: 'degraded' | 'down'): void => {
    if (s === 'down' || state === 'ok') state = s;
  };
  if (baseGone) {
    if (st.baseRecipe) {
      worse('degraded');
      problems.push(`the seat base ${st.base!.image} is missing; it is rebuilt from its Dockerfile before the next seat image`);
    } else {
      worse('down');
      problems.push(`the seat base ${st.base!.image} is missing and nothing can rebuild it, so a missing seat image cannot be built`);
    }
  }
  if (missing.length > 0) {
    worse(baseGone && !st.baseRecipe ? 'down' : 'degraded');
    problems.push(`seat images missing: ${missing.join(', ')} (the next unit on each builds it first, minutes)`);
  }
  if (operatorMissing.length > 0) {
    worse('down');
    problems.push(`the operator's own seat image is missing for ${operatorMissing.join(', ')} (WICKED_SEAT_IMAGE_<CLI>; the engine never builds it)`);
  }
  if (!st.floor.present) {
    worse('degraded');
    problems.push(`the floor image ${st.floor.image} is missing (built on the next seat)`);
  }
  if (disk !== null && disk.usedPct >= SEAT_DISK_DOWN_PCT) {
    worse('down');
    problems.push(`${diskWords}: the container runtime is close to refusing writes`);
  } else if (disk !== null && disk.usedPct >= SEAT_DISK_WARN_PCT) {
    worse('degraded');
    problems.push(`${diskWords}: past ${st.imageGcHighPct}% a kubelet's image cleanup deletes every image no container holds`);
  }
  if (unheld.length > 0 && problems.length === 0) {
    worse('degraded');
    problems.push(`not yet held against image cleanup: ${unheld.join(', ')} (the engine holds them on the next seat)`);
  }
  if (state === 'ok') {
    const n = seats.length + 1 + (st.base !== null ? 1 : 0);
    return infraRow('seat_images', 'ok', `${n} seat image(s) present and held${diskWords !== null ? `; ${diskWords}` : ''}${rebuildWords}`, null, started, details, timeoutMs);
  }
  const onlyDisk = missing.length === 0 && operatorMissing.length === 0 && !baseGone && st.floor.present;
  const remedy = operatorMissing.length > 0
    ? 'Rebuild or re-pull your own seat image (WICKED_SEAT_IMAGE_<CLI>), then re-check.'
    : baseGone && !st.baseRecipe
      ? `Rebuild ${st.base!.image} from its Dockerfile (or set WICKED_SEAT_BASE_DOCKERFILE so the engine rebuilds it), then Rebuild seat images.`
      : onlyDisk && disk !== null && disk.usedPct >= SEAT_DISK_WARN_PCT
        ? 'Free space in the container runtime VM: dangling volumes (`docker volume prune` removes anonymous volumes no container uses) and build cache (`docker builder prune`). The seat images are held and survive the cleanup.'
        : 'Rebuild seat images now, or let the next unit build each on first use.';
  return infraRow('seat_images', state, `${problems.join('; ')}${rebuildWords}`, remedy, started, details, timeoutMs);
}

export type SpawnLike = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ rc: number; stdout: string; stderr: string }>;

/**
 * One rebuild at a time: `wicked-core seat-image build <clis…>` (builds the floor and each seat
 * image, rebuilding a missing base from its recipe, and holds them). Its state is kept for the row.
 */
export class SeatImageRebuilder {
  private state: RebuildState | null = null;

  constructor(
    private readonly exe: () => string | null,
    private readonly run: SpawnLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  current(): RebuildState | null {
    return this.state === null ? null : { ...this.state, tail: [...this.state.tail], clis: [...this.state.clis] };
  }

  /** Start a rebuild of `clis`. `started: false` with why when one is running or no engine is set. */
  start(clis: string[]): { started: true; state: RebuildState } | { started: false; reason: string; state: RebuildState | null } {
    if (this.state?.running === true) return { started: false, reason: 'a rebuild is already running', state: this.current() };
    const exe = this.exe();
    if (exe === null) return { started: false, reason: 'WICKED_CORE_EXE is not set: crew cannot reach the engine binary', state: this.current() };
    const wanted = [...new Set(clis)].filter((c) => /^[a-z][a-z0-9-]{0,31}$/.test(c));
    if (wanted.length === 0) return { started: false, reason: 'no container seat on the roster', state: this.current() };
    const state: RebuildState = { running: true, startedAt: this.now().toISOString(), finishedAt: null, rc: null, tail: [], clis: wanted };
    this.state = state;
    void this.run(exe, ['seat-image', 'build', ...wanted], { timeout: REBUILD_TIMEOUT_MS })
      .then((r) => ({ rc: r.rc, text: `${r.stdout}\n${r.stderr}` }))
      .catch((e: unknown) => ({ rc: 1, text: e instanceof Error ? e.message : String(e) }))
      .then(({ rc, text }) => {
        if (this.state !== state) return;
        state.running = false;
        state.rc = rc;
        state.finishedAt = this.now().toISOString();
        state.tail = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !/^#\d|^\s*=>/.test(l))
          .slice(-6)
          .map((l) => homeless(l))
          .map((l) => (l.length > 240 ? `${l.slice(0, 239)}…` : l));
      });
    return { started: true, state: this.current()! };
  }
}
