/**
 * The words a user reads in the Nerve Center and in diagnostics (FINDINGS B1, B2, C3a).
 *
 * Two rules this module keeps, at the source AND as a backstop:
 *  - A home path never reaches the UI. The daemon's own home — and anyone's `/Users/<name>`,
 *    `/home/<name>` or `C:\Users\<name>` — is written `~` (crew#771 taught this for seat evidence;
 *    screen shares and support tickets must not carry someone's login name).
 *  - A raw runtime error never reaches the UI. "failed to connect to the docker API at
 *    unix:///Users/<name>/.rd/docker.sock … no such file or directory" said nothing a user can act
 *    on; {@link plainRuntimeCause} turns the ones we recognise into "Docker isn't running" with the
 *    one fix.
 *
 * {@link scrubHomePaths} and {@link plainRuntimeCause} are applied where the text is MADE (so the
 * wording is right at the source). {@link registerUiTextScrub} is the one backstop: a Fastify
 * `onSend` hook over the read-only diagnostic routes that re-scrubs the serialized body, so a home
 * path a new row forgets to scrub still never ships.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where a path may start: not right after a word character, a dot, a dash or a backslash (so a match
 * never restarts at the `/` inside an escaped `\/`, which would leave `\~`). Web addresses are
 * protected whole before any of this runs ({@link WEB_URL}).
 */
const PATH_START = String.raw`(?<![\w.\\-])`;
/**
 * A web address, in plain or JSON-escaped spelling (`https://…`, `https:\/\/…`), any scheme but
 * `unix:` and `file:` (those name local paths and are scrubbed). Its whole span is set aside before
 * scrubbing and put back after (codex r2: `https://[::1]/Users/alice` and `https://h///home/x`).
 */
