/**
 * The person's wicked home, `${WICKED_HOME:-~/.wicked}`, and the default dirs crew keeps under it (crew#1800,
 * crew#1802). One ladder for every such dir: the dir's own variable when set, else `<wicked home>/<name>`. A daemon
 * started on a scratch `WICKED_HOME` (a proof or test daemon) therefore never writes into the person's live home.
 * An empty value counts as unset (an empty override would otherwise name a relative dir).
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** `${WICKED_HOME:-~/.wicked}`, as spelled (not resolved): the base the global estate stores sit under. */
export function wickedHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['WICKED_HOME'];
  return home !== undefined && home !== '' ? home : join(homedir(), '.wicked');
}

/**
 * A default dir under the wicked home: `env[variable]` when set and non-empty, else `<wicked home>/<name>`. Always
 * absolute (resolved against the daemon's cwd): these dirs become workers' read and write roots, which the engine takes
 * only absolute.
 */
export function wickedHomeDir(variable: string, name: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[variable];
  if (explicit !== undefined && explicit !== '') return resolve(explicit);
  return resolve(wickedHome(env), name);
}
