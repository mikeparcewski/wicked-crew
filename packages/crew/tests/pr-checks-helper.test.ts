// crew#1623 — the PR-checks watch DRIVEN FOR REAL: the helper's own text run by node against a fake
// `gh` on PATH. The fake answers `pr checks --required`, `pr view` (base branch), `api …/rules/branches/…`
// (the ruleset's required contexts, the source of truth for "late" checks) and `run view --log-failed`.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prChecksJs } from '../src/core/pr-checks-helper.js';
import { redactString } from '../src/mcp/redact.js';
import { scrubHomePaths } from '../src/api/ui-text.js';
import { deliverScriptTimeoutMs, DELIVER_SCRIPT_TIMEOUT_MS, withoutCheckLogs } from '../src/api/post-hoc-deliver.js';
import { deliverChecksTimeoutSecs, DELIVER_CHECKS_TIMEOUT_DEFAULT_SECS, DELIVER_CHECKS_TIMEOUT_ENV } from '../src/core/deliver.js';

const URL = 'https://ghe.example.test/o/r/pull/7';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Row = { name: string; bucket: string; link?: string; workflow?: string };
interface Scenario {
  /** One entry per `pr checks --required` call; the last repeats. A string is stderr + exit 1. */
  polls: (Row[] | string)[];
  /** Answers without --required. A string is stderr + exit 1; the last entry repeats. */
  own?: (Row[] | string)[];
  required: string[];
  rulesFail?: boolean;
  rulesPlanGated?: boolean;
  rulesAnswer?: { stdout: string; stderr: string };
  /** Contexts only classic branch protection requires (answered on `repos/o/r/branches/main`). */
  classic?: string[];
  classicFail?: boolean;
  classicPlanGated?: boolean;
  /** Raw stdout for the classic-protection call (a malformed answer). */
  classicRaw?: string;
  /** Raw log text for `run view --log-failed`. */
  log?: string;
}

const PLAN_MESSAGE = 'Upgrade to GitHub Pro or make this repository public to enable this feature.';
const PLAN_BODY = JSON.stringify({ message: PLAN_MESSAGE, documentation_url: 'https://docs.github.com/rest/repos/rules#get-rules-for-a-branch', status: '403' });
const PLAN_STDERR = `gh: ${PLAN_MESSAGE} (HTTP 403)`;
const PLAN_LINE = "deliver: PR checks: branch rules are not available on this repository's plan; judged by the PR's own checks";

