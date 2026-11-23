/**
 * (studio#1324) Whether this daemon's port starts at login: the unit `wicked-crew serve --install-service` writes for
 * it (crew#1469, one per port: a launchd agent on macOS, a systemd user unit on Linux), read from where that command
 * writes it, and the commands that install and remove it. Studio's Settings shows it as a row; the install itself stays
 * a CLI step (it writes and loads a unit for the account, which a browser request should not do).
 */
import { homedir } from 'node:os';
import type { StartOnLoginStatus } from 'wicked-crew-api-types';

import { DEFAULT_DAEMON_PORT } from '../cli/port.js';
import { INSTALL_SERVICE_FLAG, UNINSTALL_SERVICE_FLAG, installedService, servicePlatform, type ServicePlatform } from '../cli/service.js';
import { homeless } from './seat-standing.js';

export function startOnLoginStatus(port: number, platform: ServicePlatform = servicePlatform(), home: string = homedir()): StartOnLoginStatus {
  const unit = installedService(platform, home, port);
  // The flag only off the default port: `serve --install-service` names the unit by the port it is given.
  const serve = `wicked-crew serve${port === DEFAULT_DAEMON_PORT ? '' : ` --port ${port}`}`;
  return {
    platform,
    port,
    installed: unit !== null,
    // Home-relative: the person's home path stays off the wire.
    unit: unit === null ? null : homeless(unit.unitPath, home),
    installCommand: `${serve} ${INSTALL_SERVICE_FLAG}`,
    uninstallCommand: `${serve} ${UNINSTALL_SERVICE_FLAG}`,
  };
}
