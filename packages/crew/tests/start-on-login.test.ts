// studio#1324: Settings' start-on-login row reads whether this daemon's port has the unit `serve --install-service`
// writes (crew#1469), from where that command writes it, and the commands that install and remove it.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startOnLoginStatus } from '../src/api/start-on-login.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { renderPlist, renderSystemdUnit, serviceUnitPath, type ServicePlatform, type ServiceSpec } from '../src/cli/service.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const r of roots.splice(0)) removeScratch(r);
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'crew-start-on-login-'));
  roots.push(h);
  return h;
}

/** Install the unit exactly where, and as, `installService` writes it (src/cli/service.ts). */
function install(platform: Exclude<ServicePlatform, 'other'>, h: string, port: number): void {
  const spec: ServiceSpec = { port, program: ['/usr/bin/node', '/opt/crew/dist/cli/index.js', 'serve', '--port', String(port)], env: { PATH: '/usr/bin' }, logPath: join(h, '.wicked-crew', 'daemon.log'), workingDir: h };
  const path = serviceUnitPath(platform, h, port)!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, platform === 'darwin' ? renderPlist(spec) : renderSystemdUnit(spec));
}

describe('startOnLoginStatus (studio#1324)', () => {
  it('reads the unit for this port where serve --install-service writes it, home-relative', () => {
    const h = home();
    expect(startOnLoginStatus(7701, 'darwin', h)).toEqual({
      platform: 'darwin', port: 7701, installed: false, unit: null,
      installCommand: 'wicked-crew serve --install-service', uninstallCommand: 'wicked-crew serve --uninstall-service',
    });
    install('darwin', h, 7701);
    expect(startOnLoginStatus(7701, 'darwin', h)).toMatchObject({ installed: true, unit: '~/Library/LaunchAgents/com.wickedagile.wicked-crew.plist' });
    // One unit per port: another port's unit is not this daemon's.
    expect(startOnLoginStatus(7741, 'darwin', h)).toMatchObject({ installed: false, installCommand: 'wicked-crew serve --port 7741 --install-service' });
    install('linux', h, 7741);
    expect(startOnLoginStatus(7741, 'linux', h)).toEqual({
      platform: 'linux', port: 7741, installed: true, unit: '~/.config/systemd/user/wicked-crew-7741.service',
      installCommand: 'wicked-crew serve --port 7741 --install-service', uninstallCommand: 'wicked-crew serve --port 7741 --uninstall-service',
    });
  });

  it('elsewhere nothing is automated: never installed, the command still prints its recipe', () => {
    expect(startOnLoginStatus(7701, 'other', home())).toMatchObject({ platform: 'other', installed: false, unit: null, installCommand: 'wicked-crew serve --install-service' });
  });

  it('GET /settings/start-on-login answers it for this daemon', async () => {
    const h = home();
    install('linux', h, 7701);
    const app = Fastify();
    apps.push(app);
    registerRoutes(app, { getSettings: async () => ({}) } as unknown as CoreAdapter, new GateCache(), new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'off' },
      { startOnLogin: { platform: 'linux', home: h } });
    const res = await app.inject('/api/v1/settings/start-on-login');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      platform: 'linux', port: 7701, installed: true, unit: '~/.config/systemd/user/wicked-crew.service',
      installCommand: 'wicked-crew serve --install-service', uninstallCommand: 'wicked-crew serve --uninstall-service',
    });
    expect(res.body).not.toContain(h);
  });
});
