// DES-seats-page A8 + A2: account identifiers never reach `GET /roster`, and the account KIND does.
//
// The shapes are the CLIs' real ones with FABRICATED values (no real credential is read): claude
// 2.1.x `auth status --json` signed in prints `loggedIn`, `authMethod`, `apiProvider`, the config
// and projects directories, then `email`, `orgId`, `orgName` and `subscriptionType`; codex
// `login status` prints "Logged in using ChatGPT" or "Logged in using an API key - <masked key>".

import { describe, expect, it } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { SeatProbe, type ProbeOutput } from '../src/api/seat-probe.js';
import { refusalSummary } from '../src/api/seat-health.js';
import { accountFromStatus, liveSummary, scrubEvidence, scrubStatusOutput, statusSummary } from '../src/api/seat-scrub.js';
import type { CoreEvent } from '../src/core/types.js';

const EMAIL = 'pat.example@fabricated.test';
const ORG_ID = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const ORG_NAME = 'Fabricated Org Ltd';
const HOME = '/home/fabricated';

/** claude 2.1.x `auth status --json`, signed in on a subscription (fabricated values). */
const CLAUDE_SIGNED_IN = JSON.stringify(
  {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    analyticsDisabled: false,
    projectsDirectory: `${HOME}/.wicked-worker/claude/projects`,
    configDirectory: `${HOME}/.wicked-worker/claude`,
    email: EMAIL,
    orgId: ORG_ID,
    orgName: ORG_NAME,
    subscriptionType: 'max',
  },
  null,
  2,
);

/** The same CLI with an API key from `/login` (it prints the account too). */
const CLAUDE_API_KEY = JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: '/login managed key', email: EMAIL, orgId: ORG_ID, orgName: ORG_NAME });

const CODEX_CHATGPT = 'Logged in using ChatGPT\n';
const CODEX_API_KEY = 'Logged in using an API key - sk-proj-***Zx9Q\n';

const LEAKS = [EMAIL, ORG_ID, ORG_NAME, 'sk-proj', 'Zx9Q', HOME];

/** Token-SHAPED fixtures, built at run time so no committed line looks like a credential to a
 *  secret scanner. Every one is fabricated. */
const fake = (...parts: string[]): string => parts.join('');
const FAKE_GH = fake('gh', 'p_', 'FAKE', 'fake', 'FAKE', '1234');
const FAKE_BEARER = fake('fab', 'RICATED', '0000', 'not', 'A', 'real', 'TOKEN', '99');
const FAKE_ACCT = fake('acct_', '0'.repeat(10), '9'.repeat(10));
const leaksIn = (text: string): string[] => LEAKS.filter((l) => text.includes(l));

