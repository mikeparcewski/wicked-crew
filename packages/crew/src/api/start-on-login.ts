/**
 * (studio#1324) Whether this daemon's port starts at login: the unit `wicked-crew serve --install-service` writes for
 * it (crew#1469, one per port: a launchd agent on macOS, a systemd user unit on Linux), read from where that command
 * writes it, and the commands that install and remove it. Studio's Settings shows it as a row; the install itself stays
 * a CLI step (it writes and loads a unit for the account, which a browser request should not do).
 */
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { StartOnLoginStatus } from 'wicked-crew-api-types';

import { INSTALL_SERVICE_FLAG, UNINSTALL_SERVICE_FLAG, installedService, servicePlatform, type ServicePlatform } from '../cli/service.js';
import { homeless } from './seat-standing.js';

export function startOnLoginStatus(port: number, platform: ServicePlatform = servicePlatform(), home: string = homedir()): StartOnLoginStatus {
  const unit = installedService(platform, home, port);
  // Always the port: without it `serve` takes `CREW_PORT` from the person's shell, which may name another daemon's unit.
  const serve = `wicked-crew serve --port ${port}`;
  return {
    platform,
    port,
    installed: unit !== null,
    unit: unit === null ? null : homeRelative(unit.unitPath, home),
    installCommand: `${serve} ${INSTALL_SERVICE_FLAG}`,
    uninstallCommand: `${serve} ${UNINSTALL_SERVICE_FLAG}`,
  };
}

/**
 * The unit path as `~/…`: the person's home path stays off the wire. Taken relative to the normalized home, because the
 * unit path is built with `join` (a home spelled `/home//alice` or with a `.` segment must still come off). A path that
 * is not under the home (never, as the unit is written there) falls back to the general redactor.
 */
function homeRelative(path: string, home: string): string {
  const rel = relative(resolve(home), resolve(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return homeless(path, home);
  return `~/${rel.split(sep).join('/')}`;
}
