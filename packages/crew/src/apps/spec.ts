/**
 * `apps.json`, the app spec (DES-APPS-001 §4, rev 11): the runtime schema crew checks every tree
 * against, mirroring the wire contract's `AppSpec` (`wicked-crew-api-types`; the drift guard in
 * `tests/wire-contract.test.ts` holds the two equal in both directions).
 *
 * Two layers, both pure:
 *  - {@link AppSpecSchema}: the shape and every per-field limit, strict at every level, so a key crew
 *    does not know is refused rather than dropped (an agent writes this file: what crew cannot read, it
 *    does not accept).
 *  - {@link checkSpec}: what a shape cannot say. Ids are unique; every binding names a query, action,
 *    filter, form field, row column or page that exists; a viewer-bound parameter is never bound by a
 *    component; a link leaves only for a listed host over https; a pie has one series.
 *
 * Both answer findings (`AppCheckFinding`, stage `spec`) with a JSON path into the document, so the
 * staged check, the builder and `apps_check` all name the same place.
 */

import { z } from 'zod';

import type { AppBindingRef, AppCheckFinding, AppParamSchema, AppParamsSchema, AppSpec, AppValue } from '../core/types.js';
import { MCP_SERVER_NAME_RE } from '../mcp/classify.js';

/** Page and component ids: unique across the app. */
export const APP_ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Query and action ids. A query id is a file name (`queries/<id>.sql`), so lower case only. */
export const APP_NAMED_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Output column and SQL identifier names. */
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}\.[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const TOOL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** A JSONPath subset: `$`, then `.name`, `[*]` or `[n]` steps. */
const JSON_PATH_RE = /^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[[0-9]{1,6}\])*$/;
/** `filter.<id>` (`.from`/`.to` on a date range), `form.<field>`, `row.<column>`, `url.<name>`. */
const BINDING_RE =
  /^(filter\.[A-Za-z][A-Za-z0-9_-]{0,63}(\.(from|to))?|form\.[a-z][a-z0-9_]{0,63}|row\.[A-Za-z_][A-Za-z0-9_-]{0,127}|url\.[A-Za-z_][A-Za-z0-9_]{0,63})$/;
/** 256 KB decoded: the base64 payload of at most 262,144 bytes. */
const IMAGE_MAX_BYTES = 262_144;
const IMAGE_MAX_BASE64 = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;

/** The decoded size of a whole base64 payload (`null` when it is not whole quartets). */
function base64Bytes(payload: string): number | null {
  if (payload.length % 4 !== 0) return null;
  const pad = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length / 4) * 3 - pad;
}
const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const id = z.string().regex(APP_ELEMENT_ID_RE, 'an id is 1-64 of A-Z a-z 0-9 _ -, starting with a letter');
const namedId = z.string().regex(APP_NAMED_ID_RE, 'a query or action id is 1-64 of a-z 0-9 _, starting with a letter');
const sourceName = z.string().regex(MCP_SERVER_NAME_RE, 'a source name is 1-63 of a-z 0-9 _ -, starting with a letter or digit');
const column = z.string().regex(COLUMN_RE, 'a column is 1-128 of A-Z a-z 0-9 _ -, starting with a letter or _');
const color = z.string().regex(COLOR_RE, 'a colour is #rrggbb');
const text = (max: number) => z.string().min(1).max(max);
const binding = z.custom<AppBindingRef>((v) => typeof v === 'string' && BINDING_RE.test(v), {
    error: 'a binding is filter.<id>, form.<field>, row.<column> or url.<name>'
});
const bindings = z.record(z.string().regex(PARAM_RE), binding).refine((r) => Object.keys(r).length <= 30, 'at most 30 bindings');

const BoxSchema = z.strictObject({
    x: z.int().min(0).max(11),
    y: z.int().min(0).max(999),
    w: z.int().min(1).max(12),
    h: z.int().min(1).max(50),
  })
  .refine((b) => b.x + b.w <= 12, { path: ['w'],
      error: 'x + w must be at most 12'
});

const ThemeSchema = z.strictObject({
    mode: z.enum(['light', 'dark', 'auto']).optional(),
    accent: color.optional(),
    palette: z.array(color).max(12).optional(),
    density: z.enum(['comfortable', 'compact']).optional(),
  });

const FormatSchema = z.union([
  z.strictObject({
          kind: z.literal('currency'),
          currency: z.string().regex(/^[A-Z]{3}$/, 'a currency is an ISO 4217 code'),
          decimals: z.int().min(0).max(10).optional(),
        }),
  z.strictObject({
          kind: z.enum(['text', 'number', 'percent', 'date', 'datetime', 'duration']),
          decimals: z.int().min(0).max(10).optional(),
        }),
]);

const QueryBindingSchema = z.strictObject({ query: namedId, params: bindings.optional() });
const ActionBindingSchema = z.strictObject({ label: text(60), action: namedId, params: bindings.optional() });
const OptionSchema = z.strictObject({ value: z.string().max(200), label: z.string().max(200).optional() });

const base = {
  id,
  box: BoxSchema,
  title: z.string().max(120).optional(),
  hideOnPhone: z.boolean().optional(),
};

