/**
 * crew#1623: the PR-checks half of the deliver script. A delivered PR whose REQUIRED check is red
 * cannot merge, so the deliver phase does not report a delivery until the PR's required checks have
 * a conclusion: a small node program the script writes into its temp dir and runs with the node that
 * runs crew (the same shape as the Azure DevOps helper, and for the same reason: a run waits at its
 * gate across a crew upgrade, so it must not depend on where crew's dist lives).
 *
 * It reads `gh pr checks <url> --required --json …` on the SAME identity the script pushed with (the
 * script hands it the token one-shot, exactly as its own gh calls get it) and polls to a conclusion:
 *
 *   exit 0  every required check is green (`pass` / `skipping`), or the base branch requires none;
 *   exit 3  a required check is red (`fail` / `cancel`): failing job names plus the tail of each
 *           failed job's log, printed as the finding the rework reads; does not wait for the rest;
 *   exit 4  a required check is still pending when the timeout ends;
 *   exit 5  the checks could not be read (gh missing, auth, rate limit, a gh without `--required`).
 *
 * WHICH checks are required comes from the base branch itself: the rulesets' `required_status_checks`
 * rule (`repos/{o}/{r}/rules/branches/{base}`) and the branch's classic protection
 * (`repos/{o}/{r}/branches/{base}`), both readable with repo read access; either failing to read is
 * "cannot read", never "none required". `gh pr checks --required` only lists checks that have REPORTED, so a
 * required check that is merely late (a ruleset's "Expected — waiting for status") is matched by
 * name against that list and counts as PENDING, never as green and never as "none required". A
 * PR passes with no checks only when the base branch requires none.
 *
 * Arguments: `<pr-url> <timeout-secs> <poll-secs>`.
 *
 * Plain JavaScript in a string on purpose; the tests run this exact text against a fake `gh`.
 */

import { VALUE_PATTERNS } from '../mcp/redact.js';
import { HOME_PATH_PATTERNS } from '../api/ui-text.js';

/**
 * A failed job's log is untrusted text from CI: before the helper prints any of it, it is cut by the
 * SAME rules crew already uses (no second redactor): the secret value patterns of `mcp/redact.ts`
 * (bearer / basic / JWT / cloud and git tokens / `name=value` secrets / private-key blocks) and
 * `api/ui-text.ts`'s home-path patterns (a user's home directory on macOS, Linux or Windows becomes `~`). The rules
 * ride into the helper's text as data; `tests/pr-checks-helper.test.ts` pins the helper's output equal to
 * those modules' own on the same samples. A pattern with a replacer keeps the key it matched (its tail is probed from the replacer, not copied).
 */
/**
 * Secret shapes a CI LOG prints that `mcp/redact.ts` does not cut, kept here (the deliver module), not in the
 * shared MCP patterns, which also redact tool results and so must not touch fields like pagination cursors:
 * a secret-named key followed by `=` (spaced or not) and a plain or quoted value, e.g.
 * `aws_secret_access_key = v`, `password="v"`. A name ending in `page` + `token` (`nextPageToken`,
 * `next_page_token`) is a cursor, not a secret, and is left alone.
 */
