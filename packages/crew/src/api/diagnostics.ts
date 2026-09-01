/**
 * GET /api/v1/diagnostics — the daemon's self-knowledge surface.
 *
 * The operator question this answers is "is ACP really working across the CLIs, and what is this
 * daemon actually running?" — an answer that previously lived only in raw NDJSON under
 * `<state-home>/core.db.events/` and in whatever `--version` the operator remembered to run.
 * Everything here is READ-ONLY and derived from records the daemon already owns:
 *
 *   - component versions (crew's package.json; the bundled studio's shipped manifest; the
 *     installed wicked-core-ts; engine binaries crew already knows how to invoke)
 *   - store files with sizes (core.db + its sidecars, the durable events dir as a total)
 *   - a bounded tail of the daemon's own error-level log lines (an in-process ring — see
 *     {@link ErrorRing}; empty on a daemon that has logged no errors, never invented)
 *   - the ACP fold: acpSessionStarted / acpFallback per cliKey from the durable run event logs
 *
 * The honesty rule is the wire contract's: a field the daemon cannot answer is `null` (or an
 * empty collection) — NEVER fabricated. A missing studio bundle is `null`, an unprobeable
 * binary is `null`, a machine with no event logs folds to `{}`.
 */

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import { execCapped } from '../core/exec.js';

// ── ACP fold ─────────────────────────────────────────────────────────────────

/** Per-CLI ACP health, folded from the durable run event logs. Mirrors the wire contract's
 *  `AcpCliDiagnostics` (wicked-crew-api-types). */
export interface AcpCliFold {
  sessionsStarted: number;
  fallbacks: number;
  fallbackKinds: Record<string, number>;
  lastStartedTs: number | null;
  lastFallbackTs: number | null;
}

/** Bounds on the fold's work — the events dir grows one file per run forever, and this fold
 *  runs inside a request handler, so both dimensions are capped. At the caps this is still
 *  hundreds of runs' worth of history; past them the answer is the bounded subset (newest
 *  files first), which stays honest for "is ACP working" — the recent record is what matters. */
const ACP_FOLD_MAX_FILES = 512;
const ACP_FOLD_MAX_LINE_BYTES = 1024 * 1024;

/**
 * Fold `acpSessionStarted` / `acpFallback` events per cliKey from `<dir>/*.ndjson`.
 *
 * Stream-parsed (readline over a file stream — never a whole-file read into memory), with a
 * cheap substring pre-filter so the JSON parser only ever runs on candidate lines. A missing
 * dir, an unreadable file, or a malformed line each degrade to "contributes nothing" — the
 * fold is a diagnosis surface and must not itself become a failure mode.
 */
export async function foldAcpEvents(eventsDir: string): Promise<Record<string, AcpCliFold>> {
  const byCli: Record<string, AcpCliFold> = {};
  let names: string[];
  try {
    names = await fsp.readdir(eventsDir);
  } catch {
    return byCli; // no events dir yet — nothing recorded, honestly empty
  }
  let files = names.filter((n) => n.endsWith('.ndjson'));
  if (files.length > ACP_FOLD_MAX_FILES) {
    // Newest runs first when the cap bites: mtime is one stat per file, paid only past the cap.
    const stamped = await Promise.all(
      files.map(async (n) => {
        try {
          const st = await fsp.stat(join(eventsDir, n));
          return { n, mtime: st.mtimeMs };
        } catch {
          return { n, mtime: 0 };
        }
      }),
    );
    files = stamped
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, ACP_FOLD_MAX_FILES)
      .map((s) => s.n);
  }
  for (const name of files) {
    await foldOneFile(join(eventsDir, name), byCli);
  }
  return byCli;
}

function entryFor(byCli: Record<string, AcpCliFold>, cliKey: string): AcpCliFold {
  let e = byCli[cliKey];
  if (e === undefined) {
    e = {
      sessionsStarted: 0,
      fallbacks: 0,
      fallbackKinds: {},
      lastStartedTs: null,
      lastFallbackTs: null,
    };
    byCli[cliKey] = e;
  }
  return e;
}

