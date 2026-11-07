// CS9: the crew web source. Each guard below has a test that fails without it: the egress proxy's connect-time
// address check (rebinding included), its 2 MB cap and its credential stripping; the record and audit line with
// the URL and the time; the plain refusal with no container engine; and "Agents can query" OFF until a person
// turns it on.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { type AddressInfo, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { Actor } from '../src/core/types.js';
import { EgressProxy, WEB_DOWNLOAD_CAP_BYTES } from '../src/knowledge/adapters/web/egress.js';
import { detectEngine, NO_ENGINE_REASON } from '../src/knowledge/adapters/web/engine.js';
import { clampText, FETCH_MAX_CHARS, FETCH_TEXT_MAX, fetchArgs, fetchArgv, fetchEnv, installEnv, installVenv, pipArgs, READER_BOOTSTRAP, READER_DECODED_MAX, readLock } from '../src/knowledge/adapters/web/fetch.js';
import { WebGate, WEB_SOURCE } from '../src/knowledge/adapters/web/gate-web.js';
import { registerWebSourceRoutes } from '../src/knowledge/adapters/web/routes.js';
import { createArgs, searchHits, searxngSettings, SEARXNG_DIGEST, SearxngService } from '../src/knowledge/adapters/web/searxng.js';
import { type FetchOutcome, WebSource, WebSourceRefusal } from '../src/knowledge/adapters/web/source.js';
import { GateSchedulers } from '../src/knowledge/gate/scheduler.js';
import { isGatedSource, setAgentAccess } from '../src/knowledge/gate/sources.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import type { Resolver } from '../src/sources/dialer.js';

const LOOPBACK = { allow: ['127.0.0.0/8'], plaintext: true };

function table(map: Record<string, string[] | (() => string[])>): Resolver & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const r = (async (host: string) => {
    calls[host] = (calls[host] ?? 0) + 1;
    const v = map[host];
    return typeof v === 'function' ? v() : (v ?? []);
  }) as Resolver & { calls: Record<string, number> };
  r.calls = calls;
  return r;
}

const servers: Server[] = [];
const proxies: EgressProxy[] = [];
afterEach(async () => {
  for (const p of proxies.splice(0)) await p.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** A local upstream that records what it was sent. */
async function upstream(handler: (path: string, res: import('node:http').ServerResponse) => void): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const srv = createHttpServer((req, res) => {
    seen.push(req.headers);
    handler(req.url ?? '/', res);
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { port: (srv.address() as AddressInfo).port, seen };
}

/** One raw request through the proxy; answers everything the proxy and upstream sent until close. */
function raw(proxyPort: number, text: string, tunnel?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, '127.0.0.1');
    let out = '';
    let tunnelled = false;
    sock.on('data', (c: Buffer) => {
      out += c.toString('latin1');
      if (tunnel !== undefined && !tunnelled && out.startsWith('HTTP/1.1 200')) {
        tunnelled = true;
        sock.write(tunnel);
      }
    });
    sock.on('close', () => resolve(out));
    sock.on('error', (e) => (out === '' ? reject(e) : resolve(out)));
    sock.write(text);
  });
}

const basic = (proxyUrl: string): string => {
  const u = new URL(proxyUrl);
  return `Proxy-Authorization: Basic ${Buffer.from(`${u.username}:${u.password}`).toString('base64')}\r\n`;
};

