// Slice B / FINDINGS C3a,B2: the infra rows word their causes at the source. The gateway row says a
// plain cause (never the raw docker line or a home path); the estate row says estate is NEEDED to add
// a repository, with the one install command.
import { describe, expect, it } from 'vitest';

import { probeEstate, probeGateway } from '../src/api/system-snapshot.js';
import { ESTATE_INSTALL_HINT } from '../src/core/estate-mcp-client.js';
import { expectNoHomePaths } from './fr-privacy-helpers.js';

const base = { containerFloor: true, gatewayDir: '/state/gateway', runtime: '/usr/bin/docker', timeoutMs: 50 };

describe('probeGateway (FINDINGS C3a)', () => {
  it('the Rancher daemon-down error with a home socket path → "Docker isn\'t running", no unix://, no home path', async () => {
    const row = await probeGateway({
      ...base,
      exec: async () => {
        throw new Error(
          'failed to connect to the docker API at unix:///Users/alice/.rd/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/alice/.rd/docker.sock: connect: no such file or directory',
        );
      },
    });
    expect(row.state).toBe('down');
    expect(row.reason).toBe("Docker isn't running");
    expect(row.reason).not.toMatch(/unix:\/\//);
    expect(row.remedy ?? '').toMatch(/Start Docker/);
    // The row (details included) carries no home path, even though the raw error did.
    expectNoHomePaths(JSON.stringify(row));
  });
});

describe('probeEstate (FINDINGS B2)', () => {
  const store = { path: '/state/mem.db', source: 'default', notice: null };
  const call = async (): Promise<Record<string, unknown>> => ({});

  it('no binary → the row says estate is NEEDED for repositories, with the one install command', async () => {
    const row = await probeEstate({ memoryStore: store, resolvable: () => false, exists: async () => false, call });
    expect(row.state).toBe('down');
    expect(row.reason).toMatch(/wicked-estate isn't installed/);
    expect(row.reason).toMatch(/code map/);
    expect(row.reason).not.toMatch(/optional/);
    expect(row.remedy ?? '').toMatch(/npx wicked-installer install wicked-estate/);
  });

  it('the shared install hint names the one command', () => {
    expect(ESTATE_INSTALL_HINT).toMatch(/npx wicked-installer install wicked-estate/);
    expect(ESTATE_INSTALL_HINT).toMatch(/WICKED_ESTATE_MCP_EXE/);
  });
});
