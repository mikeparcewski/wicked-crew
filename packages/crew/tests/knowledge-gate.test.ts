// DES-KNOWLEDGE-DATA-001 §7 (B2): the data gate's parts that need no database. The predicate and the
// disclosure class, the per-source scheduler and its fail-closed reservation, the unit envelope's cell and
// byte caps, the Postgres rewrite (statement cut, LIMIT, per-cell projection, the policy again), and the
// Toolbox document's spawn policy and YAML-escaped secret.

import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

import { agentAccessOf, agentMay, AGENT_ACCESS_DEFAULT, neededFor } from '../src/knowledge/gate/access.js';
import { citeOf, rowsWithin, sqlstateOf, UNIT_CELL_CHARS, unitCell, unitRows } from '../src/knowledge/gate/envelope.js';
import { admitPg, boundedType, cellExpression, limitRewrite, projectedRewrite, recheckPg, statementOf } from '../src/knowledge/gate/pg.js';
import { DEFAULT_LIMITS, GateBusyError, type Lease, SourceScheduler } from '../src/knowledge/gate/scheduler.js';
import { applicationNameOf, toolboxDocument, ToolboxDocumentError, yamlQuotedBody } from '../src/knowledge/adapters/toolbox/document.js';
import { splitQualified } from '../src/knowledge/adapters/toolbox/catalog.js';
import { StderrTail } from '../src/knowledge/adapters/toolbox/supervisor.js';
import { platformKey, TOOLBOX_PINS, toolboxPath, toolboxUrl, ToolboxBinary } from '../src/knowledge/adapters/toolbox/binary.js';
import { type PolicyCatalog, relKey } from '../src/sources/policy/types.js';

const LOOPBACK = { allow: ['127.0.0.0/8'], plaintext: false };

describe('the predicate and the disclosure class (§7.1)', () => {
  const src = { enabled: true, queryable: true };
  it('a new source: see on, query off, no project, so nothing reaches an agent', () => {
    const a = agentAccessOf({});
    expect(a).toEqual({ see: true, query: false, projects: [], everyProject: false });
    expect(agentMay(a, src, 'proj_a', 'see')).toBe(false);
    expect(agentMay(a, src, null, 'see')).toBe(false);
    expect(AGENT_ACCESS_DEFAULT.query).toBe(false);
  });
  it('a project is named, or every project chosen; query needs see, the switch, and a source the gate governs', () => {
    const a = agentAccessOf({ agents: { see: true, query: true, projects: ['proj_a', 'proj_a', 'bad name'] } });
    expect(a.projects).toEqual(['proj_a']);
    expect(agentMay(a, src, 'proj_a', 'query')).toBe(true);
    expect(agentMay(a, src, 'proj_b', 'see')).toBe(false);
    expect(agentMay(a, src, null, 'see')).toBe(false);
    expect(agentMay(a, { enabled: false, queryable: true }, 'proj_a', 'see')).toBe(false);
    expect(agentMay(a, { enabled: true, queryable: false }, 'proj_a', 'query')).toBe(false);
    expect(agentMay({ ...a, everyProject: true }, src, null, 'query')).toBe(true);
    // query never outlives see
    expect(agentAccessOf({ agents: { see: false, query: true, everyProject: true } }).query).toBe(false);
  });
  it('rows needs query, structure and none need see, no class means no agent', () => {
    expect(neededFor('rows')).toBe('query');
    expect(neededFor('structure')).toBe('see');
    expect(neededFor('none')).toBe('see');
    expect(neededFor(null)).toBe(null);
    expect(neededFor(undefined)).toBe(null);
  });
});

