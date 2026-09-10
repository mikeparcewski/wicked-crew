// Where the governance store and its dead letters live (crew#495, acceptance finding F-022).
//
// The engine's emit seam writes every `wicked.*` governance event to the estate store named by
// WICKED_ESTATE_DB and dead-letters to WICKED_APPS_EMIT_DEADLETTER when it cannot; `serve` set
// neither, so every default install spooled every event under the operator's HOME. These pin the
// pure resolution (`core/governance-store.ts`): the default is a SIDECAR of the core db that the
// state-home fence registry already classifies (the `core.db` prefix claim), the override ladder,
// the outbox never leaving the state home, the env handoff, and the boot-value restore for children.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyEmitOrigin,
  applyGovernanceStoreEnv,
  canonicalPath,
  childEnvWithBootEstateDb,
  EMIT_DEADLETTER_ENGINE_ENV,
  EMIT_ORIGIN_ENGINE_ENV,
  emitOrigin,
  ESTATE_DB_ENGINE_ENV,
  GOVERNANCE_DB_ENV,
  GovernanceStoreError,
  governanceSidecarDb,
  governanceSidecarDir,
  governanceSidecarOutbox,
  isStoreSpec,
  isUrlSpec,
  legacyHomeOutboxPath,
  redactStoreSpec,
  resolveGovernanceStore,
} from '../src/core/governance-store.js';
import { removeScratch } from './setup/scratch.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('resolveGovernanceStore (crew#495)', () => {
  it('defaults to the core db\'s SIDECAR — <core db>.governance/governance.db — so every --db gets its own store and outbox', () => {
    const a = resolveGovernanceStore({ coreDbPath: '/homes/a/.wicked-crew/core.db' });
    const b = resolveGovernanceStore({ coreDbPath: '/scratch/fresh/state/core.db' });
    expect(a).toEqual({
      dbPath: resolve('/homes/a/.wicked-crew/core.db.governance/governance.db'),
      displayPath: resolve('/homes/a/.wicked-crew/core.db.governance/governance.db'),
      source: 'core-db-sidecar',
      coreDbPath: resolve('/homes/a/.wicked-crew/core.db'),
      outboxPath: resolve('/homes/a/.wicked-crew/core.db.governance/emit-outbox.ndjson'),
      outboxSource: 'core-db-sidecar',
      sidecarDir: resolve('/homes/a/.wicked-crew/core.db.governance'),
    });
    expect(b.sidecarDir).toBe(resolve('/scratch/fresh/state/core.db.governance'));
    expect(a.dbPath).not.toBe(b.dbPath);
    expect(a.outboxPath).not.toBe(b.outboxPath);
    // A custom db name keeps the same sidecar convention core uses for `<db>.events` and crew for `<db>.bus`.
    expect(governanceSidecarDir('/x/mydb.sqlite')).toBe(resolve('/x/mydb.sqlite.governance'));
    expect(governanceSidecarDb('/x/mydb.sqlite')).toBe(resolve('/x/mydb.sqlite.governance/governance.db'));
    expect(governanceSidecarOutbox('/x/mydb.sqlite')).toBe(resolve('/x/mydb.sqlite.governance/emit-outbox.ndjson'));
    // A relative --db resolves against the cwd ONCE, here — never differently on a later join.
    expect(resolveGovernanceStore({ coreDbPath: 'scratch/core.db' }).sidecarDir).toBe(resolve('scratch/core.db.governance'));
  });

  it('the override ladder: --governance-db › WICKED_CREW_GOVERNANCE_DB › an inherited WICKED_ESTATE_DB › the sidecar', () => {
    const core = { coreDbPath: '/x/core.db' };
    expect(resolveGovernanceStore({ ...core, flagDb: '/opt/shared/gov.db', envCrewDb: '/ignored', envEstateDb: '/ignored' })).toMatchObject({
      dbPath: resolve('/opt/shared/gov.db'),
      source: 'flag',
    });
    expect(resolveGovernanceStore({ ...core, envCrewDb: '/opt/crew.db', envEstateDb: '/ignored' })).toMatchObject({
      dbPath: resolve('/opt/crew.db'),
      source: 'env-crew',
    });
    expect(resolveGovernanceStore({ ...core, envEstateDb: '/opt/estate/graph.db' })).toMatchObject({
      dbPath: resolve('/opt/estate/graph.db'),
      source: 'env-estate',
    });
    // Empty / whitespace-only values are "unset" at every rung.
    expect(resolveGovernanceStore({ ...core, flagDb: '', envCrewDb: '  ', envEstateDb: '' }).source).toBe('core-db-sidecar');
    // A relative explicit store is spelled absolute; `:memory:` (the engine's own spec) is left exactly as written.
    expect(resolveGovernanceStore({ ...core, flagDb: 'rel/gov.db' }).dbPath).toBe(resolve('rel/gov.db'));
    expect(resolveGovernanceStore({ ...core, flagDb: ':memory:' }).dbPath).toBe(':memory:');
  });

  it('REFUSES a URL spec at every explicit rung — the emit seam is SQLite-only, so a postgres store would dead-letter 100 % — and the refusal never echoes a credential', () => {
    const core = { coreDbPath: '/x/core.db' };
    for (const input of [
      { ...core, flagDb: 'postgres://user:s3cret@h:5432/gov' },
      { ...core, envCrewDb: 'postgresql://user:s3cret@h/gov' },
      { ...core, envEstateDb: 'postgres://h/gov' },
    ]) {
      let thrown: unknown;
      try {
        resolveGovernanceStore(input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(GovernanceStoreError);
      const msg = (thrown as Error).message;
      expect(msg).toMatch(/emit seam stores to SQLite/);
      expect(msg).toMatch(/not supported/);
      expect(msg).not.toContain('s3cret');
    }
    expect(() => resolveGovernanceStore({ ...core, flagDb: 'postgres://user:s3cret@h/gov' })).toThrow(/postgres:\/\/\*\*\*@h\/gov/);
    expect(isUrlSpec('postgres://h/db')).toBe(true);
    expect(isUrlSpec('/x/gov.db')).toBe(false);
  });

  it('REFUSES the daemon\'s own core db and the bus db as the governance store — a second writer on a store another process owns', () => {
    const core = { coreDbPath: '/state/core.db', busDbPath: '/state/core.db.bus/bus.db' };
    expect(() => resolveGovernanceStore({ ...core, flagDb: '/state/core.db' })).toThrow(GovernanceStoreError);
    expect(() => resolveGovernanceStore({ ...core, flagDb: '/state/core.db' })).toThrow(/own core db/);
    expect(() => resolveGovernanceStore({ ...core, envEstateDb: '/state/../state/core.db' })).toThrow(/own core db/);
    expect(() => resolveGovernanceStore({ ...core, envCrewDb: '/state/core.db.bus/bus.db' })).toThrow(/bus db/);
    // …while a sibling file beside them is fine, and the sidecar default never collides.
    expect(resolveGovernanceStore({ ...core, flagDb: '/state/other.db' }).source).toBe('flag');
    expect(resolveGovernanceStore(core).dbPath).toBe(resolve('/state/core.db.governance/governance.db'));
  });

  it('…and the refusal compares CANONICAL paths: a symlink to the core db, or to its directory, is caught (canonicalPath resolves the nearest existing ancestor)', () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'crew-gov-canon-'));
    try {
      const state = join(scratchDir, 'state');
      mkdirSync(state);
      writeFileSync(join(state, 'core.db'), '', 'utf8');
      const fileLink = join(scratchDir, 'core-link.db');
      const dirLink = join(scratchDir, 'state-link');
      symlinkSync(join(state, 'core.db'), fileLink);
      symlinkSync(state, dirLink);
      const core = { coreDbPath: join(state, 'core.db') };
      expect(() => resolveGovernanceStore({ ...core, flagDb: fileLink })).toThrow(/own core db/);
      expect(() => resolveGovernanceStore({ ...core, flagDb: join(dirLink, 'core.db') })).toThrow(/own core db/);
      expect(() => resolveGovernanceStore({ ...core, busDbPath: join(state, 'core.db.bus', 'bus.db'), flagDb: join(dirLink, 'core.db.bus', 'bus.db') })).toThrow(/bus db/);
      // A not-yet-existing file under the linked directory canonicalizes through the link…
      expect(canonicalPath(join(dirLink, 'new', 'gov.db'))).toBe(join(realpathSync.native(state), 'new', 'gov.db'));
      // …and a sibling that is NOT an alias is admitted.
      expect(resolveGovernanceStore({ ...core, flagDb: join(dirLink, 'other.db') }).source).toBe('flag');
    } finally {
      removeScratch(scratchDir);
    }
  });

  it('isStoreSpec is `:memory:` and nothing else; a Windows drive written with forward slashes is a PATH, not a URL', () => {
    expect(isStoreSpec(':memory:')).toBe(true);
    expect(isStoreSpec('postgres://h/db')).toBe(false); // a URL is refused, not a spec
    expect(isStoreSpec('C://tmp/gov.db')).toBe(false);
    expect(isStoreSpec('/state/core.db.governance/governance.db')).toBe(false);
    expect(isUrlSpec('C://tmp/gov.db')).toBe(false);
    expect(isUrlSpec('C:\\tmp\\gov.db')).toBe(false);
    expect(isUrlSpec('postgresql://h:5432/db')).toBe(true);
    // …and a drive path resolves like any other path rather than riding through verbatim.
    expect(resolveGovernanceStore({ coreDbPath: '/x/core.db', flagDb: 'C://tmp/gov.db' }).dbPath).toBe(resolve('C://tmp/gov.db'));
  });

  it('redactStoreSpec is defence in depth: a URL\'s credentials become ***, paths and :memory: are unchanged, and displayPath equals dbPath for every admitted value', () => {
    expect(redactStoreSpec('postgres://user:s3cret@db.internal:5432/gov')).toBe('postgres://***@db.internal:5432/gov');
    expect(redactStoreSpec('postgresql://user@h/db')).toBe('postgresql://***@h/db');
    expect(redactStoreSpec('postgres://h/db')).toBe('postgres://h/db');
    expect(redactStoreSpec(':memory:')).toBe(':memory:');
    expect(redactStoreSpec('/state/core.db.governance/governance.db')).toBe('/state/core.db.governance/governance.db');
    // An `@` in a PATH is not userinfo.
    expect(redactStoreSpec('/homes/op@corp/gov.db')).toBe('/homes/op@corp/gov.db');
    for (const loc of [
      resolveGovernanceStore({ coreDbPath: '/x/core.db' }),
      resolveGovernanceStore({ coreDbPath: '/x/core.db', flagDb: '/homes/op@corp/gov.db' }),
      resolveGovernanceStore({ coreDbPath: '/x/core.db', flagDb: ':memory:' }),
    ]) {
      expect(loc.displayPath).toBe(loc.dbPath);
    }
  });

  it('the outbox lives in the sidecar whichever store won — never under HOME — unless the engine\'s own override is set', () => {
    const explicitStore = resolveGovernanceStore({ coreDbPath: '/x/core.db', flagDb: '/opt/shared/gov.db' });
    expect(explicitStore.outboxPath).toBe(resolve('/x/core.db.governance/emit-outbox.ndjson'));
    expect(explicitStore.outboxSource).toBe('core-db-sidecar');
    const armed = resolveGovernanceStore({ coreDbPath: '/x/core.db', envOutbox: '/tmp/hermetic/emit-outbox.ndjson' });
    expect(armed.outboxPath).toBe(resolve('/tmp/hermetic/emit-outbox.ndjson'));
    expect(armed.outboxSource).toBe('env');
    expect(armed.dbPath).toBe(resolve('/x/core.db.governance/governance.db')); // the outbox override never moves the store
    // No resolution ever spells the engine's HOME default.
    for (const loc of [explicitStore, armed, resolveGovernanceStore({ coreDbPath: '/x/core.db' })]) {
      expect(loc.outboxPath.includes('.something-wicked')).toBe(false);
    }
  });

  it('the sidecar is classified by the state-home fence registry through the `core.db` PREFIX claim — no registry change, no core release', () => {
    const registry = JSON.parse(
      readFileSync(join(HERE, 'fixtures', 'state-home-subtrees.json'), 'utf8'),
    ) as { entries: Array<{ name?: string; prefix?: string; kind: string; owner: string }> };
    const classify = (top: string) =>
      registry.entries.find((e) => (e.name !== undefined ? e.name === top : top.startsWith(e.prefix as string)));
    const { sidecarDir } = resolveGovernanceStore({ coreDbPath: '/state/core.db' });
    const top = sidecarDir.slice(resolve('/state').length + 1);
    expect(top).toBe('core.db.governance');
    expect(classify(top)).toMatchObject({ prefix: 'core.db', kind: 'file-with-sidecars', owner: 'engine' });
  });
});