async function foldOneFile(path: string, byCli: Record<string, AcpCliFold>): Promise<void> {
  let rl: ReturnType<typeof createInterface>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(path, { encoding: 'utf8' });
    rl = createInterface({ input: stream, crlfDelay: Infinity });
  } catch {
    return; // unreadable file contributes nothing
  }
  try {
    for await (const line of rl) {
      // Substring pre-filter: almost every line in a run log is NOT an ACP event, and
      // JSON.parse on megabytes of narration is exactly the stall this fold must not cause.
      const isStart = line.includes('"acpSessionStarted"');
      const isFallback = !isStart && line.includes('"acpFallback"');
      if (!isStart && !isFallback) continue;
      if (line.length > ACP_FOLD_MAX_LINE_BYTES) continue; // pathological line — skip, don't parse
      let event: { type?: unknown; cliKey?: unknown; ts?: unknown; fallbackKind?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue; // torn tail line of a crashed run — not this surface's problem
      }
      if (typeof event.cliKey !== 'string') continue;
      const ts = typeof event.ts === 'number' ? event.ts : null;
      if (event.type === 'acpSessionStarted') {
        const e = entryFor(byCli, event.cliKey);
        e.sessionsStarted += 1;
        if (ts !== null && (e.lastStartedTs === null || ts > e.lastStartedTs)) {
          e.lastStartedTs = ts;
        }
      } else if (event.type === 'acpFallback') {
        const e = entryFor(byCli, event.cliKey);
        e.fallbacks += 1;
        const kind = typeof event.fallbackKind === 'string' ? event.fallbackKind : 'unknown';
        e.fallbackKinds[kind] = (e.fallbackKinds[kind] ?? 0) + 1;
        if (ts !== null && (e.lastFallbackTs === null || ts > e.lastFallbackTs)) {
          e.lastFallbackTs = ts;
        }
      }
    }
  } catch {
    // A read error mid-stream (file rotated away, disk hiccup): keep what folded so far.
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * A short-TTL, in-flight-deduplicated cache around {@link foldAcpEvents}. The events dir holds
 * one file per run (139+ observed), so the fold is real IO — briefly caching keeps a dashboard
 * polling /diagnostics from turning the daemon into an NDJSON re-reader, while the TTL keeps
 * the answer honest to within seconds.
 */
export class AcpFoldCache {
  private value: { at: number; byCli: Record<string, AcpCliFold> } | null = null;
  private inFlight: Promise<Record<string, AcpCliFold>> | null = null;

  constructor(private readonly ttlMs: number = 15_000) {}

  async get(eventsDir: string): Promise<Record<string, AcpCliFold>> {
    const now = Date.now();
    if (this.value !== null && now - this.value.at < this.ttlMs) return this.value.byCli;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = foldAcpEvents(eventsDir)
      .then((byCli) => {
        this.value = { at: Date.now(), byCli };
        return byCli;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

// ── Recent-error ring ────────────────────────────────────────────────────────

/** One captured error-level log line — the wire contract's `DiagnosticsRecentError`. */
export interface RecentError {
  ts: number;
  source: string;
  line: string;
}

/** Keep captured lines readable, not exhaustive: the tail is a diagnosis pointer, the full
 *  narrative stays wherever the operator ships the daemon's stdout. */
const RING_LINE_MAX_CHARS = 2000;

/**
 * A bounded ring of the daemon's own error-level log lines.
 *
 * Crew has no persistent log file of its own (pino writes to stdout; `daemon-stdout.log` under
 * the state home belongs to whatever launched the daemon) — so the "recent errors" record is
 * an IN-PROCESS ring fed by a tee on the pino stream ({@link teeStreamWithErrorRing}). Empty
 * on a fresh or healthy daemon; capped so it can never grow with uptime.
 */
export class ErrorRing {
  private readonly entries: RecentError[] = [];

  constructor(private readonly cap: number = 20) {}

  push(entry: RecentError): void {
    const line =
      entry.line.length > RING_LINE_MAX_CHARS
        ? `${entry.line.slice(0, RING_LINE_MAX_CHARS)}…`
        : entry.line;
    this.entries.push({ ...entry, line });
    if (this.entries.length > this.cap) this.entries.shift();
  }

  /** Newest first — the wire order. */
  list(): RecentError[] {
    return [...this.entries].reverse();
  }
}

/** Pino numeric levels: 50 = error, 60 = fatal. Anything below stays out of the ring. */
const PINO_ERROR_LEVEL = 50;

/**
 * A pino destination that forwards every line to `out` (stdout in the daemon) and folds
 * error-level lines into `ring`. Passed to Fastify as `logger.stream`, so the ring sees
 * exactly what the daemon logs — no second logging channel to keep in step.
 *
 * The parse is guarded end-to-end: a log line that fails to parse as pino JSON still ships to
 * `out` verbatim, and a throw in the ring can never break logging (which would turn the
 * diagnosis surface into an outage).
 */
export function teeStreamWithErrorRing(
  ring: ErrorRing,
  out: { write(chunk: string): unknown } = process.stdout,
): { write(chunk: string): void } {
  return {
    write(chunk: string): void {
      try {
        out.write(chunk);
      } catch {
        /* a broken stdout must not also kill the ring */
      }
      try {
        // Cheap pre-filter before JSON.parse — most lines are info/debug.
        if (!/"level":\s*(50|60)\b/.test(chunk)) return;
        for (const line of chunk.split('\n')) {
          if (line === '') continue;
          const parsed = JSON.parse(line) as { level?: unknown; time?: unknown; msg?: unknown };
          const level = typeof parsed.level === 'number' ? parsed.level : 0;
          if (level < PINO_ERROR_LEVEL) continue;
          ring.push({
            ts: typeof parsed.time === 'number' ? parsed.time : Date.now(),
            source: 'daemon',
            line: typeof parsed.msg === 'string' ? parsed.msg : line,
          });
        }
      } catch {
        /* an unparseable line is not an error record — skip it */
      }
    },
  };
}

// ── Component versions ───────────────────────────────────────────────────────

/**
 * The bundled studio's version, read from the manifest the bundle ALREADY ships:
 * `testid-inventory.json` carries `studioVersion` (a versioned build artifact, TH-13). No
 * bundle — a headless daemon — is `null`, and so is a bundle predating the inventory.
 */
export function readStudioBundleVersion(studioRoot: string): string | null {
  try {
    const raw = readFileSync(join(studioRoot, 'testid-inventory.json'), 'utf8');
    const parsed = JSON.parse(raw) as { studioVersion?: unknown };
    return typeof parsed.studioVersion === 'string' ? parsed.studioVersion : null;
  } catch {
    return null;
  }
}

/**
 * The installed version of a dependency, or `null`. Walks the resolver's candidate dirs and
 * reads package.json with fs — the same sidestep `apiTypesVersion()` uses, because a
 * types-only exports map (wicked-core-ts included) refuses `require.resolve` on the package
 * root and on `/package.json` alike.
 */
export function installedPackageVersion(name: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    for (const dir of require.resolve.paths(name) ?? []) {
      const pkgPath = join(dir, name, 'package.json');
      if (existsSync(pkgPath)) {
        const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown })
          .version;
        return typeof version === 'string' ? version : null;
      }
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/** First semver-looking token of a `--version` output, else the trimmed first line, else null. */
export function parseVersionOutput(stdout: string): string | null {
  const firstLine = stdout.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') return null;
  const semver = firstLine.match(/\d+\.\d+\.\d+[^\s]*/);
  return semver !== null ? semver[0] : firstLine;
}

type ExecLike = (
  file: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * `--version` of the engine binaries crew ALREADY knows how to invoke — never a new path
 * resolution invented for diagnostics:
 *
 *   - `wicked-core`: the standalone engine binary the adapter resolves at construction for the
 *     gate-hook command and publishes as `WICKED_CORE_EXE`. Env unset = crew never resolved
 *     one = `null`.
 *   - `wicked-estate`: invoked by bare name on PATH, exactly as the graph-view/blast-radius
 *     routes do. Not on PATH = `null`.
 *
 * Under a test runner the probes are SKIPPED (both `null`) unless an exec is injected — the
 * seat-health-probe posture: a test-built server never spawns CLI children by default.
 */
export async function engineBinaryVersions(exec?: ExecLike): Promise<Record<string, string | null>> {
  const underTestRunner =
    process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test';
  if (exec === undefined && underTestRunner) {
    return { 'wicked-core': null, 'wicked-estate': null };
  }
  const run = exec ?? (execCapped as ExecLike);
  const probe = async (file: string): Promise<string | null> => {
    try {
      const { stdout } = await run(file, ['--version'], { timeout: 5_000 });
      return parseVersionOutput(stdout);
    } catch {
      return null;
    }
  };
  const coreExe = process.env['WICKED_CORE_EXE'];
  const [core, estate] = await Promise.all([
    coreExe !== undefined && coreExe !== '' ? probe(coreExe) : Promise.resolve(null),
    probe('wicked-estate'),
  ]);
  return { 'wicked-core': core, 'wicked-estate': estate };
}

/** Version probes answer the same for the life of a process — cache the first answer. */
export class EngineVersionCache {
  private value: Record<string, string | null> | null = null;
  private inFlight: Promise<Record<string, string | null>> | null = null;

  async get(exec?: ExecLike): Promise<Record<string, string | null>> {
    if (this.value !== null) return this.value;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = engineBinaryVersions(exec)
      .then((v) => {
        this.value = v;
        return v;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

// ── Store files ──────────────────────────────────────────────────────────────

/** One store file (or dir, sized as a total) — the wire contract's `DiagnosticsStoreFile`. */
export interface StoreFileEntry {
  name: string;
  path: string;
  bytes: number;
}

/** Directory totals stop counting past this many entries — a runaway dir must not turn a
 *  diagnostics GET into a filesystem crawl. The observed events dir is ~139 files. */
const DIR_SIZE_MAX_ENTRIES = 10_000;

async function dirBytes(path: string): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen >= DIR_SIZE_MAX_ENTRIES) return total;
      seen += 1;
      const child = join(dir, name);
      try {
        const st = await fsp.stat(child);
        if (st.isDirectory()) stack.push(child);
        else total += st.size;
      } catch {
        /* raced deletion — skip */
      }
    }
  }
  return total;
}

/**
 * `core.db` and every sidecar sharing its basename (`core.db-wal`, `core.db.knowledge`,
 * `core.db.mem*`, …), plus the events dir (`core.db.events`) sized as a TOTAL of its
 * contents. Paths and sizes only — no file contents ever ride this wire.
 */
export async function listStoreFiles(dbPath: string): Promise<StoreFileEntry[]> {
  const home = dirname(dbPath);
  const base = basename(dbPath);
  let names: string[];
  try {
    names = await fsp.readdir(home);
  } catch {
    return [];
  }
  const matches = names
    .filter((n) => n === base || n.startsWith(`${base}.`) || n.startsWith(`${base}-`))
    .sort();
  const out: StoreFileEntry[] = [];
  for (const name of matches) {
    const path = join(home, name);
    try {
      const st = await fsp.stat(path);
      out.push({ name, path, bytes: st.isDirectory() ? await dirBytes(path) : st.size });
    } catch {
      /* raced deletion — skip */
    }
  }
  return out;
}

/** Where a core db's durable run event logs live — the engine's `<db>.events/` convention. */
export function eventsDirOf(dbPath: string): string {
  return `${dbPath}.events`;
}
