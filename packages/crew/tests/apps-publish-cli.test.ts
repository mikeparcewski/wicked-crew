// (DES-APPS-001 §9.3, K6) The commands an `apps-publish` run's Tool units run (`wicked-crew apps-check --publish`,
// `wicked-crew apps-produce`): they post the unit's token to crew and exit 0 only when the step passed.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runAppsCheck, runAppsProduce } from '../src/cli/apps.js';

describe('the publish step commands', () => {
  let server: Server;
  const seen: Array<{ path: string; body: unknown }> = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    vi.stubEnv('WICKED_CREW_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    vi.stubEnv('WICKED_MCP_TOKEN', 'unit-token');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const quiet = () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => void out.push(String(m)));
    return out;
  };

  it('apps-check --publish posts the token and passes only on ok, printing the consent card', async () => {
    const out = quiet();
    answer = { status: 200, body: { ok: true, card: 'Share link: https://esc.example.com/', findings: [] } };
    expect(await runAppsCheck(['--publish'])).toBe(0);
    expect(seen.at(-1)).toEqual({ path: '/api/v1/apps/publish/check', body: { token: 'unit-token' } });
    expect(out.join('\n')).toContain('Share link: https://esc.example.com/');
    answer = { status: 200, body: { ok: false, card: 'c', findings: [{ code: 'manifest_changed', message: 'what this publish would ship changed' }] } };
    expect(await runAppsCheck(['--publish'])).toBe(1);
    answer = { status: 403, body: { code: 'not_this_step', error: 'no' } };
    expect(await runAppsCheck(['--publish'])).toBe(1);
    expect(await runAppsCheck([])).toBe(2); // the turn check is not this command's yet
    vi.restoreAllMocks();
  });

  it('apps-produce passes only when crew recorded the publish, and prints the share link', async () => {
    const out = quiet();
    answer = { status: 200, body: { published: { shareUrl: 'https://esc.example.com/', image: { tag: 'wicked-apps/esc:v3', id: 'sha256:x' }, run: { env: ['APPS_SRC_A_PASSWORD'], volume: '/data', port: 8080 } } } };
    expect(await runAppsProduce()).toBe(0);
    expect(seen.at(-1)?.path).toBe('/api/v1/apps/publish/produce');
    expect(out.join('\n')).toMatch(/Share link: https:\/\/esc\.example\.com\/[\s\S]*-e APPS_SRC_A_PASSWORD=… -v <volume>:\/data wicked-apps\/esc:v3/);
    answer = { status: 503, body: { code: 'no_runtime', error: 'no runtime' } };
    expect(await runAppsProduce()).toBe(1);
    vi.unstubAllEnvs();
    expect(await runAppsProduce()).toBe(2); // not a run step
    vi.restoreAllMocks();
  });
});