describe('scrubStatusOutput / scrubEvidence (A8)', () => {
  it('a signed-in claude status keeps only loggedIn / authMethod / apiProvider', () => {
    const out = scrubStatusOutput(CLAUDE_SIGNED_IN);
    expect(JSON.parse(out)).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
    expect(leaksIn(out)).toEqual([]);
  });

  it('an API-key claude status drops the account and the key source', () => {
    const out = scrubStatusOutput(CLAUDE_API_KEY);
    expect(JSON.parse(out)).toEqual({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' });
  });

  it('codex text keeps its words and loses the key prefix', () => {
    expect(scrubStatusOutput(CODEX_API_KEY)).toBe('Logged in using an API key - <key>\n');
    expect(scrubStatusOutput(CODEX_CHATGPT)).toBe(CODEX_CHATGPT);
  });

  it('free text: emails, ids, account pairs and long tokens are masked; plain words survive', () => {
    const text = `Logged in as ${EMAIL} (org ${ORG_ID}); account_id=${FAKE_ACCT} token ${FAKE_GH} ${fake('Bear', 'er')} ${FAKE_BEARER}`;
    const out = scrubEvidence(text);
    expect(leaksIn(out)).toEqual([]);
    for (const t of [FAKE_ACCT, FAKE_GH, FAKE_BEARER]) expect(out).not.toContain(t);
    expect(out).toContain('<email>');
    expect(out).toContain('<id>');
    expect(scrubEvidence('Not logged in · Please run /login')).toBe('Not logged in · Please run /login');
    expect(scrubEvidence('quota_exhausted (no success in the run)')).toBe('quota_exhausted (no success in the run)');
    expect(scrubEvidence('opencode v2.0.25')).toBe('opencode v2.0.25');
  });

  it("codex r1's leak: a multi-word org name and a digit-free token= value go whole", () => {
    const out = scrubEvidence('Not logged in; organization: Acme Research Ltd; token=abcdefghijklmnopqrstuvwxyz');
    expect(out).toBe('Not logged in; organization: <redacted>; token=<redacted>');
    expect(scrubEvidence(`HTTP 401: Authorization: ${fake('Bear', 'er')} ${fake('abc', '.def', '.ghi')}`)).not.toMatch(/abc\.def/);
    expect(scrubEvidence('api_key="k-123"; secret: s3cr3t')).toBe('api_key="<redacted>"; secret: <redacted>');
    expect(scrubEvidence('fallback read_only_requires_wrapped for governance_requires_wrapped')).toBe('fallback read_only_requires_wrapped for governance_requires_wrapped');
  });

  it('a truncated JSON status still loses its identifiers (the text guard)', () => {
    const cut = CLAUDE_SIGNED_IN.slice(0, CLAUDE_SIGNED_IN.indexOf(ORG_NAME) + 4);
    expect(leaksIn(scrubStatusOutput(cut)).filter((l) => l !== HOME)).toEqual([]);
  });
});

describe('the evidence is crew\'s vocabulary, never the CLI\'s prose (codex r2 on #996)', () => {
  it('a refusal carrying an unlabelled key and org keeps only the refusal phrase', () => {
    expect(refusalSummary('Invalid API key abcdefghijklmnopqrstuvwxyz; organization Acme Research Ltd')).toBe('Invalid API key');
    expect(refusalSummary('Error: No API key found for anthropic. Run /login.')).toBe('No API key found');
    expect(refusalSummary('ballot timed out after 40s')).toBeNull();
  });

  it('a JSON status with a stderr warning still goes through the allowlist (stdout alone); escaped quotes never leak', () => {
    const out = { code: 0, stdout: `{"loggedIn":true,"authMethod":"claude.ai","orgName":"Acme \\"Research\\" Ltd","email":"${EMAIL}"}`, stderr: 'Warning: update available' };
    const words = statusSummary('claude', out);
    expect(JSON.parse(words)).toEqual({ loggedIn: true, authMethod: 'claude.ai' });
    expect(words).not.toMatch(/Research|Acme|update available/);
  });

  it('malformed JSON is withheld, not echoed; codex keeps only its known phrase', () => {
    expect(statusSummary('claude', { code: 0, stdout: `{"loggedIn":true,"orgName":"Acme ${ORG_NAME}`, stderr: '' })).toBe('exit 0: the status output is not JSON (withheld)');
    expect(statusSummary('codex', { code: 0, stdout: CODEX_API_KEY, stderr: '' })).toBe('Logged in using an API key');
    expect(statusSummary('codex', { code: 2, stdout: `weird output for ${EMAIL}`, stderr: '' })).toBe('exit 2: the status output is withheld');
    expect(statusSummary('claude', { code: null, stdout: '', stderr: '', error: 'spawn claude ENOENT' })).toBe('the CLI is not installed (ENOENT)');
  });

  it('the live check says what stopped it in crew words', () => {
    expect(liveSummary({ code: 1, stdout: '', stderr: `Claude AI usage limit reached for ${EMAIL}|1760300000` })).toBe('exit 1: usage limit');
    expect(liveSummary({ code: 1, stdout: '', stderr: 'Failed to authenticate: OAuth session expired and could not be refreshed' })).toBe('OAuth session expired');
    expect(liveSummary({ code: 1, stdout: `something about ${ORG_NAME}`, stderr: '' })).toBe('exit 1');
  });
});

describe('accountFromStatus (A2): the kind, never an identifier', () => {
  it('reads claude and codex kinds and a provider-public plan', () => {
    expect(accountFromStatus('claude', CLAUDE_SIGNED_IN)).toEqual({ kind: 'subscription', plan: 'Max' });
    expect(accountFromStatus('claude', CLAUDE_API_KEY)).toEqual({ kind: 'api_key' });
    expect(accountFromStatus('claude', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'secret-internal-tier' }))).toEqual({ kind: 'subscription' });
    expect(accountFromStatus('claude', JSON.stringify({ loggedIn: false, authMethod: 'none' }))).toBeUndefined();
    expect(accountFromStatus('codex', CODEX_CHATGPT)).toEqual({ kind: 'subscription' });
    expect(accountFromStatus('codex', CODEX_API_KEY)).toEqual({ kind: 'api_key' });
    expect(accountFromStatus('codex', 'Not logged in')).toBeUndefined();
    expect(accountFromStatus('pi', 'anything')).toBeUndefined();
  });
});