describe('one scheduler per source (§7.4) and the remote-work reservation (§7.3)', () => {
  const tick = () => new Promise((r) => setImmediate(r));
  it('priority person > unit > describe, FIFO within a class', async () => {
    const s = new SourceScheduler({ ...DEFAULT_LIMITS, concurrency: 1, perMinute: {} }, 'src');
    const first = await s.admit('unit');
    const order: string[] = [];
    const go = (cls: 'unit' | 'person' | 'describe', tag: string) =>
      s.admit(cls).then((l: Lease) => {
        order.push(tag);
        l.done({ outcome: 'ok' });
      });
    const all = Promise.all([go('describe', 'd1'), go('unit', 'u1'), go('person', 'p1'), go('unit', 'u2')]);
    first.done({ outcome: 'ok' });
    await all;
    expect(order).toEqual(['p1', 'u1', 'u2', 'd1']);
  });
  it('a call refused for a full queue does not spend the rate', async () => {
    const s = new SourceScheduler({ ...DEFAULT_LIMITS, concurrency: 1, queueMax: 1, perMinute: { unit: 2 } }, 'src');
    const held = await s.admit('unit');
    const queued = s.admit('unit');
    for (let i = 0; i < 5; i++) await expect(s.admit('unit')).rejects.toMatchObject({ code: 'busy' });
    held.done({ outcome: 'ok' });
    (await queued).done({ outcome: 'ok' });
    await expect(s.admit('unit')).rejects.toMatchObject({ code: 'rate_limited' }); // 2 spent: the held and the queued
  });
  it('a full queue is busy, the unit rate is 30 a minute', async () => {
    const s = new SourceScheduler({ ...DEFAULT_LIMITS, concurrency: 1, queueMax: 1, perMinute: { unit: 2 } }, 'src');
    const held = await s.admit('person');
    const queued = s.admit('person');
    await expect(s.admit('person')).rejects.toMatchObject({ code: 'busy' });
    held.done({ outcome: 'ok' });
    (await queued).done({ outcome: 'ok' });
    (await s.admit('unit')).done({ outcome: 'ok' });
    (await s.admit('unit')).done({ outcome: 'ok' });
    await expect(s.admit('unit')).rejects.toMatchObject({ code: 'rate_limited' });
  });
  it('after a kill with no source deadline the source stays closed until the check says gone; unknown and errors keep it closed', async () => {
    const s = new SourceScheduler({ ...DEFAULT_LIMITS, concurrency: 1, perMinute: {}, recheckMs: 60_000 }, 'src');
    const answers: Array<'running' | 'unknown' | 'throw' | 'gone'> = ['running', 'unknown', 'throw', 'gone'];
    let checks = 0;
    const check = async () => {
      const a = answers[checks++] ?? 'gone';
      if (a === 'throw') throw new Error('cannot reach the source');
      return a;
    };
    const l = await s.admit('unit');
    const queued = s.admit('person');
    l.done({ outcome: 'killed', remoteCheck: check });
    await expect(queued).rejects.toMatchObject({ code: 'remote_work_pending' });
    await tick();
    expect(s.state().reserved).toBe(true);
    await expect(s.admit('person')).rejects.toBeInstanceOf(GateBusyError);
    expect(await s.recheck()).toBe(false); // unknown
    expect(await s.recheck()).toBe(false); // the check failed: fail closed
    expect(await s.recheck()).toBe(true); // gone
    expect(checks).toBe(4);
    (await s.admit('unit')).done({ outcome: 'ok' });
  });
  it('a kill on a source WITH a deadline holds nothing', async () => {
    const s = new SourceScheduler({ ...DEFAULT_LIMITS, perMinute: {} }, 'src');
    (await s.admit('unit')).done({ outcome: 'killed' });
    expect(s.state().reserved).toBe(false);
  });
});