export const LOG_SECRET_PATTERNS: ReadonlyArray<{ id: string; re: RegExp; replace: (match: string, key: string) => string }> = [
  {
    id: 'log-secret',
    re: /\b([A-Za-z0-9_.-]*(?:(?<!page[-_]?)token|secret|passw(?:or)?d|api[-_]?key|private[-_]?key|access[-_]?key|credential)[A-Za-z0-9_.-]*["']?[ \t]*=[ \t]*)(?!\[REDACTED)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    replace: (_m: string, k: string) => `${k}[REDACTED:log]`,
  },
];

/** Built on first use, not at import: `mcp/redact` reaches this module through `mcp/secrets` -> `core/deliver`, so a module-level read of its exports would see them undefined. */
const redactRules = (): string => JSON.stringify([
  ...[...VALUE_PATTERNS, ...LOG_SECRET_PATTERNS].map((p) => ({ id: p.id, source: p.re.source, flags: p.re.flags, keepTail: p.replace === undefined ? undefined : p.replace('', '\u0001', '').slice(1) })),
  ...HOME_PATH_PATTERNS.map((re) => ({ id: 'home', source: re.source, flags: re.flags, home: true })),
]);

const HELPER_BODY = String.raw`
// (program text for another process: not a crew child spawn, so it is not one of the daemon's guarded sites)
const { execFile: runGh } = require('node:child_process');
const [, , url, timeoutArg, pollArg] = process.argv;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const timeoutMs = num(timeoutArg, 2700) * 1000;
const pollMs = Math.max(num(pollArg, 20), 0) * 1000;
const LOG_CAP = 3000;
const RULES = JSON.parse(RULES_JSON).map((r) => ({ ...r, re: new RegExp(r.source, r.flags) }));
function redact(text) {
  let out = String(text ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  for (const r of RULES) {
    r.re.lastIndex = 0;
    out = r.home ? out.replace(r.re, '~') : r.keepTail !== undefined ? out.replace(r.re, (_m, k) => k + r.keepTail) : out.replace(r.re, '[REDACTED:' + r.id + ']');
  }
  return out;
}
function gh(args) {
  return new Promise((resolve) => {
    runGh('gh', args, { timeout: 90000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || '', spawnError: err && typeof err.code !== 'number' ? String(err.code || err.message) : '' });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One read of the required checks: { rows } or { error }.
async function read() {
  const r = await gh(['pr', 'checks', url, '--required', '--json', 'name,bucket,link,workflow']);
  const text = r.stdout.trim();
  if (text !== '') {
    try {
      const rows = JSON.parse(text);
      if (Array.isArray(rows)) return { rows };
    } catch {}
  }
  // gh answers a PR with no required checks on stderr (older versions, exit 1) or with an empty list.
  if (/no required checks reported/i.test(r.stderr)) return { rows: [] };
  return { error: redact((r.spawnError || r.stderr || r.stdout || 'gh answered nothing') .trim().split('\n').slice(-3).join(' | ')).slice(0, 300) };
}
// The contexts the base branch requires: { names } or { error }. Rulesets must read; classic protection is best-effort.
async function expected() {
  const m = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(url);
  const repo = m[2];
  const host = m[1];
  const base = await gh(['pr', 'view', url, '--json', 'baseRefName', '-q', '.baseRefName']);
  const branch = base.stdout.trim();
  if (base.code !== 0 || branch === '') return { error: redact((base.stderr || 'no base branch').trim().split('\n').slice(-1)[0]).slice(0, 200) };
  const names = new Set();
  const rules = await gh(['api', 'repos/' + repo + '/rules/branches/' + encodeURIComponent(branch).replace(/%2F/g, '/'), '--hostname', host]);
  let parsed;
  try { parsed = JSON.parse(rules.stdout); } catch {}
  if (rules.code !== 0 || !Array.isArray(parsed)) return { error: 'the base branch rules could not be read: ' + redact((rules.stderr || rules.stdout || 'empty').trim().split('\n').slice(-1)[0]).slice(0, 200) };
  for (const rule of parsed) if (rule && rule.type === 'required_status_checks') for (const c of (rule.parameters && rule.parameters.required_status_checks) || []) if (c && c.context) names.add(c.context);
  // Classic branch protection, from the branch itself (readable with repo read access; its own endpoint needs admin).
  const classic = await gh(['api', 'repos/' + repo + '/branches/' + encodeURIComponent(branch).replace(/%2F/g, '/'), '--hostname', host]);
  if (classic.code !== 0) return { error: 'the base branch protection could not be read: ' + redact((classic.stderr || 'empty').trim().split('\n').slice(-1)[0]).slice(0, 200) };
  // A branch answer that is not the branch object is unreadable, never "nothing required".
  let branchInfo;
  try { branchInfo = JSON.parse(classic.stdout); } catch {}
  if (branchInfo === null || typeof branchInfo !== 'object' || Array.isArray(branchInfo)) return { error: 'the base branch protection could not be read: the answer is not a branch' };
  // An unprotected branch has no protection key or a null required_status_checks; both mean none.
  const rsc = branchInfo.protection && branchInfo.protection.required_status_checks;
  for (const c of (rsc && rsc.contexts) || []) names.add(c);
  for (const c of (rsc && rsc.checks) || []) if (c && c.context) names.add(c.context);
  return { names: [...names] };
}
function label(row) { return (row.workflow ? row.workflow + ' / ' : '') + row.name; }
async function failedLog(row) {
  const m = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)/.exec(String(row.link || ''));
  if (!m) return 'no job log available: ' + (row.link ? redact(row.link) : 'the check names no link') + ' (an external check)';
  const r = await gh(['run', 'view', '--repo', m[1] + '/' + m[2], '--job', m[3], '--log-failed']);
  const text = redact(r.stdout).trim();
  if (text === '') return 'the failed job\'s log could not be read: ' + redact((r.stderr || 'empty').trim().split('\n').slice(-1)[0]).slice(0, 200);
  return text.length > LOG_CAP ? '[… log cut …]\n' + text.slice(text.length - LOG_CAP) : text;
}
async function main() {
  if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(url || '')) { process.stdout.write('deliver: PR checks: not a pull request URL\n'); process.exit(5); }
  const start = Date.now();
  let unreadable = 0;
  let last = [];
  let want = null;
  for (;;) {
    let got = want === null ? await expected() : { names: want };
    if (got.error === undefined) { want = got.names; got = await read(); }
    const elapsed = Date.now() - start;
    if (got.error !== undefined) {
      unreadable += 1;
      // A single hiccup is retried; three in a row is "cannot read".
      if (unreadable >= 3 || elapsed >= timeoutMs) { process.stdout.write('deliver: PR checks: could not be read: ' + got.error + '\n'); process.exit(5); }
    } else {
      unreadable = 0;
      last = got.rows;
      const red = last.filter((r) => r.bucket === 'fail' || r.bucket === 'cancel');
      if (red.length > 0) {
        process.stdout.write('deliver: PR CHECKS DETAIL\n');
        for (const row of red) process.stdout.write('--- ' + label(row) + ' (' + row.bucket + ')' + (row.link ? ' ' + redact(row.link) : '') + '\n' + (await failedLog(row)) + '\n');
        process.stdout.write('deliver: failing required check(s): ' + red.map(label).join(', ') + '\n');
        process.exit(3);
      }
      const reported = new Set(last.map((r) => r.name));
      const late = want.filter((n) => !reported.has(n));
      const pending = last.filter((r) => r.bucket !== 'pass' && r.bucket !== 'skipping').map(label).concat(late.map((n) => n + ' (not reported yet)'));
      if (pending.length === 0) { process.stdout.write('deliver: PR checks: ' + (want.length === 0 && last.length === 0 ? 'the base branch requires no status check' : last.length + ' required check(s) green') + '\n'); process.exit(0); }
      if (elapsed + pollMs >= timeoutMs) { process.stdout.write('deliver: PR checks: still pending after ' + Math.round(elapsed / 1000) + 's: ' + pending.join(', ') + '\n'); process.exit(4); }
    }
    await sleep(pollMs);
  }
}
main().catch((e) => { process.stdout.write('deliver: PR checks: could not be read: ' + redact(e && e.message) + '\n'); process.exit(5); });
`;

/** The helper's text: the redaction rules, then the program. */
export function prChecksJs(): string {
  return `const RULES_JSON = ${JSON.stringify(redactRules())};\n${HELPER_BODY}`;
}
