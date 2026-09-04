// crew#309 — A STUB-ENGINE DAEMON MUST NOT ANSWER ANOTHER PRODUCT'S BUS TRAFFIC.
//
// # What went wrong
//
// `wicked.interactive.doc.created` was answered by a crew daemon running `--stub`. Under
// `Core.spawnStub` the engine is a `StubDispatcher` (every seat votes for the first roster option,
// no subprocess) plus a `StubStepRunner` (fixed text, no CLI), so the "governed run" resolved every
// phase Ok inside a millisecond and narrated the whole lifecycle onto interactive's vocabulary —
// council convened, seats picked, phases dispatched, TWO gate approvals — for work that never
// happened. On the shared bus the damage is not confined to the stub daemon either: the durable
// cursor is keyed by plugin name (`wicked-crew-interactive-draft`), so the frame it claimed is a
// frame the production daemon never saw.
//
// The recorded incident (issue #309, bus rows 242632–242643, 2026-08-23T13:29:54.994Z →
// 13:29:55.046Z, 52ms wide) carries the tell: BOTH units were assigned the same first-roster seat
// ("Council picked claude for outline…", "Council picked claude for draft…") within 1ms of
// convening — the StubDispatcher's signature. The real runs five minutes later took ~95s to vote
// and split their seats (`pi` for outline, `claude` for draft). The run id the stub narrated
// (3c106511-6340-4465-b029-30cb5b004416) exists in NO store, NO event log and NO audit trail on the
// daemon the operator was watching: `GET /runs/:id` 404s on a run the bus says was gate-approved.
//
// # What this suite pins
//
// The four ANSWERING seams — draft / edit / demo / chat, the ones that reply to interactive by
// LAUNCHING A GOVERNED RUN — must not arm on a stub-engine daemon, and must still arm on a
// production-engine one. Arming is observed through `registerWorkflow`: each seam registers its
// own workflow def with the engine as the first thing it does, so a seam that never registers is a
// seam that never opened a subscription.
//
// Both directions matter. "Refused under --stub" alone is satisfied by a guard that never arms
// anything, which would silently retire the seams for every real daemon — so the production case
// is asserted in the same file, off the same fake adapter, differing only in `stub`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SystemSettings, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

/** Every workflow id an interactive seam armed with the engine this boot. */
let registered: string[];
let tmp: string;

/**
 * The minimal adapter surface `createServer` + the interactive seams touch at boot. `stub` is the
 * field under test; `registerWorkflow` is the arming probe.
 */
function fakeAdapter(stub: boolean): CoreAdapter {
  return {
    stub,
    getSettings: async (): Promise<SystemSettings> => ({ graphNodeLimit: 150 }),
    projectsSupported: (): boolean => false,
    onEvent: (): (() => void) => () => undefined,
    registerWorkflow: async (def: WorkflowDef): Promise<string> => {
      registered.push(def.id);
      return 'registered';
    },
  } as unknown as CoreAdapter;
}

/** Boot the daemon with all four answering seams enabled, on a bus db of this test's own. */
async function bootWithSeams(stub: boolean): Promise<Awaited<ReturnType<typeof createServer>>> {
  const dbPath = join(tmp, 'bus.db');
  const seam = { enabled: true, dbPath, pollIntervalMs: 60_000 };
  return createServer(fakeAdapter(stub), {
    projectEvents: { disabled: true },
    interactiveDraftEvents: { ...seam, ledgerPath: join(tmp, 'draft.json'), draftDir: join(tmp, 'drafts') },
    interactiveEditEvents: { ...seam, ledgerPath: join(tmp, 'edit.json'), editDir: join(tmp, 'edits') },
    interactiveDemoEvents: { ...seam, ledgerPath: join(tmp, 'demo.json'), demoDir: join(tmp, 'demos') },
    interactiveChatEvents: { ...seam, ledgerPath: join(tmp, 'chat.json'), chatDir: join(tmp, 'chats') },
  });
}

describe('crew#309: the stub engine is never an answerer', () => {
  beforeEach(() => {
    registered = [];
    tmp = mkdtempSync(join(tmpdir(), 'crew309-'));
  });
  afterEach(() => {
    removeScratch(tmp);
  });

  it('refuses to arm the interactive answering seams on a --stub daemon', async () => {
    const app = await bootWithSeams(true);
    try {
      // A registered workflow here means a seam armed: it holds a durable cursor on the shared
      // bus and will answer the next doc.created with a fabricated, gate-approved, empty run.
      expect(registered).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('still arms them on a production-engine daemon', async () => {
    const app = await bootWithSeams(false);
    try {
      // The guard must key on the ENGINE, not on "interactive seams are risky" — a real daemon
      // answering interactive is the whole point of these seams.
      expect(registered.length).toBeGreaterThan(0);
      expect(registered).toContain('interactive-draft');
    } finally {
      await app.close();
    }
  });
});
