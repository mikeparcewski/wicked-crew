import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deliverPrScript } from '../src/core/deliver.js';

const engine = vi.hoisted(() => ({ Core: { checkRunTree: undefined as ((...args: string[]) => Promise<string>) | undefined } }));
vi.mock('wicked-core-ts', () => engine);

it('T7 pins deliverPrScript byte for byte across resolver extraction', () => {
  const text = deliverPrScript('redeliver extraction pin', { originUrl: 'https://github.com/o/r.git', nonce: '0123456789abcdef' }).split(process.execPath).join('<node>');
  expect(createHash('sha256').update(text).digest('hex')).toBe('9a03dab226b635683a182cfeb70f41f857504223ab91828905981eb37835f7cc');
});
it('exports the single shared CHANGELOG rebase mechanism', async () => {
  const deliver = await import('../src/core/deliver.js');
  expect(deliver).toHaveProperty('CHANGELOG_REBASE_LINES');
});

it('reads Core.checkRunTree at call time and names an unsupported engine addon', async () => {
  const { checkRunTreeViaCore } = await import('../src/api/redeliver.js');
  await expect(checkRunTreeViaCore('run', '/tree', '/repo', 'a'.repeat(40))).rejects.toMatchObject({ status: 501, message: expect.stringContaining('unsupported') });
  engine.Core.checkRunTree = async () => JSON.stringify({ passed: true, head: 'checked' });
  await expect(checkRunTreeViaCore('run', '/tree', '/repo', 'a'.repeat(40))).resolves.toMatchObject({ passed: true, head: 'checked' });
});

it('(crew#1862) the refresh shell itself starts without the Azure DevOps credential and with fsmonitor off', async () => {
  const { runRefreshScript } = await import('../src/api/redeliver.js');
  const dir = mkdtempSync(join(tmpdir(), 'crew-1862-refresh-'));
  vi.stubEnv('AZURE_DEVOPS_EXT_PAT', 'pat-SECRET-0123456789abcdef'); // ggignore: a made-up test value
  vi.stubEnv('CREW_ADO_CLIENT_SECRET', 'sp-SECRET-value'); // ggignore: a made-up test value
  try {
    // Names only, never a value; what the login shell (and so its profile) was started with.
    const r = await runRefreshScript(dir, "printf 'names=[%s]\\n' \"$(env | grep -oE '^(AZURE_DEVOPS_EXT_PAT|CREW_ADO_[A-Z_]+)=' | tr -d '=' | tr '\\n' ' ')\"; printf 'fsmonitor=%s\\n' \"$(git config --get core.fsmonitor)\"");
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('names=[]');
    expect(r.output).toContain('fsmonitor=false');
    expect(r.output).not.toContain('SECRET');
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
