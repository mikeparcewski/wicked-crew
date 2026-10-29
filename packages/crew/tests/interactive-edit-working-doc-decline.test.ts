// Program DES-POWER-MODE spike 3: a run's WORKING DOCUMENT (kind `phase-report`, marked by crew's sidecar) is never
// edited by a governed run. Structural feedback on it is declined by the edit seam with an honest error status, and
// nothing is launched. Real bus, fake engine.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKING_DOC_REFUSED_MESSAGE } from '../src/interactive/chat-events.js';
import { writeSidecar } from '../src/working-doc/store.js';
import { STATUS_POSTED } from '../src/interactive/draft-events.js';
import { EDIT_COMPLETED, FEEDBACK_PROCESSED, startInteractiveEditSubscriber } from '../src/interactive/edit-events.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const SEATS = JSON.stringify([{ key: 'stub', display_name: 'Stub', binary: 'stub', headless_invocation: 'stub {PROMPT}' }]);

async function waitFor(cond: () => boolean, ms = 8000, step = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

describe('the edit seam declines a run\'s working document (spike 3)', () => {
  let dir: string;
  let busDb: string;
  let docsRoot: string;
  let subs: { stop(): Promise<void> | void }[];
  let events: Array<{ event_type: string; payload: unknown }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-edit-wd-'));
    busDb = join(dir, 'bus.db');
    docsRoot = join(dir, 'docs');
    subs = [];
    events = [];
  });

  afterEach(async () => {
    for (const s of subs) await s.stop();
    removeScratch(dir);
  });

  it('posts an error status and launches nothing, whatever the manifest says', async () => {
    const bus = await import('wicked-bus');
    const docDir = join(docsRoot, 'checkout-demo');
    mkdirSync(docDir, { recursive: true });
    // No kind on the manifest (an interactive that records none): the sidecar alone makes it a working document.
    writeFileSync(join(docDir, 'versions.json'), JSON.stringify({ head: 0, versions: [{ version: 0, html_file: '_v0.html' }] }));
    writeFileSync(join(docDir, '_v0.html'), '<div data-wid="wd-goal">Goal</div>');
    writeSidecar(docDir, 'run-1');

    const probeDb = bus.openDb({ db_path: busDb });
    subs.push(
      bus.subscribe({
        db: probeDb,
        plugin: 'test-probe',
        filter: '*@wicked-interactive',
        cursor_init: 'oldest',
        pollIntervalMs: 25,
        maxRetries: 0,
        handler: (e) => {
          events.push({ event_type: e.event_type, payload: e.payload });
        },
      }),
    );
    const launches: LaunchRunInput[] = [];
    const adapter = {
      registerWorkflow: async (def: { id: string }) => def.id,
      launchRun: async (input: LaunchRunInput) => {
        launches.push(input);
        return input.sessionId;
      },
      onEvent: () => () => undefined,
      listRepos: async () => [],
    } as unknown as CoreAdapter;
    const sub = await startInteractiveEditSubscriber(adapter, {
      dbPath: busDb,
      pollIntervalMs: 25,
      heartbeatMs: 60_000,
      ledgerPath: join(dir, 'edit-ledger.json'),
      editDir: join(dir, 'edits'),
      clisJson: SEATS,
      resolveDocsRoot: () => docsRoot,
      log: () => {},
    });
    expect(sub).not.toBeNull();
    subs.push(sub!);

    const db = bus.openDb({ db_path: busDb });
    const config = bus.loadConfig({ db_path: busDb });
    bus.emit(db, config, {
      event_type: FEEDBACK_PROCESSED,
      domain: 'wicked-interactive',
      subdomain: 'feedback',
      payload: {
        document_id: 'checkout-demo',
        version: 3,
        applied: [],
        rejected: [],
        stale: [],
        awaiting_structural: 1,
        structural_items: [
          { selector: '[data-wid="w-step-3"]', instruction: 'show the coupon field', fragment: '<li data-wid="w-step-3">Checkout</li>' },
        ],
        ts: new Date().toISOString(),
      },
      producer_id: 'wi-service',
    });

    const isError = (e: { event_type: string; payload: unknown }) =>
      e.event_type === STATUS_POSTED &&
      (e.payload as { state?: string }).state === 'error' &&
      (e.payload as { document_id?: string }).document_id === 'checkout-demo';
    await waitFor(() => events.some(isError));
    expect((events.find(isError)!.payload as { message: string }).message).toBe(WORKING_DOC_REFUSED_MESSAGE);
    await new Promise((r) => setTimeout(r, 300));
    expect(launches.length, 'a working document is never edited by a governed run').toBe(0);
    expect(events.filter((e) => e.event_type === EDIT_COMPLETED).length).toBe(0);
    // Declined, not answered: no ledger row, so the frame is judged again on a replay.
    expect(sub!.ledger.size()).toBe(0);
  });
});
