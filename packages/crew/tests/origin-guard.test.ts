import { describe, expect, it } from 'vitest';
import { corsAllowed, refuseRequest, type GuardedRequest } from '../src/api/origin-guard.js';

const LOCAL = { mode: 'off' as const, allowedOrigins: null };
const req = (r: Partial<GuardedRequest>): GuardedRequest => ({
  method: 'GET', path: '/api/v1/runs', host: '127.0.0.1:7701', origin: undefined, secFetchSite: undefined, upgrade: undefined, ...r,
});

describe('origin guard, auth off (crew#1048)', () => {
  it('passes the CLI and the daemon\'s own studio: loopback Host, same-origin writes and WebSockets', () => {
    expect(refuseRequest(req({ method: 'POST' }), LOCAL)).toBeNull();
    expect(refuseRequest(req({ method: 'POST', origin: 'http://127.0.0.1:7701', secFetchSite: 'same-origin' }), LOCAL)).toBeNull();
    expect(refuseRequest(req({ host: 'localhost:7701', origin: 'http://localhost:7701', upgrade: 'websocket' }), LOCAL)).toBeNull();
    expect(refuseRequest(req({ host: '[::1]:7701', method: 'PUT', origin: 'http://[::1]:7701' }), LOCAL)).toBeNull();
  });

  it('accepts loopback Host spellings a browser can send: case, a trailing dot, the default port', () => {
    expect(refuseRequest(req({ host: 'LOCALHOST.:7701', method: 'POST', origin: 'http://localhost.:7701' }), LOCAL)).toBeNull();
    expect(refuseRequest(req({ host: 'localhost:80', method: 'POST', origin: 'http://localhost' }), LOCAL)).toBeNull();
  });

  it('passes studio\'s dev server writing cross-origin, and an origin the operator allows', () => {
    expect(refuseRequest(req({ method: 'POST', origin: 'http://localhost:4200' }), LOCAL)).toBeNull();
    expect(refuseRequest(req({ method: 'POST', origin: 'http://localhost:4999' }), { mode: 'off', allowedOrigins: ['http://localhost:4999'] })).toBeNull();
  });

  it('refuses another local page writing or opening a WebSocket, an opaque frame included', () => {
    expect(refuseRequest(req({ method: 'POST', origin: 'http://localhost:4999' }), LOCAL)).toMatch(/may not change/);
    expect(refuseRequest(req({ path: '/ws/terminals/t1', origin: 'http://127.0.0.1:5173', upgrade: 'websocket' }), LOCAL)).toMatch(/may not change/);
    expect(refuseRequest(req({ method: 'DELETE', origin: 'null' }), LOCAL)).toMatch(/may not change/);
    // Same name, other scheme: https://localhost is port 443, a different app (codex r2 #8).
    expect(refuseRequest(req({ host: 'localhost:80', method: 'POST', origin: 'https://localhost' }), LOCAL)).toMatch(/may not change/);
  });

  it('refuses a write that says it is cross-site without an Origin', () => {
    expect(refuseRequest(req({ method: 'POST', secFetchSite: 'cross-site' }), LOCAL)).toMatch(/cross-site/);
    expect(refuseRequest(req({ method: 'POST', secFetchSite: 'same-site' }), LOCAL)).toMatch(/same-site/);
  });

  it('refuses a DNS-rebound page by its Host, plain reads with no browser headers included', () => {
    expect(refuseRequest(req({ host: 'evil.example:7701' }), LOCAL)).toMatch(/not a loopback name/);
    expect(refuseRequest(req({ host: undefined }), LOCAL)).toMatch(/not a loopback name/);
  });

  it('exempts exactly the worker MCP routes, whose unit token the engine checks, from the Host rule', () => {
    expect(refuseRequest(req({ method: 'POST', path: '/api/v1/mcp/ask', host: 'host.lima.internal:7701' }), LOCAL)).toBeNull();
    expect(refuseRequest(req({ method: 'POST', path: '/api/v1/mcp/call', host: 'agw:8700' }), LOCAL)).toBeNull();
    expect(refuseRequest(req({ method: 'POST', path: '/api/v1/mcp/servers', host: 'agw:8700' }), LOCAL)).toMatch(/loopback/);
  });

  it('reflects CORS for studio dev and allowed origins only', () => {
    expect(corsAllowed('http://127.0.0.1:4200', LOCAL)).toBe(true);
    expect(corsAllowed('http://localhost:4999', LOCAL)).toBe(false);
  });
});

describe('origin guard, auth required: unchanged', () => {
  const REQUIRED = { mode: 'required' as const, allowedOrigins: ['https://skin.example.com'] };
  it('refuses nothing (the bearer token is the boundary) and keeps the old CORS rule', () => {
    expect(refuseRequest(req({ method: 'POST', host: 'crew.example.com', origin: 'https://other.example.com' }), REQUIRED)).toBeNull();
    expect(corsAllowed('http://localhost:4999', REQUIRED)).toBe(true);
    expect(corsAllowed('https://skin.example.com', REQUIRED)).toBe(true);
    expect(corsAllowed('https://other.example.com', REQUIRED)).toBe(false);
    expect(corsAllowed('https://any.example.com', { mode: 'required', allowedOrigins: null })).toBe(true);
  });
});