const TableSchema = z.strictObject({
    ...base,
    type: z.literal('table'),
    data: QueryBindingSchema,
    columns: z
      .array(z.strictObject({ column, label: z.string().max(120).optional(), format: FormatSchema.optional() }))
      .min(1)
      .max(200)
      .optional(),
    rowActions: z.array(ActionBindingSchema).max(4).optional(),
    pageSize: z.int().min(5).max(500).optional(),
  });

const ChartSchema = z.strictObject({
    ...base,
    type: z.literal('chart'),
    chart: z.enum(['line', 'bar', 'area', 'pie']),
    data: QueryBindingSchema,
    x: column,
    series: z.array(z.strictObject({ column, label: z.string().max(120).optional(), color: color.optional() })).min(1).max(12),
    stacked: z.boolean().optional(),
  });

const KpiSchema = z.strictObject({
    ...base,
    type: z.literal('kpi'),
    data: QueryBindingSchema,
    value: column,
    format: FormatSchema.optional(),
    delta: column.optional(),
    caption: z.string().max(120).optional(),
  });

const TextSchema = z.strictObject({ ...base, type: z.literal('text'), text: text(4000), style: z.enum(['heading', 'body', 'caption']).optional() });

const FilterSchema = z.strictObject({
    ...base,
    type: z.literal('filter'),
    filter: z.enum(['select', 'date-range', 'search']),
    label: z.string().max(120).optional(),
    options: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('query'), query: QueryBindingSchema, value: column, label: column.optional() }),
        z.strictObject({ kind: z.literal('values'), values: z.array(OptionSchema).min(1).max(200) }),
      ])
      .optional(),
    default: z.union([z.string().max(200), z.strictObject({ lastDays: z.int().min(1).max(3660) })]).optional(),
  });

const FormSchema = z.strictObject({
    ...base,
    type: z.literal('form'),
    fields: z
      .array(
        z.strictObject({
                      name: z.string().regex(FIELD_RE, 'a field name is 1-64 of a-z 0-9 _, starting with a letter'),
                      label: z.string().max(120).optional(),
                      input: z.enum(['text', 'textarea', 'number', 'date', 'checkbox', 'select']),
                      required: z.boolean().optional(),
                      options: z.array(OptionSchema).min(1).max(200).optional(),
                    }),
      )
      .min(1)
      .max(30),
    submit: ActionBindingSchema,
  });

const ButtonSchema = z.strictObject({ ...base, type: z.literal('button'), action: ActionBindingSchema });

const ImageSchema = z.strictObject({
    ...base,
    type: z.literal('image'),
    src: z
      .string()
      .max(IMAGE_MAX_BASE64 + 32)
      .regex(IMAGE_RE, 'an image is a data:image/(png|jpeg|gif|webp);base64 URI')
      .refine((s) => {
        const n = base64Bytes(s.slice(s.indexOf(',') + 1));
        return n !== null && n <= IMAGE_MAX_BYTES;
      }, 'an image is whole base64 of at most 256 KB'),
    alt: z.string().max(300),
  });

const LinkSchema = z.strictObject({
    ...base,
    type: z.literal('link'),
    label: text(120),
    to: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('page'), page: id, params: bindings.optional() }),
      z.strictObject({ kind: z.literal('href'), href: z.string().max(2048) }),
    ]),
  });

const ComponentSchema = z.discriminatedUnion('type', [
  TableSchema,
  ChartSchema,
  KpiSchema,
  TextSchema,
  FilterSchema,
  FormSchema,
  ButtonSchema,
  ImageSchema,
  LinkSchema,
]);

const PageSchema = z.strictObject({ id, title: text(80), components: z.array(ComponentSchema).max(100) });

const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean()]);

const ParamSchema = z.strictObject({
    type: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
    items: z.strictObject({ type: z.enum(['string', 'number', 'integer']) }).optional(),
    format: z.enum(['date', 'date-time', 'uuid', 'email']).optional(),
    enum: z.array(z.union([z.string().max(200), z.number().finite()])).min(1).max(200).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    minLength: z.int().min(0).max(100_000).optional(),
    maxLength: z.int().min(0).max(100_000).optional(),
    default: scalar.optional(),
    description: z.string().max(500).optional(),
    from: z.enum(['viewer.email', 'viewer.name', 'viewer.id', 'viewer.groups']).optional(),
  });

const ParamsSchema = z.strictObject({
    type: z.literal('object'),
    properties: z.record(z.string().regex(PARAM_RE, 'a parameter name is 1-64 of A-Z a-z 0-9 _'), ParamSchema),
    required: z.array(z.string()).max(30).optional(),
  })
  .refine((p) => Object.keys(p.properties).length <= 30, 'at most 30 parameters');

const RefreshSchema = z.union([
  z.strictObject({ mode: z.literal('load') }),
  z.strictObject({ mode: z.literal('every'), seconds: z.int().min(15).max(86_400) }),
  z.strictObject({ mode: z.literal('events') }),
]);

