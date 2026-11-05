// @ts-check
/**
 * crew's one zod import. Every crew module takes `z` from here, never from `zod` itself (eslint's
 * `no-restricted-imports` holds that), so this runs before any schema parses, in the daemon, the CLI
 * and the plain-node scripts alike (it is JavaScript so `scripts/evals-internal-corpus.mjs` can load
 * it without a TypeScript loader).
 *
 * zod 4 reworded every default issue message ("Required" became "Invalid input: expected string,
 * received undefined"). crew quotes zod's messages in 400 bodies (`invalidBody`, the joined
 * `path: message` errors), in app-check findings and in logs, and clients and tests read some of
 * them, so the global error map below reproduces zod 3's English messages, rule for rule from
 * zod 3.25's `v3/locales/en.js`. A message a schema declares itself (`.regex(re, '…')`,
 * `{ error: '…' }`) still wins: zod 4 consults the global map only for issues with no message of
 * their own.
 */
import { z } from 'zod';

/** zod 3's `getParsedType`, the word after "received". @param {unknown} v */
function parsedType(v) {
  switch (typeof v) {
    case 'undefined': return 'undefined';
    case 'string': return 'string';
    case 'number': return Number.isNaN(v) ? 'nan' : 'number';
    case 'boolean': return 'boolean';
    case 'function': return 'function';
    case 'bigint': return 'bigint';
    case 'symbol': return 'symbol';
    default:
      if (Array.isArray(v)) return 'array';
      if (v === null) return 'null';
      if (typeof (/** @type {{ then?: unknown }} */ (v)).then === 'function' && typeof (/** @type {{ catch?: unknown }} */ (v)).catch === 'function') return 'promise';
      if (v instanceof Map) return 'map';
      if (v instanceof Set) return 'set';
      if (v instanceof Date) return 'date';
      return 'object';
  }
}

/** zod 3's `util.joinValues`: strings single-quoted. @param {readonly unknown[]} values @param {string} [sep] */
function joinValues(values, sep = ' | ') {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(sep);
}

/** zod 4's names for what was expected, in zod 3's words. */
const EXPECTED = /** @type {Record<string, string>} */ ({ record: 'object', tuple: 'array', int: 'integer' });

/** zod 4's string formats, in zod 3's `invalid_string` validation names. */
const FORMAT = /** @type {Record<string, string>} */ ({ guid: 'uuid', ipv4: 'ip', ipv6: 'ip', cidrv4: 'cidr', cidrv6: 'cidr' });

/** @param {unknown} o @param {string} k */
const prop = (o, k) => (o !== null && typeof o === 'object' ? /** @type {Record<string, unknown>} */ (o)[k] : undefined);

/**
 * One zod 4 raw issue → zod 3's English message (undefined: zod 4's own default).
 * @param {z.core.$ZodRawIssue} issue
 * @returns {string | undefined}
 */
