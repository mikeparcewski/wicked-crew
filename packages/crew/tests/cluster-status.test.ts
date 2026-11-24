import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_TIMEOUT_MS,
  ClusterStatusReader,
  publicText,
  clusterDiagnostics,
  clusterInstallCommand,
  clusterRows,
  engineCommand,
  parseClusterStatus,
  shellPath,
  readClusterStatus,
  type ClusterStatus,
} from '../src/api/cluster-status.js';
import type { Settled } from '../src/api/system-snapshot.js';

/** `wicked-core cluster status --json` (k8s runner B-5, `k8s/cli.rs status_doc`). */
const READY = { configured: true, reachable: true, context: 'rancher-desktop', controller: { ready: true }, gateway: 'serving', controllerVersion: 'v0.1.0', runNamespaces: 2, pendingPods: 1 };
const ok = (doc: object): Settled<ClusterStatus> => ({ kind: 'ok', value: parseClusterStatus(JSON.stringify(doc))!, ms: 1 });

describe('parseClusterStatus', () => {
  it('picks the fields it reads and nothing else, home paths spelled ~', () => {
    const doc = parseClusterStatus(JSON.stringify({ ...READY, secret: 'x', detail: `cannot read ${homedir()}/.wicked-k8s/k8s\nmore` }))!;
    expect(doc).toEqual({
      configured: true, reachable: true, kind: null, context: 'rancher-desktop', controller: { ready: true, detail: null },
      controllerVersion: 'v0.1.0', gateway: 'serving', runNamespaces: 2, pendingPods: 1, detail: 'cannot read ~/.wicked-k8s/k8s',
    });
    expect(JSON.stringify(doc)).not.toContain('secret');
  });
  it('refuses what is not a status document', () => {
    for (const out of ['', 'not json', '[]', 'null', '{"configured":"yes","reachable":true}']) expect(parseClusterStatus(out)).toBeNull();
    expect(parseClusterStatus(JSON.stringify({ ...READY, gateway: 'weird', runNamespaces: -1, kind: 'Not A Kind!' }))).toMatchObject({ gateway: null, runNamespaces: null, kind: null });
  });
});

describe('readClusterStatus', () => {
  it('runs the engine CLI with the state home, and reads the document a failed exit prints', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify(READY), stderr: '' }));
    await expect(readClusterStatus({ exe: '/core', home: '/h', exec })).resolves.toMatchObject({ reachable: true });
    expect(exec).toHaveBeenCalledWith('/core', ['cluster', 'status', '--json', '--home', '/h'], { timeout: 6_000 });
    const down = vi.fn(async () => { throw Object.assign(new Error('Command failed'), { stdout: JSON.stringify({ configured: true, reachable: false, kind: 'cluster_unreachable', context: 'rd' }) }); });
    await expect(readClusterStatus({ exe: '/core', home: '/h', exec: down })).resolves.toMatchObject({ reachable: false, kind: 'cluster_unreachable' });
    const broken = vi.fn(async () => { throw new Error('spawn ENOENT'); });
    await expect(readClusterStatus({ exe: '/core', home: '/h', exec: broken })).rejects.toThrow('ENOENT');
    await expect(readClusterStatus({ exe: null, home: '/h', exec })).rejects.toThrow('WICKED_CORE_EXE');
    await expect(readClusterStatus({ exe: '/core', home: null, exec })).rejects.toThrow('state home');
  });
});

