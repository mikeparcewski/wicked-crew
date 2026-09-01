// crew#353 (lane-2 finding) — the audit trail must FOLLOW `--db`, never escape to the real home.
//
// The settings fix moved the LAST store that resolved `~/.wicked-crew` from `homedir()`
// unconditionally — except it wasn't the last: `defaultAuditPath()` still did, so a
// `--db $SCRATCH/core.db` daemon appended every `run.launched` / `settings.updated` /
// `project.created` to the operator's REAL `~/.wicked-crew/audit.log`, and hydrated its
// retry/guidance/delivery indexes from that real trail at boot. Caught by the E2E gate
// (fake-$HOME full-tree snapshot: `.wicked-crew/audit.log` appeared under `--db`).
//
// Pure path-resolution tests: no daemon, no filesystem writes.

import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultAuditPath } from '../src/api/audit.js';
import { setCrewStateHome } from '../src/projects/state-home.js';

afterEach(() => setCrewStateHome(undefined));

describe('defaultAuditPath follows the daemon state home (crew#353)', () => {
  it('resolves under the configured state home (the --db parent)', () => {
    setCrewStateHome('/scratch/lane2-state');
    expect(defaultAuditPath({})).toBe(join('/scratch/lane2-state', 'audit.log'));
  });

  it('falls back to ~/.wicked-crew/audit.log when no state home is configured (default boot)', () => {
    setCrewStateHome(undefined);
    expect(defaultAuditPath({})).toBe(join(homedir(), '.wicked-crew', 'audit.log'));
  });

  it('the explicit WICKED_CREW_AUDIT_LOG override outranks the configured state home', () => {
    setCrewStateHome('/scratch/lane2-state');
    expect(defaultAuditPath({ WICKED_CREW_AUDIT_LOG: '/elsewhere/audit.log' })).toBe(
      '/elsewhere/audit.log',
    );
  });
});
