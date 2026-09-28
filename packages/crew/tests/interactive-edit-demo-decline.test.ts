// studio#373 (M9b): demos are made by the Demo experience's `demo` preset, so a demo DOCUMENT has no
// answerer. Its step feedback (`feedback.processed` on a doc whose manifest says `kind: "demo"`) is
// declined by the edit seam with an honest error status naming Demo mode — never a storyboard-text
// edit the next recording would overwrite, and never a silent drop. Real bus, fake engine.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_DOC_MOVED_MESSAGE } from '../src/interactive/chat-events.js';
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

describe('the edit seam declines a demo document honestly (M9b)', () => {
  let dir: string;
  let busDb: string;
  let docsRoot: string;
  let subs: { stop(): Promise<void> | void }[];
  let events: Array<{ event_type: string; payload: unknown }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-edit-demo-'));
    busDb = join(dir, 'bus.db');
    docsRoot = join(dir, 'docs');
    subs = [];
    events = [];
  });

  afterEach(async () => {
    for (const s of subs) await s.stop();
    removeScratch(dir);
  });

  it('posts an error status naming Demo mode and launches nothing', async () => {
    const bus = await import('wicked-bus');
    const docDir = join(docsRoot, 'checkout-demo');
    mkdirSync(docDir, { recursive: true });
    writeFileSync(join(docDir, 'versions.json'), JSON.stringify({ kind: 'demo', head: 0, versions: [{ version: 0, html_file: '_v0.html' }] }));
    writeFileSync(join(docDir, '_v0.html'), '<section class="wi-demo">placeholder</section>');

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
    expect((events.find(isError)!.payload as { message: string }).message).toBe(DEMO_DOC_MOVED_MESSAGE);
    expect(DEMO_DOC_MOVED_MESSAGE).toMatch(/Demo mode/);
    expect(DEMO_DOC_MOVED_MESSAGE).toMatch(/Nothing was changed/);
    await new Promise((r) => setTimeout(r, 300));
    expect(launches.length, 'a demo handoff must not become a storyboard edit').toBe(0);
    expect(events.filter((e) => e.event_type === EDIT_COMPLETED).length).toBe(0);
    // Declined, not answered: no ledger row, so the frame is judged again on a replay.
    expect(sub!.ledger.size()).toBe(0);
  });
});
