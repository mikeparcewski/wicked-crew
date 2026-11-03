// The standalone site against a real Postgres and a real HTTPS issuer (DES-APPS-001 §8.2; S8 host side, S9,
// S15, S17 through the server): an app built, checked and granted by crew's own code, published with crew's
// manifest and packer, served by `startSite`. Needs APPS_PG16_URL or APPS_PG17_URL (crew's sources-db job).

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppPublishBody } from '../../crew/src/core/types.js';
import { LOGINS, writeRig, type WriteRig } from '../../crew/tests/support/apps-writes.js';
import { type FreshPg, freshPgDatabase, PG_TARGETS } from '../../crew/tests/support/sources-db.js';
import { startSite, type RunningSite } from '../src/main.js';
import { SiteError } from '../src/site.js';
import { startIdp, type TestIdp } from './support/idp.js';
import { ASSIGN, call, MINE, MINE_SQL, publishSite, SITE_ORIGIN, TICKETS, TICKETS_SQL } from './support/published.js';

const PG = PG_TARGETS[0];
const ENV = { APPS_SRC_WRITER_PASSWORD: LOGINS.writer.password };

describe.skipIf(PG === undefined)(`the standalone site on ${PG?.label ?? 'postgres (not configured: set APPS_PG16_URL)'}`, () => {
  let idp: TestIdp;
  let db: FreshPg;
  let rig: WriteRig;
  let siteDir: string;
  let dataDir: string;
  let site: RunningSite;
  const lines: string[] = [];
  const body = (): AppPublishBody => ({
    base: rig.version(),
    targets: ['site'],
    site: { origin: SITE_ORIGIN },
    identity: { profile: 'oidc', issuer: idp.issuer, clientId: 'desk-site', allowRanges: ['127.0.0.1/32'] },
    audience: { kind: 'oidc-groups', groups: ['support-ops'] },
  });
  const start = (o: { env?: Record<string, string>; mounted?: boolean; dir?: string } = {}): Promise<RunningSite> =>
    startSite({ siteDir: o.dir ?? siteDir, dataDir, hostJs: 'void 0;', hostCss: '.wk-host{}', port: 0, host: '127.0.0.1', env: o.env ?? ENV, dial: idp.dial, isMount: () => o.mounted ?? true, out: (l) => void lines.push(l) });
  const priya = (extra: Record<string, unknown> = {}): string => idp.token({ sub: 'u-priya', aud: 'desk-site', email: 'priya@example.com', email_verified: true, groups: ['support-ops'], name: 'Priya', ...extra });

  beforeAll(async () => {
    idp = await startIdp();
    db = await freshPgDatabase(PG!);
    rig = await writeRig(db, ['writer']);
    await rig.land([ASSIGN], [TICKETS, MINE], { tickets: TICKETS_SQL, mine: MINE_SQL });
    const g = await rig.grant('assign');
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    ({ dir: siteDir } = await publishSite(rig, body(), idp.endpoints));
    dataDir = mkdtempSync(join(tmpdir(), 'apps-k6-data-'));
    site = await start();
  });
  afterAll(async () => {
    await site?.close();
    await rig?.h.close();
    await db?.drop();
    await idp?.close();
    for (const d of [siteDir, dataDir]) if (d !== undefined) rmSync(d, { recursive: true, force: true });
  });

  it('serves the page with COOP and a CSP that pins its one script and its one stylesheet by hash', async () => {
    const r = await call(site.port, 'GET', '/');
    expect(r.status).toBe(200);
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    const csp = String(r.headers['content-security-policy']);
    const script = /<script>([\s\S]*)<\/script>\n<\/body>/.exec(r.text)![1]!;
    const style = /<style id="wk-apps-sheet">([\s\S]*?)<\/style>/.exec(r.text)![1]!;
    const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64');
    expect(csp).toContain(`script-src 'sha256-${h(script)}'`);
    expect(csp).toContain(`style-src 'sha256-${h(style)}'`);
    expect(csp).toContain(`connect-src 'self' ${idp.issuer}`);
    expect(csp).toContain("frame-ancestors 'none'");
    // Exactly one executable script and one stylesheet; the bootstrap block does not execute.
    expect(r.text.match(/<script>/g)).toHaveLength(1);
    expect(r.text.match(/<style/g)).toHaveLength(1);
    expect(r.text).toContain('<script type="application/json" id="wk-boot">');
    expect(r.text).not.toMatch(/style="/);
    // /auth/callback is the same page.
    expect((await call(site.port, 'GET', '/auth/callback?code=x&state=y')).text).toBe(r.text);
  });

  it('GET /spec is behind the token: none is 401, outside the audience 403, inside it the spec', async () => {
    expect((await call(site.port, 'GET', '/spec')).status).toBe(401);
    const outside = await call(site.port, 'GET', '/spec', { token: priya({ sub: 'u-olga', groups: ['finance'] }) });
    expect(outside.status).toBe(403);
    expect(outside.json.code).toBe('not_in_audience');
    expect(outside.json).not.toHaveProperty('spec');
    const r = await call(site.port, 'GET', '/spec', { token: priya() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ app: { slug: 'desk', version: rig.version() }, viewer: { email: 'priya@example.com' }, actions: true, refused: [] });
  });

  it('refuses tokens from another key, issuer or client, and expired ones (S15)', async () => {
    const cases = [
      idp.token({ sub: 'u1', aud: 'desk-site', groups: ['support-ops'] }, { key: 'stranger' }),
      priya({ iss: 'https://other.example.com' }),
      priya({ aud: 'another-app' }),
      priya({ aud: ['desk-site', 'another-app'] }), // several audiences and no azp naming us
      priya({ exp: Math.floor(Date.now() / 1000) - 10 }),
    ];
    for (const t of cases) expect((await call(site.port, 'GET', '/spec', { token: t })).status).toBe(401);
    expect((await call(site.port, 'GET', '/spec', { token: priya({ aud: ['desk-site', 'another-app'], azp: 'desk-site' }) })).status).toBe(200);
  });

  it('viewer.email only with email_verified === true: the string "true", false or absent leaves it unknown (S15)', async () => {
    for (const ev of ['true', false, undefined]) {
      const t = priya(ev === undefined ? { email_verified: undefined } : { email_verified: ev });
      const r = await call(site.port, 'GET', '/spec', { token: t });
      expect(r.status).toBe(200);
      expect((r.json['viewer'] as { email: unknown }).email).toBeNull();
      // A query bound to viewer.email cannot run without one.
      const q = await call(site.port, 'POST', '/q/mine', { token: t, body: {} });
      expect(q.status).toBeGreaterThanOrEqual(400);
      // The site's words: the claim comes from the sign-in (never "set your git user.email").
      expect(q.json.error).toMatch(/your sign-in does not give this app/);
      expect(q.json.error).not.toMatch(/git/);
    }
  });

  it('a POST needs the site origin and application/json; a client value for a viewer-bound parameter is refused', async () => {
    expect((await call(site.port, 'POST', '/q/tickets', { token: priya(), body: {}, origin: null })).status).toBe(403);
    expect((await call(site.port, 'POST', '/q/tickets', { token: priya(), body: {}, origin: 'https://evil.example' })).json.code).toBe('origin_refused');
    expect((await call(site.port, 'POST', '/q/tickets', { token: priya(), raw: '{}', contentType: 'text/plain' })).status).toBe(415);
    expect((await call(site.port, 'POST', '/q/tickets', { token: priya(), body: { version: 1 } })).status).toBe(400); // the version is the server's
    const forged = await call(site.port, 'POST', '/q/mine', { token: priya(), body: { params: { me: 'someone@else.example' } } });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    const r = await call(site.port, 'POST', '/q/tickets', { token: priya(), body: {} });
    expect(r.status, r.text).toBe(200);
    expect(r.json['rows']).toEqual([[4821, 'nobody', 'EMEA'], [4822, 'nobody', 'AMER'], [4823, 'nobody', 'APAC']]);
    expect((await call(site.port, 'GET', '/q/tickets', { token: priya() })).status).toBe(404);
    expect((await call(site.port, 'GET', '/api/v1/apps', { token: priya() })).status).toBe(404);
  });

  it('a row write through the site: the card, then the run, the row, the audit line without values, one run per record (S9, S17)', async () => {
    const prep = await call(site.port, 'POST', '/a/assign/prepare', { token: priya(), body: { params: { id: 4822 } } });
    expect(prep.status, prep.text).toBe(200);
    const card = prep.json['card'] as { kind: string; verb: string; table: string; columns: Array<{ name: string; value: unknown; label: string }>; key: Array<{ value: unknown }> };
    expect(card).toMatchObject({ kind: 'row-write', verb: 'UPDATE', table: 's.tickets' });
    expect(card.columns).toEqual([expect.objectContaining({ name: 'owner', value: 'priya@example.com', label: 'your sign-in' })]);
    expect(card.key[0]!.value).toBe(4822);
    const record = String(prep.json['record']);
    // Someone else cannot run (or read) priya's record.
    const sam = priya({ sub: 'u-sam', email: 'sam@example.com' });
    expect((await call(site.port, 'POST', '/a/assign/run', { token: sam, body: { record } })).status).toBeGreaterThanOrEqual(400);
    expect((await call(site.port, 'GET', `/a/records/${record}`, { token: sam })).status).toBeGreaterThanOrEqual(400);
    const ran = await call(site.port, 'POST', '/a/assign/run', { token: priya(), body: { record } });
    expect(ran.status, ran.text).toBe(200);
    expect(ran.json['state']).toBe('succeeded');
    expect(await rig.one('SELECT owner AS v FROM s.tickets WHERE id = 4822')).toBe('priya@example.com');
    // Replayed: refused, nothing written twice.
    const again = await call(site.port, 'POST', '/a/assign/run', { token: priya(), body: { record } });
    expect(again.json.code).toBe('record_used');
    expect((await call(site.port, 'GET', `/a/records/${record}`, { token: priya() })).json['state']).toBe('succeeded');
    // An altered record id is no record.
    expect((await call(site.port, 'POST', '/a/assign/run', { token: priya(), body: { record: record.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } })).status).toBeGreaterThanOrEqual(400);
    const audit = readFileSync(join(dataDir, 'log', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"apps.action.ran"');
    expect(audit).toContain('"outcome":"succeeded"');
    expect(audit).not.toContain('priya@example.com');
    // The decision log has the claims, never the token.
    const decisions = readFileSync(join(dataDir, 'log', 'decisions.jsonl'), 'utf8');
    expect(decisions).toContain('"decision":"deny"');
    expect(decisions).not.toContain(priya().split('.')[2]!);
    // The read after the write sees it (the run invalidated the cache).
    const r = await call(site.port, 'POST', '/q/tickets', { token: priya(), body: {} });
    expect((r.json['rows'] as unknown[][])[1]).toEqual([4822, 'priya@example.com', 'AMER']);
  });

  it('prepare, then a trigger lands on the table, then run: refused under the lock, nothing written (S9, S17)', async () => {
    const prep = await call(site.port, 'POST', '/a/assign/prepare', { token: priya(), body: { params: { id: 4823 } } });
    expect(prep.status, prep.text).toBe(200);
    await db.admin.unsafe('CREATE OR REPLACE FUNCTION s.k6_mark() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.region := \'X\'; RETURN NEW; END $$');
    await db.admin.unsafe('CREATE TRIGGER k6_mark BEFORE UPDATE ON s.tickets FOR EACH ROW EXECUTE FUNCTION s.k6_mark()');
    try {
      const ran = await call(site.port, 'POST', '/a/assign/run', { token: priya(), body: { record: String(prep.json['record']) } });
      expect(ran.status === 409 || ran.json['state'] === 'failed', ran.text).toBe(true);
      expect(await rig.one("SELECT owner || '/' || region AS v FROM s.tickets WHERE id = 4823")).toBe('nobody/APAC');
    } finally {
      await db.admin.unsafe('DROP TRIGGER k6_mark ON s.tickets');
    }
  });

  it('a manifest that drops a grant the spec still needs does not start (revoking is publishing again without the action)', async () => {
    const { cpSync, writeFileSync } = await import('node:fs');
    const copy = mkdtempSync(join(tmpdir(), 'apps-k6-site2-'));
    try {
      cpSync(siteDir, copy, { recursive: true });
      const m = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(copy, 'manifest.json'), JSON.stringify({ ...m, actions: [] }));
      await expect(start({ dir: copy })).rejects.toThrow(/action assign has no grant/);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('every protected request writes exactly one decision line, early refusals included, and never the token', async () => {
    const log = (): Array<Record<string, unknown>> => readFileSync(join(dataDir, 'log', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const before = log().length;
    const t = priya();
    await call(site.port, 'POST', '/q/tickets', { token: t, raw: '{not json' }); // signed in, then a bad body
    await call(site.port, 'POST', '/q/tickets', { token: t, body: {}, origin: 'https://evil.example' }); // refused before sign-in
    await call(site.port, 'POST', '/a/assign/prepare', { token: t, body: { nope: 1 } }); // signed in, then an unknown field
    const bad = await call(site.port, 'POST', '/q/%E0%A4%A', { token: t, body: {} }); // a malformed escape: 400, not 500
    expect(bad.status).toBe(400);
    const lines = log().slice(before);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatchObject({ route: 'query', decision: 'refused', outcome: 'bad_request' });
    expect(lines[0]).toMatchObject({ route: 'query', decision: 'allow', outcome: 'bad_request', sourceCalled: false });
    expect(lines[1]).toMatchObject({ route: 'query', decision: 'refused', outcome: 'origin_refused', claims: null });
    expect(lines[2]).toMatchObject({ route: 'prepare', decision: 'allow', outcome: 'bad_request', sourceCalled: false });
    expect(JSON.stringify(lines)).not.toContain(t.split('.')[2]!);
  });

  it('a source the site could not describe refuses its actions too (503), not only its queries', async () => {
    site.registry.setDown('writer', 'timeout', Date.now());
    try {
      const p = await call(site.port, 'POST', '/a/assign/prepare', { token: priya(), body: { params: { id: 4821 } } });
      expect(p.status).toBe(503);
      expect(p.json.code).toBe('source_unavailable');
    } finally {
      await site.refresh();
    }
    expect((await call(site.port, 'POST', '/a/assign/prepare', { token: priya(), body: { params: { id: 4821 } } })).status).toBe(200);
  });

  it('APPS_READ_ONLY, or no volume at /data, turns actions off with the reason; reads go on', async () => {
    await site.close();
    for (const [o, reason] of [[{ env: { ...ENV, APPS_READ_ONLY: '1' } }, /APPS_READ_ONLY/], [{ mounted: false }, /no volume is mounted/]] as const) {
      const s = await start(o);
      try {
        const spec = await call(s.port, 'GET', '/spec', { token: priya() });
        expect(spec.json['actions']).toBe(false);
        // Off for the whole site is said once (`actions: false`), not as a refusal of each action.
        expect(spec.json['refused']).toEqual([]);
        const p = await call(s.port, 'POST', '/a/assign/prepare', { token: priya(), body: { params: { id: 4821 } } });
        expect(p.json.code).toBe('actions_off');
        expect(p.json.error).toMatch(reason);
        expect((await call(s.port, 'POST', '/q/tickets', { token: priya(), body: {} })).status).toBe(200);
        // Under APPS_READ_ONLY the person can still read what an earlier action did (the store is there).
        if (o.env !== undefined) {
          const records = JSON.parse(readFileSync(join(dataDir, 'apps-actions.json'), 'utf8')) as { records: Record<string, { viewer: string; state: string }> };
          const mine = Object.entries(records.records).find(([, r]) => r.state === 'succeeded');
          expect(mine).toBeDefined();
          const view = await call(s.port, 'GET', `/a/records/${mine![0]}`, { token: priya() });
          expect(view.status, view.text).toBe(200);
          expect(view.json['state']).toBe('succeeded');
        }
      } finally {
        await s.close();
      }
    }
    site = await start();
  });

  it('one server per data volume: a second start on it stops, naming the owner; it starts once the first has stopped', async () => {
    await expect(start()).rejects.toThrow(/another wicked-apps-server owns/);
    await site.close();
    site = await start();
    expect((await call(site.port, 'GET', '/healthz')).json['actions']).toBe(true);
  });

  it('close waits for an admitted request, even one whose viewer disconnected, before it gives the volume up', async () => {
    const before = Object.keys((JSON.parse(readFileSync(join(dataDir, 'apps-actions.json'), 'utf8')) as { records: object }).records).length;
    const pending = call(site.port, 'POST', '/a/assign/prepare', { token: priya(), body: { params: { id: 4821 } } }).catch(() => null);
    await new Promise((r) => setTimeout(r, 15));
    site.server.closeAllConnections(); // the viewer goes away mid-request
    await site.close();
    await pending;
    // The handler finished (its record is on the volume) before the claim was released and a new server could load the store.
    const after = Object.keys((JSON.parse(readFileSync(join(dataDir, 'apps-actions.json'), 'utf8')) as { records: object }).records).length;
    expect(after).toBe(before + 1);
    site = await start();
  });

  it('startup refuses a missing secret by name, and a changed contract and an unsafe row-write table by name (S14, S17)', async () => {
    await site.close();
    await expect(start({ env: {} })).rejects.toThrow(SiteError);
    await expect(start({ env: {} })).rejects.toThrow(/APPS_SRC_WRITER_PASSWORD/);
    // A trigger on the table the row write targets: the action is refused at startup, naming it and the table.
    await db.admin.unsafe('CREATE FUNCTION s.k6_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
    await db.admin.unsafe('CREATE TRIGGER k6_noop BEFORE UPDATE ON s.tickets FOR EACH ROW EXECUTE FUNCTION s.k6_noop()');
    // A used column's type changed (still executable): the query that reads it is refused by name.
    await db.admin.unsafe('ALTER TABLE s.tickets ALTER COLUMN region TYPE varchar(20)');
    const s = await start();
    try {
      const refused = s.state.list();
      expect(refused.find((r) => r.kind === 'action' && r.id === 'assign')?.reason).toMatch(/s\.tickets|table/);
      expect(refused.find((r) => r.kind === 'query' && r.id === 'tickets')?.reason).toMatch(/contract_changed|changed/);
      expect(lines.join('')).toContain('"event":"refused"');
      const health = await call(s.port, 'GET', '/healthz');
      const listed = health.json['refused'] as Array<Record<string, unknown>>;
      expect(listed.length).toBeGreaterThanOrEqual(2);
      // Unauthenticated: kind, id and a code only; the reasons (which name tables) are behind the sign-in.
      for (const r of listed) expect(Object.keys(r).sort()).toEqual(['code', 'id', 'kind']);
      expect(health.text).not.toContain('s.tickets');
      const spec = await call(s.port, 'GET', '/spec', { token: priya() });
      expect(JSON.stringify(spec.json['refused'])).toContain('s.tickets');
      const p = await call(s.port, 'POST', '/a/assign/prepare', { token: priya(), body: { params: { id: 4821 } } });
      expect(p.status).toBe(409);
      expect((await call(s.port, 'POST', '/q/tickets', { token: priya(), body: {} })).status).toBe(409);
      // Handed to the executor, which refused: the decision line says the request got past the site's own checks.
      const last = readFileSync(join(dataDir, 'log', 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['route'] === 'query').at(-1);
      expect(last).toMatchObject({ decision: 'allow', query: 'tickets', outcome: 'contract_changed', sourceCalled: true });
    } finally {
      await s.close();
      await db.admin.unsafe('DROP TRIGGER k6_noop ON s.tickets');
      await db.admin.unsafe('ALTER TABLE s.tickets ALTER COLUMN region TYPE text');
    }
    site = await start();
  });
});
