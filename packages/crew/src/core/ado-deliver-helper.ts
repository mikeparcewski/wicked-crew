/**
 * crew#720: the Azure DevOps half of the deliver script — a small node program the script writes
 * into its temp dir and runs with the node that runs crew. It does the three things bash cannot do
 * safely: mint the auth header (an Entra client-credentials token for a service principal, or
 * `Basic base64(":"+PAT)`), compare origin's URLs with the consented repository, and open (or
 * adopt) the pull request through the REST API with a JSON body.
 *
 * Rules it keeps:
 *  - credentials are read from the environment only (`CREW_ADO_*` / `AZURE_DEVOPS_EXT_PAT`), and
 *    the minted header is written to stdout for the script to capture into an UNEXPORTED shell
 *    variable — never to a file, argv or the log;
 *  - the `pr` call reads the header from `WICKED_ADO_AUTH`, set one-shot on that one child;
 *  - every request uses `redirect: 'manual'`, so the header never follows a redirect to another
 *    host, and a 3xx is a failure;
 *  - every message is redacted (each secret, its base64 Basic forms, JWTs, Authorization values,
 *    URL userinfo) before it is printed.
 *
 * Plain JavaScript in a string on purpose: the script must not depend on where crew's dist lives
 * (a run waits at its gate across a crew upgrade), and the same text is what the tests run.
 */

