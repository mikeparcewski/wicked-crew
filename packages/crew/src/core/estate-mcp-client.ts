/**
 * The estate-MCP proposal-queue client (DES-MEM-FACETED-001 §5.0).
 *
 * # Why this exists
 *
 * The proposal queue (`proposal.list` / `proposal.approve` / `proposal.reject`, estate #162) lives
 * ONLY on the estate MCP server — a JSON-RPC 2.0 process that speaks newline-delimited frames over
 * stdio. Crew already reaches estate two other ways, and NEITHER carries these tools: the
 * `wicked-estate` CLI (`projects/graph.ts` — indexing/query subcommands) and the wicked-core napi
 * addon (the run engine). So the queue needs its own small client, and this is it.
 *
 * # The operator posture — NON-`--readonly`
 *
 * This is the OPERATOR surface: it must list, approve, AND reject. `proposal.approve` /
 * `proposal.reject` mutate the active store / decide the queue, which the estate server REFUSES
 * under `--readonly` (a -32601 backstop — see `wicked-estate-mcp/tests/proposals.rs`). So the
 * server is spawned with NO `--readonly` flag. This is the deliberate inverse of the governed
 * WORKER grounding client (DES-GROUNDING-001), which allow-lists the estate MCP `--readonly`
 * precisely so a worker can never mutate the operator's stores.
 *
 * `WICKED_MEMORY_DB` is pinned to the operator global store (`${WICKED_HOME:-~/.wicked}/memory.db`,
 * matching the server's own default in `wicked-estate-mcp/src/main.rs`) so the queue is read/written
 * where the operator's memories actually live, regardless of the daemon's cwd/home.
 *
 * # Framing (mirrors `wicked-estate-mcp/src/main.rs`)
 *
 * The server reads one JSON object per line on stdin and writes one response object per line on
 * stdout. A NOTIFICATION (no `id`) produces no output. The handshake is
 * `initialize` (id 1) → `notifications/initialized` → `tools/call` (id 2); the tool result is
 * wrapped in the MCP envelope `{ content: [{ type:'text', text: '<json>' }], isError }`, and a
 * failure is a JSON-RPC `error` object. Spawn-per-call is fine for v1: the queue is an operator
 * action, not a hot path.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The MCP protocol version crew declares in the handshake (the version the estate server speaks). */
export const ESTATE_MCP_PROTOCOL_VERSION = '2024-11-05';

/** JSON-RPC ids for the two request frames (the notification carries none). */
const INITIALIZE_ID = 1;
const TOOLS_CALL_ID = 2;

/** The handshake + call must complete inside this budget or the child is killed and the call fails.
 *  Generous because a cold `wicked-estate-mcp` may open a SQLite store on first use, but finite so
 *  a wedged/absent binary fails loudly instead of hanging the request. */
export const DEFAULT_ESTATE_MCP_TIMEOUT_MS = 30_000;

const CLIENT_NAME = 'wicked-crew';

/** Crew's own version for the handshake `clientInfo`. Read from package.json the same way
 *  `api/routes.ts` reads it (works under both the `src` and compiled `dist` layouts); a read
 *  failure is non-fatal — the server ignores `clientInfo` — so it degrades to a placeholder. */
const CLIENT_VERSION: string = ((): string => {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** A JSON-RPC error surfaced by the estate MCP (or a transport failure reaching it). `code` is the
 *  JSON-RPC error code when the failure came back as a JSON-RPC `error` (e.g. -32602 invalid
 *  params, -32601 method refused under --readonly, -32603 internal), absent for a transport fault. */
export class EstateMcpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'EstateMcpError';
    if (code !== undefined) this.code = code;
  }
}