describe('the unit envelope (§7.4, §7.7, §7.8)', () => {
  it('an int8 column keeps its type: a number inside 2^53, its text past it', () => {
    expect(unitCell('42', 'bigint')).toEqual({ value: 42, cut: false });
    expect(unitCell('9007199254740993', 'bigint')).toEqual({ value: '9007199254740993', cut: false });
    expect(unitCell('42', 'text')).toEqual({ value: '42', cut: false });
    expect(unitCell(7n, null)).toEqual({ value: 7, cut: false });
  });
  it('a cell is cut at 2,000 characters and says so', () => {
    const c = unitCell('x'.repeat(UNIT_CELL_CHARS + 1), 'text');
    expect(c.cut).toBe(true);
    expect((c.value as string).length).toBe(UNIT_CELL_CHARS + 1);
    expect((c.value as string).endsWith('…')).toBe(true);
  });
  it('cells are scrubbed of the secret BEFORE the byte cap, and only whole rows fit', () => {
    const secret = 'pw"\nx';
    const r = unitRows([[secret], ['ok']], [{ name: 'a', type: 'text' }], [secret]);
    expect(JSON.stringify(r.rows)).not.toContain('pw');
    expect(rowsWithin([['a'.repeat(10)], ['b']], 20)).toEqual({ rows: [['a'.repeat(10)]], cut: true });
  });
  it('a source error is its SQLSTATE only', () => {
    expect(sqlstateOf('ERROR: invalid input syntax for type integer: "k3-secret-value-123" (SQLSTATE 22P02)')).toBe('22P02');
    expect(sqlstateOf('ORA-01017: invalid username/password')).toBe('ORA-01017');
    expect(sqlstateOf('no code here')).toBe(null);
  });
  it('the cite names the read, never its rows', () => {
    const c = citeOf('support-pg', 'id-1', 'call-1', 'h', '2026-11-04T03:00:12.000Z');
    expect(c).toMatch(/^src:support-pg@2026-11-04T03:00:12\.000Z#[0-9a-f]{8}$/);
  });
});

describe('the Postgres rewrite (§6.3, §7.2)', () => {
  const k = relKey('s', 't');
  const cat: PolicyCatalog = { relations: new Map([[k, 'table']]), columns: new Map([[k, new Set(['id', 'note', 'big'])]]), viewsAllowed: new Set() };
  it('the statement is cut by libpg_query: a trailing ; or comment never reaches the wrapper', async () => {
    expect(await statementOf('SELECT t.id FROM s.t AS t;')).toBe('SELECT t.id FROM s.t AS t');
    expect(await statementOf('  SELECT 1 -- note')).toBe('SELECT 1 -- note');
    const w = limitRewrite('SELECT 1 -- note', 200);
    expect(w).toBe('SELECT * FROM (\nSELECT 1 -- note\n) AS q LIMIT 201');
    expect((await recheckPg(w, cat)).ok).toBe(true);
    expect(await statementOf('SELECT 1; SELECT 2')).toBe(null);
  });
  it('refuses SET, BEGIN, DDL, DML, two statements, pg_sleep and current_setting before anything runs', async () => {
    for (const [text, code] of [
      ['SET default_transaction_read_only = off', 'not_select'],
      ['BEGIN', 'not_select'],
      ['CREATE TEMP TABLE x (a int)', 'not_select'],
      ['UPDATE s.t SET note = $1', 'not_select'],
      ['SELECT 1; SELECT 2', 'statements'],
      ['SELECT pg_sleep(20)', 'function'],
      ["SELECT current_setting('transaction_read_only')", 'function'],
      ["SELECT pg_read_file('/etc/passwd')", 'function'],
      ['SELECT inet_server_addr(), version()', 'function'],
    ] as const) {
      const r = await admitPg(text, cat);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.code, text).toBe(code);
    }
  });
  it('the unit projection: bounded types keep, bytea is cut by substring, everything else by left(c::text)', async () => {
    expect(boundedType('bigint')).toBe(true);
    // numeric is not bounded by its type (prepare reports no typmod; an unconstrained one holds 131,072 digits)
    expect(boundedType('numeric')).toBe(false);
    expect(cellExpression('q."c1"', 'numeric', 2000)).toBe('pg_catalog.left(q."c1"::pg_catalog.text, 2001)');
    expect(boundedType('timestamp(3) with time zone')).toBe(true);
    expect(boundedType('text')).toBe(false);
    expect(boundedType('support.ticket_status')).toBe(false);
    expect(cellExpression('q."c1"', 'bigint', 2000)).toBe('q."c1"');
    expect(cellExpression('q."c1"', 'bytea', 2000)).toBe('pg_catalog.substring(q."c1", 1, 1000)');
    expect(cellExpression('q."c1"', 'jsonb', 2000)).toBe('pg_catalog.left(q."c1"::pg_catalog.text, 2001)');
    const a = await admitPg('SELECT t.id, t.note, t.id AS id FROM s.t AS t', cat);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const text = projectedRewrite(a.statement, ['integer', 'text', 'integer'], 200, 2000);
    expect(text).toBe('SELECT q."c1", pg_catalog.left(q."c2"::pg_catalog.text, 2001), q."c3" FROM (\nSELECT t.id, t.note, t.id AS id FROM s.t AS t\n) AS q("c1", "c2", "c3") LIMIT 201');
    // the final text passes the same policy
    expect(await recheckPg(text, cat)).toEqual({ ok: true });
  });
});