export const ADO_HELPER_JS = String.raw`
const [, , cmd, ...args] = process.argv;
const env = process.env;
const secrets = [];
const keep = (s) => { if (typeof s === 'string' && s.length >= 4) secrets.push(s); return s; };
for (const n of ['AZURE_DEVOPS_EXT_PAT', 'CREW_ADO_CLIENT_SECRET', 'WICKED_ADO_AUTH']) keep(env[n]);
if (env.WICKED_ADO_AUTH) keep(env.WICKED_ADO_AUTH.replace(/^(Basic|Bearer) /, ''));
function redact(text) {
  let out = String(text ?? '');
  for (const s of secrets) {
    for (const f of [s, Buffer.from(':' + s).toString('base64'), Buffer.from(s).toString('base64')]) out = out.split(f).join('[REDACTED]');
  }
  return out
    .replace(/(authorization\s*:\s*)(basic|bearer)\s+\S+/gi, '$1$2 [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g, '[REDACTED-JWT]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@');
}
function fail(msg, code = 3) { process.stderr.write('deliver: ' + redact(msg) + '\n'); process.exit(code); }
const v = (n) => (typeof env[n] === 'string' ? env[n].trim() : '');
async function call(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  } catch (e) {
    fail('Azure DevOps request to ' + new URL(url).host + ' failed (' + (e && e.name ? e.name : 'error') + ')');
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text };
}
// The canonical form of a remote URL: an Azure DevOps spelling becomes
// https://dev.azure.com/<org>/<project>/_git/<repo>; anything else loses its userinfo, a trailing
// slash and .git, and has its scheme and host lowercased. Two URLs name one repository when their
// canonical forms are equal (case-insensitively: Azure DevOps names are).
function canon(raw) {
  const s = String(raw).trim();
  const e = (x) => encodeURIComponent(decodeURIComponent(x));
  let m = /^(?:ssh:\/\/)?[^@\/\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:\/]v3\/([^\/]+)\/([^\/]+)\/([^\/]+?)\/?$/i.exec(s);
  if (m) return ('https://dev.azure.com/' + e(m[1]) + '/' + e(m[2]) + '/_git/' + e(m[3].replace(/\.git$/i, ''))).toLowerCase();
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  const g = segs.indexOf('_git');
  if (host === 'dev.azure.com' && g === 2 && segs.length === 4) return ('https://dev.azure.com/' + e(segs[0]) + '/' + e(segs[1]) + '/_git/' + e(segs[3].replace(/\.git$/i, ''))).toLowerCase();
  if (host.endsWith('.visualstudio.com') && g >= 1 && g === segs.length - 2) {
    const rest = segs.slice(0, g).filter((x, i) => !(i === 0 && x.toLowerCase() === 'defaultcollection'));
    if (rest.length !== 1) return null;
    return ('https://dev.azure.com/' + e(host.slice(0, -'.visualstudio.com'.length)) + '/' + e(rest[0]) + '/_git/' + e(segs[g + 1].replace(/\.git$/i, ''))).toLowerCase();
  }
  return (u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')).toLowerCase();
}
async function header(loginBase) {
  const tenant = v('CREW_ADO_TENANT_ID'), client = v('CREW_ADO_CLIENT_ID'), secret = v('CREW_ADO_CLIENT_SECRET');
  if (tenant && client && secret) {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: secret, scope: '499b84ac-1321-427f-aa17-267ca6975798/.default' }).toString();
    const r = await call(loginBase.replace(/\/+$/, '') + '/' + encodeURIComponent(tenant) + '/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    const tok = r.json && typeof r.json.access_token === 'string' ? keep(r.json.access_token) : '';
    if (!r.ok || !tok) fail('Entra refused the Azure DevOps service-principal credential (HTTP ' + r.status + (r.json && typeof r.json.error === 'string' ? ', ' + r.json.error : '') + ')');
    return 'Bearer ' + tok;
  }
  const pat = v('AZURE_DEVOPS_EXT_PAT');
  if (pat) return 'Basic ' + keep(Buffer.from(':' + pat).toString('base64'));
  fail('Azure DevOps credentials not configured', 4);
}
const API = 'api-version=7.1';
async function findPr(apiBase, auth, source, target) {
  const q = new URLSearchParams({ 'searchCriteria.sourceRefName': 'refs/heads/' + source, 'searchCriteria.targetRefName': 'refs/heads/' + target, 'searchCriteria.status': 'active' });
  const r = await call(apiBase + '/pullrequests?' + q + '&' + API, { method: 'GET', headers: { Authorization: auth, Accept: 'application/json' } });
  if (!r.ok) return null;
  const list = r.json && Array.isArray(r.json.value) ? r.json.value : [];
  const mine = list.filter((p) => p && p.sourceRefName === 'refs/heads/' + source && p.targetRefName === 'refs/heads/' + target && p.status === 'active' && typeof p.pullRequestId === 'number');
  return mine.length === 1 ? mine[0] : null;
}
function fitDescription(body) {
  const MAX = 4000;
  if (body.length <= MAX) return body;
  const note = '\n\n_(description truncated to Azure DevOps\' 4000-character limit)_';
  const tail = body.slice(-600);
  return body.slice(0, MAX - tail.length - note.length) + note + tail;
}
async function pr(apiBase, webUrl, source, target, titleFile, bodyFile) {
  const fs = await import('node:fs');
  const auth = env.WICKED_ADO_AUTH || '';
  if (!auth) fail('no Azure DevOps auth header was handed to the pull-request step');
  let title = fs.readFileSync(titleFile, 'utf8').replace(/\n+$/, '');
  if (title.length > 400) title = title.slice(0, 399) + '…';
  const description = fitDescription(fs.readFileSync(bodyFile, 'utf8'));
  const r = await call(apiBase + '/pullrequests?' + API, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sourceRefName: 'refs/heads/' + source, targetRefName: 'refs/heads/' + target, title, description }),
  });
  if (r.ok && r.json && typeof r.json.pullRequestId === 'number') {
    process.stdout.write(webUrl + '/pullrequest/' + r.json.pullRequestId + '\n');
    return;
  }
  // A PR for this branch pair may already exist (a retry after the push landed, a rework): adopt
  // it only when exactly one ACTIVE PR has this source AND target branch.
  const existing = await findPr(apiBase, auth, source, target);
  if (existing) {
    process.stdout.write('deliver: ADO-PR-EXISTS ' + webUrl + '/pullrequest/' + existing.pullRequestId + '\n');
    return;
  }
  const why = r.json && typeof r.json.message === 'string' ? r.json.message : r.text.slice(0, 300);
  fail('Azure DevOps refused the pull request (HTTP ' + r.status + '): ' + why);
}
(async () => {
  if (cmd === 'header') process.stdout.write((await header(args[0])) + '\n');
  else if (cmd === 'same') {
    const want = canon(args[0]);
    const urls = args.slice(1).join('\n').split(/\s+/).filter(Boolean);
    if (!want || urls.length === 0 || urls.some((u) => canon(u) !== want)) process.exit(1);
  } else if (cmd === 'pr') await pr(...args);
  else fail('unknown helper command ' + cmd);
})().catch((e) => fail(e && e.message ? e.message : String(e)));
`;
