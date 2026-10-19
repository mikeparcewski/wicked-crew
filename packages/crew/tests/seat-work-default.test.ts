// crew 0.15.2 (#916) read a seat's council and work roles separately, and `seat_eligible_for_work`
// defaults to TRUE in the engine. A CUSTOM seat the operator wrote `enabled_for_council = false`
// with no work flag therefore became work-eligible on upgrade (the 0.15.2 release smoke's chat
// seat was re-seated onto review units this way). `seat.work_default` names each such seat on
// `/health.warnings` and `/diagnostics.seatGovernance.roleFindings`; built-in seats never warn,
// and an explicit `seat_eligible_for_work` (true or false) silences it.
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import {
  readOverlaySeatRoles,
  SEAT_WORK_DEFAULT_KIND,
  seatWorkDefaultNow,
  seatWorkDefaultWarnings,
} from '../src/api/seat-work-default.js';
import { CoreAdapter } from '../src/core/adapter.js';
import type { DiagnosticsResponse, HealthResponse } from '../src/core/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { removeScratch } from './setup/scratch.js';
import { useUnconfiguredTempHome } from './setup/temp-home.js';

/** One `[[cli]]` record of the registry's documented shape, plus extra lines. */
function record(key: string, ...extra: string[]): string {
  return ['[[cli]]', `key = "${key}"`, `display_name = "${key}"`, `binary = "/opt/${key}"`, `headless_invocation = '/opt/${key} -p "{PROMPT}"'`, ...extra, ''].join('\n');
}

const warn = (toml: string) => seatWorkDefaultWarnings(readOverlaySeatRoles(toml));

describe('seat.work_default (crew 0.15.2, #916)', () => {
  it('a custom seat with enabled_for_council = false and no seat_eligible_for_work key warns once, naming the seat and the fix', () => {
    const w = warn(record('chat-helper', 'enabled_for_council = false'));
    expect(w).toEqual([
      {
        kind: SEAT_WORK_DEFAULT_KIND,
        severity: 'warning',
        message:
          'seat chat-helper is not enabled for council but is now eligible for work (since crew 0.15.2 the two are separate); ' +
          'set seat_eligible_for_work = false to keep it off work',
      },
    ]);
  });

  it('an explicit seat_eligible_for_work, true or false, silences it', () => {
    expect(warn(record('worker', 'enabled_for_council = false', 'seat_eligible_for_work = true'))).toEqual([]);
    expect(warn(record('chat-only', 'enabled_for_council = false', 'seat_eligible_for_work = false'))).toEqual([]);
  });

  it('built-in seats never warn: agy written false/false, and a built-in override that omits the work flag', () => {
    expect(warn(record('agy', 'enabled_for_council = false', 'seat_eligible_for_work = false'))).toEqual([]);
    expect(warn(record('agy', 'enabled_for_council = false'))).toEqual([]);
    expect(warn(record('copilot', 'enabled_for_council = false'))).toEqual([]);
  });

  it('keys match exactly, as in the engine: agy#2 in the overlay is a custom seat and warns', () => {
    expect(warn(record('agy#2', 'enabled_for_council = false')).map((w) => w.message.split(' ')[1])).toEqual(['agy#2']);
  });

  it('a council-enabled or council-unset custom seat does not warn', () => {
    expect(warn(record('judge', 'enabled_for_council = true'))).toEqual([]);
    expect(warn(record('judge'))).toEqual([]);
  });

  it('one warning per affected seat, in overlay order', () => {
    const toml = [
      record('a', 'enabled_for_council = false'),
      record('b', 'enabled_for_council = true'),
      record('c', 'enabled_for_council = false   # chat only'),
    ].join('\n');
    expect(warn(toml).map((w) => w.message.split(' ')[1])).toEqual(['a', 'c']);
  });

  it("a key written twice folds by the engine rule: an omitted flag inherits the earlier record's value", () => {
    // The later record omits both flags: the engine keeps the earlier council-off; work stays default.
    expect(warn([record('chat-helper', 'enabled_for_council = false'), record('chat-helper')].join('\n'))).toHaveLength(1);
    // The earlier record wrote work = false: the later council-off record inherits it, so no warning.
    expect(warn([record('chat-helper', 'seat_eligible_for_work = false'), record('chat-helper', 'enabled_for_council = false')].join('\n'))).toEqual([]);
    // The later record re-enables the council: no warning.
    expect(warn([record('chat-helper', 'enabled_for_council = false'), record('chat-helper', 'enabled_for_council = true')].join('\n'))).toEqual([]);
  });

  it('parses TOML, not lines: triple quotes in a comment or a string, and an inline-table roster', () => {
    const comment = `# prompts may use """ or ''' for multi-line text\n`;
    const toml = comment + record('after-comment', 'enabled_for_council = false', `notes = 'contains """ too'`);
    expect(warn(toml).map((w) => w.message.split(' ')[1])).toEqual(['after-comment']);
    const inline = 'cli = [ { key = "inline", display_name = "x", binary = "/x", headless_invocation = "/x", enabled_for_council = false } ]\n';
    expect(warn(inline).map((w) => w.message.split(' ')[1])).toEqual(['inline']);
  });

  it('a malformed overlay throws here; the daemon reads it as no finding (see the wire case)', () => {
    expect(() => readOverlaySeatRoles('[[cli]]\nkey = "x\n')).toThrow();
  });

  it('reads only the record\'s own keys: a [cli.acp] sub-table and a multi-line string do not count', () => {
    const toml = [
      record('acp-chat', 'enabled_for_council = false'),
      '[cli.acp]',
      'binary = "/opt/acp-chat"',
      'seat_eligible_for_work = false',
      '',
      '[[cli]]',
      'key = "notes"',
      'display_name = """',
      'seat_eligible_for_work = false',
      '"""',
      'binary = "/opt/notes"',
      "headless_invocation = '/opt/notes'",
      'enabled_for_council = false',
      '',
    ].join('\n');
    expect(readOverlaySeatRoles(toml)).toEqual([
      { key: 'acp-chat', enabled_for_council: false, work_flag_written: false },
      { key: 'notes', enabled_for_council: false, work_flag_written: false },
    ]);
    expect(warn(toml)).toHaveLength(2);
  });
});

