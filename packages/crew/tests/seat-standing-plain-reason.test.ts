// crew#771 — a signed-out seat's council_ineligible_reason (the sentence studio shows on the launch
// form) pasted the CLI's raw auth-status JSON, with two absolute paths under the operator's home,
// into the plain sentence. The reason stays one plain sentence; the evidence keeps its own field
// (`auth_evidence`), with the home directory written `~`.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { homeless, plainEvidence, seatStanding } from '../src/api/seat-standing.js';

const HOME = homedir();
const RAW = JSON.stringify({
  loggedIn: false,
  authMethod: 'none',
  apiProvider: 'firstParty',
  projectsDirectory: join(HOME, '.wicked-worker', 'claude', 'projects'),
  configDirectory: join(HOME, '.wicked-worker', 'claude'),
});

describe('a signed-out seat reads as one plain sentence (crew#771)', () => {
  it("the probe's raw auth JSON never reaches the reason; the evidence keeps it, home written ~", () => {
    const s = seatStanding({ key: 'claude' }, true, null, { signedIn: false, check: 'status', probedAt: '2026-10-04T00:00:00.000Z', detail: RAW });
    expect(s.council_eligible).toBe(false);
    expect(s.council_ineligible_reason).toBe("signed out — the seat's own auth check says it is not logged in; sign it in from the System page");
    expect(s.auth_evidence).toContain('"loggedIn":false');
    expect(s.auth_evidence).not.toContain(HOME);
    expect(s.auth_evidence).toContain('~/.wicked-worker/claude');
  });

  it("a seat's own short words still name the cause; a path or a JSON blob in them does not reach the sentence", () => {
    const failure = { at: '2026-10-04T00:00:00.000Z', detail: 'No API key found for anthropic', source: 'ballot' as const, run: 'r-1' };
    expect(seatStanding({ key: 'pi' }, true, failure).council_ineligible_reason).toMatch(/reported no credential \(ballot: No API key found for anthropic\)/);
    const leaky = { ...failure, detail: `Error: could not read ${join(HOME, '.pi', 'auth.json')}` };
    const r = seatStanding({ key: 'pi' }, true, leaky).council_ineligible_reason!;
    expect(r).not.toContain(HOME);
    expect(r).toBe('signed out — the seat itself reported no credential (ballot); sign it in from the System page');
  });

  it('plainEvidence keeps one short plain line and refuses JSON, paths, multi-line and long text', () => {
    expect(plainEvidence('No API key found for anthropic')).toBe('No API key found for anthropic');
    expect(plainEvidence(RAW)).toBeNull();
    expect(plainEvidence('see /etc/thing')).toBeNull();
    expect(plainEvidence('see C:\\Users\\x\\auth.json')).toBeNull();
    expect(plainEvidence('see ~/.codex/auth.json')).toBeNull();
    expect(plainEvidence('line one\nline two')).toBeNull();
    expect(plainEvidence('x'.repeat(200))).toBeNull();
    expect(plainEvidence('')).toBeNull();
    // codex on #797: relative paths and scheme-less URLs carry account names too.
    expect(plainEvidence('could not read .wicked-worker/claude/projects/auth.json')).toBeNull();
    expect(plainEvidence('open example.com/someone/auth.json')).toBeNull();
    expect(plainEvidence('HTTP 401: invalid x-api-key')).toBe('HTTP 401: invalid x-api-key');
  });

  it('homeless replaces the home only as a whole path segment, in every separator spelling (codex on #797)', () => {
    expect(homeless('could not read /home/alice/.claude/auth.json', '/home/al')).toBe('could not read /home/alice/.claude/auth.json');
    expect(homeless('could not read /home/al/.claude/auth.json', '/home/al')).toBe('could not read ~/.claude/auth.json');
    expect(homeless('home is /home/al', '/home/al/')).toBe('home is ~');
    expect(homeless('C:\\Users\\alice\\.claude\\auth.json', 'C:\\Users\\alice')).toBe('~\\.claude\\auth.json');
    expect(homeless('C:/Users/alice/.claude', 'C:\\Users\\alice')).toBe('~/.claude');
    // Inside a CLI's JSON status a Windows home is written with doubled backslashes.
    expect(homeless(JSON.stringify({ configDirectory: 'C:\\Users\\alice\\.claude' }), 'C:\\Users\\alice')).toBe('{"configDirectory":"~\\\\.claude"}');
    expect(homeless('anything at /', '/')).toBe('anything at /');
  });
});
