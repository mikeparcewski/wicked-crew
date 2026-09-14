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

/** `--port <n>` › `CREW_PORT` › 7701 — the one place the daemon port is decided. */
export function resolveDaemonPort(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const raw = flagValue(args, '--port') ?? env[DAEMON_PORT_ENV];
  return raw !== undefined ? Number(raw) : DEFAULT_DAEMON_PORT;
}