describe('the egress proxy (connect-time checks)', () => {
  it('refuses a private and a metadata address, and a name that resolves to one, under the production policy', async () => {
    const resolver = table({ 'meta.example': ['169.254.169.254'], 'intranet.example': ['10.0.0.5'] });
    const proxy = new EgressProxy({ resolver });
    proxies.push(proxy);
    const port = await proxy.start();
    const s = await proxy.open();
    for (const target of ['meta.example:443', 'intranet.example:443', '10.0.0.5:443', '169.254.169.254:443']) {
      const out = await raw(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${basic(s.proxyUrl)}\r\n`);
      expect(out.startsWith('HTTP/1.1 403'), target).toBe(true);
    }
    const r = proxy.close(s);
    expect(r.hosts).toEqual([]);
    expect(r.refused.map((x) => x.code)).toEqual(['address_refused', 'address_unconfirmed', 'address_unconfirmed', 'address_refused']);
  });

  it('closes DNS rebinding: one resolution per connection, and the socket goes to the checked address', async () => {
    const up = await upstream((_p, res) => res.end('page'));
    let n = 0;
    // First answer: the (test-confirmed) local server. Every later answer: the metadata address.
    const resolver = table({ 'rebind.example': () => (n++ === 0 ? ['127.0.0.1'] : ['169.254.169.254']) });
    const proxy = new EgressProxy({ resolver, policy: LOOPBACK, ports: { connect: [up.port], http: [up.port] } });
    proxies.push(proxy);
    const port = await proxy.start();
    const s = await proxy.open();
    const out = await raw(port, `GET http://rebind.example:${up.port}/x HTTP/1.1\r\nHost: rebind.example\r\n${basic(s.proxyUrl)}\r\n`);
    expect(out).toContain('page');
    expect(resolver.calls['rebind.example']).toBe(1);
    // The next connection resolves again and is refused: the name now points at metadata.
    const again = await raw(port, `GET http://rebind.example:${up.port}/y HTTP/1.1\r\nHost: rebind.example\r\n${basic(s.proxyUrl)}\r\n`);
    expect(again.startsWith('HTTP/1.1 403')).toBe(true);
    expect(up.seen).toHaveLength(1);
    expect(proxy.close(s).refused[0]?.code).toBe('address_refused');
  });

  it('refuses any port but 443 (CONNECT) and 80 (http) in production', async () => {
    const proxy = new EgressProxy({ resolver: table({ 'mail.example': ['93.184.216.34'] }) });
    proxies.push(proxy);
    const port = await proxy.start();
    const s = await proxy.open();
    const out = await raw(port, `CONNECT mail.example:25 HTTP/1.1\r\n${basic(s.proxyUrl)}\r\n`);
    expect(out.startsWith('HTTP/1.1 403')).toBe(true);
    expect(proxy.close(s).refused[0]?.code).toBe('port_refused');
  });

  it('needs the call credential, and refuses it once the call ended', async () => {
    const up = await upstream((_p, res) => res.end('page'));
    const proxy = new EgressProxy({ resolver: table({ 'a.example': ['127.0.0.1'] }), policy: LOOPBACK, ports: { connect: [], http: [up.port] } });
    proxies.push(proxy);
    const port = await proxy.start();
    const none = await raw(port, `GET http://a.example:${up.port}/ HTTP/1.1\r\nHost: a.example\r\n\r\n`);
    expect(none.startsWith('HTTP/1.1 407')).toBe(true);
    const s = await proxy.open();
    proxy.close(s);
    const revoked = await raw(port, `GET http://a.example:${up.port}/ HTTP/1.1\r\nHost: a.example\r\n${basic(s.proxyUrl)}\r\n`);
    expect(revoked.startsWith('HTTP/1.1 407')).toBe(true);
    expect(up.seen).toHaveLength(0);
  });

  it('cuts a 10 MB download at 2 MB, through a tunnel, and says so', async () => {
    const chunk = Buffer.alloc(64 * 1024, 120);
    const up = await upstream((_p, res) => {
      res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
      let sent = 0;
      const push = (): void => {
        while (sent < 10 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', push);
        }
        res.end();
      };
      push();
    });
    const proxy = new EgressProxy({ resolver: table({ 'big.example': ['127.0.0.1'] }), policy: LOOPBACK, ports: { connect: [up.port], http: [] } });
    proxies.push(proxy);
    const port = await proxy.start();
    const s = await proxy.open();
    const out = await raw(port, `CONNECT big.example:${up.port} HTTP/1.1\r\n${basic(s.proxyUrl)}\r\n`, `GET /big HTTP/1.1\r\nHost: big.example\r\n\r\n`);
    const r = proxy.close(s);
    expect(r.cut).toBe(true);
    expect(r.bytes).toBeGreaterThan(WEB_DOWNLOAD_CAP_BYTES);
    expect(out.length).toBeLessThanOrEqual(WEB_DOWNLOAD_CAP_BYTES + 1024);
  });

  it('sends no cookie, authorization or proxy header upstream on the plain-HTTP path', async () => {
    const up = await upstream((_p, res) => res.end('ok'));
    const proxy = new EgressProxy({ resolver: table({ 'c.example': ['127.0.0.1'] }), policy: LOOPBACK, ports: { connect: [], http: [up.port] } });
    proxies.push(proxy);
    const port = await proxy.start();
    const s = await proxy.open();
    await raw(port, `GET http://c.example:${up.port}/p HTTP/1.1\r\nHost: c.example\r\nCookie: sid=secret\r\nAuthorization: Bearer t0k\r\nProxy-Connection: keep-alive\r\nUser-Agent: test\r\n${basic(s.proxyUrl)}\r\n`);
    expect(up.seen).toHaveLength(1);
    const h = up.seen[0] as IncomingHttpHeaders;
    expect(h['cookie']).toBeUndefined();
    expect(h['authorization']).toBeUndefined();
    expect(h['proxy-authorization']).toBeUndefined();
    expect(h['proxy-connection']).toBeUndefined();
    expect(h['user-agent']).toBe('test');
    expect(proxy.close(s).hosts).toEqual(['c.example']);
  });
});


describe('the egress proxy (bounded)', () => {
  it('closes a connection whose request head is too large, reading no more of it', async () => {
    const proxy = new EgressProxy({});
    proxies.push(proxy);
    const port = await proxy.start();
    const closed = await new Promise<boolean>((resolve) => {
      const sock = netConnect(port, '127.0.0.1');
      sock.on('error', () => undefined);
      sock.on('close', () => resolve(true));
      sock.on('connect', () => {
        const junk = Buffer.alloc(8 * 1024, 97);
        let sent = 0;
        const t = setInterval(() => {
          if (sock.destroyed || sent > 4 * 1024 * 1024) { clearInterval(t); return; }
          sent += junk.length;
          sock.write(junk);
        }, 1);
      });
      setTimeout(() => resolve(false), 5000);
    });
    expect(closed).toBe(true);
  });

  it('refuses a whole request head that is too large, before it is parsed or routed', async () => {
    const proxy = new EgressProxy({});
    proxies.push(proxy);
    const port = await proxy.start();
    const out = await raw(port, `GET http://a.example/ HTTP/1.1\r\nX-Pad: ${'a'.repeat(20_000)}\r\n\r\n`);
    expect(out.startsWith('HTTP/1.1 431')).toBe(true);
  });

  it('stop() closes a client that never authenticated', async () => {
    const proxy = new EgressProxy({});
    const port = await proxy.start();
    const sock = netConnect(port, '127.0.0.1');
    sock.on('error', () => undefined);
    await new Promise<void>((r) => sock.on('connect', () => r()));
    sock.write('GET http://a.example/ HTTP/1.1\r\nHost: a');
    await new Promise((r) => setTimeout(r, 50));
    const gone = new Promise<void>((r) => sock.on('close', () => r()));
    await Promise.race([proxy.stop(), new Promise((_r, j) => setTimeout(() => j(new Error('stop() hung')), 3000))]);
    await gone;
  });
});

describe('the page reader: command, env and arguments', () => {
  it('starts through crew\'s bootstrap: no credential on the command line, robots obeyed, private addresses refused, no Node', () => {
    const argv = fetchArgv();
    expect(argv.slice(0, 2)).toEqual(['-I', '-c']);
    expect(argv).toContain('--no-readability-js');
    expect(argv.join(' ')).not.toMatch(/ignore-robots-txt|allow-private-ips|127\.0\.0\.1:\d/);
    // The bootstrap takes the proxy from the env, caps decoded bytes and keeps no cookie, then runs the server.
    expect(READER_BOOTSTRAP).toContain("os.environ.pop('CREW_WEB_PROXY'");
    expect(READER_BOOTSTRAP).toContain('extract_cookies = lambda self, response: None');
    expect(READER_BOOTSTRAP).toContain('aiter_bytes');
    expect(READER_BOOTSTRAP).toContain("['--proxy-url', proxy]");
    expect(READER_BOOTSTRAP).not.toMatch(/ignore-robots-txt|allow-private-ips/);
  });

  it('runs with none of the daemon\'s proxy, cookie or token variables, an empty crew HOME, and the call\'s proxy and cap', () => {
    const env = fetchEnv('/state/mcp/adapters/web/home', '/v/bin/python', 'http://i:s@127.0.0.1:9', { HTTP_PROXY: 'http://x', NO_PROXY: '*', GH_TOKEN: 't', HOME: '/home/person', COOKIE: 'c', PATH: '/usr/bin' }, 'darwin');
    expect(Object.keys(env).sort()).toEqual(['CREW_WEB_DECODED_MAX', 'CREW_WEB_PROXY', 'HOME', 'LANG', 'PATH', 'PYTHONUTF8', 'TMPDIR']);
    expect(env['HOME']).toBe('/state/mcp/adapters/web/home');
    expect(env['PATH']).toBe('/v/bin');
    expect(Number(env['CREW_WEB_DECODED_MAX'])).toBe(READER_DECODED_MAX);
  });

  it('clamps max_length and the whole answer (a robots refusal quotes all of robots.txt), and refuses URLs with credentials or other schemes', () => {
    expect(fetchArgs({ url: 'https://example.com/a', max_length: 999_999 })).toEqual({ url: 'https://example.com/a', max_length: FETCH_MAX_CHARS, start_index: 0 });
    expect(typeof fetchArgs({ url: 'https://u:p@example.com/' })).toBe('string');
    expect(typeof fetchArgs({ url: 'file:///etc/passwd' })).toBe('string');
    expect(typeof fetchArgs({ url: 'https://example.com', start_index: -1 })).toBe('string');
    const c = clampText('x'.repeat(60_000));
    expect(c.clipped).toBe(true);
    expect(c.text.length).toBeLessThan(FETCH_TEXT_MAX + 100);
  });

  it('ships a lock that pins mcp-server-fetch 2026.11.4 and hashes every package', () => {
    const lock = readLock();
    const reader = lock.packages.find((p) => p.name === 'mcp-server-fetch');
    expect(reader?.version).toBe('2026.11.4');
    expect(reader?.sha256).toContain('7c5891e3d3e3ea7d2d8c21acb9c64ccd30ff1f42beeea59f95715637b970307d');
    expect(lock.packages.every((p) => p.sha256.length > 0)).toBe(true);
    expect(lock.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('installs with pip isolated from the person\'s pip configuration, index credentials and PIP_* variables', () => {
    const env = installEnv('/state/web/install-home', { PATH: '/usr/bin', PIP_INDEX_URL: 'https://u:p@corp/simple', PIP_TARGET: '/tmp/x', HOME: '/home/person', NETRC: '/home/person/.netrc', HTTPS_PROXY: 'http://proxy:3128' }, 'darwin');
    expect(Object.keys(env).filter((k) => k.startsWith('PIP_')).sort()).toEqual(['PIP_CONFIG_FILE', 'PIP_NO_INPUT']);
    expect(env['PIP_CONFIG_FILE']).toBe('/dev/null');
    expect(env['HOME']).toBe('/state/web/install-home');
    expect(env['NETRC']).toBeUndefined();
    expect(env['HTTPS_PROXY']).toBe('http://proxy:3128');
    const a = pipArgs('/x.lock');
    expect(a).toContain('--isolated');
    expect(a[a.indexOf('--index-url') + 1]).toBe('https://pypi.org/simple');
    expect(a).toContain('--require-hashes');
  });

  it('installs exactly the consented lock bytes, never others', async () => {
    const lock = readLock();
    await expect(installVenv({ python: 'python3', venv: join(mkdtempSync(join(tmpdir(), 'web-v-')), 'v'), lockText: `${lock.text}\n# changed`, lockSha: lock.sha256, home: tmpdir(), exec: async () => ({ code: 0, stdout: '', stderr: '' }) })).rejects.toThrow('not the consented lock');
    const web = new WebSource({ mcpDir: mkdtempSync(join(tmpdir(), 'web-src-')), engine: async () => ({ ok: false, reason: NO_ENGINE_REASON, found: [] }) });
    await expect(web.install('0'.repeat(64))).rejects.toMatchObject({ code: 'consent_stale' });
  });
});

describe('SearXNG: settings, container and answers', () => {
  it('JSON only, a minimal engine list, no metrics, no image proxy or autocomplete', () => {
    const y = searxngSettings('s3cret');
    expect(y).toContain('keep_only:');
    expect(y).toMatch(/formats:\n\s+- json\n/);
    expect(y).toContain('enable_metrics: false');
    expect(y).toContain('image_proxy: false');
    expect(y).toContain('autocomplete: ""');
  });

  it('publishes on 127.0.0.1 only, with no capabilities, and runs the image by digest', () => {
    const a = createArgs('n');
    expect(a[a.indexOf('-p') + 1]).toBe('127.0.0.1::8080');
    expect(a).toContain('ALL');
    expect(a.at(-1)).toContain(`@${SEARXNG_DIGEST}`);
  });

  it('hands an agent at most 10 http(s) results', () => {
    const results = Array.from({ length: 30 }, (_v, i) => ({ url: i === 0 ? 'javascript:alert(1)' : `https://e.example/${i}`, title: `t${i}`, content: 'c' }));
    const h = searchHits({ results, unresponsive_engines: [['duckduckgo', 'CAPTCHA']] });
    expect(h.results).toHaveLength(10);
    expect(h.results[0]?.url).toBe('https://e.example/1');
    expect(h.unresponsive).toEqual(['duckduckgo: CAPTCHA']);
  });
});

describe('the search container: a start that fails or is stopped removes what it made', () => {
  const engine = { name: 'docker' as const, label: 'Docker', cli: '/x/docker', env: {}, pullArgs: [] };
  it('a failure after the create (no published port) removes the container, even after a stop meanwhile', async () => {
    const cmds: string[] = [];
    let svc: SearxngService | null = null;
    svc = new SearxngService({
      engine: async () => ({ ok: true, engine }),
      stateHome: '/state',
      scratchDir: mkdtempSync(join(tmpdir(), 'web-sx-')),
      exec: async (_c, args) => {
        cmds.push(args.join(' '));
        if (args[0] === 'create') await (svc as SearxngService).stop();
        return { code: 0, stdout: args[0] === 'port' ? '' : 'id', stderr: '' };
      },
    });
    await expect(svc.ensure()).rejects.toThrow();
    expect(cmds.at(-1)).toBe(`rm -f ${svc.container}`);
    expect(cmds.filter((c) => c.startsWith('start '))).toEqual([]);
  });

  it('a copy that fails removes the created container', async () => {
    const cmds: string[] = [];
    const svc = new SearxngService({
      engine: async () => ({ ok: true, engine }),
      stateHome: '/state',
      scratchDir: mkdtempSync(join(tmpdir(), 'web-sx-')),
      exec: async (_c, args) => {
        cmds.push(args.join(' '));
        return { code: args[0] === 'cp' ? 1 : 0, stdout: 'id', stderr: args[0] === 'cp' ? 'no such container path' : '' };
      },
    });
    await expect(svc.ensure()).rejects.toThrow('could not hand the search container its settings');
    expect(cmds.at(-1)).toBe(`rm -f ${svc.container}`);
  });
});

describe('the search container: a stop while it starts', () => {
  it('removes what the start made and publishes no port', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const health = createHttpServer((_q, res) => void gate.then(() => res.end('OK')));
    servers.push(health);
    await new Promise<void>((r) => health.listen(0, '127.0.0.1', () => r()));
    const hp = (health.address() as AddressInfo).port;
    const cmds: string[] = [];
    const engine = { name: 'docker' as const, label: 'Docker', cli: '/x/docker', env: {}, pullArgs: [] };
    const svc = new SearxngService({
      engine: async () => ({ ok: true, engine }),
      stateHome: '/state',
      scratchDir: mkdtempSync(join(tmpdir(), 'web-sx-')),
      exec: async (_c, args) => {
        cmds.push(args.join(' '));
        return { code: 0, stdout: args[0] === 'port' ? `127.0.0.1:${hp}\n` : 'id', stderr: '' };
      },
    });
    const starting = svc.ensure();
    await new Promise((r) => setTimeout(r, 50));
    await svc.stop();
    release();
    await expect(starting).rejects.toThrow('stopped while its search was starting');
    expect(cmds.at(-1)).toBe(`rm -f ${svc.container}`);
  });
});

describe('the container engine', () => {
  const quiet = async () => ({ code: 0, stdout: '', stderr: '' });
  it('none found: says it plainly', async () => {
    const d = await detectEngine({ configDir: mkdtempSync(join(tmpdir(), 'web-eng-')), find: async () => null, exec: quiet });
    expect(d).toEqual({ ok: false, reason: NO_ENGINE_REASON, found: [] });
    expect(NO_ENGINE_REASON).toBe('Research needs a container engine for web search: install Docker, Rancher Desktop or Podman');
  });

  it('found but not answering: told to start it', async () => {
    const d = await detectEngine({ configDir: mkdtempSync(join(tmpdir(), 'web-eng-')), find: async (n) => (n === 'podman' ? '/x/podman' : null), exec: async () => ({ code: 125, stdout: '', stderr: 'no machine' }) });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/Podman is installed but not answering; start it$/);
  });

  it('docker: the person\'s DOCKER_HOST wins over the context, and crew\'s own empty config is used', async () => {
    const seen: Array<{ args: readonly string[]; env?: Record<string, string> }> = [];
    const dir = mkdtempSync(join(tmpdir(), 'web-eng-'));
    const d = await detectEngine({ configDir: dir, env: { PATH: '/usr/bin', DOCKER_HOST: 'unix:///chosen.sock', DOCKER_CONFIG: '/home/person/.docker' }, find: async (n) => (n === 'docker' ? '/x/docker' : null), exec: async (_c, args, o) => { seen.push({ args, ...(o.env !== undefined ? { env: o.env } : {}) }); return { code: 0, stdout: 'unix:///other.sock', stderr: '' }; } });
    expect(d.ok && d.engine.env['DOCKER_HOST']).toBe('unix:///chosen.sock');
    expect(d.ok && d.engine.env['DOCKER_CONFIG']).toBe(dir);
    expect(seen.some((x) => x.args[0] === 'context')).toBe(false);
  });

  it('docker: an explicit DOCKER_CONTEXT wins over DOCKER_HOST, as Docker itself decides', async () => {
    const d = await detectEngine({ configDir: mkdtempSync(join(tmpdir(), 'web-eng-')), env: { PATH: '/usr/bin', DOCKER_HOST: 'unix:///stale.sock', DOCKER_CONTEXT: 'intended' }, find: async (n) => (n === 'docker' ? '/x/docker' : null), exec: async (_c, args) => ({ code: 0, stdout: args[0] === 'context' ? 'unix:///intended.sock' : '', stderr: '' }) });
    expect(d.ok && d.engine.env['DOCKER_HOST']).toBe('unix:///intended.sock');
  });

  it('a probe still running is shared, however long it takes', async () => {
    let calls = 0;
    let clock = 0;
    const web = new WebSource({ mcpDir: mkdtempSync(join(tmpdir(), 'web-src-')), now: () => clock, engine: () => { calls++; return new Promise(() => undefined); } });
    const a = web.engine();
    clock = 31_000;
    const b = web.engine();
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('install and search refuse with the plain text', async () => {
    const web = new WebSource({ mcpDir: mkdtempSync(join(tmpdir(), 'web-src-')), engine: async () => ({ ok: false, reason: NO_ENGINE_REASON, found: [] }), python: async () => ({ ok: true, cmd: 'python3', version: '3.12.0' }) });
    await expect(web.install(readLock().sha256)).rejects.toThrow(NO_ENGINE_REASON);
    await expect(web.search('x')).rejects.toBeInstanceOf(WebSourceRefusal);
  });
});

class NoSecrets implements SecretStore {
  readonly available = true;
  async get(): Promise<string | null> {
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

describe('the gate: agents cannot query until a person switches it on; every call is recorded', () => {
  const NOW = '2026-11-07T04:00:00.000Z';
  const scope = { unit: { runId: 'r1', ord: 2, attempt: 1, phase: 'research', seat: 'claude' }, projectId: 'p1' };
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A fresh registry with the web source installed, its switches as given; a gate over it. */
  async function world(agents: { projects?: string[]; query?: boolean } | null, opts: { fetch?: (a: { url: string }) => Promise<FetchOutcome>; failRecord?: () => boolean; openFile?: typeof import('node:fs/promises').open; onRead?: (e: { outcome: string; released: boolean }) => Promise<void> } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'web-gate-'));
    dirs.push(base);
    mkdirSync(join(base, 'mcp'), { recursive: true });
    const store = new McpRegistryStore(join(base, 'mcp'));
    const registry = new McpRegistry({ store, secrets: new NoSecrets(), probe: async () => ({ ok: true, serverInfo: null, tools: [] }), discover: () => [], env: {} });
    await registry.registerWebSource(WEB_SOURCE);
    if (agents !== null) {
      const r = await setAgentAccess(store, WEB_SOURCE, { ...(agents.projects !== undefined ? { projects: agents.projects } : {}) });
      if (agents.query === true) await setAgentAccess(store, WEB_SOURCE, { query: true });
      expect('error' in r).toBe(false);
    }
    const audit: Array<{ action: string; detail?: Record<string, unknown> }> = [];
    const fetched: string[] = [];
    const web = {
      search: async (q: string) => ({ results: [{ url: `https://e.example/?q=${q}`, title: 't', snippet: 's' }], unresponsive: [] }),
      fetch:
        opts.fetch ??
        (async (a: { url: string }): Promise<FetchOutcome> => {
          fetched.push(a.url);
          if (a.url.includes('huge')) return { text: '', isError: true, report: { hosts: ['huge.example'], bytes: WEB_DOWNLOAD_CAP_BYTES + 1, cut: true, refused: [] } };
          return { text: `Contents of ${a.url}:\nhello`, isError: false, report: { hosts: ['e.example'], bytes: 120, cut: false, refused: [] } };
        }),
    };
    const recordPath = join(base, 'mcp', 'web-calls.ndjson');
    const gate = new WebGate({
      store,
      audit: { record: (action, _a, f) => void audit.push({ action, ...(f?.detail !== undefined ? { detail: f.detail } : {}) }) },
      schedulers: new GateSchedulers(),
      web,
      ...(opts.onRead !== undefined ? { reads: { append: opts.onRead } } : {}),
      ...(opts.openFile !== undefined ? { openFile: opts.openFile } : {}),
      recordPath: opts.failRecord !== undefined ? join(base, 'mcp', 'nope', '\u0000bad') : recordPath,
      now: () => Date.parse(NOW),
    });
    const records = (): Array<Record<string, unknown>> => {
      try {
        return readFileSync(recordPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    };
    /** A call through the broker's release protocol: answer, then commit. */
    const call = async (tool: string, args: Record<string, unknown>, id: string) => {
      const r = await gate.unitCall(scope, WEB_SOURCE, tool, args, id);
      if (r.ok && r.commit !== undefined) {
        const c = await r.commit();
        if (!c.ok) return { released: false as const, reason: c.reason, answer: null };
      }
      return r.ok ? { released: true as const, answer: r.answer, isError: r.isError } : { released: false as const, reason: r.reason, answer: null };
    };
    return { store, registry, gate, audit, fetched, records, call };
  }

  it('after install "Agents can query" is OFF: nothing listed, a call is refused and recorded with its URL, nothing fetched', async () => {
    const w = await world({ projects: ['p1'] });
    expect(await isGatedSource(w.store, WEB_SOURCE)).toBe(true);
    expect((await w.registry.callableTools()).filter((t) => t.server === WEB_SOURCE)).toEqual([]);
    expect((await w.gate.reach('p1')).map((t) => t.tool)).toEqual(['receipts']);
    const r = await w.call('fetch', { url: 'https://e.example/a' }, 'c0');
    expect((r.answer as { refused?: string } | null)?.refused).toBe('query_off');
    expect(w.fetched).toEqual([]);
    expect(w.records().find((x) => x['callId'] === 'c0')).toMatchObject({ outcome: 'query_off', url: 'https://e.example/a', at: NOW });
    expect(w.audit.find((a) => a.detail?.['callId'] === 'c0')?.detail).toMatchObject({ outcome: 'query_off', url: 'https://e.example/a', at: NOW });
  });

  it('with no project chosen the source is hidden (no oracle), and the attempt is still recorded', async () => {
    const w = await world(null);
    const r = await w.call('search', { query: 'x' }, 'c0');
    expect((r.answer as { refused?: string } | null)?.refused).toBe('unknown_source');
    expect(w.records().find((x) => x['callId'] === 'c0')).toMatchObject({ outcome: 'unknown_source', query: 'x' });
  });

  it('switched on for the project: both tools listed, and a fetch carries the URL and fetch time in the answer, the record and the audit line', async () => {
    const w = await world({ projects: ['p1'], query: true });
    expect((await w.gate.reach('p1')).map((t) => t.tool)).toEqual(['search', 'fetch', 'receipts']);
    expect(await w.gate.reach('other')).toEqual([]);
    const r = await w.call('fetch', { url: 'https://e.example/a' }, 'c1');
    expect(r.released).toBe(true);
    expect(r.answer).toMatchObject({ url: 'https://e.example/a', fetched_at: NOW, hosts_reached: ['e.example'] });
    expect(w.audit.find((a) => a.action === 'knowledge.source.agent_web' && a.detail?.['callId'] === 'c1')?.detail).toMatchObject({ url: 'https://e.example/a', at: NOW, outcome: 'ok' });
    const lines = w.records().filter((x) => x['callId'] === 'c1');
    expect(lines.map((x) => x['outcome'])).toEqual(['unconfirmed', 'ok']);
    expect(lines[1]).toMatchObject({ url: 'https://e.example/a', at: NOW, runId: 'r1', seat: 'claude' });
    expect(JSON.stringify(w.records())).not.toContain('hello');
  });

  it('a search is recorded with its query and time', async () => {
    const w = await world({ projects: ['p1'], query: true });
    const r = await w.call('search', { query: 'vector db' }, 'c3');
    expect((r.answer as Record<string, unknown>)['searched_at']).toBe(NOW);
    expect(w.audit.find((a) => a.detail?.['callId'] === 'c3')?.detail).toMatchObject({ query: 'vector db', at: NOW, tool: 'search' });
  });

  it('a page over the cap comes back refused as too large, with nothing of it', async () => {
    const w = await world({ projects: ['p1'], query: true });
    const r = await w.call('fetch', { url: 'https://huge.example/x' }, 'c2');
    expect(r.answer).toMatchObject({ refused: 'too_large', cut: true });
    expect((r.answer as Record<string, unknown>)['text']).toBeUndefined();
  });

  it('switched off while the call runs: the answer is withheld at release, and the record says so', async () => {
    let w: Awaited<ReturnType<typeof world>> | null = null;
    w = await world({ projects: ['p1'], query: true }, {
      fetch: async () => {
        await setAgentAccess((w as NonNullable<typeof w>).store, WEB_SOURCE, { query: false });
        return { text: 'page text', isError: false, report: { hosts: ['e.example'], bytes: 10, cut: false, refused: [] } };
      },
    });
    const r = await w.call('fetch', { url: 'https://e.example/b' }, 'c4');
    expect(r.released).toBe(false);
    expect(r.answer).toBeNull();
    expect(w.records().filter((x) => x['callId'] === 'c4').at(-1)?.['outcome']).toBe('changed_while_running');
  });

  it('switched off between the answer and the broker\'s release: withheld at commit', async () => {
    const w = await world({ projects: ['p1'], query: true });
    const r = await w.gate.unitCall(scope, WEB_SOURCE, 'fetch', { url: 'https://e.example/c' }, 'c5');
    expect(r.ok && r.commit !== undefined).toBe(true);
    await setAgentAccess(w.store, WEB_SOURCE, { query: false });
    const c = r.ok && r.commit !== undefined ? await r.commit() : null;
    expect(c?.ok).toBe(false);
    expect(w.records().filter((x) => x['callId'] === 'c5').at(-1)?.['outcome']).toBe('changed_while_running');
  });

  it('switched off while the final records are written: still withheld', async () => {
    let w: Awaited<ReturnType<typeof world>> | null = null;
    w = await world({ projects: ['p1'], query: true }, {
      onRead: async (e) => {
        if (e.released) await setAgentAccess((w as NonNullable<typeof w>).store, WEB_SOURCE, { query: false });
      },
    });
    const r = await w.call('fetch', { url: 'https://e.example/e' }, 'c7');
    expect(r.released).toBe(false);
    expect(w.records().filter((x) => x['callId'] === 'c7').at(-1)?.['outcome']).toBe('changed_while_running');
  });

  it('removed between the gate\'s dispatch and the call: refused, and recorded under the dispatched identity', async () => {
    const w = await world({ projects: ['p1'], query: true });
    const dispatched = await w.gate.entry();
    await w.registry.remove(WEB_SOURCE);
    const r = await w.gate.unitCall(scope, WEB_SOURCE, 'fetch', { url: 'https://e.example/f' }, 'c8', dispatched ?? undefined);
    expect(r.ok && (r.answer as { refused?: string }).refused).toBe('unknown_source');
    expect(w.records().find((x) => x['callId'] === 'c8')).toMatchObject({ outcome: 'unknown_source', url: 'https://e.example/f', sourceId: dispatched?.id });
  });

  it('a record line is written whole and synced, and the new file\'s directory is synced, before release', async () => {
    const { open: realOpen } = await import('node:fs/promises');
    const seen: string[] = [];
    const openFile = (async (path: string, flags: string, mode?: number) => {
      const fh = await realOpen(path, flags, mode);
      return new Proxy(fh, {
        get(t, k, r) {
          const v = Reflect.get(t, k, r) as unknown;
          if (k === 'sync') return async () => { seen.push(`sync ${flags === 'r' ? 'dir' : 'file'}`); await t.sync(); };
          if (k === 'writeFile') return async (d: string) => { seen.push('writeFile'); await t.writeFile(d); };
          if (k === 'write') return async () => { throw new Error('a single write() may be short: not used'); };
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    }) as unknown as typeof import('node:fs/promises').open;
    const w = await world({ projects: ['p1'], query: true }, { openFile });
    const r = await w.call('fetch', { url: 'https://e.example/g' }, 'c9');
    expect(r.released).toBe(true);
    expect(seen.slice(0, 3)).toEqual(['writeFile', 'sync file', 'sync dir']);
    // Once per file: the record's, then the run's receipts file.
    expect(seen.filter((x) => x === 'sync dir')).toHaveLength(2);
  });

  it('removed and installed again between the dispatch and the call: refused under the routed identity', async () => {
    const w = await world({ projects: ['p1'], query: true });
    const dispatched = await w.gate.entry();
    await w.registry.remove(WEB_SOURCE);
    await w.registry.registerWebSource(WEB_SOURCE);
    await setAgentAccess(w.store, WEB_SOURCE, { projects: ['p1'] });
    await setAgentAccess(w.store, WEB_SOURCE, { query: true });
    const r = await w.gate.unitCall(scope, WEB_SOURCE, 'fetch', { url: 'https://e.example/h' }, 'c10', dispatched ?? undefined);
    expect(r.ok && (r.answer as { refused?: string }).refused).toBe('unknown_source');
    expect(w.records().find((x) => x['callId'] === 'c10')).toMatchObject({ outcome: 'unknown_source', sourceId: dispatched?.id });
    expect(w.fetched).toEqual([]);
  });

  it('the run\'s receipts are crew\'s own record: released reads only, with the answer\'s time, the text\'s hash and a search\'s URLs; a seat\'s arguments add nothing', async () => {
    const w = await world({ projects: ['p1'], query: true });
    const f = await w.call('fetch', { url: 'https://e.example/r' }, 'r-1');
    const q = await w.call('search', { query: 'vector db' }, 'r-2');
    await w.call('fetch', { url: 'https://huge.example/r' }, 'r-3');
    await w.gate.unitCall({ ...scope, unit: { ...scope.unit, runId: 'other' } }, WEB_SOURCE, 'fetch', { url: 'https://e.example/other' }, 'r-4').then((r) => (r.ok && r.commit !== undefined ? r.commit() : null));
    await setAgentAccess(w.store, WEB_SOURCE, { query: false });
    await w.call('fetch', { url: 'https://e.example/refused' }, 'r-5');
    const all = await w.gate.receipts('r1');
    expect(all.complete).toBe(true);
    const got = all.receipts;
    expect(got.map((x) => x.callId).sort()).toEqual(['r-1', 'r-2', 'r-3']);
    const fr = got.find((x) => x.callId === 'r-1');
    const fa = f.answer as Record<string, unknown>;
    expect(fr).toMatchObject({ tool: 'fetch', url: 'https://e.example/r', observedAt: fa['fetched_at'], outcome: 'ok', hosts: ['e.example'] });
    expect(fr?.contentSha256).toBe(createHash('sha256').update(String(fa['text'])).digest('hex'));
    expect(got.find((x) => x.callId === 'r-2')).toMatchObject({ tool: 'search', query: 'vector db', observedAt: (q.answer as Record<string, unknown>)['searched_at'], resultUrls: ['https://e.example/?q=vector db'] });
    expect(got.find((x) => x.callId === 'r-3')).toMatchObject({ outcome: 'too_large' });
    expect(got.find((x) => x.callId === 'r-3')?.contentSha256).toBeUndefined();
    // Listed with "see" alone (no web is touched), and read for the unit's own run, whatever it passes.
    expect((await w.gate.reach('p1')).map((t) => t.tool)).toEqual(['receipts']);
    const r = await w.gate.unitCall(scope, WEB_SOURCE, 'receipts', { receipts: [{ url: 'https://typed.example/' }], runId: 'other' }, 'r-6');
    const ans = (r as unknown as { answer: { runId: string; receipts: Array<{ callId: string }> } }).answer;
    expect(ans.runId).toBe('r1');
    expect(ans.receipts.map((x) => x.callId).sort()).toEqual(['r-1', 'r-2', 'r-3']);
    // And for a person, the run's read route.
    const app = Fastify();
    let who: Actor = { id: 'seat:x', kind: 'agent', trust: 'observer' };
    registerWebSourceRoutes(app, { gate: w.gate, audit: { record: () => undefined }, actorOf: () => who });
    // Any run id may be named on the route, so a non-human actor may not use it (its own run's are the gate's).
    expect((await app.inject({ method: 'GET', url: '/api/v1/runs/r1/web-receipts' })).statusCode).toBe(403);
    who = { id: 'me', kind: 'human', trust: 'observer' };
    const http = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/web-receipts' });
    expect(http.json()).toMatchObject({ runId: 'r1', known: true, complete: true });
    expect((http.json() as { receipts: unknown[] }).receipts).toHaveLength(3);
    await app.close();
  });

  it('a receipt names the subject as executed, and a call withheld at release has none', async () => {
    let w: Awaited<ReturnType<typeof world>> | null = null;
    w = await world({ projects: ['p1'], query: true }, {
      onRead: async (e) => {
        if (e.released && (e as unknown as { callId: string }).callId === 'n-2') await setAgentAccess((w as NonNullable<typeof w>).store, WEB_SOURCE, { query: false });
      },
    });
    const a = await w.call('fetch', { url: 'https://e.example/a\tb' }, 'n-1');
    expect((a.answer as Record<string, unknown>)['url']).toBe('https://e.example/ab');
    await w.call('search', { query: '  padded  ' }, 'n-2');
    const r = (await w.gate.receipts('r1')).receipts;
    expect(r.map((x) => x.callId)).toEqual(['n-1']);
    expect(r[0]?.url).toBe('https://e.example/ab');
  });

  it('switched off while the receipt is written: the receipt is withdrawn and the answer withheld', async () => {
    const { open: realOpen } = await import('node:fs/promises');
    let w: Awaited<ReturnType<typeof world>> | null = null;
    let flipped = false;
    const openFile = (async (path: string, flags: string, mode?: number) => {
      if (!flipped && path.includes('web-receipts')) {
        flipped = true;
        await setAgentAccess((w as NonNullable<typeof w>).store, WEB_SOURCE, { query: false });
      }
      return realOpen(path, flags, mode);
    }) as unknown as typeof import('node:fs/promises').open;
    w = await world({ projects: ['p1'], query: true }, { openFile });
    const r = await w.call('fetch', { url: 'https://e.example/w' }, 'w-1');
    expect(r.released).toBe(false);
    expect((await w.gate.receipts('r1')).receipts).toEqual([]);
  });

  it('no record, no release: a record that cannot be written withholds the answer', async () => {
    const w = await world({ projects: ['p1'], query: true }, { failRecord: () => true });
    const r = await w.gate.unitCall(scope, WEB_SOURCE, 'fetch', { url: 'https://e.example/d' }, 'c6');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.ruleId).toBe('gate:record');
  });

  it('a re-install turns "Agents can query" off again', async () => {
    const w = await world({ projects: ['p1'], query: true });
    expect(await w.gate.reach('p1')).toHaveLength(3);
    await w.registry.registerWebSource(WEB_SOURCE);
    expect((await w.gate.reach('p1')).map((t) => t.tool)).toEqual(['receipts']);
  });

  it('the install route is a human operator\'s, with consent to the exact lock and image, and says plainly when there is no engine', async () => {
    const w = await world(null);
    const app = Fastify();
    let who: Actor = { id: 'seat:x', kind: 'agent', trust: 'operator' };
    const web = new WebSource({ mcpDir: mkdtempSync(join(tmpdir(), 'web-src-')), engine: async () => ({ ok: false, reason: NO_ENGINE_REASON, found: [] }), python: async () => ({ ok: true, cmd: 'python3', version: '3.12.0' }), searcher: { search: async () => ({ results: [], unresponsive: [] }), pull: async () => undefined, imagePresent: async () => false, stop: async () => undefined } });
    registerWebSourceRoutes(app, { registry: w.registry, gate: w.gate, web, audit: { record: () => undefined }, actorOf: () => who });
    const consent = { consent: { lock: readLock().sha256, image: SEARXNG_DIGEST } };
    const setup = await app.inject({ method: 'GET', url: '/api/v1/sources/web/setup' });
    expect(setup.statusCode).toBe(200);
    expect(setup.json()).toMatchObject({ registered: true, agents: { query: false }, search: { ready: false, reason: NO_ENGINE_REASON }, reader: { name: 'mcp-server-fetch', version: '2026.11.4' }, image: { digest: SEARXNG_DIGEST, license: 'AGPL-3.0-or-later' } });
    expect((await app.inject({ method: 'POST', url: '/api/v1/sources/web/install', payload: consent })).statusCode).toBe(403);
    who = { id: 'me', kind: 'human', trust: 'operator' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/sources/web/install', payload: { consent: { ...consent.consent, lock: '0'.repeat(64) } } })).statusCode).toBe(409);
    const r = await app.inject({ method: 'POST', url: '/api/v1/sources/web/install', payload: consent });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ code: 'no_engine', error: NO_ENGINE_REASON });
    await app.close();
  });
});