describe('the engine handoff', () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) removeScratch(scratch);
    scratch = undefined;
  });

  it('applyGovernanceStoreEnv exports WICKED_ESTATE_DB + WICKED_APPS_EMIT_DEADLETTER and creates the sidecar (the engine does not create a missing parent)', () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-gov-store-'));
    const loc = resolveGovernanceStore({ coreDbPath: join(scratch, 'core.db') });
    const env: NodeJS.ProcessEnv = {};
    expect(existsSync(loc.sidecarDir)).toBe(false);
    applyGovernanceStoreEnv(loc, env);
    expect(existsSync(loc.sidecarDir)).toBe(true);
    expect(env[ESTATE_DB_ENGINE_ENV]).toBe(loc.dbPath);
    expect(env[EMIT_DEADLETTER_ENGINE_ENV]).toBe(loc.outboxPath);
    // An explicit store elsewhere gets ITS parent created too; a spec is never treated as a path.
    const elsewhere = resolveGovernanceStore({ coreDbPath: join(scratch, 'core.db'), flagDb: join(scratch, 'shared', 'gov.db') });
    applyGovernanceStoreEnv(elsewhere, env);
    expect(existsSync(join(scratch, 'shared'))).toBe(true);
    expect(() => applyGovernanceStoreEnv(resolveGovernanceStore({ coreDbPath: join(scratch as string, 'core.db'), flagDb: ':memory:' }), env)).not.toThrow();
    expect(env[ESTATE_DB_ENGINE_ENV]).toBe(':memory:');
  });

  it('the origin stamp names the daemon (version, pid, port once bound, core db) and is exported under the engine\'s variable', () => {
    const env: NodeJS.ProcessEnv = {};
    const before = emitOrigin({ version: '0.7.27', pid: 4242, coreDbPath: '/state/core.db' });
    expect(before).toBe(`wicked-crew@0.7.27 serve pid=4242 db=${resolve('/state/core.db')}`);
    const after = emitOrigin({ version: '0.7.27', pid: 4242, coreDbPath: '/state/core.db', port: 7701 });
    expect(after).toBe(`wicked-crew@0.7.27 serve pid=4242 port=7701 db=${resolve('/state/core.db')}`);
    applyEmitOrigin(after, env);
    expect(env[EMIT_ORIGIN_ENGINE_ENV]).toBe(after);
  });

  it('childEnvWithBootEstateDb hands a child the BOOT value of WICKED_ESTATE_DB back — the operator\'s instruction, not the daemon\'s sidecar — and drops crew\'s own override', () => {
    const daemonEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      [ESTATE_DB_ENGINE_ENV]: '/state/core.db.governance/governance.db',
      [GOVERNANCE_DB_ENV]: '/opt/operator/gov.db',
    };
    const unsetAtBoot = childEnvWithBootEstateDb(daemonEnv, undefined);
    expect(unsetAtBoot[ESTATE_DB_ENGINE_ENV]).toBeUndefined();
    expect(unsetAtBoot[GOVERNANCE_DB_ENV]).toBeUndefined(); // needed at resolution only — never a child's
    expect(unsetAtBoot['PATH']).toBe('/usr/bin');
    const operatorStore = childEnvWithBootEstateDb(daemonEnv, '/opt/estate/graph.db');
    expect(operatorStore[ESTATE_DB_ENGINE_ENV]).toBe('/opt/estate/graph.db');
    // The daemon's own env is never mutated.
    expect(daemonEnv[ESTATE_DB_ENGINE_ENV]).toBe('/state/core.db.governance/governance.db');
  });

  it('legacyHomeOutboxPath spells the engine\'s pre-fix HOME default (for REPORTING only) and is null without a home', () => {
    expect(legacyHomeOutboxPath({ HOME: '/homes/op' })).toBe(join('/homes/op', '.something-wicked', 'wicked-apps', 'emit-outbox.ndjson'));
    expect(legacyHomeOutboxPath({ USERPROFILE: 'C:\\Users\\op' })).toBe(join('C:\\Users\\op', '.something-wicked', 'wicked-apps', 'emit-outbox.ndjson'));
    expect(legacyHomeOutboxPath({})).toBeNull();
    expect(legacyHomeOutboxPath({ HOME: '' })).toBeNull();
  });
});