const QuerySchema = z.strictObject({
    id: namedId,
    source: sourceName,
    kind: z.enum(['sql', 'graphql', 'rest', 'mcp', 'crew']),
    description: z.string().max(500).optional(),
    params: ParamsSchema.optional(),
    output: z.array(z.strictObject({ name: column, type: z.enum(['string', 'number', 'integer', 'boolean', 'date', 'datetime']), nullable: z.boolean().optional() })).min(1).max(200),
    rowPath: z.string().max(256).regex(JSON_PATH_RE, 'a row path is $ then .name, [*] or [n] steps').optional(),
    morePath: z.string().max(256).regex(JSON_PATH_RE, 'a more path is $ then .name, [*] or [n] steps').optional(),
    refresh: RefreshSchema.optional(),
    public: z.boolean().optional(),
  });

const ParamValueSchema = z.strictObject({ kind: z.literal('param'), name: z.string().regex(PARAM_RE) });
const ValueSchema = z.discriminatedUnion('kind', [
  ParamValueSchema,
  z.strictObject({ kind: z.literal('literal'), value: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]) }),
  z.strictObject({ kind: z.literal('viewer'), claim: z.enum(['email', 'name', 'id']) }),
  z.strictObject({ kind: z.literal('crew'), value: z.enum(['now', 'uuid']) }),
]);

const ApiActionSchema = z.strictObject({
    id: namedId,
    kind: z.literal('api'),
    source: sourceName,
    call: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('tool'), tool: z.string().regex(TOOL_RE, 'a tool name is 1-128 of A-Z a-z 0-9 _ . -') }),
      z.strictObject({
                kind: z.literal('mutation'),
                mutation: text(16_384).refine((m) => Buffer.byteLength(m, 'utf8') <= 16_384, 'a mutation is at most 16 KB of UTF-8'),
              }),
    ]),
    args: z.record(z.string().min(1).max(128), ValueSchema).refine((r) => Object.keys(r).length <= 50, 'at most 50 arguments'),
    params: ParamsSchema.optional(),
    description: z.string().max(500).optional(),
  });

const RowWriteActionSchema = z.strictObject({
    id: namedId,
    kind: z.literal('row-write'),
    source: sourceName,
    table: z.string().regex(TABLE_RE, 'a table is schema.table'),
    op: z.enum(['insert', 'update', 'delete']),
    set: z
      .record(z.string().regex(SQL_IDENT_RE, 'a column is a plain SQL identifier'), ValueSchema)
      .refine((r) => Object.keys(r).length <= 200, 'at most 200 columns')
      .optional(),
    key: z
      .record(z.string().regex(SQL_IDENT_RE, 'a key column is a plain SQL identifier'), ParamValueSchema)
      .refine((k) => Object.keys(k).length >= 1 && Object.keys(k).length <= 16, 'a key names 1-16 columns'),
    params: ParamsSchema.optional(),
    description: z.string().max(500).optional(),
  });

const ActionSchema = z.discriminatedUnion('kind', [ApiActionSchema, RowWriteActionSchema]);

/** The whole `apps.json`. */
export const AppSpecSchema = z.strictObject({
    schema: z.literal('wicked.apps/v1'),
    name: text(120),
    description: z.string().max(2000).optional(),
    theme: ThemeSchema.optional(),
    pages: z.array(PageSchema).min(1).max(20),
    queries: z.array(QuerySchema).max(100),
    actions: z.array(ActionSchema).max(50),
    linkHosts: z.array(z.string().regex(HOST_RE, 'a link host is a lower-case host name, no scheme or port')).max(50),
  });

/** The largest `apps.json` crew reads (the spec, images included). */
export const APP_SPEC_MAX_BYTES = 2 * 1024 * 1024;


/**
 * Bounds on the JSON's structure, checked BEFORE the schema sees it: zod records an over-long array and
 * still parses every element, so a 2 MB document of a million empty objects would cost a million
 * findings. Every legal spec is inside these: its longest list is 200, its deepest object 7 levels down,
 * and the node budget is above any legal spec's node count (it also bounds an edit body, which may be
 * larger than 2 MB, before the size check). Published with the contract (`AppSpec`).
 */
export const APP_SPEC_LIMITS = { depth: 16, arrayLength: 200, objectKeys: 256, nodes: 1_000_000 } as const;

/**
 * Each list's own limit, by its path with indices and record keys as `*` (codex r3): the walk refuses a
 * list longer than the schema allows before zod parses its elements, so no list can make zod expand
 * more items than a legal spec holds. A list not named here is held to {@link APP_SPEC_LIMITS.arrayLength},
 * the longest any legal list is.
 */
const LIST_LIMITS: ReadonlyMap<string, number> = new Map([
  ['pages', 20],
  ['queries', 100],
  ['actions', 50],
  ['linkHosts', 50],
  ['theme.palette', 12],
  ['pages.*.components', 100],
  ['pages.*.components.*.rowActions', 4],
  ['pages.*.components.*.series', 12],
  ['pages.*.components.*.fields', 30],
  ['queries.*.params.required', 30],
  ['actions.*.params.required', 30],
]);

/**
 * Each record's own key limit, by the same normalised path (codex r5): zod checks a record's size only
 * after parsing every value, so the walk holds it first. Every binding map on a component (`…params`) is
 * held to 30; any other object to {@link APP_SPEC_LIMITS.objectKeys}. With these and the list limits, one
 * component, query or action can yield a few thousand diagnostics at most.
 */