/** A probe over scripted answers: the status command, then the live check. */
function probeWith(status: ProbeOutput, live: ProbeOutput): SeatProbe {
  return new SeatProbe({
    run: async (_cmd, args) => (args[0] === 'auth' || args[0] === 'login' ? status : live),
    env: { WICKED_WORKER_HOME: `${HOME}/.wicked-worker` },
    home: HOME,
  });
}

const REGISTRY = [
  { key: 'claude', display_name: 'Claude Code', binary: 'claude', enabled_for_council: true },
  { key: 'codex', display_name: 'Codex', binary: 'codex', enabled_for_council: true },
];

async function rosterOver(probe: SeatProbe, tracker = new SeatHealthTracker()) {
  const roster = rosterWithStandingFactory({
    seatHealth: tracker,
    registry: () => REGISTRY.map((s) => ({ ...s })),
    signedIn: () => true,
    env: { WICKED_WORKER_HOME: `${HOME}/.wicked-worker` },
    probe,
    worktreeBench: null,
    hostBoundary: () => 'sandbox-exec',
  });
  await roster.ready?.();
  return roster();
}

describe('GET /roster carries no account identifier (A8) and the account kind (A2)', () => {
  it('signed in, live check could not tell: login_note quotes the scrubbed status only', async () => {
    const probe = probeWith({ code: 0, stdout: CLAUDE_SIGNED_IN, stderr: '' }, { code: 1, stdout: '', stderr: `request failed for ${EMAIL}: overloaded` });
    const roster = await rosterOver(probe);
    const claude = roster.find((s) => s.key === 'claude')!;
    expect(claude.auth).toBe('signed_in');
    expect(claude.login_check).toBe('status');
    expect(claude.login_note).toContain('"authMethod":"claude.ai"');
    expect(claude['account']).toEqual({ kind: 'subscription', plan: 'Max' });
    expect(leaksIn(JSON.stringify(roster))).toEqual([]);
  });

  it('signed in live: the account kind rides, nothing else from the status', async () => {
    const probe = probeWith({ code: 0, stdout: CLAUDE_SIGNED_IN, stderr: '' }, { code: 0, stdout: 'OK', stderr: '' });
    const roster = await rosterOver(probe);
    expect(roster.find((s) => s.key === 'claude')!.login_check).toBe('live');
    expect(roster.find((s) => s.key === 'claude')!['account']).toEqual({ kind: 'subscription', plan: 'Max' });
    // codex's status words state no kind here (the scripted runner answered claude's JSON): unknown.
    expect(roster.find((s) => s.key === 'codex')!['account']).toEqual({ kind: 'unknown' });
    expect(leaksIn(JSON.stringify(roster))).toEqual([]);
  });

  it('codex on an API key: the masked key never reaches the wire', async () => {
    const probe = probeWith({ code: 0, stdout: CODEX_API_KEY, stderr: '' }, { code: 1, stdout: '', stderr: 'stream disconnected' });
    const roster = await rosterOver(probe);
    const codex = roster.find((s) => s.key === 'codex')!;
    expect(codex['account']).toEqual({ kind: 'api_key' });
    expect(leaksIn(JSON.stringify(roster))).toEqual([]);
  });

  it("a seat's own refusal that names its account is scrubbed before it is kept", async () => {
    const tracker = new SeatHealthTracker();
    const probe = probeWith({ code: 0, stdout: CLAUDE_SIGNED_IN, stderr: '' }, { code: 0, stdout: 'OK', stderr: '' });
    await rosterOver(probe, tracker); // the live check answers first…
    // …then the seat refuses a unit, naming its account (a refusal after the check is kept).
    tracker.ingest({ type: 'unitDistributed', session: 's1', ord: 1, cli: 'claude' } as unknown as CoreEvent);
    tracker.ingest({ type: 'stepFailed', session: 's1', ord: 1, ts: Date.now() + 1000, detail: `Not logged in as ${EMAIL} (org ${ORG_ID}) · Please run /login` } as unknown as CoreEvent);
    const roster = await rosterOver(probe, tracker);
    const claude = roster.find((s) => s.key === 'claude')!;
    expect(claude.auth).toBe('signed_out');
    expect(claude.auth_source).toBe('seat-stderr');
    // A8: only crew's phrase for the refusal is kept — the account never was text the roster held.
    expect(claude.auth_evidence).toBe('Not logged in');
    expect(claude.council_ineligible_reason).toMatch(/Agents page/);
    expect(leaksIn(JSON.stringify(roster))).toEqual([]);
  });
});
