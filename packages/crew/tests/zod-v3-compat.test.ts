// crew#1338: crew moved to zod 4, and src/zod.js keeps what zod 3 refused refused, in zod 3's words.
// Every expected message below was recorded from zod 3.25.76 (the version crew ran before) on the same
// schema and input.
import { describe, expect, it } from 'vitest';
import { record, z } from '../src/zod.js';
import { AppActionRunSchema, AppEditsSchema } from '../src/apps/routes.js';
import { AddSkillSchema } from '../src/api/skills.js';

const issues = (s: z.ZodType, v: unknown): [string, string][] => {
  const r = s.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => [i.path.join('.'), i.message]);
};

describe('zod 3 messages on zod 4 (src/zod.js error map)', () => {
  it.each<[string, z.ZodType, unknown, [string, string][]]>([
    ['a missing key', z.object({ a: z.string() }), {}, [['a', 'Required']]],
    ['a wrong type', z.object({ a: z.number() }), { a: true }, [['a', 'Expected number, received boolean']]],
    ['null for an object', z.strictObject({}), null, [['', 'Expected object, received null']]],
    ['an array for an object', z.object({}), [], [['', 'Expected object, received array']]],
    ['a string for a record', z.record(z.string(), z.string()), 'x', [['', 'Expected object, received string']]],
    ['a float for an int', z.int(), 1.5, [['', 'Expected integer, received float']]],
    ['a string for an int', z.int(), '1', [['', 'Expected number, received string']]],
    ['a literal', z.literal('a'), 'b', [['', 'Invalid literal value, expected "a"']]],
    ['an enum value', z.enum(['a', 'b']), 'c', [['', "Invalid enum value. Expected 'a' | 'b', received 'c'"]]],
    ['a non-string for an enum', z.enum(['a', 'b']), 3, [['', "Expected 'a' | 'b', received number"]]],
    ['a missing enum', z.object({ e: z.enum(['a', 'b']) }), {}, [['e', 'Required']]],
    ['unknown keys', z.strictObject({ a: z.string() }), { a: 'x', b: 1, c: 2 }, [['', "Unrecognized key(s) in object: 'b', 'c'"]]],
    ['a discriminator', z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })]), { k: 'c' }, [['k', "Invalid discriminator value. Expected 'a' | 'b'"]]],
    ['a union', z.union([z.string(), z.number()]), true, [['', 'Invalid input']]],
    ['a regex', z.string().regex(/^a+$/), 'b', [['', 'Invalid']]],
    ['a url', z.url(), 'nope', [['', 'Invalid url']]],
    ['a uuid', z.guid(), 'nope', [['', 'Invalid uuid']]],
    ['startsWith', z.string().startsWith('ab'), 'x', [['', 'Invalid input: must start with "ab"']]],
    ['a string min', z.string().min(2), 'a', [['', 'String must contain at least 2 character(s)']]],
    ['a string max', z.string().max(2), 'abc', [['', 'String must contain at most 2 character(s)']]],
    ['a string length', z.string().length(2), 'a', [['', 'String must contain exactly 2 character(s)']]],
    ['an array min', z.array(z.string()).min(2), ['a'], [['', 'Array must contain at least 2 element(s)']]],
    ['an array max', z.array(z.string()).max(1), ['a', 'b'], [['', 'Array must contain at most 1 element(s)']]],
    ['a number min', z.number().min(5), 4, [['', 'Number must be greater than or equal to 5']]],
    ['a positive number', z.number().positive(), 0, [['', 'Number must be greater than 0']]],
    ['a number max', z.number().max(5), 6, [['', 'Number must be less than or equal to 5']]],
    ['a number lt', z.number().lt(5), 5, [['', 'Number must be less than 5']]],
    ['multipleOf', z.number().multipleOf(3), 4, [['', 'Number must be a multiple of 3']]],
    ['a refine', z.string().refine(() => false), 'x', [['', 'Invalid input']]],
    ['a record key', z.record(z.string().max(2), z.string()), { abc: 'x' }, [['abc', 'String must contain at most 2 character(s)']]],
  ])('%s', (_name, schema, input, expected) => {
    expect(issues(schema, input)).toEqual(expected);
  });

  it("a schema's own message still wins over the map", () => {
    expect(issues(z.string().regex(/^a$/, 'must be a'), 'b')).toEqual([['', 'must be a']]);
    expect(issues(z.string().refine(() => false, { error: 'mine' }), 'x')).toEqual([['', 'mine']]);
  });
});

describe("record(): an own __proto__ entry is validated, as zod 3 did (zod 4's z.record skips it)", () => {
  const files = record(z.string().min(1), z.string());
  // JSON.parse (crew's body parser) makes `__proto__` an own key.
  const body = (s: string): unknown => JSON.parse(s);

  it('refuses an invalid __proto__ value and key, at the __proto__ path', () => {
    expect(issues(files, body('{"__proto__": 42}'))).toEqual([['__proto__', 'Expected string, received number']]);
    expect(issues(record(z.string().max(3), z.string()), body('{"__proto__": "x"}'))).toEqual([['__proto__', 'String must contain at most 3 character(s)']]);
    // plain zod 4 accepts both: the guard is load-bearing.
    expect(z.record(z.string().min(1), z.string()).safeParse(body('{"__proto__": 42}')).success).toBe(true);
  });

  it('a route body: POST /skills files {"__proto__": 42} is refused, as on zod 3', () => {
    expect(issues(AddSkillSchema, body('{"name":"a","files":{"__proto__":42},"expectedRevision":1}'))).toEqual([['files.__proto__', 'Expected string, received number']]);
  });

  it('accepts a valid one and drops it from the output, as zod 3 did; every other entry parses as before', () => {
    const r = files.safeParse(body('{"__proto__": "ok", "a.md": "x"}'));
    expect(r.success && r.data).toEqual({ 'a.md': 'x' });
    expect(r.success && Object.hasOwn(r.data, '__proto__')).toBe(false);
    expect(issues(files, { 'a.md': 5 })).toEqual([['a.md', 'Expected string, received number']]);
    expect(issues(files, 'x')).toEqual([['', 'Expected object, received string']]);
    expect(issues(z.object({ files }), {})).toEqual([['files', 'Required']]);
  });
});

describe('route schemas keep what zod 3 accepted', () => {
  it("an app edit's spec op may omit the spec (zod 4 requires a z.unknown() key); parseSpec refuses it later", () => {
    expect(AppEditsSchema.safeParse({ base: 1, ops: [{ op: 'spec' }] }).success).toBe(true);
  });

  it("an action run's record id is any 8-4-4-4-12 hex id, as zod 3's .uuid() accepted", () => {
    expect(AppActionRunSchema.safeParse({ record: '12345678-1234-1234-1234-123456789abc' }).success).toBe(true);
    expect(issues(AppActionRunSchema, { record: 'nope' })).toEqual([['record', 'Invalid uuid']]);
  });
});
