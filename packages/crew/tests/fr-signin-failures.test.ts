import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginContainerFromArgv, signInFailure } from '../src/api/seat-container-login.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fr-signin-')); vi.stubEnv('HOME', home); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('signInFailure', () => {
  it('replaces the runtime diagnostic with the one runtime repair', () => {
    expect(signInFailure('seat-login: container_runtime_down: /Users/x/.rd/docker failed\ntrace', 'claude')).toEqual({
      code: 'container_runtime_down',
      error: "Docker isn't running, so the sign-in container can't start. Start Docker Desktop or Rancher Desktop, then try again.",
    });
  });
  it('explains that the missing CLI is installed on this computer', () => {
    expect(signInFailure("codex is not installed on this host: its sign-in runs this host's own codex (the seats run codex 0.162.1). Install it, then sign in again", 'codex')).toEqual({
      code: 'cli_not_installed',
      error: "Codex isn't installed on this computer. Its sign-in runs your own codex: install it (see its install guide), then try again.",
    });
    expect(signInFailure('codex is not installed on this host. Install it: npm install -g @openai/codex', 'codex').error).toContain('(npm install -g @openai/codex)');
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
  it('extracts exactly the named run container and never a host command or a guessed target', () => {
    expect(loginContainerFromArgv(['/runtime', 'run', '--name', 'specific-login-deadbeef', 'image'])).toEqual({ runtime: '/runtime', name: 'specific-login-deadbeef' });
    expect(loginContainerFromArgv(['/runtime', 'run', '--name=specific-login-deadbeef', 'image'])?.name).toBe('specific-login-deadbeef');
    expect(loginContainerFromArgv(['codex', 'login', '--name', 'unrelated'])).toBeNull();
    expect(loginContainerFromArgv(['/runtime', 'run', 'image'])).toBeNull();
    expect(loginContainerFromArgv(['/runtime', 'run', '--name', '-a'])).toBeNull();
  });
});