const RECORD_LIMITS: ReadonlyMap<string, number> = new Map([
  ['queries.*.params.properties', 30],
  ['actions.*.params.properties', 30],
  ['actions.*.args', 50],
  ['actions.*.set', 200],
  ['actions.*.key', 16],
]);
const BINDING_MAP_PATH = /^pages\.\*\.components\.\*\.(.+\.)?params$/;

/** A walk path with list indices and parameter names as `*`. */
const normalise = (path: ReadonlyArray<string | number>): string =>
  path.map((p) => (typeof p === 'number' ? '*' : p)).join('.').replace(/\.properties\.[^.]+/g, '.properties.*');

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);

function pathOf(path: ReadonlyArray<string | number>): string {
  let out = '$';
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`;
  return out;
}

function finding(code: string, path: ReadonlyArray<string | number>, message: string): AppCheckFinding {
  return { stage: 'spec', code, path: pathOf(path), message };
}

/**
 * The structure walk: depth, list length, key count and node count within {@link APP_SPEC_LIMITS}, and no
 * `__proto__` key (JSON makes it an own key, but a parsed record drops it, so crew would check a document
 * other than the one it was given). Iterative: depth is what it bounds.
 */
export function structureFinding(value: unknown): AppCheckFinding | null {
  const stack: Array<{ v: unknown; path: (string | number)[] }> = [{ v: value, path: [] }];
  let nodes = 0;
  while (stack.length > 0) {
    const { v, path } = stack.pop()!;
    if (++nodes > APP_SPEC_LIMITS.nodes) return finding('too_complex', [], `apps.json holds more than ${APP_SPEC_LIMITS.nodes} values`);
    if (v === null || typeof v !== 'object') continue;
    if (path.length >= APP_SPEC_LIMITS.depth) return finding('too_complex', path, `apps.json nests deeper than ${APP_SPEC_LIMITS.depth}`);
    if (Array.isArray(v)) {
      const limit = LIST_LIMITS.get(normalise(path)) ?? APP_SPEC_LIMITS.arrayLength;
      if (v.length > limit) return finding('too_complex', path, `a list here holds at most ${limit} items`);
      v.forEach((x, i) => stack.push({ v: x, path: [...path, i] }));
      continue;
    }
    const keys = Object.keys(v);
    const norm = normalise(path);
    const keyLimit = RECORD_LIMITS.get(norm) ?? (BINDING_MAP_PATH.test(norm) ? 30 : APP_SPEC_LIMITS.objectKeys);
    if (keys.length > keyLimit) return finding('too_complex', path, `an object here holds at most ${keyLimit} keys`);
    for (const k of keys) {
      if (k === '__proto__') return finding('bad_key', [...path, k], '__proto__ is not a key apps.json may use');
      stack.push({ v: (v as Record<string, unknown>)[k], path: [...path, k] });
    }
  }
  return null;
}

/** The most findings a check answers; the element-wise pass stops once it has this many. */
const MAX_FINDINGS = 50;

/**
 * The document with its three big lists (components, queries, actions) unparsed: cheap, and what the
 * element-wise pass walks.
 */
const SkeletonSchema = AppSpecSchema.extend({
  pages: z.array(PageSchema.extend({ components: z.array(z.unknown()).max(100) })).min(1).max(20),
  queries: z.array(z.unknown()).max(100),
  actions: z.array(z.unknown()).max(50),
});

/** (tests) What the last {@link parseSpec} parsed: big-list elements, and whether the whole schema ran. */
export const parseWork = { elements: 0, whole: false };

/**
 * Schema findings with a budget (codex r4): the skeleton first, then each component, query and action on
 * its own, stopping once {@link MAX_FINDINGS} findings are in hand, so a malformed document costs at most
 * the elements up to that point, never zod's diagnostics for every element of every list.
 */
function budgetedFindings(value: unknown): AppCheckFinding[] {
  const out: AppCheckFinding[] = [];
  const add = (issues: z.ZodIssue[], prefix: (string | number)[]): void => {
    for (const i of issues) {
      if (out.length >= MAX_FINDINGS) return;
      out.push(finding('schema', [...prefix, ...i.path], i.message));
    }
  };
  const skeleton = SkeletonSchema.safeParse(value);
  if (!skeleton.success) add(skeleton.error.issues, []);
  // A root that is not an object (null, a list, a scalar) has no pieces to walk (codex r5).
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  const doc = value as { pages?: unknown; queries?: unknown; actions?: unknown };
  const lists: Array<[unknown, z.ZodType, (i: number, p?: number) => (string | number)[]]> = [];
  if (Array.isArray(doc.pages)) {
    doc.pages.forEach((page, pi) => {
      const comps = (page as { components?: unknown } | null)?.components;
      if (Array.isArray(comps)) lists.push([comps, ComponentSchema, (i) => ['pages', pi, 'components', i]]);
    });
  }
  if (Array.isArray(doc.queries)) lists.push([doc.queries, QuerySchema, (i) => ['queries', i]]);
  if (Array.isArray(doc.actions)) lists.push([doc.actions, ActionSchema, (i) => ['actions', i]]);
  for (const [items, schema, at] of lists) {
    for (const [i, item] of (items as unknown[]).entries()) {
      if (out.length >= MAX_FINDINGS) return out;
      parseWork.elements++;
      const r = schema.safeParse(item);
      if (!r.success) add(r.error.issues, at(i));
    }
  }
  return out;
}

/** The shape alone: the parsed spec, or the findings (at most 50). */
export function parseSpec(value: unknown): { spec: AppSpec; findings: [] } | { spec: null; findings: AppCheckFinding[] } {
  parseWork.elements = 0;
  parseWork.whole = false;
  const structure = structureFinding(value);
  if (structure !== null) return { spec: null, findings: [structure] };
  const findings = budgetedFindings(value);
  if (findings.length > 0) return { spec: null, findings };
  // Every piece passed on its own; the whole schema now types the document (and has nothing to say
  // beyond what the pieces said: a valid document costs zod no diagnostics).
  parseWork.whole = true;
  const parsed = AppSpecSchema.safeParse(value);
  if (parsed.success) return { spec: parsed.data as AppSpec, findings: [] };
  return { spec: null, findings: parsed.error.issues.slice(0, MAX_FINDINGS).map((i) => finding('schema', i.path, i.message)) };
}

/** `apps.json` bytes → the parsed spec or findings: size, JSON, then {@link parseSpec} and {@link checkSpec}. */
export function readSpec(bytes: Buffer | string): { spec: AppSpec; findings: [] } | { spec: null; findings: AppCheckFinding[] } {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  if (size > APP_SPEC_MAX_BYTES) return { spec: null, findings: [finding('too_large', [], `apps.json is ${size} bytes; the limit is ${APP_SPEC_MAX_BYTES}`)] };
  let json: unknown;
  try {
    json = JSON.parse(typeof bytes === 'string' ? bytes : bytes.toString('utf8'));
  } catch (err) {
    return { spec: null, findings: [finding('not_json', [], `apps.json is not JSON: ${err instanceof Error ? err.message : String(err)}`)] };
  }
  const parsed = parseSpec(json);
  if (parsed.spec === null) return parsed;
  const findings = checkSpec(parsed.spec);
  return findings.length === 0 ? parsed : { spec: null, findings };
}

/** A real calendar date `YYYY-MM-DD`, years 0001-9999 (proleptic Gregorian). */
function isDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

/**
 * The `date-time` crew accepts: RFC 3339 with seconds, `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`, a real
 * date, seconds 00-59 (no leap second: no source stores one), any number of fraction digits.
 */
function isDateTime(v: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(v);
  if (m === null || !isDate(m[1]!)) return false;
  const [h, mi, se] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (h > 23 || mi > 59 || se > 59) return false;
  return m[7] === undefined || (Number(m[7]) <= 23 && Number(m[8]) <= 59);
}

/** A string's length as JSON Schema counts it: Unicode code points, not UTF-16 units. */
const codePoints = (v: string): number => Array.from(v).length;

const FORMAT_OK: Record<NonNullable<AppParamSchema['format']>, (v: string) => boolean> = {
  date: isDate,
  'date-time': isDateTime,
  uuid: (v) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v),
  email: (v) => /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(v),
};

/**
 * Why `value` does not satisfy the SCALAR declaration `decl`, or `null` when it does: type (integer
 * included), enum, numeric and length bounds, format. An `array` parameter is not a scalar (its values
 * are judged item by item by whoever validates a request).
 */
export function paramValueProblem(decl: Pick<AppParamSchema, 'type' | 'format' | 'enum' | 'minimum' | 'maximum' | 'minLength' | 'maxLength'>, value: unknown): string | null {
  switch (decl.type) {
    case 'string':
      if (typeof value !== 'string') return 'is not a string';
      if (decl.minLength !== undefined && codePoints(value) < decl.minLength) return `is shorter than ${decl.minLength}`;
      if (decl.maxLength !== undefined && codePoints(value) > decl.maxLength) return `is longer than ${decl.maxLength}`;
      if (decl.format !== undefined && !FORMAT_OK[decl.format](value)) return `is not a ${decl.format}`;
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'is not a number';
      if (decl.type === 'integer' && !Number.isSafeInteger(value)) return 'is not an integer';
      if (decl.minimum !== undefined && value < decl.minimum) return `is below ${decl.minimum}`;
      if (decl.maximum !== undefined && value > decl.maximum) return `is above ${decl.maximum}`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return 'is not a boolean';
      break;
    default:
      return 'is not a scalar';
  }
  if (decl.enum !== undefined && !decl.enum.some((e) => e === value)) return 'is not one of its enum values';
  return null;
}

/** Every binding of a component, with the JSON path of its map, and what it binds into. */
interface BindingSite {
  path: (string | number)[];
  target: { query: string } | { action: string } | { page: string };
  params: Record<string, string>;
  /** `row.<column>` is allowed only on a table's row action, against the table's own query. */
  rowQuery: string | null;
  /** `form.<field>` is allowed only on a form's submit, against its own fields. */
  formFields: ReadonlySet<string> | null;
}

/**
 * What the schema cannot say (DES §6.2 "Spec schema, bindings exist, link hosts listed"). Empty when the
 * spec is consistent. Every name lookup is an OWN-property lookup: `constructor` or `toString` is a name
 * like any other, never something an object inherits.
 */
export function checkSpec(spec: AppSpec): AppCheckFinding[] {
  const out: AppCheckFinding[] = [];
  const push = (code: string, path: (string | number)[], message: string): void => {
    if (out.length < 50) out.push(finding(code, path, message));
  };

  const queries = new Map(spec.queries.map((q) => [q.id, q] as const));
  const actions = new Map(spec.actions.map((a) => [a.id, a] as const));
  const pages = new Set(spec.pages.map((p) => p.id));
  const hosts = new Set(spec.linkHosts);

  const dup = (ids: string[], what: string, path: (i: number) => (string | number)[]): void => {
    const seen = new Set<string>();
    ids.forEach((v, i) => {
      if (seen.has(v)) push('duplicate_id', path(i), `${what} id ${JSON.stringify(v)} is used twice`);
      seen.add(v);
    });
  };
  dup(spec.queries.map((q) => q.id), 'query', (i) => ['queries', i, 'id']);
  dup(spec.actions.map((a) => a.id), 'action', (i) => ['actions', i, 'id']);
  const elementIds: string[] = [];
  const elementPaths: (string | number)[][] = [];
  spec.pages.forEach((p, pi) => {
    elementIds.push(p.id);
    elementPaths.push(['pages', pi, 'id']);
    p.components.forEach((c, ci) => {
      elementIds.push(c.id);
      elementPaths.push(['pages', pi, 'components', ci, 'id']);
    });
  });
  dup(elementIds, 'page or component', (i) => elementPaths[i]!);

  // Parameters: `required` names declared ones; `from` fits the type; `items` only on arrays; bounds in
  // order; a default and every enum value satisfy the declaration.
  const checkParams = (params: AppParamsSchema | undefined, path: (string | number)[]): void => {
    if (params === undefined) return;
    const required = params.required ?? [];
    for (const r of required) {
      if (!own(params.properties, r)) push('unknown_param', [...path, 'required'], `required parameter ${JSON.stringify(r)} is not declared`);
    }
    if (new Set(required).size !== required.length) push('bad_param', [...path, 'required'], 'a parameter is listed as required twice');
    for (const [name, p] of Object.entries(params.properties)) {
      const at = [...path, 'properties', name];
      if ((p.type === 'array') !== (p.items !== undefined)) push('bad_param', at, 'an array parameter declares items, and only an array does');
      if (p.from === 'viewer.groups' && !(p.type === 'array' && p.items?.type === 'string')) push('bad_param', at, 'viewer.groups is an array of strings');
      if (p.from !== undefined && p.from !== 'viewer.groups' && p.type !== 'string') push('bad_param', at, `${p.from} is a string`);
      if (p.from !== undefined && p.default !== undefined) push('bad_param', at, 'a viewer-bound parameter has no default');
      if (p.minimum !== undefined && p.maximum !== undefined && p.minimum > p.maximum) push('bad_param', at, 'minimum is above maximum');
      if (p.minLength !== undefined && p.maxLength !== undefined && p.minLength > p.maxLength) push('bad_param', at, 'minLength is above maxLength');
      // Constraints apply to their own type only.
      const isString = p.type === 'string';
      const isNumber = p.type === 'number' || p.type === 'integer';
      if (!isString && (p.format !== undefined || p.minLength !== undefined || p.maxLength !== undefined)) push('bad_param', at, 'format, minLength and maxLength apply to a string');
      if (!isNumber && (p.minimum !== undefined || p.maximum !== undefined)) push('bad_param', at, 'minimum and maximum apply to a number');
      if (p.type === 'array' && p.enum !== undefined) push('bad_param', [...at, 'enum'], 'an array has no enum');
      if (p.type === 'array' && p.default !== undefined) push('bad_param', [...at, 'default'], 'an array has no default');
      if (p.type !== 'array') {
        // Every enum value satisfies the rest of the declaration; the default satisfies all of it, so a
        // default must also be one of the enum values.
        const { enum: values, default: dflt, description: _d, from: _f, items: _i, ...decl } = p;
        void _d;
        void _f;
        void _i;
        for (const [i, e] of (values ?? []).entries()) {
          const problem = paramValueProblem(decl, e);
          if (problem !== null) push('bad_param', [...at, 'enum', i], `enum value ${JSON.stringify(e)} ${problem}`);
        }
        if (dflt !== undefined) {
          const problem = paramValueProblem(p, dflt);
          if (problem !== null) push('bad_param', [...at, 'default'], `the default ${problem}`);
        }
      }
    }
  };
  /** A required parameter nobody fills: no `from`, no default. */
  const mustBind = (params: AppParamsSchema | undefined): string[] =>
    [...new Set(params?.required ?? [])].filter((r) => own(params!.properties, r) && params!.properties[r]!.from === undefined && params!.properties[r]!.default === undefined);

  spec.queries.forEach((q, i) => {
    checkParams(q.params, ['queries', i, 'params']);
    if (q.refresh?.mode === 'events' && q.source !== 'crew') push('bad_refresh', ['queries', i, 'refresh'], 'refresh on events is for the built-in crew source only');
    if (q.kind === 'crew' && q.source !== 'crew') push('bad_source', ['queries', i, 'source'], 'a crew query reads the built-in crew source');
    if (q.kind !== 'crew' && q.source === 'crew') push('bad_source', ['queries', i, 'kind'], 'the built-in crew source is read by a crew query');
    if (q.kind === 'sql' && (q.rowPath !== undefined || q.morePath !== undefined)) push('bad_path', ['queries', i], 'a SQL query has no row or more path');
    dup(q.output.map((c) => c.name), 'output column', (ci) => ['queries', i, 'output', ci, 'name']);
  });
  spec.actions.forEach((a, i) => {
    const path = ['actions', i];
    checkParams(a.params, [...path, 'params']);
    const declared = a.params?.properties ?? {};
    const values: [(string | number)[], AppValue][] = [];
    if (a.kind === 'api') {
      for (const [k, v] of Object.entries(a.args)) values.push([[...path, 'args', k], v]);
    } else {
      for (const [k, v] of Object.entries(a.set ?? {})) values.push([[...path, 'set', k], v]);
      for (const [k, v] of Object.entries(a.key)) values.push([[...path, 'key', k], v]);
      if (a.op === 'delete' && a.set !== undefined) push('bad_row_write', [...path, 'set'], 'a delete sets no column');
      if (a.op !== 'delete' && (a.set === undefined || Object.keys(a.set).length === 0)) push('bad_row_write', [...path, 'set'], `an ${a.op} sets at least one column`);
      for (const k of Object.keys(a.set ?? {})) {
        if (a.op === 'update' && own(a.key, k)) push('bad_row_write', [...path, 'set', k], 'an update never changes a primary-key column');
      }
      // The row's identity always comes from the request: every key parameter is required (codex r2).
      const required = new Set(a.params?.required ?? []);
      for (const [k, v] of Object.entries(a.key)) {
        if (own(declared, v.name) && !required.has(v.name)) push('bad_row_write', [...path, 'key', k], `key parameter ${JSON.stringify(v.name)} must be required`);
        // An insert sets each key column from its own key parameter, never a second value (DES §7.4).
        if (a.op === 'insert') {
          const set = a.set !== undefined && own(a.set, k) ? a.set[k] : undefined;
          if (set === undefined || set.kind !== 'param' || set.name !== v.name) {
            push('bad_row_write', [...path, 'set', k], `an insert sets key column ${k} from its key parameter ${JSON.stringify(v.name)}`);
          }
        }
      }
    }
    for (const [at, v] of values) {
      if (v.kind === 'param' && !own(declared, v.name)) push('unknown_param', at, `parameter ${JSON.stringify(v.name)} is not declared`);
    }
  });

  // Bindings.
  const sites: BindingSite[] = [];
  spec.pages.forEach((page, pi) => {
    const filters = new Map<string, string>();
    for (const c of page.components) if (c.type === 'filter') filters.set(c.id, c.filter);
    page.components.forEach((c, ci) => {
      const at: (string | number)[] = ['pages', pi, 'components', ci];
      const dataQuery = 'data' in c ? c.data.query : null;
      if ('data' in c) sites.push({ path: [...at, 'data'], target: { query: c.data.query }, params: c.data.params ?? {}, rowQuery: null, formFields: null });
      if (c.type === 'table') {
        (c.rowActions ?? []).forEach((ra, ri) =>
          sites.push({ path: [...at, 'rowActions', ri], target: { action: ra.action }, params: ra.params ?? {}, rowQuery: c.data.query, formFields: null }),
        );
      }
      if (c.type === 'filter' && c.options?.kind === 'query') {
        sites.push({ path: [...at, 'options', 'query'], target: { query: c.options.query.query }, params: c.options.query.params ?? {}, rowQuery: null, formFields: null });
        const q = queries.get(c.options.query.query);
        if (q !== undefined) {
          for (const [key, col] of [['value', c.options.value], ['label', c.options.label]] as const) {
            if (col !== undefined && !q.output.some((o) => o.name === col)) push('unknown_column', [...at, 'options', key], `query ${q.id} declares no output column ${JSON.stringify(col)}`);
          }
        }
      }
      if (c.type === 'filter' && c.options !== undefined && c.filter !== 'select') push('bad_filter', [...at, 'options'], 'only a select filter has options');
      if (c.type === 'filter' && c.default !== undefined && (typeof c.default === 'object') !== (c.filter === 'date-range')) {
        push('bad_filter', [...at, 'default'], c.filter === 'date-range' ? 'a date range defaults to { lastDays }' : 'only a date range defaults to { lastDays }');
      }
      if (c.type === 'form') {
        dup(c.fields.map((f) => f.name), 'form field', (fi) => [...at, 'fields', fi, 'name']);
        c.fields.forEach((f, fi) => {
          if ((f.input === 'select') !== (f.options !== undefined)) push('bad_field', [...at, 'fields', fi], 'a select field has options, and only a select field does');
        });
        sites.push({ path: [...at, 'submit'], target: { action: c.submit.action }, params: c.submit.params ?? {}, rowQuery: null, formFields: new Set(c.fields.map((f) => f.name)) });
      }
      if (c.type === 'button') sites.push({ path: [...at, 'action'], target: { action: c.action.action }, params: c.action.params ?? {}, rowQuery: null, formFields: null });
      if (c.type === 'link') {
        if (c.to.kind === 'page') sites.push({ path: [...at, 'to'], target: { page: c.to.page }, params: c.to.params ?? {}, rowQuery: null, formFields: null });
        else {
          let url: URL | null = null;
          try {
            url = new URL(c.to.href);
          } catch {
            url = null;
          }
          if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
            push('bad_link', [...at, 'to', 'href'], 'a link leaves over https, with no credentials or port');
          } else if (!hosts.has(url.hostname)) {
            push('unlisted_host', [...at, 'to', 'href'], `host ${url.hostname} is not in linkHosts`);
          }
        }
      }
      // A component's columns are columns of its own query.
      const q = dataQuery === null ? undefined : queries.get(dataQuery);
      if (q !== undefined) {
        const cols = new Set(q.output.map((o) => o.name));
        const need: [string, (string | number)[]][] = [];
        if (c.type === 'table') (c.columns ?? []).forEach((tc, i) => need.push([tc.column, [...at, 'columns', i, 'column']]));
        if (c.type === 'chart') {
          need.push([c.x, [...at, 'x']]);
          c.series.forEach((s, i) => need.push([s.column, [...at, 'series', i, 'column']]));
        }
        if (c.type === 'kpi') {
          need.push([c.value, [...at, 'value']]);
          if (c.delta !== undefined) need.push([c.delta, [...at, 'delta']]);
        }
        for (const [col, p] of need) if (!cols.has(col)) push('unknown_column', p, `query ${q.id} declares no output column ${JSON.stringify(col)}`);
      }
      if (c.type === 'chart' && c.chart === 'pie' && c.series.length !== 1) push('bad_chart', [...at, 'series'], 'a pie has exactly one series');
    });

    // Each binding on this page: the target exists, every parameter it binds is declared (an OWN key) and
    // not viewer-bound, every required parameter nobody else fills is bound, and the bound value's source
    // exists where it is bound.
    for (const site of sites.splice(0)) {
      let params: AppParamsSchema | undefined;
      if ('query' in site.target) {
        const q = queries.get(site.target.query);
        if (q === undefined) {
          push('unknown_query', [...site.path, 'query'], `no query ${JSON.stringify(site.target.query)}`);
          continue;
        }
        params = q.params;
      } else if ('action' in site.target) {
        const a = actions.get(site.target.action);
        if (a === undefined) {
          push('unknown_action', [...site.path, 'action'], `no action ${JSON.stringify(site.target.action)}`);
          continue;
        }
        params = a.params;
      } else {
        if (!pages.has(site.target.page)) push('unknown_page', [...site.path, 'page'], `no page ${JSON.stringify(site.target.page)}`);
        params = undefined;
      }
      if (!('page' in site.target)) {
        for (const r of mustBind(params)) {
          if (!own(site.params, r)) push('unbound_param', [...site.path, 'params'], `required parameter ${JSON.stringify(r)} has no binding, default or viewer claim`);
        }
      }
      for (const [name, ref] of Object.entries(site.params)) {
        const at = [...site.path, 'params', name];
        if (!('page' in site.target)) {
          const decl = params !== undefined && own(params.properties, name) ? params.properties[name] : undefined;
          if (decl === undefined) {
            push('unknown_param', at, `parameter ${JSON.stringify(name)} is not declared`);
            continue;
          }
          if (decl.from !== undefined) {
            push('viewer_bound', at, `parameter ${JSON.stringify(name)} is filled from ${decl.from}; no component binds it`);
            continue;
          }
        }
        const dot = ref.indexOf('.');
        const kind = ref.slice(0, dot);
        const rest = ref.slice(dot + 1);
        if (kind === 'filter') {
          const [fid, end] = rest.split('.') as [string, string | undefined];
          const f = filters.get(fid);
          if (f === undefined) push('unknown_filter', at, `no filter ${JSON.stringify(fid)} on this page`);
          else if ((f === 'date-range') !== (end !== undefined)) push('bad_binding', at, f === 'date-range' ? 'a date range binds .from or .to' : 'only a date range binds .from or .to');
        } else if (kind === 'form') {
          if (site.formFields === null) push('bad_binding', at, 'form.<field> binds only on a form submit');
          else if (!site.formFields.has(rest)) push('unknown_field', at, `the form has no field ${JSON.stringify(rest)}`);
        } else if (kind === 'row') {
          const rq = site.rowQuery === null ? undefined : queries.get(site.rowQuery);
          if (site.rowQuery === null) push('bad_binding', at, "row.<column> binds only on a table's row action");
          else if (rq !== undefined && !rq.output.some((o) => o.name === rest)) push('unknown_column', at, `query ${rq.id} declares no output column ${JSON.stringify(rest)}`);
        }
      }
    }
  });
  return out;
}
