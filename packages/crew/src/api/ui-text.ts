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
 * Replace one home-dir spelling, used as a WHOLE path prefix, with `~`: `/Users/alice/.rd/x` →
 * `~/.rd/x`, but `/Users/alice2` (another user) is untouched. Covers the forward- and back-slash
 * spellings and the JSON-escaped (doubled-backslash) Windows form. The boundary lookahead keeps the
 * separator that follows, so the rest of the path survives.
 */
function replaceHome(text: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, '');
  if (trimmed === '') return text;
  const back = trimmed.replace(/\//g, '\\');
  const spellings = new Set([trimmed, trimmed.replace(/\\/g, '/'), back, back.replace(/\\/g, '\\\\')]);
  let out = text;
  // Longest first, so a parent never eats a child spelling's prefix.
  for (const h of [...spellings].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`${escapeRegExp(h)}(?=$|[\\\\/\\s"'),;:])`, 'g'), () => '~');
  }
  return out;
}

/**
 * Every home path in `text` becomes `~`. First the daemon's own home (and its realpath, so a
 * symlinked home like macOS's `/var` → `/private/var` is caught), then ANY remaining `/Users/<name>`,
 * `/home/<name>` or `C:\Users\<name>` — `<name>` is one path segment, either slash, any case of the
 * drive letter, and the forms that appear inside `unix:///Users/…` sockets and inside JSON strings
 * (a Windows path's backslashes doubled). Idempotent: the output carries no home path, so a second
 * pass is a no-op.
 */
export function scrubHomePaths(text: string, home: string = homedir()): string {
  if (text === '') return text;
  let out = replaceHome(text, home);
  try {
    const real = realpathSync(home);
    if (real !== home) out = replaceHome(out, real);
  } catch {
    // The home may not exist (tests inject a temp home that is never created); the generic pass below
    // still catches `/Users/<name>` etc.
  }
  // Windows `C:\Users\<name>` FIRST (before the `/Users/` pass can eat the slash form): any
  // drive-letter case, either slash, backslashes possibly doubled (a path inside a JSON string). The
  // lookbehind keeps `unix:` (the `x:` there is not a drive) from being read as one.
  out = out.replace(/(?<![A-Za-z])[A-Za-z]:(?:\\\\|[\\/])Users(?:\\\\|[\\/])[^\\/\s"'),;:]+/gi, () => '~');
  // Any other user's home: one path segment after `/Users/` or `/home/`, including inside a
  // `unix:///Users/…` URL. Only at a path's start (not after a word character, a dot or a dash), so
  // a web address such as `https://example.com/home/page` is left alone.
  out = out.replace(/(?<![\w.-])\/(?:Users|home)\/[^/\\\s"'),;:]+/gi, () => '~');
  return out;
}

/**
 * Classify a container-runtime error into a plain cause and its one fix, or `null` when we do not
 * recognise it (the caller keeps its own text, scrubbed). Recognises the daemon being unreachable
 * (Docker, Podman or nerdctl) and a permission-denied socket.
 */
export function plainRuntimeCause(raw: string): { cause: string; fix: string } | null {
  const t = raw.toLowerCase();
  const aboutSocket = /\.sock\b/.test(t) || /docker\.sock/.test(t) || /docker api|docker daemon/.test(t);
  // Permission denied on the socket is its own cause — starting the daemon will not fix it.
  if (aboutSocket && /permission denied|operation not permitted/.test(t)) {
    return {
      cause: "The container runtime's socket refused this user (permission denied)",
      fix: 'Add your user to the docker group (or run Docker/Rancher Desktop as this user), then re-check.',
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
  if (daemonDown) {
    return {
      cause: "Docker isn't running",
      fix: 'Start Docker Desktop or Rancher Desktop (or your container runtime), then re-check.',
    };
  }
  return null;
}

/** Scrub every string in a parsed JSON value in place-by-copy (so the result re-serializes valid). */
function deepScrub(value: unknown, home: string): unknown {
  if (typeof value === 'string') return scrubHomePaths(value, home);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, home));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepScrub(v, home);
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
