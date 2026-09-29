// cli/bearer.ts — the CLI says WHY a team-runtime daemon refused it (#637)
//
// `WICKED_CREW_TOKEN` (the client's bearer, added by #636) is one character from
// `WICKED_CREW_TOKENS` (the daemon's token-FILE path) and meant the opposite thing, and only the
// plural was documented. So an operator could do everything the docs said, send no bearer, get 401
// on every verb, and be told nothing about the cause — silence was the defect, not the 401.
//
// These tests pin the line and its conditions. They import the side-effect-free bearer module,
// never cli/index.ts (which calls main() on import).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLIENT_TOKEN_ENV,
  DAEMON_TOKENS_ENV,
  missingBearerAdvice,
  resetBearerAdviceLatch,
  warnIfUnauthorizedWithoutBearer,
} from '../src/cli/bearer.js';

const TOKEN = 'test-crew-token-abc';

describe('missingBearerAdvice', () => {
  it('names the singular variable when no bearer is set', () => {
    const advice = missingBearerAdvice({});
    expect(advice).toContain(CLIENT_TOKEN_ENV);
    expect(advice).toMatch(/sent no bearer/);
  });

  it('says the plural one is the daemon-side token file when THAT is what is set', () => {
    const advice = missingBearerAdvice({ [DAEMON_TOKENS_ENV]: '/some/tokens.json' });
    // The exact footgun: the operator followed the documented plural and got 401s.
    expect(advice).toContain(`${DAEMON_TOKENS_ENV} (plural, set here)`);
    expect(advice).toContain(CLIENT_TOKEN_ENV);
  });

  it('says nothing when a bearer WAS sent — that 401 is about the token, not the variable', () => {
    expect(missingBearerAdvice({ [CLIENT_TOKEN_ENV]: TOKEN })).toBeNull();
    expect(missingBearerAdvice({ [CLIENT_TOKEN_ENV]: TOKEN, [DAEMON_TOKENS_ENV]: '/t.json' })).toBeNull();
  });

  it('does not offer the plural as an alias (its value is a path, which would 401 identically)', () => {
    const advice = missingBearerAdvice({ [DAEMON_TOKENS_ENV]: '/some/tokens.json' }) ?? '';
    expect(advice).not.toMatch(/alias|deprecat|accepted instead/i);
  });
});

describe('warnIfUnauthorizedWithoutBearer', () => {
  let said: string[];

  beforeEach(() => {
    resetBearerAdviceLatch();
    said = [];
  });

  afterEach(() => {
    resetBearerAdviceLatch();
  });

  const say = (line: string) => { said.push(line); };

  it('speaks on 401 and on 403', () => {
    expect(warnIfUnauthorizedWithoutBearer(401, {}, say)).not.toBeNull();
    resetBearerAdviceLatch();
    expect(warnIfUnauthorizedWithoutBearer(403, {}, say)).not.toBeNull();
    expect(said).toHaveLength(2);
  });

  it('stays quiet on a success, and on a failure that is not about auth', () => {
    for (const status of [200, 201, 400, 404, 409, 500, 502]) {
      expect(warnIfUnauthorizedWithoutBearer(status, {}, say)).toBeNull();
    }
    expect(said).toEqual([]);
  });

  it('speaks once per process, not once per verb', () => {
    warnIfUnauthorizedWithoutBearer(401, {}, say);
    warnIfUnauthorizedWithoutBearer(401, {}, say);
    warnIfUnauthorizedWithoutBearer(403, {}, say);
    expect(said).toHaveLength(1);
  });

  it('stays quiet when a bearer was sent, whatever the status', () => {
    expect(warnIfUnauthorizedWithoutBearer(401, { [CLIENT_TOKEN_ENV]: TOKEN }, say)).toBeNull();
    expect(said).toEqual([]);
  });
});
