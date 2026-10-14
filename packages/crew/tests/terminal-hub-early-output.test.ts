// A terminal's output written BEFORE its browser socket attaches reaches that socket (wicked-core C6):
// a login container prints its sign-in link the moment it starts, but the browser opens
// /ws/terminals/:id only after the POST that created the terminal returns.
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  EARLY_OUTPUT_MAX_BYTES,
  EARLY_OUTPUT_MAX_TERMINALS,
  GONE_GRACE_MS,
  TerminalHub,
} from '../src/events/terminals.js';
import type { CoreEvent } from '../src/core/types.js';

function fakeSocket(): { socket: WebSocket; sent: string[]; raw: Buffer[]; closed: () => boolean } {
  const sent: string[] = [];
  const raw: Buffer[] = [];
  const state = { readyState: WebSocket.OPEN as number };
  const socket = {
    get readyState() {
      return state.readyState;
    },
    send: (b: Buffer) => {
      raw.push(b);
      sent.push(b.toString('utf8'));
    },
    close: () => {
      state.readyState = WebSocket.CLOSING;
    },
  } as unknown as WebSocket;
  return { socket, sent, raw, closed: () => state.readyState !== WebSocket.OPEN };
}

const out = (id: string, text: string): CoreEvent =>
  ({ type: 'terminalOutput', id, seq: 0, bytesB64: Buffer.from(text).toString('base64') }) as unknown as CoreEvent;
const exited = (id: string): CoreEvent => ({ type: 'terminalExited', id, code: 0 }) as unknown as CoreEvent;

