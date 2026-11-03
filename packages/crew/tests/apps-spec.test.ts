// DES-APPS-001 §4 (K2a): `apps.json`, the schema and the consistency check crew runs on every tree.
import { describe, expect, it } from 'vitest';

import { APP_SPEC_MAX_BYTES, checkSpec, parseSpec, parseWork, readSpec } from '../src/apps/spec.js';
import type { AppSpec } from '../src/core/types.js';

/** Priya's "Escalations" app (DES §3), trimmed: every component kind and both action kinds. */
function escalations(): AppSpec {
  return {
    schema: 'wicked.apps/v1',
    name: 'Escalations',
    theme: { mode: 'auto', accent: '#3355ff', palette: ['#3355ff', '#ff5533'], density: 'compact' },
    linkHosts: ['support.example.com'],
    pages: [
      {
        id: 'overview',
        title: 'Overview',
        components: [
          { id: 'region', type: 'filter', filter: 'select', box: { x: 0, y: 0, w: 3, h: 1 }, options: { kind: 'query', query: { query: 'regions' }, value: 'region' } },
          { id: 'period', type: 'filter', filter: 'date-range', box: { x: 3, y: 0, w: 3, h: 1 }, default: { lastDays: 90 } },
          {
            id: 'kpi-open',
            type: 'kpi',
            box: { x: 0, y: 1, w: 3, h: 2 },
            title: 'Open escalations',
            data: { query: 'open_escalations', params: { region: 'filter.region', since: 'filter.period.from' } },
            value: 'open',
            delta: 'change',
            caption: 'vs previous 90 days',
            format: { kind: 'number', decimals: 0 },
          },
          {
            id: 'breaches-chart',
            type: 'chart',
            chart: 'bar',
            box: { x: 0, y: 3, w: 6, h: 4 },
            data: { query: 'breaches_by_region', params: { since: 'filter.period.from' } },
            x: 'region',
            series: [{ column: 'breaches', label: 'Breaches', color: '#ff5533' }],
          },
          {
            id: 'tickets',
            type: 'table',
            box: { x: 0, y: 7, w: 12, h: 6 },
            data: { query: 'escalation_list', params: { region: 'filter.region' } },
            columns: [{ column: 'id', label: 'Ticket' }, { column: 'owner' }],
            rowActions: [{ label: 'Assign to me', action: 'assign_to_me', params: { ticket: 'row.id' } }],
            pageSize: 50,
          },
          { id: 'note', type: 'text', box: { x: 6, y: 3, w: 6, h: 1 }, text: '<b>not html</b>', style: 'caption' },
          { id: 'kb', type: 'link', box: { x: 6, y: 4, w: 3, h: 1 }, label: 'Runbook', to: { kind: 'href', href: 'https://support.example.com/runbook' } },
          { id: 'to-detail', type: 'link', box: { x: 9, y: 4, w: 3, h: 1 }, label: 'Detail', to: { kind: 'page', page: 'detail', params: { region: 'filter.region' } } },
          { id: 'logo', type: 'image', box: { x: 6, y: 5, w: 2, h: 2 }, src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'logo' },
        ],
      },
      {
        id: 'detail',
        title: 'Detail',
        components: [
          {
            id: 'refund',
            type: 'form',
            box: { x: 0, y: 0, w: 6, h: 4 },
            fields: [
              { name: 'order', input: 'text', required: true },
              { name: 'reason', input: 'select', options: [{ value: 'damaged' }] },
            ],
            submit: { label: 'Submit request', action: 'request_refund', params: { order: 'form.order', reason: 'form.reason' } },
          },
          { id: 'ping', type: 'button', box: { x: 6, y: 0, w: 2, h: 1 }, action: { label: 'Ping', action: 'request_refund', params: { order: 'url.order' } } },
        ],
      },
    ],
    queries: [
      { id: 'regions', source: 'support-pg', kind: 'sql', output: [{ name: 'region', type: 'string' }] },
      {
        id: 'open_escalations',
        source: 'support-pg',
        kind: 'sql',
        params: {
          type: 'object',
          properties: { region: { type: 'string' }, since: { type: 'string', format: 'date' }, me: { type: 'string', from: 'viewer.email' } },
          required: ['since'],
        },
        output: [{ name: 'open', type: 'integer' }, { name: 'change', type: 'integer', nullable: true }],
        refresh: { mode: 'every', seconds: 60 },
      },
      {
        id: 'breaches_by_region',
        source: 'support-pg',
        kind: 'sql',
        params: { type: 'object', properties: { since: { type: 'string', format: 'date' } } },
        output: [{ name: 'region', type: 'string' }, { name: 'breaches', type: 'integer' }],
      },
      {
        id: 'escalation_list',
        source: 'support-pg',
        kind: 'sql',
        params: { type: 'object', properties: { region: { type: 'string' } } },
        output: [{ name: 'id', type: 'integer' }, { name: 'owner', type: 'string', nullable: true }],
      },
      { id: 'gates', source: 'crew', kind: 'crew', output: [{ name: 'run', type: 'string' }], rowPath: '$.runs[*]', refresh: { mode: 'events' } },
    ],
    actions: [
      {
        id: 'assign_to_me',
        kind: 'row-write',
        source: 'support-pg-writer',
        table: 'support.tickets',
        op: 'update',
        set: { owner: { kind: 'viewer', claim: 'email' }, updated_at: { kind: 'crew', value: 'now' } },
        key: { id: { kind: 'param', name: 'ticket' } },
        params: { type: 'object', properties: { ticket: { type: 'integer' } }, required: ['ticket'] },
        description: 'Assign this ticket to you',
      },
      {
        id: 'request_refund',
        kind: 'api',
        source: 'finance-api',
        call: { kind: 'tool', tool: 'createRefund' },
        args: { order: { kind: 'param', name: 'order' }, reason: { kind: 'param', name: 'reason' }, channel: { kind: 'literal', value: 'refund-app' } },
        params: { type: 'object', properties: { order: { type: 'string' }, reason: { type: 'string' } } },
      },
    ],
  };
}

