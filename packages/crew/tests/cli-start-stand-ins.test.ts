// coord round 2 F3 (crew#1888): `wicked-crew start` posts POST /runs, which asks the stand-in question on a short
// roster. A person at the CLI must have a way through: `--stand-ins` consents for this job (the launch's
// `standIns: true`), and the 409 names that exact command, the every-job setting and the other ways out.
import { describe, expect, it } from 'vitest';
import { startLaunchFailure, startStandInsFlag } from '../src/cli/start-stand-ins.js';

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--problem', '--repo']);

describe('wicked-crew start and the stand-in choice', () => {
  it('--stand-ins is the person\'s consent for this job, read as an option only', () => {
    expect(startStandInsFlag(['start', '--stand-ins'], VALUE_FLAGS)).toBe(true);
    expect(startStandInsFlag(['start', '--repo', 'r', '--stand-ins'], VALUE_FLAGS)).toBe(true);
    expect(startStandInsFlag(['start'], VALUE_FLAGS)).toBe(false);
    // `--problem --stand-ins` is a problem text, not a consent.
    expect(startStandInsFlag(['start', '--problem', '--stand-ins'], VALUE_FLAGS)).toBe(false);
  });

  it('a 409 stand_in_choice prints the engine\'s words and the exact ways through', () => {
    const text = startLaunchFailure(409, { code: 'stand_in_choice', error: 'This job\'s helpers can\'t check it independently: it needs a judge that did not build the work.', retryWith: { standIns: true } }, 'Conflict');
    expect(text).toMatch(/^launch failed \(409\): This job's helpers can't check it independently/);
    expect(text).toMatch(/wicked-crew start --stand-ins/);
    expect(text).toMatch(/every job/);
    expect(text).toMatch(/standInReview/);
    expect(text).toMatch(/--reduced-assurance/);
  });

  it('no_usable_helper and other failures offer no stand-ins', () => {
    const none = startLaunchFailure(409, { code: 'no_usable_helper', error: 'No helper on this job can be a judge for it, even as a stand-in, so it can\'t start.' }, 'Conflict');
    expect(none).toBe('launch failed (409): No helper on this job can be a judge for it, even as a stand-in, so it can\'t start.');
    expect(startLaunchFailure(500, null, 'Internal Server Error')).toBe('launch failed (500): Internal Server Error');
  });
});