export function zod3Message(issue) {
  const i = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (issue));
  const input = i['input'];
  switch (issue.code) {
    case 'invalid_type': {
      if (input === undefined) return 'Required';
      const expected = String(i['expected']);
      // zod 4's number refuses ±Infinity (JSON's 1e400) itself; zod 3 refused it only by `.finite()`, in these words.
      if ((expected === 'number' || expected === 'int') && typeof input === 'number' && !Number.isFinite(input) && !Number.isNaN(input)) return 'Number must be finite';
      // zod 3 checked `.int()` after the number type: a float was "Expected integer, received float".
      if (expected === 'int') return typeof input === 'number' ? 'Expected integer, received float' : `Expected number, received ${parsedType(input)}`;
      return `Expected ${EXPECTED[expected] ?? expected}, received ${parsedType(input)}`;
    }
    case 'invalid_value': {
      const values = /** @type {unknown[]} */ (i['values'] ?? []);
      const kind = prop(prop(prop(i['inst'], '_zod'), 'def'), 'type');
      if (kind === 'literal') return `Invalid literal value, expected ${JSON.stringify(values[0], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
      // zod 3's enum type-checked first: a missing value was "Required", a non-string a type error.
      if (input === undefined) return 'Required';
      if (typeof input !== 'string') return `Expected ${joinValues(values)}, received ${parsedType(input)}`;
      return `Invalid enum value. Expected ${joinValues(values)}, received '${input}'`;
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(/** @type {unknown[]} */ (i['keys'] ?? []), ', ')}`;
    case 'invalid_union':
      if (i['note'] === 'No matching discriminator') return `Invalid discriminator value. Expected ${joinValues(/** @type {unknown[]} */ (i['options'] ?? []))}`;
      return 'Invalid input';
    case 'invalid_key': {
      // zod 3 reported a refused record key with the key schema's own issue; zod 4 nests it.
      const nested = /** @type {{ message?: unknown }[]} */ (i['issues'] ?? []);
      const first = nested[0]?.message;
      return typeof first === 'string' ? first : 'Invalid input';
    }
    case 'invalid_format': {
      const format = String(i['format']);
      if (format === 'regex') return 'Invalid';
      if (format === 'starts_with') return `Invalid input: must start with "${String(i['prefix'])}"`;
      if (format === 'ends_with') return `Invalid input: must end with "${String(i['suffix'])}"`;
      if (format === 'includes') return `Invalid input: must include "${String(i['includes'])}"`;
      return `Invalid ${FORMAT[format] ?? format}`;
    }
    case 'too_small': {
      const { origin, minimum, inclusive, exact } = /** @type {{ origin?: string, minimum?: unknown, inclusive?: boolean, exact?: boolean }} */ (i);
      const n = String(minimum);
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${n} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${n} character(s)`;
      if (origin === 'number' || origin === 'int' || origin === 'bigint') return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${n}`;
      if (origin === 'date') return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum)).toString()}`;
      return 'Invalid input';
    }
    case 'too_big': {
      const { origin, maximum, inclusive, exact } = /** @type {{ origin?: string, maximum?: unknown, inclusive?: boolean, exact?: boolean }} */ (i);
      const n = String(maximum);
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${n} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${n} character(s)`;
      if (origin === 'number' || origin === 'int') return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${n}`;
      if (origin === 'bigint') return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${n}`;
      if (origin === 'date') return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum)).toString()}`;
      return 'Invalid input';
    }
    case 'not_multiple_of':
      return `Number must be a multiple of ${String(i['divisor'])}`;
    case 'custom':
      return 'Invalid input';
    default:
      return undefined;
  }
}

z.config({ customError: zod3Message });

/**
 * zod 3's `.url()` check, for `z.string().superRefine(zod3Url)`: `new URL(value)` must parse, and the value is
 * left exactly as sent. zod 4's `z.url()` trims it and strips tabs and newlines BEFORE the checks after it, so
 * `z.url().max(n).refine(isHttp)` would pass `" https://x"` and a URL padded past `n` with newlines, both of
 * which zod 3 refused.
 * @param {string} value
 * @param {z.RefinementCtx} ctx
 */
export function zod3Url(value, ctx) {
  if (!URL.canParse(value)) ctx.addIssue({ code: 'invalid_format', format: 'url', input: value });
}

/**
 * `z.record(key, value)`, validating an own `__proto__` entry as zod 3 did.
 *
 * zod 4's record skips a `__proto__` key without validating it (zod 3 checked it against the key and
 * value schemas like any other entry, and both drop it from the output). crew's JSON body parser is a
 * plain `JSON.parse`, which keeps `__proto__` as an own key, so on zod 4 alone `{"files":
 * {"__proto__": 42}}` would pass a record of strings that refused it on zod 3. This refuses what zod 3
 * refused, with zod 3's message at the `__proto__` path, before the record itself parses (so an answer that
 * refuses that entry does not also list the other entries' problems). Not for an MCP tool schema: the SDK
 * renders a pipe by its input side, which here is `unknown`.
 *
 * Typed as the record it wraps (input and output), so `z.input<>` wire guards still see the entries.
 *
 * @template {z.core.$ZodRecordKey} K
 * @template {z.core.SomeType} V
 * @param {K} key
 * @param {V} value
 * @param {string | z.core.$ZodRecordParams} [params]
 * @returns {z.ZodType<z.output<z.ZodRecord<K, V>>, z.input<z.ZodRecord<K, V>>>}
 */
export function record(key, value, params) {
  const guarded = z
    .unknown()
    .superRefine((input, ctx) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, '__proto__')) return;
      const entry = /** @type {Record<string, unknown>} */ (input)['__proto__'];
      for (const [schema, v] of /** @type {[z.core.$ZodType, unknown][]} */ ([[key, '__proto__'], [value, entry]])) {
        const r = z.safeParse(schema, v);
        if (!r.success) for (const iss of r.error.issues) ctx.addIssue({ code: 'custom', path: ['__proto__', ...iss.path], message: iss.message });
      }
    })
    .pipe(z.record(key, value, params));
  return /** @type {z.ZodType<z.output<z.ZodRecord<K, V>>, z.input<z.ZodRecord<K, V>>>} */ (/** @type {unknown} */ (guarded));
}

export { z };
