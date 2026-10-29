// Spike 3 (codex on #1197): the dedicated retire route refuses a run's working document before the bridge is asked.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_ACTOR } from '../src/api/auth.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { registerInteractiveDocDelete } from '../src/interactive/doc-delete-routes.js';
import { projectDocsRoot } from '../src/interactive/project-root.js';
import { ProjectSettingsStore } from '../src/projects/settings.js';
import { writeSidecar } from '../src/working-doc/store.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the retire route and a working document', () => {
  it('is refused 403, and the bridge is never asked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wd-del-'));
    dirs.push(home);
    const settings = new ProjectSettingsStore(join(home, 'settings.json'), () => undefined);
    const adapter = {} as CoreAdapter;
    const opts = { stateHome: home, env: {} as NodeJS.ProcessEnv, home };
    const root = (await projectDocsRoot(adapter, settings, 'default', opts))!;
    writeSidecar(join(root, 'working-run-1'), 'run-1');
    let asked = 0;
    const app = Fastify();
    registerInteractiveDocDelete(app, adapter, {
      settings, audit: AuditLog.noop(), actorOf: () => LOCAL_ACTOR, dropDocLedgerRows: () => ({ ok: true, removed_keys: [] }) as never,
      pool: { ensure: async () => { asked += 1; throw new Error('never'); }, invalidate: () => undefined } as never,
      ...opts,
    });
    await app.ready();
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/projects/default/interactive/docs/working-run-1' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: 'working_doc', document_id: 'working-run-1' });
    expect(asked).toBe(0);
  });
});
