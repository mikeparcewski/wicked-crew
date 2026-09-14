// The daemon port, resolved ONE way for every verb (F-W1-101, wave-1 gate P1 — FIX-IT-ALL L10).
//
// `wicked-crew serve` honoured `--port <n>`, else `CREW_PORT`, else 7701 — but `status` and `gate`
// read only `--port` and fell back to 7701, so on a host running the daemon on `CREW_PORT=<other>`
// `wicked-crew status` queried the DEFAULT port, found a stranger's daemon there, and exited 0
// reporting ANOTHER daemon's runs. One resolver, imported by the boot and by every daemon-client
// verb, no second env read anywhere (D2 — one mechanism per concern); a test pins that the CLI has
// exactly one `CREW_PORT` read and that this is it.
//
// Semantics are `serve`'s, unchanged: a present `--port` wins; else a present `CREW_PORT` (even
// `CREW_PORT=` → `Number('') === 0`, which `serve` already meant as "an ephemeral port"); else 7701.

/** The default daemon port when neither `--port` nor `CREW_PORT` is given. */
export const DEFAULT_DAEMON_PORT = 7701;

/** The env variable `serve` — and therefore every client verb — honours for the daemon port. */
export const DAEMON_PORT_ENV = 'CREW_PORT';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Where the daemon port came from and the raw spelling — for messages that name the input. */
export interface DaemonPortSource {
  /** The raw value as given (`--port` argument or the env variable), or `undefined` for the default. */
  raw: string | undefined;
  from: '--port' | typeof DAEMON_PORT_ENV | 'default';
}

/**
 * The one read of `--port` / `CREW_PORT` (review-L10-604 MED: a display-only
 * `process.env[DAEMON_PORT_ENV]` in the `mcp` error text was a second read of the same variable —
 * every consumer, including error text, goes through here).
 */
export function daemonPortSource(args: string[], env: NodeJS.ProcessEnv = process.env): DaemonPortSource {
  const fromArgs = flagValue(args, '--port');
  if (fromArgs !== undefined) return { raw: fromArgs, from: '--port' };
  const fromEnv = env[DAEMON_PORT_ENV];
  if (fromEnv !== undefined) return { raw: fromEnv, from: DAEMON_PORT_ENV };
  return { raw: undefined, from: 'default' };
}

/** `--port <n>` › `CREW_PORT` › 7701 — the one place the daemon port is decided. */
export function resolveDaemonPort(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const { raw } = daemonPortSource(args, env);
  return raw !== undefined ? Number(raw) : DEFAULT_DAEMON_PORT;
}