describe('the Toolbox document (§5.1 deployment policy at spawn, §7.5 host mode, §7.6 secrets)', () => {
  const base = { kind: 'source', type: 'postgres', host: '127.0.0.1', port: '55431', user: 'reader', password: '${WICKED_SRC_1}', database: 'support' };
  const input = (document: Record<string, unknown>, extra: Partial<Parameters<typeof toolboxDocument>[0]> = {}) =>
    toolboxDocument({ id: '3f0c9a1e-0000-4000-8000-000000000001', document, address: { ...LOOPBACK, plaintext: false }, tls: 'disable', statementTimeoutMs: 10_000, ...extra });
  it('refuses connectionString, queryExecMode, queryParams and any field off the allowlist', async () => {
    for (const f of ['connectionString', 'queryExecMode', 'queryParams', 'sqlCommenter', 'tnsAdmin', 'name', 'connectTimeout']) {
      await expect(input({ ...base, [f]: 'x' })).rejects.toMatchObject({ code: 'field_refused' });
    }
  });
  it('refuses a password that is a value, a placeholder anywhere else, and a type it does not serve', async () => {
    await expect(input({ ...base, password: 'hunter2' })).rejects.toMatchObject({ code: 'secret_inline' });
    await expect(input({ ...base, user: '${WICKED_SRC_2}' })).rejects.toMatchObject({ code: 'field_invalid' });
    await expect(input({ ...base, type: 'oracle' })).rejects.toMatchObject({ code: 'type_unsupported' });
  });
  it('host mode admits an IP literal the dialer checked (loopback here) and refuses a host name and an unconfirmed range', async () => {
    await expect(input({ ...base, host: 'db.example.com' })).rejects.toMatchObject({ code: 'host_mode_hostname' });
    await expect(input({ ...base, host: '10.1.2.3' })).rejects.toMatchObject({ code: 'address_unconfirmed' });
    await expect(input({ ...base, host: '169.254.169.254' })).rejects.toMatchObject({ code: 'address_refused' });
    await expect(input(base)).resolves.toMatchObject({ host: '127.0.0.1', port: 55431, secretVar: 'WICKED_SRC_1', sourceDeadline: true });
  });
  it('writes the startup parameters of §7.2, and none when the simulation removes the timeout', async () => {
    const d = await input(base);
    const docs = parseAllDocuments(d.yaml).map((x) => x.toJS() as Record<string, unknown>);
    const src = docs.find((x) => x['kind'] === 'source') as Record<string, unknown>;
    expect(src['queryParams']).toEqual({
      application_name: applicationNameOf('3f0c9a1e-0000-4000-8000-000000000001'),
      default_transaction_read_only: 'on',
      search_path: 'pg_catalog,pg_temp',
      standard_conforming_strings: 'on',
      statement_timeout: '10000',
      idle_in_transaction_session_timeout: '15000',
      sslmode: 'disable',
    });
    expect(docs.filter((x) => x['kind'] === 'tool').map((x) => x['name'])).toEqual(['execute_sql', 'list_tables']);
    expect(d.yaml).toContain('password: "${WICKED_SRC_1}"');
    const sim = await input(base, { omitStatementTimeout: true });
    expect(sim.sourceDeadline).toBe(false);
    expect(sim.yaml).not.toContain('statement_timeout');
  });
  it('a secret with a quote, a newline, a backslash and a dollar-brace comes back byte for byte after text substitution', async () => {
    const d = await input(base);
    for (const secret of ['pa"ss\nword\\x${HOME}', 'tab\there\r\n', 'ünï cødé', '#not a comment']) {
      const substituted = d.yaml.replace('${WICKED_SRC_1}', yamlQuotedBody(secret));
      const src = parseAllDocuments(substituted).map((x) => x.toJS() as Record<string, unknown>).find((x) => x['kind'] === 'source') as Record<string, unknown>;
      expect(src['password']).toBe(secret);
    }
  });
  it('crew writes sslmode=verify-full unless plaintext is allowed for the address', async () => {
    const d = await input(base, { tls: 'verify-full' });
    expect(d.yaml).toContain('sslmode: "verify-full"');
    await expect(input({ ...base, host: '10.1.2.3' }, { tls: 'disable', address: { allow: ['10.0.0.0/8'], plaintext: false } })).rejects.toBeInstanceOf(ToolboxDocumentError);
  });
});