describe('seat.work_default on the wire', () => {
  const home = useUnconfiguredTempHome();
  const apps: FastifyInstance[] = [];
  const adapters: CoreAdapter[] = [];
  const scratch: string[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    for (const a of adapters.splice(0)) a.close();
    for (const d of scratch.splice(0)) removeScratch(d);
  });

  function overlay(text: string): void {
    const dir = join(home.home(), '.config', 'wicked-council');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'clis.toml'), text);
  }

  function routes(): FastifyInstance {
    const db = mkdtempSync(join(tmpdir(), 'crew-916-warn-'));
    scratch.push(db);
    const adapter = new CoreAdapter({ dbPath: join(db, 'core.db'), stub: true });
    adapters.push(adapter);
    const app = Fastify({ logger: false });
    registerRoutes(
      app,
      adapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      { governanceLegacyOutboxPath: null },
    );
    apps.push(app);
    return app;
  }

  it('/health.warnings and /diagnostics.seatGovernance.roleFindings carry the same finding; the explicit key clears it', async () => {
    overlay([record('chat-helper', 'enabled_for_council = false'), record('agy', 'enabled_for_council = false', 'seat_eligible_for_work = false')].join('\n'));
    const app = routes();
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect(health.status).toBe('ok');
    const found = (health.warnings ?? []).filter((w) => w.kind === SEAT_WORK_DEFAULT_KIND);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toMatch(/^seat chat-helper is not enabled for council but is now eligible for work/);
    const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
    expect(diag.seatGovernance?.roleFindings).toEqual(found);

    // The operator sets the key: the next probe says nothing (no restart).
    overlay([record('chat-helper', 'enabled_for_council = false', 'seat_eligible_for_work = false', '# edited'), record('agy', 'enabled_for_council = false', 'seat_eligible_for_work = false')].join('\n'));
    const after = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect((after.warnings ?? []).filter((w) => w.kind === SEAT_WORK_DEFAULT_KIND)).toEqual([]);
    expect(seatWorkDefaultNow()).toEqual([]);
  });

  it('a malformed overlay yields no finding (the engine reports the file itself)', () => {
    overlay('[[cli]]\nkey = "chat-helper\nenabled_for_council = false\n');
    expect(seatWorkDefaultNow({ HOME: home.home() })).toEqual([]);
  });

  it('no overlay: no finding, and roleFindings is an empty list', async () => {
    const app = routes();
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect((health.warnings ?? []).filter((w) => w.kind === SEAT_WORK_DEFAULT_KIND)).toEqual([]);
    const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
    expect(diag.seatGovernance?.roleFindings).toEqual([]);
  });
});
