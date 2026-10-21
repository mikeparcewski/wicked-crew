import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes, type UnitRouteDeps } from '../src/api/mcp.js';
import { registerJsonParser } from '../src/api/json-parser.js';
import { createUnitListener, unitPortFromEnv } from '../src/api/unit-listener.js';
import { startServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { AskError, type AskAdapter, type AskUnit } from '../src/core/types.js';
import { AskServer } from '../src/mcp/ask-server.js';
import { removeScratch } from './setup/scratch.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

function deps() {
  const askUnit = vi.fn<AskAdapter['askUnit']>(async (token) => {
    if (token !== 'wmt_valid') throw new AskError('invalid_token', 'invalid token');
    return { runId: 'run', ord: 1, attempt: 0, seat: 'codex', timeoutSecs: 5 } satisfies AskUnit;
  });
  const call = vi.fn(async ({ token }: { token: string }) => token === 'wmt_valid'
    ? { status: 200, body: { ok: true } }
    : { status: 401, body: { code: 'invalid_token' } });
  const d = {
    askServer: new AskServer({ adapter: { askUnit, openAsk: vi.fn(), closeAsk: vi.fn() } }),
    broker: { call } as unknown as NonNullable<UnitRouteDeps['broker']>,
    registry: { callableTools: async () => [] } as unknown as NonNullable<UnitRouteDeps['registry']>,
    toolLister: () => async (json: string) => {
      if ((JSON.parse(json) as { token: string }).token !== 'wmt_valid') throw new Error('invalid_token');
      return JSON.stringify({ unit: { runId: 'run', ord: 1, attempt: 0, phase: 'build', seat: 'codex' }, tools: [] });
    },
  } satisfies UnitRouteDeps;
  return { d, askUnit, call };
}

async function pair() {
  const f = deps();
  const main = Fastify();
  registerJsonParser(main);
  const audit = vi.fn();
  registerMcpRoutes(main, { ...f.d, audit: { record: audit }, actorOf: () => LOCAL_ACTOR });
  const unit = createUnitListener(f.d);
  cleanups.push(() => main.close(), () => unit.close());
  return { ...f, main, unit, audit };
}

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const askBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('isolated unit routes', () => {
  it.each(['wmt_valid', 'wmt_invalid'])('matches all five main routes with %s', async (token) => {
    const { main, unit } = await pair();
    // The MCP SDK writes to real Node HTTP streams; Fastify injection's mock socket
    // does not implement the transport's draining/close behavior.
    const mainOrigin = await main.listen({ port: 0, host: '127.0.0.1' });
    const unitOrigin = await unit.listen({ port: 0, host: '127.0.0.1' });
    for (const [method, path, payload] of [
      ['POST', 'call', { token, subject: 'mcp:fixture/tool' }],
      ['POST', 'tools', { token }],
      ['POST', 'ask', askBody],
      ['GET', 'ask', undefined],
      ['DELETE', 'ask', undefined],
    ] as const) {
      const request = { method, headers: { ...headers, authorization: `Bearer ${token}` }, ...(payload ? { body: JSON.stringify(payload) } : {}) };
      const a = await fetch(`${mainOrigin}/api/v1/mcp/${path}`, request);
      const b = await fetch(`${unitOrigin}/api/v1/mcp/${path}`, request);
      expect(b.status).toBe(a.status);
      expect(await b.text()).toBe(await a.text());
      expect(b.headers.get('allow')).toBe(a.headers.get('allow'));
      expect(b.status).toBe(method !== 'POST' ? 405 : token === 'wmt_invalid' ? 401 : 200);
    }
  });

  it.each(['', '{malformed'])('shares empty and malformed JSON parsing (%j)', async (payload) => {
    const { main, unit } = await pair();
    for (const path of ['call', 'tools', 'ask']) {
      const request = { method: 'POST' as const, url: `/api/v1/mcp/${path}`, headers, payload };
      const a = await main.inject(request);
      const b = await unit.inject(request);
      expect([b.statusCode, b.body]).toEqual([a.statusCode, a.body]);
    }
  });

  it('404s operator routes and unexpected methods before parsing or touching state', async () => {
    const { unit, audit, call, askUnit } = await pair();
    for (const [method, url] of [
      ['GET', '/api/v1/runs'], ['POST', '/api/v1/runs/run/gate'], ['GET', '/api/v1/settings'],
      ['GET', '/api/v1/editors'], ['GET', '/api/v1/mcp/servers'], ['POST', '/api/v1/mcp/approvals'],
      ['HEAD', '/api/v1/mcp/ask'], ['OPTIONS', '/api/v1/mcp/ask'], ['PUT', '/api/v1/mcp/call'],
      ['POST', '/api/v1/mcp/call/'], ['POST', '/api/v1/mcp/%63all'],
    ] as const) {
      const res = await unit.inject({ method, url, headers, ...(method === 'POST' || method === 'PUT' ? { payload: '{malformed' } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    for (const spy of [audit, call, askUnit]) expect(spy).not.toHaveBeenCalled();
  });
});

async function boot() {
  const scratch = mkdtempSync(join(tmpdir(), 'crew-unit-boot-'));
  cleanups.push(() => removeScratch(scratch));
  const adapter = {
    stub: true, dbPath: join(scratch, 'core.db'), projectsSupported: () => false,
    getSettings: async () => ({}), ping: async () => 'ok',
    sessionsDetail: vi.fn(async () => []), confirmGate: vi.fn(), updateSettings: vi.fn(),
    onLaunch: () => () => {}, onEvent: () => () => {},
  } as unknown as CoreAdapter;
  const started = await startServer(adapter, 0, '127.0.0.1', {
    auth: { mode: 'off' }, auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true }, interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false }, studioRoot: join(scratch, 'no-studio'),
  });
  cleanups.push(() => started.app.close());
  return { ...started, adapter };
}

describe('unit listener boot', () => {
  it.each(['', '0', '-1', '65536', '1.2', ' 123', 'abc'])('rejects invalid port %j', (value) => {
    expect(() => unitPortFromEnv(value)).toThrow('WICKED_CREW_UNIT_PORT');
  });

  it('rejects an invalid port before touching the engine or advertising an endpoint', async () => {
    vi.stubEnv('WICKED_CREW_UNIT_PORT', 'invalid');
    vi.stubEnv('WICKED_CREW_URL', 'prior-main');
    vi.stubEnv('WICKED_SEAT_UNIT_URL', 'prior-unit');
    const adapter = new Proxy({} as CoreAdapter, {
      get: () => { throw new Error('invalid configuration must fail before engine access'); },
    });
    await expect(startServer(adapter, 0)).rejects.toThrow('WICKED_CREW_UNIT_PORT');
    expect(process.env['WICKED_CREW_URL']).toBe('prior-main');
    expect(process.env['WICKED_SEAT_UNIT_URL']).toBe('prior-unit');
  });

  it('exports the bound unit origin, serves ask there, reports the port, and closes both sockets', async () => {
    vi.stubEnv('WICKED_CREW_UNIT_PORT', undefined);
    vi.stubEnv('WICKED_CREW_URL', 'prior');
    vi.stubEnv('WICKED_SEAT_UNIT_URL', 'prior');
    const settingsPath = process.env['WICKED_CREW_SYSTEM_SETTINGS'];
    if (!settingsPath) throw new Error('hermetic settings path missing');
    writeFileSync(settingsPath, '{"unchanged":true}');
    const settingsBefore = readFileSync(settingsPath, 'utf8');
    const started = await boot();
    const origin = `http://127.0.0.1:${started.unit.port}`;
    expect(started.unit.port).not.toBe(started.port);
    expect(process.env['WICKED_CREW_URL']).toBe(origin);
    expect(process.env['WICKED_SEAT_UNIT_URL']).toBe(origin);
    for (const [method, path] of [['GET', '/runs'], ['POST', '/runs/run/gate'], ['GET', '/settings']] as const) {
      const res = await fetch(`${origin}/api/v1${path}`, { method, headers,
        ...(method === 'POST' ? { body: JSON.stringify({ approve: true, action: 'approve' }) } : {}) });
      expect(res.status).toBe(404);
    }
    expect(readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    expect(started.adapter.sessionsDetail).not.toHaveBeenCalled();
    expect(started.adapter.confirmGate).not.toHaveBeenCalled();
    const ask = await fetch(`${process.env['WICKED_CREW_URL']}/api/v1/mcp/ask`, { method: 'POST', headers, body: JSON.stringify(askBody) });
    const mainAsk = await started.app.inject({ method: 'POST', url: '/api/v1/mcp/ask', headers, payload: askBody });
    expect([ask.status, await ask.text()]).toEqual([mainAsk.statusCode, mainAsk.body]);
    expect((await started.app.inject('/api/v1/health')).json()).toMatchObject({ unitPort: started.unit.port });
    expect((await started.app.inject('/api/v1/diagnostics')).json()).toMatchObject({ daemon: { port: started.port, unitPort: started.unit.port } });
    await started.app.close();
    await expect(fetch(`${origin}/api/v1/mcp/ask`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${started.port}/api/v1/health`)).rejects.toThrow();
  });

  it('fails an occupied fixed unit port without advertising a new endpoint', async () => {
    const occupied: FastifyInstance = Fastify();
    await occupied.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => occupied.close());
    const address = occupied.server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');
    vi.stubEnv('WICKED_CREW_UNIT_PORT', String(address.port));
    vi.stubEnv('WICKED_CREW_URL', 'prior-main');
    vi.stubEnv('WICKED_SEAT_UNIT_URL', 'prior-unit');
    await expect(boot()).rejects.toThrow(`unit 127.0.0.1:${address.port}`);
    expect(process.env['WICKED_CREW_URL']).toBe('prior-main');
    expect(process.env['WICKED_SEAT_UNIT_URL']).toBe('prior-unit');
  });
});
