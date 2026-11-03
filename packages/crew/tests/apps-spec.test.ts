// DES-APPS-001 §4 (K2a): `apps.json`, the schema and the consistency check crew runs on every tree.
import { describe, expect, it } from 'vitest';

import { APP_SPEC_MAX_BYTES, checkSpec, parseSpec, readSpec } from '../src/apps/spec.js';
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

  it('holds defaults, enum values and bounds to their declaration', () => {
    const s = escalations();
    const props = s.queries[1]!.params!.properties;
    props['region'] = { type: 'number', default: 'wrong' as unknown as number };
    props['n'] = { type: 'integer', minimum: 10, maximum: 1, enum: [1.5] };
    props['since'] = { type: 'string', format: 'date', default: 'yesterday', minLength: 5, maxLength: 2 };
    props['tags'] = { type: 'array', items: { type: 'string' }, default: 'x' };
    expect(codes(s).sort()).toEqual(
      [
        'bad_param@$.queries[1].params.properties.region.default',
        'bad_param@$.queries[1].params.properties.n',
        'bad_param@$.queries[1].params.properties.n.enum[0]',
        'bad_param@$.queries[1].params.properties.since',
        'bad_param@$.queries[1].params.properties.since.default',
        'bad_param@$.queries[1].params.properties.tags.default',
      ].sort(),
    );
  });

  it('keeps refresh on events and the crew kind to the built-in crew source', () => {
    const s = escalations();
    s.queries[0]!.refresh = { mode: 'events' };
    s.queries[4]!.source = 'support-pg';
    // queries[4] now refreshes on events from a non-crew source too.
    expect(codes(s).sort()).toEqual(['bad_refresh@$.queries[0].refresh', 'bad_refresh@$.queries[4].refresh', 'bad_source@$.queries[4].source'].sort());
  });
});