const WEB_URL = /\b(?!unix:|file:)[a-z][a-z0-9+.-]*:(?:\\?\/){2}[^\s"'<>]*/gi;
/** A path separator as it may appear in a decoded string: `/`, `\`, or a JSON-escaped `\/` / `\\`. */
const SEP = String.raw`(?:\\\\|\\\/|[\\/])`;
/** The end of a home spelling: the string's end, a separator (escaped or not), whitespace or punctuation. */
const HOME_END = String.raw`(?=$|\\|\/|\s|["'),;:])`;

/** The home dir's spellings, matched as a whole path prefix (compiled once per home: the backstop runs per string). */
function homeMatchers(home: string): RegExp[] {
  const out: RegExp[] = [];
  const add = (h: string): void => {
    const trimmed = h.replace(/[\\/]+$/, '');
    if (trimmed === '') return;
    const parts = trimmed.split(/[\\/]+/).filter((part) => part !== "").map(escapeRegExp);
    // `/Users/alice` in any separator spelling (`/`, `\`, `\/`, `\\`); a drive (`C:`) keeps its own case rules.
    const body = parts.join(SEP);
    const lead = /^[\\/]/.test(trimmed) ? SEP : '';
    out.push(new RegExp(`${PATH_START}${lead}${body}${HOME_END}`, 'gi'));
  };
  add(home);
  try {
    const real = realpathSync(home);
    if (real !== home) add(real);
  } catch {
    // The home may not exist (tests inject a temp home that is never created); the generic pass still
    // catches `/Users/<name>` etc.
  }
  return out;
}

const matcherCache = new Map<string, RegExp[]>();
function matchersFor(home: string): RegExp[] {
  let m = matcherCache.get(home);
  if (m === undefined) {
    m = homeMatchers(home);
    if (matcherCache.size > 16) matcherCache.clear();
    matcherCache.set(home, m);
  }
  return m;
}

/** `C:\Users\<name>` (any drive case, any separator spelling); the lookbehind keeps `unix:` from reading as a drive. */
const WINDOWS_HOME = new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:${SEP}Users${SEP}[^\\/\s"'),;:]+`, 'gi');
/** Any other user's `/Users/<name>` or `/home/<name>`, at a path start (see {@link PATH_START}). */
const POSIX_HOME = new RegExp(String.raw`${PATH_START}${SEP}(?:Users|home)${SEP}[^\\/\s"'),;:]+`, 'gi');

/**
 * Every home path in `text` becomes `~`. First the daemon's own home (and its realpath, so a
 * symlinked home like macOS's `/var` → `/private/var` is caught), then ANY remaining `/Users/<name>`,
 * `/home/<name>` or `C:\Users\<name>`: `<name>` is one path segment, any case, any separator spelling
 * (`/`, `\`, and the JSON-escaped `\/` and `\\` that a serialized fragment inside a string carries),
 * including inside `unix:///Users/…` sockets. Web addresses are left alone (see {@link PATH_START}).
 * Idempotent. The home's spellings are compiled once per home, never per call.
 */
export function scrubHomePaths(text: string, home: string = homedir()): string {
  if (text === '') return text;
  const urls: string[] = [];
  // A private-use placeholder cannot occur in the text we scrub, and no home pattern matches it.
  let out = text.replace(WEB_URL, (url) => `\uE000${urls.push(url) - 1}\uE001`);
  for (const re of matchersFor(home)) out = out.replace(re, () => '~');
  out = out.replace(WINDOWS_HOME, () => '~');
  out = out.replace(POSIX_HOME, () => '~');
  return urls.length === 0 ? out : out.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => urls[Number(i)] as string);
}

/**
 * Classify a container-runtime error into a plain cause and its one fix, or `null` when we do not
 * recognise it (the caller keeps its own text, scrubbed). Recognises the daemon being unreachable
 * (Docker, Podman or nerdctl) and a permission-denied socket.
 */
export function plainRuntimeCause(raw: string, runtime: string | null = null): { cause: string; fix: string } | null {
  const t = raw.toLowerCase();
  const aboutSocket = /\.sock\b/.test(t) || /docker\.sock/.test(t) || /docker api|docker daemon/.test(t) || /podman|nerdctl|containerd/.test(t);
  // Name the runtime the user actually has (codex r1: a Podman user was told to start Docker).
  const rt = (runtime ?? '').toLowerCase();
  const which = /podman/.test(t) || /podman/.test(rt) ? 'podman' : /nerdctl|containerd/.test(t) || /nerdctl/.test(rt) ? 'nerdctl' : 'docker';
  // Permission denied on the socket is its own cause — starting the daemon will not fix it.
  if (aboutSocket && /permission denied|operation not permitted/.test(t)) {
    return {
      cause: "The container runtime's socket refused this user (permission denied)",
      fix: which === 'docker'
        ? 'Add your user to the docker group (or run Docker/Rancher Desktop as this user), then re-check.'
        : 'Give your user access to the runtime socket, then re-check.',
    };
  }
  const daemonDown =
    /cannot connect to the docker daemon/.test(t) ||
    /failed to connect to the docker api/.test(t) ||
    /is the docker daemon running/.test(t) ||
    /cannot connect to podman/.test(t) ||
    /cannot connect to nerdctl|nerdctl.*cannot connect/.test(t) ||
    (/dial unix/.test(t) && aboutSocket && /no such file|connection refused/.test(t)) ||
    (aboutSocket && /connect: (?:no such file|connection refused)/.test(t));
  if (!daemonDown) return null;
  if (which === 'podman') return { cause: "Podman isn't running", fix: 'Start it (podman machine start), then re-check.' };
  if (which === 'nerdctl') return { cause: "The container runtime (nerdctl) isn't running", fix: 'Start it (Rancher Desktop, or containerd), then re-check.' };
  return { cause: "Docker isn't running", fix: 'Start Docker Desktop or Rancher Desktop (or your container runtime), then re-check.' };
}

/** Scrub every string in a parsed JSON value in place-by-copy (so the result re-serializes valid). */
function deepScrub(value: unknown, home: string): unknown {
  if (typeof value === 'string') return scrubHomePaths(value, home);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, home));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A path-keyed map (codex r1) scrubs its keys too; two keys that fold to one keep both values.
      const base = scrubHomePaths(k, home);
      let key = base;
      for (let n = 2; Object.hasOwn(out, key); n += 1) key = `${base} (${n})`;
      out[key] = deepScrub(v, home);
    }
    return out;
  }
  return value;
}

/**
 * The backstop: for GET responses to exactly the given `paths` (prefix-aware URLs; the query string
 * is ignored), rewrite every home path in the JSON body. Parsing the body and scrubbing its DECODED
 * string values keeps the payload valid JSON and handles JSON escaping (doubled backslashes, `\/`)
 * for free; a body we cannot parse is scrubbed as text so nothing leaks either way. Register once;
 * the hook is cheap and only runs for these four routes.
 */
export function registerUiTextScrub(app: FastifyInstance, paths: readonly string[], home: string = homedir()): void {
  const guarded = new Set(paths);
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET') return payload;
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (!guarded.has(path)) return payload;
    if (typeof payload !== 'string') return payload;
    const ct = String(reply.getHeader('content-type') ?? '');
    if (!ct.includes('application/json')) return payload;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      const text = scrubHomePaths(payload, home);
      reply.header('content-length', Buffer.byteLength(text));
      return text;
    }
    const out = JSON.stringify(deepScrub(parsed, home));
    reply.header('content-length', Buffer.byteLength(out));
    return out;
  });
}