describe('ClusterStatusReader', () => {
  it('is single-flight and never serves an old answer', async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify(READY), stderr: '' }));
    const reader = new ClusterStatusReader(() => ({ exe: '/core', home: '/h', exec }));
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(a.kind === "ok" && b.kind === "ok" && a.value === b.value).toBe(true); expect(exec).toHaveBeenCalledTimes(1);
    await reader.read(); expect(exec).toHaveBeenCalledTimes(2);
  });
  it('a caller that gives up leaves the one engine process running, and the next caller joins it', async () => {
    let finish!: (out: { stdout: string; stderr: string }) => void;
    const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>((r) => { finish = r; }));
    const reader = new ClusterStatusReader(() => ({ exe: '/core', home: '/h', exec }));
    expect((await reader.read(10)).kind).toBe('timeout');
    const second = reader.read();
    expect(exec).toHaveBeenCalledTimes(1);
    finish({ stdout: JSON.stringify(READY), stderr: '' });
    expect((await second).kind).toBe('ok');
    await reader.read(); expect(exec).toHaveBeenCalledTimes(2);
  });
  it('a caller never waits past the engine bound, whatever bound it asks for (crew#1780: proven on fake time)', async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>(() => undefined));
      const reader = new ClusterStatusReader(() => ({ exe: '/core', home: '/h', exec }));
      let settled: Settled<ClusterStatus> | null = null;
      void reader.read(60_000).then((r) => { settled = r; });
      await vi.advanceTimersByTimeAsync(CLUSTER_TIMEOUT_MS - 1);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({ kind: 'timeout', ms: CLUSTER_TIMEOUT_MS });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clusterRows', () => {
  const at = Date.now();
  it('a ready cluster: both rows ok, the load in words', () => {
    const { cluster, gateway } = clusterRows(ok(READY), true, at);
    expect(cluster).toMatchObject({ key: 'cluster', label: 'Kubernetes cluster', state: 'ok', reason: 'ready (context rancher-desktop): 2 run namespaces, 1 pod waiting to start', remedy: null });
    expect(cluster.details).toMatchObject({ context: 'rancher-desktop', controllerReady: true, runNamespaces: 2, pendingPods: 1, gateway: 'serving' });
    expect(gateway).toMatchObject({ key: 'gateway', state: 'ok', reason: 'serving (in the cluster)' });
  });
  it('each gateway state', () => {
    expect(clusterRows(ok({ ...READY, gateway: 'starting' }), true, at).gateway.state).toBe('degraded');
    expect(clusterRows(ok({ ...READY, gateway: 'stopped' }), true, at).gateway).toMatchObject({ state: 'down', reason: expect.stringContaining('quarantine') });
    expect(clusterRows(ok({ ...READY, gateway: 'absent' }), true, at).gateway).toMatchObject({ state: 'degraded', reason: expect.stringContaining('not started yet') });
  });
  it('not configured, not answering, no controller: down, with the one repair', () => {
    const none = clusterRows(ok({ configured: false, reachable: false, kind: 'no_cluster' }), true, at);
    expect(none.cluster).toMatchObject({ state: 'down', remedy: expect.stringContaining('wicked-core cluster install') });
    expect(none.gateway.state).toBe('down');
    const off = clusterRows(ok({ configured: true, reachable: false, kind: 'cluster_unreachable', context: 'rancher-desktop' }), true, at);
    expect(off.cluster).toMatchObject({ state: 'down', reason: "Kubernetes isn't answering (context rancher-desktop), so no seat can start", remedy: expect.stringContaining('Rancher Desktop') });
    // The API not answering proves nothing about pods already running: the gateway is unobserved, not down.
    expect(off.gateway).toMatchObject({ state: 'unknown', reason: expect.stringContaining('could not be read') });
    for (const row of [off.cluster, off.gateway]) {
      expect(row.remedy).toBe('Start Rancher Desktop with Kubernetes on, then re-check.');
      expect(row.remedy).not.toContain('Docker Desktop');
    }
    const noCtl = clusterRows(ok({ ...READY, controller: { ready: false, detail: 'no sandboxes CRD' } }), true, at);
    expect(noCtl.cluster).toMatchObject({ state: 'down', reason: expect.stringContaining('no sandboxes CRD'), remedy: expect.stringContaining('cluster install') });
  });
  it('crew#1844: every command a row names is filled in for this daemon, so it pastes and runs', () => {
    const engine = { exe: join(homedir(), '.wicked', 'bin/wicked-core'), home: join(homedir(), '.wicked-crew') };
    // The engine's own document for a state home with no cluster (wicked-core k8s/mod.rs resolve_settings).
    const none = clusterRows(ok({ configured: false, reachable: false, kind: 'no_cluster', detail: 'no cluster is configured for this daemon: run `wicked-core cluster install` or set WICKED_K8S_CONTEXT (the current kubectl context is never used implicitly)' }), true, at, engine);
    expect(none.cluster.remedy).toBe("Run `~/.wicked/bin/wicked-core cluster install --admin-context rancher-desktop --home ~/.wicked-crew` (rancher-desktop is Rancher Desktop's cluster; for a different cluster, use its context), then re-check.");
    expect(none.gateway.remedy).toBe(none.cluster.remedy);
    const unread = clusterRows({ kind: 'error', error: 'boom', ms: 1 }, true, at, engine);
    expect(unread.cluster.remedy).toBe('Re-check; if it persists, run `~/.wicked/bin/wicked-core cluster status --home ~/.wicked-crew` by hand.');
    const noCtl = clusterRows(ok({ ...READY, controller: { ready: false } }), true, at, engine);
    expect(noCtl.cluster.remedy).toContain('`~/.wicked/bin/wicked-core cluster install --admin-context rancher-desktop --home ~/.wicked-crew`');
    for (const row of [none.cluster, none.gateway, unread.cluster, noCtl.cluster]) {
      expect(row.remedy).not.toMatch(/<[^>]+>/);
    }
    // No kubectl at all is Rancher Desktop missing or stopped, not a cluster to install.
    const noKubectl = clusterRows(ok({ configured: false, reachable: false, kind: 'no_cluster', detail: 'no kubectl was found (set WICKED_KUBECTL to its path)' }), true, at, engine);
    expect(noKubectl.cluster).toMatchObject({ state: 'down', remedy: 'Start Rancher Desktop with Kubernetes on, then re-check.' });
  });
  it('a symlinked home is ~ in either spelling, and the tilde stays outside the quotes (codex r1)', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'crew-1844-')));
    try {
      const real = join(base, 'homes', 'alice');
      mkdirSync(join(real, 'State Dir'), { recursive: true });
      const link = join(base, 'home-alice');
      symlinkSync(real, link);
      expect(shellPath(join(real, 'State Dir'), link)).toBe("~/'State Dir'");
      expect(shellPath(join(link, 'State Dir'), link)).toBe("~/'State Dir'");
      expect(shellPath(join(real, '.wicked-crew'), link)).toBe('~/.wicked-crew');
      expect(shellPath(join(real, '.wicked-crew'), link)).not.toContain('alice');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  it('a command names the engine path and state home as shell words', () => {
    expect(shellPath('/opt/homebrew/bin/wicked-core', '/home/a')).toBe('/opt/homebrew/bin/wicked-core');
    expect(shellPath('/home/a', '/home/a')).toBe('~');
    expect(shellPath('/home/a/My Tools/wicked-core', '/home/a')).toBe("~/'My Tools/wicked-core'");
    expect(shellPath("/srv/it's/core", '/home/a')).toBe("'/srv/it'\\''s/core'");
    expect(shellPath('/home/ab/core', '/home/a')).toBe('/home/ab/core');
    expect(engineCommand({ exe: null, home: null }, 'cluster status')).toBe('wicked-core cluster status');
    // A relative engine path is the daemon's, made absolute; a bare name stays for PATH.
    expect(engineCommand({ exe: 'bin/engine', home: null }, 'cluster status')).toBe(`${shellPath(join(process.cwd(), 'bin', 'engine'))} cluster status`);
    expect(engineCommand({ exe: 'bin/engine', home: null }, 'cluster status')).not.toMatch(/^bin\//);
    expect(engineCommand({ exe: 'engine', home: null }, 'cluster status')).toBe('engine cluster status');
    expect(clusterInstallCommand({ exe: '/opt/wc', home: '/var/crew' })).toBe('/opt/wc cluster install --admin-context rancher-desktop --home /var/crew');
  });
  it('each row from its own evidence: a known failure is never hidden by an unread neighbour', () => {
    const noGw = clusterRows(ok({ configured: true, reachable: true, context: 'rd', controller: { ready: false, detail: 'rolling out' } }), true, at);
    expect(noGw.cluster).toMatchObject({ state: 'down', reason: expect.stringContaining('rolling out') });
    expect(noGw.gateway.state).toBe('unknown');
    const noCtl = clusterRows(ok({ configured: true, reachable: true, context: 'rd', gateway: 'serving' }), true, at);
    expect(noCtl.gateway.state).toBe('ok');
    expect(noCtl.cluster.state).toBe('degraded');
  });
  it('a counter the engine did not count is said so, never shown as zero', () => {
    const rows = clusterRows(ok({ ...READY, runNamespaces: null, pendingPods: 'x' }), true, at);
    expect(rows.cluster).toMatchObject({ state: 'ok', reason: 'ready (context rancher-desktop): run namespaces not counted, pending pods not counted' });
  });
  it('credential shapes in engine or kubectl words never cross the wire (redacted before the cut)', () => {
    const leak = 'Unauthorized: Authorization: Bearer abcdefghijklmnop0123456789 token=supersecretvalue';
    const doc = parseClusterStatus(JSON.stringify({ ...READY, controller: { ready: false, detail: leak }, detail: leak }))!;
    const rows = clusterRows({ kind: 'ok', value: doc, ms: 1 }, true, at);
    const err = clusterRows({ kind: 'error', error: leak, ms: 1 }, true, at);
    for (const text of [JSON.stringify(doc), JSON.stringify(rows), JSON.stringify(err), JSON.stringify(clusterDiagnostics({ kind: 'error', error: leak, ms: 1 }))]) {
      expect(text).not.toContain('abcdefghijklmnop0123456789');
      expect(text).not.toContain('supersecretvalue');
    }
    expect(err.cluster.remedy).toContain('cluster status');
  });
  it('every credential spelling an upstream diagnostic can carry is redacted, and every home path is ~', () => {
    const user = ['C:', 'Users', 'other', '.kube', 'config'].join('\\\\');
    const raw = `webhook {"token":"opaque-cluster-secret","password": "p4ss"} password: opaque-password Authorization: Basic dXNlcjpwYXNz https://bob:hunter2@registry.local/v2 at ${user} and ${homedir()}/.kube`;
    const out = publicText(raw);
    for (const leak of ['opaque-cluster-secret', 'p4ss', 'opaque-password', 'dXNlcjpwYXNz', 'hunter2', 'other', homedir()]) expect(out).not.toContain(leak);
    expect(out).toContain('registry.local/v2');
  });
  it('an error is sanitized whole, then cut: a credential across the cut never leaves its prefix', async () => {
    const long = `${'x'.repeat(225)} ghp_abcdefghijklmnopqrstuvwxyz0123456789`;
    const reader = new ClusterStatusReader(() => ({ exe: '/core', home: '/h', exec: async () => { throw Object.assign(new Error('Command failed'), { stderr: long }); } }));
    const read = await reader.read();
    const rows = clusterRows(read, true, at);
    expect(JSON.stringify(rows)).not.toContain('ghp_abc');
    expect(JSON.stringify(clusterDiagnostics(read))).not.toContain('ghp_abc');
  });
  it('a timeout says the wait this caller gave it', () => {
    expect(clusterRows({ kind: 'timeout', ms: 2_400 }, true, at).cluster).toMatchObject({ reason: 'the cluster did not answer within 2 s', timeoutMs: 2_400 });
  });
  it('a read that failed part-way, timed out or errored is never ok', () => {
    expect(clusterRows(ok({ configured: true, reachable: true, context: 'rd', detail: 'forbidden' }), true, at).cluster).toMatchObject({ state: 'degraded', reason: expect.stringContaining('forbidden') });
    expect(clusterRows({ kind: 'timeout', ms: 6_000 }, true, at).cluster).toMatchObject({ state: 'unknown', timeoutMs: 6_000 });
    expect(clusterRows({ kind: 'error', error: 'spawn ENOENT', ms: 1 }, true, at).gateway.state).toBe('unknown');
  });
  it('the host floor has neither', () => {
    const rows = clusterRows(null, false, at);
    expect(rows.cluster.state).toBe('off'); expect(rows.gateway.state).toBe('off');
  });
});

describe('clusterDiagnostics', () => {
  it('the document, or why there is none', () => {
    expect(clusterDiagnostics(ok(READY))).toMatchObject({ read: 'ok', reachable: true, gateway: 'serving' });
    expect(clusterDiagnostics({ kind: 'timeout', ms: 6_000 })).toEqual({ read: 'timeout', detail: 'no answer within 6 s' });
    expect(clusterDiagnostics({ kind: 'error', error: 'boom', ms: 1 })).toEqual({ read: 'error', detail: 'boom' });
  });
});