describe('TerminalHub early output', () => {
  it('replays what the terminal wrote before its socket attached, in order, then streams live', () => {
    const hub = new TerminalHub();
    hub.route(out('t1', 'Use the url below to sign in:\r\n'));
    hub.route(out('t1', 'https://example.invalid/device  code: FAKE-1234\r\n'));
    expect(hub.knowsExited('t1')).toBe(false);
    const s = fakeSocket();
    hub.register('t1', s.socket);
    hub.route(out('t1', 'Paste code here > '));
    expect(s.sent).toEqual([
      'Use the url below to sign in:\r\n',
      'https://example.invalid/device  code: FAKE-1234\r\n',
      'Paste code here > ',
    ]);
    expect(hub.heldCount()).toBe(0);
    expect(s.closed()).toBe(false);
  });

  it('closes a late socket whose terminal already exited, after replaying its output', () => {
    const hub = new TerminalHub();
    hub.route(out('t2', 'Login successful.\r\n'));
    hub.route(exited('t2'));
    expect(hub.knowsExited('t2')).toBe(true);
    const s = fakeSocket();
    hub.register('t2', s.socket);
    expect(s.sent).toEqual(['Login successful.\r\n']);
    expect(s.closed()).toBe(true);
    // The close handler must not close an engine terminal that is already reaped.
    expect(hub.hasExited('t2')).toBe(true);
  });

  it('remembers an exit apart from the output holds: evicting holds never loses it (codex c6-r1)', () => {
    const hub = new TerminalHub();
    hub.route(exited('login'));
    for (let i = 0; i < EARLY_OUTPUT_MAX_TERMINALS + 5; i++) hub.route(out(`other${i}`, 'x'));
    const s = fakeSocket();
    hub.register('login', s.socket);
    expect(s.closed()).toBe(true);
    expect(hub.hasExited('login')).toBe(true);
  });

  it('overlapping attaches to an exited terminal close BOTH sockets (codex c6-r2)', () => {
    const hub = new TerminalHub();
    hub.route(exited('reaped'));
    const a = fakeSocket();
    const b = fakeSocket();
    hub.register('reaped', a.socket);
    hub.register('reaped', b.socket);
    expect(a.closed()).toBe(true);
    expect(b.closed()).toBe(true);
    expect(hub.isCurrent('reaped', b.socket)).toBe(true);
    expect(hub.isCurrent('reaped', a.socket)).toBe(false);
  });

  it('gone(): closes after the grace, so frames already emitted are routed first (codex c6-r3)', () => {
    vi.useFakeTimers();
    try {
      const hub = new TerminalHub();
      const s = fakeSocket();
      hub.register('late', s.socket);
      hub.gone('late', s.socket);
      // The terminal's queued output and exit arrive after the probe's refusal: delivered in order.
      hub.route(out('late', 'https://example.invalid/device'));
      expect(s.sent).toEqual(['https://example.invalid/device']);
      hub.route(exited('late'));
      expect(s.closed()).toBe(true);
      vi.advanceTimersByTime(GONE_GRACE_MS);
      // A socket with nothing behind it (never opened) is closed when the grace ends.
      const t = fakeSocket();
      hub.register('never', t.socket);
      hub.gone('never', t.socket);
      expect(t.closed()).toBe(false);
      vi.advanceTimersByTime(GONE_GRACE_MS);
      expect(t.closed()).toBe(true);
      expect(hub.hasExited('never')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gone() for a replaced socket closes only that socket and leaves the bound one alone (codex c6-r3)', () => {
    const hub = new TerminalHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.register('dup', a.socket);
    hub.register('dup', b.socket);
    hub.gone('dup', a.socket, 0);
    expect(a.closed()).toBe(true);
    expect(b.closed()).toBe(false);
    expect(hub.hasExited('dup')).toBe(false);
    hub.gone('dup', b.socket, 0);
    expect(b.closed()).toBe(true);
    expect(hub.hasExited('dup')).toBe(true);
  });

  it('holds a bounded amount: the oldest bytes and the oldest terminals are dropped', () => {
    const hub = new TerminalHub();
    const chunk = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 8; i++) hub.route(out('big', `${i}${chunk}`));
    const s = fakeSocket();
    hub.register('big', s.socket);
    const total = s.sent.reduce((n, c) => n + c.length, 0);
    expect(total).toBeLessThanOrEqual(EARLY_OUTPUT_MAX_BYTES);
    expect(s.sent.at(-1)?.startsWith('7')).toBe(true);
    for (let i = 0; i < EARLY_OUTPUT_MAX_TERMINALS + 5; i++) hub.route(out(`t${i}`, 'hi'));
    expect(hub.heldCount()).toBe(EARLY_OUTPUT_MAX_TERMINALS);
    // A single frame past the bound keeps only its tail (agy c6-r1).
    const one = new TerminalHub();
    one.route(out('huge', `head${'y'.repeat(EARLY_OUTPUT_MAX_BYTES)}tail`));
    const h = fakeSocket();
    one.register('huge', h.socket);
    expect(h.sent.join('').length).toBe(EARLY_OUTPUT_MAX_BYTES);
    expect(h.sent.join('').endsWith('tail')).toBe(true);
    // ...and holds a copy, not a view that keeps the whole decoded frame alive (codex c6-r6).
    const big = new TerminalHub();
    big.route(out('eight', 'z'.repeat(8 * EARLY_OUTPUT_MAX_BYTES)));
    const e = fakeSocket();
    big.register('eight', e.socket);
    expect(e.raw[0]?.buffer.byteLength).toBeLessThan(2 * EARLY_OUTPUT_MAX_BYTES);
  });

  it('evicts a held exited terminal before a live one', () => {
    const hub = new TerminalHub();
    hub.route(out('live-login', 'https://example.invalid/device'));
    for (let i = 0; i < EARLY_OUTPUT_MAX_TERMINALS - 1; i++) {
      hub.route(out(`dead${i}`, 'x'));
      hub.route(exited(`dead${i}`));
    }
    hub.route(out('newcomer', 'y'));
    const s = fakeSocket();
    hub.register('live-login', s.socket);
    expect(s.sent).toEqual(['https://example.invalid/device']);
  });

  it('a long-lived socket is never forgotten: its frames after detaching are not held (codex c6-r1)', () => {
    const hub = new TerminalHub();
    const shell = fakeSocket();
    hub.register('shell', shell.socket);
    for (let i = 0; i < 300; i++) {
      const s = fakeSocket();
      hub.register(`t${i}`, s.socket);
      hub.unregister(`t${i}`);
    }
    hub.unregister('shell');
    hub.route(out('shell', 'trailing'));
    hub.route(exited('shell'));
    expect(hub.heldCount()).toBe(0);
  });

  it('holds nothing for non-terminal events', () => {
    const hub = new TerminalHub();
    hub.route({ type: 'runUpdated', id: 'run-1' } as unknown as CoreEvent);
    expect(hub.heldCount()).toBe(0);
    expect(hub.knowsExited('run-1')).toBe(false);
  });
});