const codes = (spec: unknown): string[] => {
  const parsed = parseSpec(spec);
  if (parsed.spec === null) return parsed.findings.map((f) => `${f.code}@${f.path}`);
  return checkSpec(parsed.spec).map((f) => `${f.code}@${f.path}`);
};

describe('apps.json: the shape', () => {
  it('accepts a spec with every component kind and both action kinds, with nothing to say', () => {
    expect(codes(escalations())).toEqual([]);
  });

  it('refuses a key it does not know, at the top and inside a component', () => {
    expect(codes({ ...escalations(), script: 'alert(1)' })).toEqual(['schema@$']);
    const s = escalations() as unknown as { pages: { components: Record<string, unknown>[] }[] };
    s.pages[0]!.components[5]!['html'] = '<img src=x onerror=alert(1)>';
    expect(codes(s)).toEqual(['schema@$.pages[0].components[5]']);
  });

  it('refuses a box past the twelfth column, an upper-case query id and an SVG image', () => {
    const s = escalations();
    s.pages[0]!.components[0]!.box = { x: 10, y: 0, w: 3, h: 1 };
    expect(codes(s)).toEqual(['schema@$.pages[0].components[0].box.w']);
    const q = escalations();
    q.queries[0]!.id = 'Regions';
    expect(codes(q)).toContain('schema@$.queries[0].id');
    const img = escalations();
    (img.pages[0]!.components[8] as { src: string }).src = 'data:image/svg+xml;base64,PHN2Zz4=';
    expect(codes(img)).toEqual(['schema@$.pages[0].components[8].src']);
  });

  it('takes an image of exactly 256 KB and refuses one byte more, measured decoded', () => {
    const at = (bytes: number): string[] => {
      const s = escalations();
      (s.pages[0]!.components[8] as { src: string }).src = `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;
      return codes(s);
    };
    expect(at(262_144)).toEqual([]);
    // 262,145 and 262,146 bytes encode to the same number of quartets as 262,144 (codex r1).
    expect(at(262_145)).toEqual(['schema@$.pages[0].components[8].src']);
    expect(at(262_146)).toEqual(['schema@$.pages[0].components[8].src']);
  });

  it('measures a mutation in UTF-8 bytes, not string length', () => {
    const s = escalations();
    (s.actions[1] as { call: unknown }).call = { kind: 'mutation', mutation: `mutation { a(x: "${'é'.repeat(9000)}") }` };
    expect(codes(s)).toEqual(['schema@$.actions[1].call.mutation']);
  });

  it('refuses a value or a call holding two variants at once', () => {
    const v = escalations() as unknown as { actions: { args: Record<string, unknown>; call: unknown }[] };
    v.actions[1]!.args['order'] = { kind: 'param', name: 'order', value: 'x' };
    expect(codes(v)).toEqual(['schema@$.actions[1].args.order']);
    const c = escalations() as unknown as { actions: { call: unknown }[] };
    c.actions[1]!.call = { kind: 'tool', tool: 'createRefund', mutation: 'mutation { x }' };
    expect(codes(c)).toEqual(['schema@$.actions[1].call']);
  });

  it('refuses an oversized list before the schema walks it, and a __proto__ key it would drop', () => {
    const big = { ...escalations(), queries: Array.from({ length: 300_000 }, () => ({})) };
    expect(codes(big)).toEqual(['too_complex@$.queries']);
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 40; i++) cur = (cur['a'] = {}) as Record<string, unknown>;
    expect(codes({ ...escalations(), theme: deep })[0]).toMatch(/^too_complex@/);
    // JSON.parse makes __proto__ an OWN key; a parsed zod record silently drops it.
    const proto = JSON.parse(
      JSON.stringify(escalations()).replace('"properties":{"ticket"', '"properties":{"__proto__":{"type":"string"},"ticket"'),
    ) as unknown;
    expect(codes(proto)).toEqual(['bad_key@$.actions[0].params.properties.__proto__']);
    // …anywhere, inside a list too; and an object with too many keys is refused like a long list.
    const inList = JSON.parse(JSON.stringify(escalations()).replace('"linkHosts":[', '"linkHosts":[{"__proto__":1},')) as unknown;
    expect(codes(inList)).toEqual(['bad_key@$.linkHosts[0].__proto__']);
    const wide = { ...escalations(), theme: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 1])) };
    expect(codes(wide)).toEqual(['too_complex@$.theme']);
    // Each list is held to the schema's own limit before zod parses its items (codex r3).
    const comps = escalations() as unknown as { pages: { components: unknown[] }[] };
    comps.pages[0]!.components = Array.from({ length: 101 }, () => ({}));
    expect(codes(comps)).toEqual(['too_complex@$.pages[0].components']);
    const outputs = escalations() as unknown as { queries: { output: unknown[] }[] };
    outputs.queries[0]!.output = Array.from({ length: 201 }, () => ({}));
    expect(codes(outputs)).toEqual(['too_complex@$.queries[0].output']);
    // …nested lists too: one table with 400,000 malformed columns never reaches zod (pi r5).
    const cols = escalations() as unknown as { pages: { components: { columns?: unknown[] }[] }[] };
    cols.pages[0]!.components[4]!.columns = Array.from({ length: 400_000 }, () => ({}));
    expect(codes(cols)).toEqual(['too_complex@$.pages[0].components[4].columns']);
  });

  it('refuses a binding that is not filter/form/row/url, and a regular-expression parameter', () => {
    const s = escalations() as unknown as { pages: { components: { data?: { params?: Record<string, string> } }[] }[] };
    s.pages[0]!.components[2]!.data!.params!['region'] = 'viewer.email';
    expect(codes(s)).toEqual(['schema@$.pages[0].components[2].data.params.region']);
    const p = escalations() as unknown as { queries: { params?: { properties: Record<string, Record<string, unknown>> } }[] };
    p.queries[1]!.params!.properties['region']!['pattern'] = '(a+)+$';
    expect(codes(p)).toEqual(['schema@$.queries[1].params.properties.region']);
  });

  it('reads bytes: refuses what is not JSON and what is over the size limit', () => {
    expect(readSpec('{').findings.map((f) => f.code)).toEqual(['not_json']);
    expect(readSpec(Buffer.alloc(APP_SPEC_MAX_BYTES + 1, 32)).findings.map((f) => f.code)).toEqual(['too_large']);
    expect(readSpec(JSON.stringify(escalations())).spec?.name).toBe('Escalations');
  });
});

describe('apps.json: the consistency check', () => {
  it('refuses an id used twice across pages and components', () => {
    const s = escalations();
    s.pages[1]!.components[1]!.id = 'kpi-open';
    expect(codes(s)).toEqual(['duplicate_id@$.pages[1].components[1].id']);
  });

  it('refuses bindings to a query, action, page, filter or column that does not exist', () => {
    const s = escalations();
    (s.pages[0]!.components[3] as { data: { query: string } }).data.query = 'nope';
    (s.pages[1]!.components[1] as { action: { action: string } }).action.action = 'nope';
    (s.pages[0]!.components[7] as { to: { page: string } }).to.page = 'nowhere';
    (s.pages[0]!.components[4] as { columns: { column: string }[] }).columns[1]!.column = 'regoin';
    expect(codes(s).sort()).toEqual(
      [
        'unknown_query@$.pages[0].components[3].data.query',
        'unknown_action@$.pages[1].components[1].action.action',
        'unknown_page@$.pages[0].components[7].to.page',
        'unknown_column@$.pages[0].components[4].columns[1].column',
      ].sort(),
    );
  });

  it('refuses a component binding a viewer-bound parameter (the server fills it; a client value is refused)', () => {
    const s = escalations();
    (s.pages[0]!.components[2] as { data: { params: Record<string, string> } }).data.params['me'] = 'filter.region';
    expect(codes(s)).toEqual(['viewer_bound@$.pages[0].components[2].data.params.me']);
  });

  it('allows row.<column> only on a table row action and form.<field> only on its own form', () => {
    const s = escalations();
    (s.pages[0]!.components[2] as { data: { params: Record<string, string> } }).data.params['region'] = 'row.region';
    (s.pages[1]!.components[0] as { submit: { params: Record<string, string> } }).submit.params['reason'] = 'form.nope';
    (s.pages[0]!.components[4] as { rowActions: { params: Record<string, string> }[] }).rowActions[0]!.params['ticket'] = 'row.nope';
    expect(codes(s).sort()).toEqual(
      [
        'bad_binding@$.pages[0].components[2].data.params.region',
        'unknown_field@$.pages[1].components[0].submit.params.reason',
        'unknown_column@$.pages[0].components[4].rowActions[0].params.ticket',
      ].sort(),
    );
  });

  it('binds a filter only on its own page, and a date range only through .from or .to', () => {
    const s = escalations();
    (s.pages[1]!.components[1] as { action: { params: Record<string, string> } }).action.params['order'] = 'filter.region';
    (s.pages[0]!.components[3] as { data: { params: Record<string, string> } }).data.params['since'] = 'filter.period';
    expect(codes(s).sort()).toEqual(
      ['unknown_filter@$.pages[1].components[1].action.params.order', 'bad_binding@$.pages[0].components[3].data.params.since'].sort(),
    );
  });

  it('lets a link leave only over https to a listed host, with no credentials or port', () => {
    for (const [href, code] of [
      ['https://evil.example.net/x', 'unlisted_host'],
      ['http://support.example.com/', 'bad_link'],
      ['javascript:alert(1)', 'bad_link'],
      ['https://user:pw@support.example.com/', 'bad_link'],
      ['https://support.example.com:8443/', 'bad_link'],
    ] as const) {
      const s = escalations();
      (s.pages[0]!.components[6] as { to: { href: string } }).to.href = href;
      expect(codes(s), href).toEqual([`${code}@$.pages[0].components[6].to.href`]);
    }
  });

  it('checks a pie, the action declarations and the parameters', () => {
    const s = escalations();
    const chart = s.pages[0]!.components[3] as { chart: string; series: { column: string }[] };
    chart.chart = 'pie';
    chart.series.push({ column: 'breaches' });
    const write = s.actions[0] as { set: Record<string, unknown> };
    write.set['id'] = { kind: 'param', name: 'ticket' };
    (s.actions[1] as { args: Record<string, unknown> }).args['who'] = { kind: 'param', name: 'undeclared' };
    s.queries[1]!.params!.required = ['since', 'until'];
    expect(codes(s).sort()).toEqual(
      [
        'bad_chart@$.pages[0].components[3].series',
        'bad_row_write@$.actions[0].set.id',
        'unknown_param@$.actions[1].args.who',
        'unknown_param@$.queries[1].params.required',
      ].sort(),
    );
  });

  it('treats constructor and toString as names, never as inherited declarations (codex r1, pi r1)', () => {
    const s = escalations();
    (s.pages[0]!.components[2] as { data: { params: Record<string, string> } }).data.params['toString'] = 'filter.region';
    s.queries[1]!.params!.required = ['since', 'constructor'];
    expect(codes(s).sort()).toEqual(['unknown_param@$.pages[0].components[2].data.params.toString', 'unknown_param@$.queries[1].params.required'].sort());
    // …and a real column named constructor is just a column: an update may set it.
    const w = escalations();
    (w.actions[0] as { set: Record<string, unknown> }).set['constructor'] = { kind: 'literal', value: 'x' };
    expect(codes(w)).toEqual([]);
  });

  it('refuses a required parameter that no binding, default or viewer claim fills', () => {
    const s = escalations();
    delete (s.pages[0]!.components[2] as { data: { params?: Record<string, string> } }).data.params!['since'];
    (s.pages[0]!.components[4] as { rowActions: { params?: Record<string, string> }[] }).rowActions[0]!.params = {};
    expect(codes(s).sort()).toEqual(['unbound_param@$.pages[0].components[2].data.params', 'unbound_param@$.pages[0].components[4].rowActions[0].params'].sort());
    // A default fills it.
    const d = escalations();
    delete (d.pages[0]!.components[2] as { data: { params?: Record<string, string> } }).data.params!['since'];
    d.queries[1]!.params!.properties['since']!.default = '2026-01-01';
    expect(codes(d)).toEqual([]);
  });

  it('holds each default and enum value to the whole declaration, one rule at a time (codex r2)', () => {
    const one = (decl: Record<string, unknown>): string[] => {
      const s = escalations();
      s.queries[0]!.params = { type: 'object', properties: { p: decl as never } };
      return codes(s);
    };
    const at = '$.queries[0].params.properties.p';
    expect(one({ type: 'number', default: 'wrong' })).toEqual([`bad_param@${at}.default`]);
    expect(one({ type: 'integer', default: 1.5 })).toEqual([`bad_param@${at}.default`]);
    expect(one({ type: 'integer', minimum: 10, enum: [1, 12] })).toEqual([`bad_param@${at}.enum[0]`]);
    expect(one({ type: 'string', maxLength: 3, enum: ['abcd'] })).toEqual([`bad_param@${at}.enum[0]`]);
    expect(one({ type: 'string', format: 'uuid', default: 'not-a-uuid' })).toEqual([`bad_param@${at}.default`]);
    // A date is a real calendar date; a date-time is RFC 3339 with seconds.
    for (const bad of ['2026-99-99', '2026-02-30', '2025-02-29']) expect(one({ type: 'string', format: 'date', default: bad }), bad).toEqual([`bad_param@${at}.default`]);
    expect(one({ type: 'string', format: 'date', default: '2024-02-29' })).toEqual([]);
    for (const bad of ['2026-99-99T99:99Z', '2026-01-01T10:00Z', '2026-01-01T24:00:00Z', '2026-01-01T10:00:00+25:00']) {
      expect(one({ type: 'string', format: 'date-time', default: bad }), bad).toEqual([`bad_param@${at}.default`]);
    }
    expect(one({ type: 'string', format: 'date-time', default: '2026-11-03T08:05:00.123+01:00' })).toEqual([]);
    // codex r3: no leap second, any fraction length, and the years 0001-0099 are years too.
    expect(one({ type: 'string', format: 'date-time', default: '2026-11-03T08:05:60Z' })).toEqual([`bad_param@${at}.default`]);
    expect(one({ type: 'string', format: 'date-time', default: '2026-11-03T08:05:00.1234567890Z' })).toEqual([]);
    expect(one({ type: 'string', format: 'date', default: '0099-01-01' })).toEqual([]);
    expect(one({ type: 'string', format: 'date', default: '0000-01-01' })).toEqual([`bad_param@${at}.default`]);
    // Lengths are code points: one emoji is one character.
    expect(one({ type: 'string', minLength: 2, default: '😀' })).toEqual([`bad_param@${at}.default`]);
    expect(one({ type: 'string', maxLength: 1, default: '😀' })).toEqual([]);
    // Bounds in order, and constraints on their own type only.
    expect(one({ type: 'integer', minimum: 10, maximum: 1 })).toEqual([`bad_param@${at}`]);
    expect(one({ type: 'string', minLength: 5, maxLength: 2 })).toEqual([`bad_param@${at}`]);
    expect(one({ type: 'number', format: 'date' })).toEqual([`bad_param@${at}`]);
    expect(one({ type: 'string', minimum: 1 })).toEqual([`bad_param@${at}`]);
    // An array takes neither enum nor default (JSON Schema would read them as whole-array values).
    expect(one({ type: 'array', items: { type: 'integer' }, enum: [1, 2] })).toEqual([`bad_param@${at}.enum`]);
    expect(one({ type: 'array', items: { type: 'string' }, default: 'x' })).toEqual([`bad_param@${at}.default`]);
  });

  it('types viewer claims, keeps a default inside its enum, and gives SQL no row path (pi r3)', () => {
    const one = (decl: Record<string, unknown>): string[] => {
      const s = escalations();
      s.queries[0]!.params = { type: 'object', properties: { p: decl as never } };
      return codes(s);
    };
    const at = '$.queries[0].params.properties.p';
    expect(one({ type: 'string', from: 'viewer.groups' })).toEqual([`bad_param@${at}`]);
    expect(one({ type: 'array', items: { type: 'string' }, from: 'viewer.groups' })).toEqual([]);
    expect(one({ type: 'integer', from: 'viewer.email' })).toEqual([`bad_param@${at}`]);
    expect(one({ type: 'string', from: 'viewer.email', default: 'x@example.com' })).toEqual([`bad_param@${at}`]);
    expect(one({ type: 'string', enum: ['a', 'b'], default: 'c' })).toEqual([`bad_param@${at}.default`]);
    const sql = escalations();
    sql.queries[0]!.rowPath = '$.rows[*]';
    expect(codes(sql)).toEqual(['bad_path@$.queries[0]']);
  });

  it('lists a required parameter once', () => {
    const s = escalations();
    s.queries[1]!.params!.required = ['since', 'since'];
    expect(codes(s)).toEqual(['bad_param@$.queries[1].params.required']);
  });

  it('takes a row write key only from required parameters, and an insert sets its key from them (codex r2)', () => {
    const optional = escalations();
    (optional.actions[0] as { params: { required?: string[] } }).params.required = [];
    expect(codes(optional)).toEqual(['bad_row_write@$.actions[0].key.id']);
    const insert = escalations();
    const w = insert.actions[0] as { op: string; set: Record<string, unknown> };
    w.op = 'insert';
    w.set['id'] = { kind: 'literal', value: 7 };
    expect(codes(insert)).toEqual(['bad_row_write@$.actions[0].set.id']);
    w.set['id'] = { kind: 'param', name: 'ticket' };
    expect(codes(insert)).toEqual([]);
    delete w.set['id'];
    expect(codes(insert)).toEqual(['bad_row_write@$.actions[0].set.id']);
  });

  it('formats a currency only with its code', () => {
    const s = escalations();
    (s.pages[0]!.components[2] as { format: unknown }).format = { kind: 'currency' };
    expect(codes(s)[0]).toMatch(/^schema@\$\.pages\[0\]\.components\[2\]\.format/);
    (s.pages[0]!.components[2] as { format: unknown }).format = { kind: 'currency', currency: 'EUR', decimals: 2 };
    expect(codes(s)).toEqual([]);
    (s.pages[0]!.components[2] as { format: unknown }).format = { kind: 'number', currency: 'EUR' };
    expect(codes(s)[0]).toMatch(/^schema@/);
  });

  it('stops parsing a malformed document once it has 50 findings (codex r4)', () => {
    // 20 pages x 100 tables x 200 malformed columns: inside every list limit, 1.26 MB.
    const comp = `{"type":"table","columns":[${Array(200).fill('{}').join(',')}]}`;
    const page = `{"id":"p","title":"t","components":[${Array(100).fill(comp).join(',')}]}`;
    const doc = `{"schema":"wicked.apps/v1","name":"x","queries":[],"actions":[],"linkHosts":[],"pages":[${Array(20).fill(page).join(',')}]}`;
    const r = readSpec(doc);
    expect(r.findings).toHaveLength(50);
    // The first component alone yields 50 findings; nothing after it is parsed.
    expect(parseWork.elements).toBe(1);
    expect(parseWork.whole).toBe(false);
    // A valid document is parsed piece by piece, then by the whole schema.
    const ok = escalations();
    expect(parseSpec(ok).findings).toEqual([]);
    expect(parseWork.elements).toBe(ok.pages.reduce((n, p) => n + p.components.length, 0) + ok.queries.length + ok.actions.length);
    expect(parseWork.whole).toBe(true);
  });

  it('counts each parse afresh, a structurally refused one included (codex r6)', () => {
    expect(parseSpec(escalations()).findings).toEqual([]);
    expect(parseWork.whole).toBe(true);
    const wide = escalations();
    (wide.actions[1] as { args: Record<string, unknown> }).args = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, { kind: 'literal', value: 1 }]));
    expect(parseSpec(wide).findings[0]?.code).toBe('too_complex');
    expect(parseWork).toEqual({ elements: 0, whole: false });
  });

  it('answers a finding, never a throw, for a root that is not an object (codex r5)', () => {
    for (const raw of ['null', '[]', '1', '"x"', 'true']) {
      expect(readSpec(raw).findings.map((f) => f.code), raw).toEqual(['schema']);
    }
  });

  it('holds each record to its own key limit before zod parses its values (codex r5)', () => {
    const props = escalations();
    props.queries[1]!.params!.properties = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, { type: 'string' as const }]));
    expect(codes(props)).toEqual(['too_complex@$.queries[1].params.properties']);
    const set = escalations();
    (set.actions[0] as { set: Record<string, unknown> }).set = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`c${i}`, { kind: 'literal', value: 1 }]));
    expect(codes(set)).toEqual(['too_complex@$.actions[0].set']);
    const binds = escalations();
    (binds.pages[0]!.components[2] as { data: { params: Record<string, string> } }).data.params = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, 'filter.region']));
    expect(codes(binds)).toEqual(['too_complex@$.pages[0].components[2].data.params']);
  });

  it('accepts the largest legal shapes inside 2 MB (codex r2: 3 pages of 90 tables of 200 columns)', () => {
    const s = escalations();
    const cols = Array.from({ length: 200 }, (_, i) => ({ name: `c${i}`, type: 'string' as const }));
    s.queries.push({ id: 'wide', source: 'support-pg', kind: 'sql', output: cols });
    s.pages = Array.from({ length: 3 }, (_, p) => ({
      id: `p${p}`,
      title: `P${p}`,
      components: Array.from({ length: 90 }, (_, t) => ({
        id: `t${p}-${t}`,
        type: 'table' as const,
        box: { x: 0, y: t, w: 12, h: 1 },
        data: { query: 'wide' },
        columns: cols.map((c) => ({ column: c.name })),
      })),
    }));
    const bytes = JSON.stringify(s);
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    expect(readSpec(bytes).findings).toEqual([]);
  });

  it('keeps refresh on events and the crew kind to the built-in crew source', () => {
    const s = escalations();
    s.queries[0]!.refresh = { mode: 'events' };
    s.queries[4]!.source = 'support-pg';
    // queries[4] now refreshes on events from a non-crew source too.
    expect(codes(s).sort()).toEqual(['bad_refresh@$.queries[0].refresh', 'bad_refresh@$.queries[4].refresh', 'bad_source@$.queries[4].source'].sort());
  });
});