/** Injectable IO — tests substitute a fake MCP (a spawned node script) for the real `wicked-estate-mcp`. */
export interface EstateMcpIo {
  /** Spawn the server process (stdio piped). Defaults to `wicked-estate-mcp`, NON-`--readonly`,
   *  with `WICKED_MEMORY_DB` pinned to the operator global store. */
  spawn?: () => ChildProcess;
  /** Overall deadline for the handshake + call round-trip. Defaults to {@link DEFAULT_ESTATE_MCP_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** `wicked-estate-mcp`, overridable via `WICKED_ESTATE_MCP_EXE` (mirrors `WICKED_ESTATE_EXE` in
 *  `projects/graph.ts` and `WICKED_CORE_EXE` in the adapter). */
export function estateMcpExe(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['WICKED_ESTATE_MCP_EXE'];
  return override !== undefined && override !== '' ? override : 'wicked-estate-mcp';
}

/** The operator global memory store path: `WICKED_MEMORY_DB` wins, else `${WICKED_HOME:-~/.wicked}/memory.db`. */
export function resolveMemoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['WICKED_MEMORY_DB'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const home = env['WICKED_HOME'];
  const base = home !== undefined && home !== '' ? home : join(homedir(), '.wicked');
  return join(base, 'memory.db');
}

/** The default spawn: `wicked-estate-mcp` with no `--readonly` flag and WICKED_MEMORY_DB pinned. */
function defaultSpawn(env: NodeJS.ProcessEnv): ChildProcess {
  return nodeSpawn(estateMcpExe(env), [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, WICKED_MEMORY_DB: resolveMemoryDbPath(env) },
    windowsHide: true,
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Build an {@link EstateMcpError} from a JSON-RPC `error` object. */
function estateErrorFrom(err: Record<string, unknown>): EstateMcpError {
  const message = typeof err['message'] === 'string' ? err['message'] : 'unknown estate-mcp error';
  return typeof err['code'] === 'number' ? new EstateMcpError(message, err['code']) : new EstateMcpError(message);
}

/** Unwrap the `id:2` response: a JSON-RPC `error` throws; otherwise parse the MCP tool-result
 *  envelope's inner JSON text (`result.content[0].text`) and return it. An `isError:true` envelope
 *  (the R1 convention) is a failure too. */
function unwrapToolResult(msg: Record<string, unknown>): unknown {
  if (isRecord(msg['error'])) throw estateErrorFrom(msg['error']);
  const result = msg['result'];
  if (!isRecord(result)) {
    throw new EstateMcpError('estate-mcp returned a response with no result');
  }
  const content = result['content'];
  const first = Array.isArray(content) ? content[0] : undefined;
  if (!isRecord(first) || typeof first['text'] !== 'string') {
    throw new EstateMcpError('estate-mcp tool result had no text content');
  }
  const text = first['text'];
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new EstateMcpError(`estate-mcp tool result text was not JSON: ${text}`);
  }
  if (result['isError'] === true) {
    const detail = isRecord(payload) && typeof payload['message'] === 'string' ? payload['message'] : text;
    throw new EstateMcpError(detail);
  }
  return payload;
}

/**
 * Call one `proposal.*` tool on the estate MCP and return its unwrapped result.
 *
 * Spawns the server, performs the handshake, issues the `tools/call`, reads the id-2 response
 * (line-buffered), unwraps the MCP envelope, then closes stdin and kills the child. Throws
 * {@link EstateMcpError} on a JSON-RPC error, a malformed response, an early process exit, a spawn
 * failure, or the timeout.
 */
export async function callEstateProposalTool(
  tool: string,
  args: Record<string, unknown>,
  io: EstateMcpIo = {},
): Promise<unknown> {
  const child = (io.spawn ?? (() => defaultSpawn(process.env)))();
  const timeoutMs = io.timeoutMs ?? DEFAULT_ESTATE_MCP_TIMEOUT_MS;

  return new Promise<unknown>((resolvePromise, rejectPromise) => {
    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        rejectPromise(new EstateMcpError(`wicked-estate-mcp did not answer ${tool} within ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    if (child.stdout === null || child.stdin === null) {
      finish(() => rejectPromise(new EstateMcpError('wicked-estate-mcp spawned without stdio pipes')));
      return;
    }
    const stdin = child.stdin;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        if (line === '') continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON noise on stdout — ignore, keep scanning for our id
        }
        if (!isRecord(msg)) continue;
        const id = msg['id'];
        if (id === TOOLS_CALL_ID) {
          finish(() => {
            try {
              resolvePromise(unwrapToolResult(msg));
            } catch (err) {
              rejectPromise(err);
            }
          });
          return;
        }
        // A failure of the handshake itself (initialize error, or a parse error with id:null)
        // arrives before the tool result and is fatal — surface it rather than time out.
        if ((id === INITIALIZE_ID || id === null) && isRecord(msg['error'])) {
          finish(() => rejectPromise(estateErrorFrom(msg['error'] as Record<string, unknown>)));
          return;
        }
      }
    });

    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => {
        stderrBuf += c;
      });
    }

    child.on('error', (err) => {
      finish(() => rejectPromise(new EstateMcpError(`failed to spawn wicked-estate-mcp: ${err.message}`)));
    });
    child.on('close', () => {
      finish(() =>
        rejectPromise(
          new EstateMcpError(
            `wicked-estate-mcp exited before answering ${tool}` +
              (stderrBuf.trim() !== '' ? `: ${stderrBuf.trim()}` : ''),
          ),
        ),
      );
    });

    // Handshake + call, then EOF so the server drains its buffered lines and exits cleanly.
    const write = (obj: unknown): void => {
      stdin.write(`${JSON.stringify(obj)}\n`);
    };
    write({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: ESTATE_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    write({ jsonrpc: '2.0', id: TOOLS_CALL_ID, method: 'tools/call', params: { name: tool, arguments: args } });
    stdin.end();
  });
}
