import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineSpotOf, signInFailure } from '../src/api/seat-container-login.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fr-signin-')); vi.stubEnv('HOME', home); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('signInFailure', () => {
  it('replaces the runtime diagnostic with the one runtime repair', () => {
    expect(signInFailure('seat-login: container_runtime_down: /Users/x/.rd/docker failed\ntrace', 'claude')).toEqual({
      code: 'container_runtime_down',
      error: "Docker isn't running, so the sign-in container can't start. Start Rancher Desktop, then try again.",
    });
    expect(signInFailure('seat-login: container_runtime_down: runtime unavailable', 'claude').error).not.toMatch(/Docker Desktop/);
  });
  it('maps every k8s runner refusal kind to its own code and one repair (wicked-core FloorUnarmed)', () => {
    const said = (kind: string, why = 'the reason') => `wicked-core seat-login: ${kind}: ${why}`;
    const kinds = ['no_cluster', 'cluster_unreachable', 'controller_missing', 'pids_unlimited', 'policy_refused', 'admission_pending', 'image_unavailable', 'exec_stream_lost'];
    for (const kind of kinds) {
      expect(signInFailure(said(kind), 'claude').code).toBe(kind);
      expect(signInFailure(said(kind), 'claude').error).not.toMatch(/Docker Desktop/);
    }
    expect(signInFailure(said('cluster_unreachable'), 'claude').error).toBe("Kubernetes isn't answering, so the Claude sign-in can't start. Start Rancher Desktop with Kubernetes on, then try again.");
    expect(signInFailure(said('no_cluster'), 'copilot').error).toContain('wicked-core cluster install --admin-context');
    expect(signInFailure(said('controller_missing'), 'copilot').error).toContain('wicked-core cluster install --admin-context');
    expect(signInFailure(said('pids_unlimited'), 'claude').error).toContain('pod-max-pids to 4096');
    expect(signInFailure(said('image_unavailable'), 'copilot').error).toContain('`wicked-core seat-image build copilot`');
    // The cluster's own words ride a policy refusal, scrubbed like any sign-in diagnostic.
    expect(signInFailure(said('policy_refused', `pods "x" is forbidden: violates PodSecurity at ${home}/k8s\nsecond line`), 'claude').error)
      .toBe('The cluster refused the Claude sign-in pod. The cluster said: pods "x" is forbidden: violates PodSecurity at ~/k8s. Fix what it names, then try again.');
    // What the kind alone cannot say rides along (a rollout still starting is not "missing").
    expect(signInFailure(said('controller_missing', 'deployment agent-sandbox-controller has 0/1 ready replicas'), 'claude').error)
      .toContain('The cluster said: deployment agent-sandbox-controller has 0/1 ready replicas.');
    expect(signInFailure(said('admission_pending', 'timed out waiting for the pod'), 'claude').error).toContain('or it is still starting');
    // A JSON-escaped foreign home path in the engine's words is ~.
    const escaped = ['C:', 'Users', 'other', '.kube', 'config'].join('\\\\');
    expect(signInFailure(said('controller_missing', `cannot read ${escaped}`), 'claude').error).not.toContain('other');
    // A credential shape in the engine's words is redacted before it crosses the wire.
    expect(signInFailure(said('policy_refused', 'webhook said Authorization: Bearer abcdefghijklmnop0123456789'), 'claude').error).not.toContain('abcdefghijklmnop0123456789');
    // Only the engine's refusal line counts: a warning line before it is fine, a kind inside another refusal's words is not.
    expect(signInFailure(`warning: something\n${said('cluster_unreachable')}`, 'claude').code).toBe('cluster_unreachable');
    expect(signInFailure('wicked-core seat-login: login failed: the cluster said cluster_unreachable: earlier', 'claude').code).toBe('signin_failed');
    expect(signInFailure('the cluster_unreachable flag was seen', 'claude').code).toBe('signin_failed');
    expect(signInFailure('xno_cluster: nope', 'claude').code).toBe('signin_failed');
  });
  it('crew#1844: the commands a cluster refusal names are filled in for this daemon', () => {
    const said = (kind: string) => `wicked-core seat-login: ${kind}: the reason`;
    const engine = { exe: '/opt/wicked/bin/wicked-core', home: '/var/crew' };
    const none = signInFailure(said('no_cluster'), 'codex', engine).error;
    expect(none).toContain("run `/opt/wicked/bin/wicked-core cluster install --admin-context rancher-desktop --home /var/crew` (rancher-desktop is Rancher Desktop's cluster; for a different cluster, use its context), then try again.");
    expect(signInFailure(said('controller_missing'), 'codex', engine).error).toContain('`/opt/wicked/bin/wicked-core cluster install --admin-context rancher-desktop --home /var/crew`');
    expect(signInFailure(said('image_unavailable'), 'codex', engine).error).toContain('`/opt/wicked/bin/wicked-core seat-image build codex`');
    for (const kind of ['no_cluster', 'controller_missing', 'image_unavailable']) expect(signInFailure(said(kind), 'codex', engine).error).not.toMatch(/<[^>]+>/);
    // The engine and state home a sign-in runs with: the gateway dir's parent, as runSeatLogin hands it.
    vi.stubEnv('WICKED_CORE_EXE', '/opt/wc');
    expect(engineSpotOf({ gatewayDir: '/opt/crew-1844/gateway' })).toEqual({ exe: '/opt/wc', home: '/opt/crew-1844' });
  });
  it('explains that the missing CLI is installed on this computer', () => {
    expect(signInFailure("codex is not installed on this host: its sign-in runs this host's own codex (the seats run codex 0.162.1). Install it, then sign in again", 'codex')).toEqual({
      code: 'cli_not_installed',
      error: "Codex isn't installed on this computer. Its sign-in runs your own codex: install it (see its install guide), then try again.",
    });
    expect(signInFailure('codex is not installed on this host. Install it: npm install -g @openai/codex', 'codex').error).toContain('(npm install -g @openai/codex)');
    // core#1845: the engine's refusal now ends with the seat package (seat_login.rs host_cli_missing).
    expect(signInFailure("codex is not installed on this host: its sign-in runs this host's own codex (the seats run codex 0.162.1). Install it, then sign in again: npm install -g @openai/codex@0.162.1", 'codex').error)
      .toBe("Codex isn't installed on this computer. Its sign-in runs your own codex: install it (npm install -g @openai/codex@0.162.1), then try again.");
  });
  it('scrubs foreign Unix and Windows homes, the injected home, and multiline diagnostics', () => {
    expect(signInFailure(`cannot read /Users/x/auth.json or /home/y/auth or C:\\Users\\z\\auth or ${home}/auth\nprivate second line`, 'codex')).toEqual({
      code: 'signin_failed', error: 'cannot read ~/auth.json or ~/auth or ~\\auth or ~/auth',
    });
    expect(signInFailure('x'.repeat(400), 'codex').error.length).toBe(240);
  });
  it('keeps conflict and supersession distinct', () => {
    expect(signInFailure('a sign-in is already open for claude', 'claude')).toEqual({ code: 'signin_already_open', error: 'A Claude sign-in is already open. Finish it, or close it and start again.' });
    expect(signInFailure('the codex sign-in was superseded', 'codex').code).toBe('signin_superseded');
  });
});
