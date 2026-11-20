import { describe, expect, it } from 'vitest';
import { jobRefusal } from '../src/api/routes.js';
import { LaunchRefusal } from '../src/api/chat-proposals.js';

describe('jobRefusal', () => {
  it('preserves a typed 409 refusal and its complete body', () => {
    const body = { code: 'no_independent_reviewer', error: 'No other seat can review.', excluded: [{ seat: 'a', reason: 'author' }], retryWith: { reducedAssurance: true } };
    const err = jobRefusal(409, body);
    expect(err).toBeInstanceOf(LaunchRefusal);
    expect(err).toMatchObject({ status: 409, body, message: body.error });
    expect((err as LaunchRefusal).body).toBe(body);
  });

  it('keeps the code suffix in an untyped 502 error', () => {
    const err = jobRefusal(502, { code: 'x', error: 'boom' });
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe('boom (x)');
  });

  it('returns a plain error for a 409 without a code', () => {
    const err = jobRefusal(409, { error: 'boom' });
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe('boom');
  });
});