describe("an adapter's stderr as crew keeps it (§7.6)", () => {
  it('a secret form longer than the kept tail, split across chunks (multi-byte at the split), is never shown in part', () => {
    const secret = `ü${'s"\n'.repeat(2700)}é`;
    const forms = [secret, yamlQuotedBody(secret), JSON.stringify(secret).slice(1, -1)];
    expect(forms[1]!.length).toBeGreaterThan(8192);
    const t = new StderrTail(forms);
    const text = Buffer.from(`before ${forms[1]} after`, 'utf8');
    // split inside a multi-byte character, and in the middle of the long form
    const cuts = [8, 9, 4000, 9000, text.length];
    let at = 0;
    for (const c of cuts) {
      t.push(text.subarray(at, c));
      at = c;
    }
    const v = t.view();
    expect(v).toContain('[redacted:secret]');
    expect(v.endsWith(' after')).toBe(true);
    for (const f of forms) for (const piece of [f.slice(0, 40), f.slice(-40), f.slice(5000, 5040)]) expect(v.includes(piece)).toBe(false);
  });
  it('a write that stops inside a secret form shows no fragment of it', () => {
    const t = new StderrTail(['hunter2-long-secret']);
    t.push(Buffer.from('connecting with hunter2-lo'));
    expect(t.view()).toBe('connecting with ');
  });
});

describe('the pinned binary (§16 supply chain)', () => {
  it('pins the five published platforms and has no linux/arm64 at v1.15.0', () => {
    expect(Object.keys(TOOLBOX_PINS).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64']);
    expect(TOOLBOX_PINS['darwin-arm64']).toBe('ddf69a8cd52904f86532d5e195d06e5d4c158de61c69dc17bd4d8b6203fc52fc');
    expect(toolboxUrl('darwin', 'arm64')).toBe('https://storage.googleapis.com/mcp-toolbox-for-databases/v1.15.0/darwin/arm64/toolbox');
    expect(platformKey('linux', 'arm64')).toBe('linux-arm64');
    expect(toolboxPath('/s/mcp', 'linux', 'x64')).toBe('/s/mcp/adapters/toolbox/1.15.0/linux-x64/toolbox');
  });
  it('a download whose bytes do not match the pin is never kept, and an unsupported platform is refused', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'tb-bin-'));
    const fake = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
    await expect(new ToolboxBinary({ home, platform: 'linux', arch: 'x64', fetch: fake }).ensure()).rejects.toMatchObject({ code: 'toolbox_checksum_mismatch' });
    expect(existsSync(toolboxPath(home, 'linux', 'x64'))).toBe(false);
    await expect(new ToolboxBinary({ home, platform: 'linux', arch: 'arm64', fetch: fake }).ensure()).rejects.toMatchObject({ code: 'toolbox_unsupported_platform' });
    // the right bytes are kept, executable, and found again without a download
    const { createHash } = await import('node:crypto');
    const bytes = new Uint8Array([9, 8, 7]);
    const pins = { 'linux-x64': createHash('sha256').update(bytes).digest('hex') };
    let downloads = 0;
    const good = (async () => (downloads++, new Response(bytes))) as unknown as typeof fetch;
    const p = await new ToolboxBinary({ home, platform: 'linux', arch: 'x64', fetch: good, pins }).ensure();
    expect(p).toBe(toolboxPath(home, 'linux', 'x64'));
    await new ToolboxBinary({ home, platform: 'linux', arch: 'x64', fetch: good, pins }).ensure();
    expect(downloads).toBe(1);
  });
  it('splits a regclass name back into its parts', () => {
    expect(splitQualified('support.regions')).toEqual({ schema: 'support', table: 'regions' });
    expect(splitQualified('"we.ird"."ta""b"')).toEqual({ schema: 'we.ird', table: 'ta"b' });
  });
});