function run(sc: Scenario, timeout = 30, poll = 0): { code: number; out: string; calls: number } {
  const dir = mkdtempSync(join(tmpdir(), 'checks-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'sc.json'), JSON.stringify(sc));
  writeFileSync(join(dir, 'n'), '0');
  writeFileSync(join(dir, 'helper.cjs'), prChecksJs());
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const d = ${JSON.stringify(dir)};
const sc = JSON.parse(fs.readFileSync(d + '/sc.json', 'utf8'));
const a = process.argv.slice(2);
function planGated() { process.stdout.write(${JSON.stringify(PLAN_BODY)}); process.stderr.write(${JSON.stringify(PLAN_STDERR)}); process.exit(1); }
if (a[0] === 'pr' && a[1] === 'checks') {
  const n = Number(fs.readFileSync(d + '/n', 'utf8')); fs.writeFileSync(d + '/n', String(n + 1));
  const polls = a.includes('--required') ? sc.polls : (sc.own || ['unexpected own checks read']);
  const p = polls[Math.min(n, polls.length - 1)];
  if (typeof p === 'string') { process.stderr.write(p); process.exit(1); }
  process.stdout.write(JSON.stringify(p)); process.exit(p.some((r) => r.bucket === 'fail') ? 1 : 0);
}
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write('main\\n'); process.exit(0); }
// An api call must name the PR's host (an Enterprise PR is not on github.com).
if (a[0] === 'api' && a.slice(2).join(' ') !== '--hostname ghe.example.test') { process.stderr.write('wrong host'); process.exit(1); }
if (a[0] === 'api' && /rules\\/branches\\/main$/.test(a[1])) {
  if (sc.rulesPlanGated) planGated();
  if (sc.rulesAnswer) { process.stdout.write(sc.rulesAnswer.stdout); process.stderr.write(sc.rulesAnswer.stderr); process.exit(1); }
  if (sc.rulesFail) { process.stderr.write('HTTP 403'); process.exit(1); }
  process.stdout.write(JSON.stringify([{ type: 'deletion' }, { type: 'required_status_checks', parameters: { required_status_checks: sc.required.map((context) => ({ context })) } }])); process.exit(0);
}
if (a[0] === 'api' && /branches\\/main$/.test(a[1])) {
  if (sc.classicPlanGated) planGated();
  if (sc.classicFail) { process.stderr.write('HTTP 403'); process.exit(1); }
  if (sc.classicRaw !== undefined) { process.stdout.write(sc.classicRaw); process.exit(0); }
  process.stdout.write(JSON.stringify({ protection: { required_status_checks: { contexts: sc.classic || [] } } })); process.exit(0);
}
if (a[0] === 'api') { process.stderr.write('HTTP 404'); process.exit(1); }
if (a[0] === 'run' && a[1] === 'view') { process.stdout.write(sc.log !== undefined ? sc.log : '\\u001b[31merror: function_missing is_minified_or_huge\\u001b[0m\\nghp_abcdefghijklmnopqrstuvwxyz0123 leaked\\n'); process.exit(0); }
process.exit(2);
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const r = spawnSync(process.execPath, [join(dir, 'helper.cjs'), URL, String(timeout), String(poll)], {
    env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` }, encoding: 'utf8',
  });
  return { code: r.status ?? -1, out: r.stdout, calls: existsSync(join(dir, 'n')) ? Number(readFileSync(join(dir, 'n'), 'utf8')) : 0 };
}
const ok = (name: string): Row => ({ name, bucket: 'pass', workflow: 'CI' });
const job = 'https://github.com/o/r/actions/runs/1/job/22';

describe('PR checks watch (crew#1623)', () => {
  it('all required green -> 0', () => {
    const r = run({ polls: [[ok('a'), ok('b')]], required: ['a', 'b'] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 required check(s) green');
  });

  it('a red required check -> 3 with the job name and a redacted log tail, without waiting for the rest', () => {
    const r = run({ polls: [[ok('a'), { name: 'semver (cargo-semver-checks vs last published)', bucket: 'fail', link: job, workflow: 'CI' }, { name: 'slow', bucket: 'pending' }]], required: ['a', 'semver (cargo-semver-checks vs last published)', 'slow'] });
    expect(r.code).toBe(3);
    expect(r.out).toContain('deliver: PR CHECKS DETAIL');
    expect(r.out).toContain('CI / semver (cargo-semver-checks vs last published)');
    expect(r.out).toContain('error: function_missing is_minified_or_huge');
    expect(r.out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(r.out).not.toContain('\u001b[');
    expect(r.out).toContain('deliver: failing required check(s): CI / semver');
    expect(r.calls).toBe(1);
  });

  it('a red check that is not required is not in the required list, so the run is green', () => {
    // `gh pr checks --required` never lists a non-required check; the fake mirrors that.
    const r = run({ polls: [[ok('a')]], required: ['a'] });
    expect(r.code).toBe(0);
  });

  it('pending then green -> 0 after waiting', () => {
    const r = run({ polls: [[{ name: 'a', bucket: 'pending' }], [{ name: 'a', bucket: 'pending' }], [ok('a')]], required: ['a'] });
    expect(r.code).toBe(0);
    expect(r.calls).toBe(3);
  });

  it('a required check that is merely late is pending, never green and never "none required"', () => {
    const r = run({ polls: [[ok('a')], [ok('a')], [ok('a'), ok('late')]], required: ['a', 'late'] });
    expect(r.code).toBe(0);
    expect(r.calls).toBe(3);
    const never = run({ polls: [[ok('a')]], required: ['a', 'late'] }, 1, 0.3);
    expect(never.code).toBe(4);
    expect(never.out).toContain('late (not reported yet)');
  });

  it('nothing reported yet while the ruleset requires checks is pending, not a pass', () => {
    const r = run({ polls: [[], [], [ok('a')]], required: ['a'] });
    expect(r.code).toBe(0);
    expect(r.calls).toBe(3);
    const none = run({ polls: [[]], required: ['a'] }, 1, 0.3);
    expect(none.code).toBe(4);
  });

  it('a base branch that requires nothing passes, said aloud', () => {
    const r = run({ polls: [[]], required: [] });
    expect(r.code).toBe(0);
    expect(r.out).toContain('requires no status check');
  });

  it('plan-gated rules + no PR checks -> 0 with the plan explanation (crew#1683)', () => {
    const r = run({ polls: ['required checks must not be read'], own: ["no checks reported on the 'b' branch"], required: [], rulesPlanGated: true });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(PLAN_LINE);
    expect(r.out).toContain('the PR has no checks');
    expect(r.calls).toBe(1);
  });

  it('plan-gated rules + a PR check only reported without --required -> 0', () => {
    const r = run({ polls: [[]], own: [[ok('GitGuardian')]], required: [], rulesPlanGated: true });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('1 check(s) green');
  });

  it('plan-gated rules + a red PR check -> 3 with the existing failing line', () => {
    const r = run({ polls: [[]], own: [[{ name: 'scan', bucket: 'fail', link: job }]], required: [], rulesPlanGated: true });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('deliver: failing required check(s): scan');
  });

  it('plan-gated rules + a PR check pending past the timeout -> 4', () => {
    const r = run({ polls: [[]], own: [[{ name: 'scan', bucket: 'pending' }]], required: [], rulesPlanGated: true }, 1, 0.3);
    expect(r.code, r.out).toBe(4);
    expect(r.out).toContain('still pending');
    expect(r.out).toContain('scan');
  });

  it('caches own mode while polling and prints the plan explanation once', () => {
    const r = run({ polls: [[]], own: [[{ name: 'scan', bucket: 'pending' }], [ok('scan')]], required: [], rulesPlanGated: true });
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toBe(2);
    expect(r.out.split(PLAN_LINE)).toHaveLength(2);
    expect(r.out).toContain('1 check(s) green');
  });

  it('classic plan-gated 403 + no PR checks -> 0 in own mode', () => {
    const r = run({ polls: ['required checks must not be read'], own: ["no checks reported on the 'b' branch"], required: [], classicPlanGated: true });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(PLAN_LINE);
    expect(r.out).toContain('the PR has no checks');
  });

  it('accepts numeric 403 and trims the exact plan message', () => {
    const r = run({ polls: [[]], own: [[]], required: [], rulesAnswer: { stdout: JSON.stringify({ message: ` ${PLAN_MESSAGE}\n`, status: 403 }), stderr: PLAN_STDERR } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(PLAN_LINE);
  });

  it.each([
    ['other 403', JSON.stringify({ message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest/repos/rules#get-rules-for-a-branch', status: '403' })],
    ['404', JSON.stringify({ message: 'Not Found', status: '404' })],
    ['502 with non-JSON stdout', 'Bad Gateway'],
    ['plan message with 404 status', JSON.stringify({ message: PLAN_MESSAGE, status: '404' })],
    ['different message with 403 status', JSON.stringify({ message: `${PLAN_MESSAGE} Contact support.`, status: '403' })],
    ['non-object JSON', 'null'],
  ])('rules refusal stays unreadable: %s', (_name, stdout) => {
    const r = run({ polls: [[]], own: [[]], required: [], rulesAnswer: { stdout, stderr: 'gh: rules unavailable' } });
    expect(r.code, r.out).toBe(5);
    expect(r.out).toContain('the base branch rules could not be read');
    expect(r.out).not.toContain(PLAN_LINE);
    expect(r.calls).toBe(0);
  });

  it('pending past the timeout -> 4 naming the pending checks', () => {
    const r = run({ polls: [[{ name: 'a', bucket: 'pending', workflow: 'CI' }]], required: ['a'] }, 1, 0.3);
    expect(r.code).toBe(4);
    expect(r.out).toContain('still pending');
    expect(r.out).toContain('CI / a');
  });

  it('checks that cannot be read -> 5', () => {
    const r = run({ polls: ['gh: HTTP 401 bad credentials'], required: ['a'] });
    expect(r.code).toBe(5);
    expect(r.out).toContain('could not be read');
  });

  it('classic protection that cannot be read is "cannot read", never "none required" (403 while nothing is reported)', () => {
    const r = run({ polls: [[]], required: [], classicFail: true });
    expect(r.code).toBe(5);
    expect(r.out).toContain('could not be read');
  });

  it('a context only classic protection requires is waited on like a ruleset one', () => {
    const r = run({ polls: [[ok('a')]], required: ['a'], classic: ['legacy'] }, 1, 0.3);
    expect(r.code).toBe(4);
    expect(r.out).toContain('legacy (not reported yet)');
  });

  it('a malformed classic-protection answer is unreadable (5), never "no required checks"', () => {
    for (const raw of ['not json', '[]', '"x"', 'null']) {
      const r = run({ polls: [[]], required: [], classicRaw: raw });
      expect(r.code, raw).toBe(5);
    }
    // An unprotected branch (no `protection`) legitimately requires nothing from classic rules.
    expect(run({ polls: [[]], required: [], classicRaw: '{"name":"main"}' }).code).toBe(0);
  });

  it('a failed log is cut by the repo\'s own redaction before it is printed: key assignment, bearer, home paths', () => {
    // A web address that merely contains a home-looking segment is not a path (assembled: no literal path in source).
    const webHome = ['https://github.com', 'ho' + 'me', 'not-a-path'].join('/');
    // Synthetic secrets are assembled at run time so no secret-shaped literal sits in the source.
    const [k1, k2, k3] = [['hunter', '2hunter2hunter2'], ['correct', '-horse-battery'], ['abc123', 'def456', 'ghi789']].map((p) => p.join(''));
    const log = [
      `API_KEY=${k1}`,
      `password=${k2}`,
      `Authorization: Bearer ${k3}`,
      `cwd ${['', 'Users', 'alice', 'work'].join('/')} and ${['', 'home', 'bob', 'src'].join('/')} and ${['C:', 'Users', 'carol', 'proj'].join('\\')}`,
      `see ${webHome} for details`,
    ].join('\n');
    const r = run({ polls: [[{ name: 'x', bucket: 'fail', link: job }]], required: ['x'], log });
    expect(r.code).toBe(3);
    for (const leaked of [k1, k2, k3, 'alice', 'bob', 'carol']) {
      expect(r.out, leaked).not.toContain(leaked);
    }
    expect(r.out).toContain('API_KEY=[REDACTED:kv]');
    expect(r.out).toContain('[REDACTED:bearer]');
    expect(r.out).toContain('~');
    expect(r.out).toContain(webHome);
    // Drift guard: the helper's cut equals the modules' own on the same text.
    const body = r.out.split('--- ')[1]!.split('\n').slice(1).join('\n').split('deliver: failing')[0]!.trim();
    expect(body).toBe(scrubHomePaths(redactString(log), '/nonexistent-home').trim());
  });

  it('log-line secrets the MCP patterns miss are cut; pagination cursors survive', () => {
    const [v1, v2, v3, v4] = [['wJalr', 'XUtn1'], ['pw0', 'rd-two'], ['sing', 'le-three'], ['spa', 'ced-four']].map((p) => p.join(''));
    const log = [
      `aws_secret_access_key = ${v1}`,
      `password="${v2}"`,
      `password='${v3}'`,
      `API_KEY = ${v4}`,
      'nextPageToken=cursor-abc123',
      'next_page_token = cursor-def456',
      'pageToken = cursor-ghi789',
      'cursor = cursor-jkl012',
    ].join('\n');
    const r = run({ polls: [[{ name: 'x', bucket: 'fail', link: job }]], required: ['x'], log });
    expect(r.code).toBe(3);
    for (const leaked of [v1, v2, v3, v4]) expect(r.out, leaked).not.toContain(leaked);
    for (const kept of ['nextPageToken=cursor-abc123', 'next_page_token = cursor-def456', 'pageToken = cursor-ghi789', 'cursor = cursor-jkl012']) {
      expect(r.out, kept).toContain(kept);
    }
  });

  it('rules that cannot be read -> 5, never a pass', () => {
    const r = run({ polls: [[ok('a')]], required: ['a'], rulesFail: true });
    expect(r.code).toBe(5);
  });
});

describe('post-hoc delivery returns no CI log (crew#1623)', () => {
  it('keeps the verdict lines and each failing check\'s name and link, and deletes the log between', () => {
    const secret = ['aws_secret_access_key = wJalr', 'XUtn1'].join('');
    const home = ['', 'Users', 'alice', 'w'].join('/');
    const out = [
      'deliver: pushed b to origin',
      'deliver: PR CHECKS DETAIL',
      '--- CI / semver (fail) https://github.com/o/r/actions/runs/1/job/2',
      secret,
      `cwd ${home}`,
      'deliver: failing required check(s): CI / semver',
      'deliver: PR CHECKS FAILING - https://github.com/o/r/pull/7: CI / semver',
    ].join('\n');
    const kept = withoutCheckLogs(out);
    expect(kept).not.toContain('wJalr');
    expect(kept).not.toContain('alice');
    expect(kept).toContain('--- CI / semver (fail) https://github.com/o/r/actions/runs/1/job/2');
    expect(kept).toContain('deliver: failing required check(s): CI / semver');
    expect(kept).toContain('deliver: PR CHECKS FAILING');
    expect(withoutCheckLogs('plain output\nno detail')).toBe('plain output\nno detail');
  });
});

describe('the checks wait is one setting (crew#1623)', () => {
  it('the post-hoc lift\'s process bound is its own 5 minutes PLUS the checks wait, from the same env var', () => {
    expect(deliverChecksTimeoutSecs({})).toBe(DELIVER_CHECKS_TIMEOUT_DEFAULT_SECS);
    expect(deliverScriptTimeoutMs({})).toBe(DELIVER_SCRIPT_TIMEOUT_MS + 2700 * 1000);
    expect(deliverScriptTimeoutMs({ [DELIVER_CHECKS_TIMEOUT_ENV]: '90' })).toBe(DELIVER_SCRIPT_TIMEOUT_MS + 90_000);
    expect(deliverScriptTimeoutMs({ [DELIVER_CHECKS_TIMEOUT_ENV]: 'junk' })).toBe(DELIVER_SCRIPT_TIMEOUT_MS + 2700 * 1000);
  });
});
