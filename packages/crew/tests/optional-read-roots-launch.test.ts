// wicked-core#1463 / crew#1883 — CoreAdapter.launchRun hands the engine the optional read roots it
// was given, beside the read roots they mark, and nothing when there are none. The route tests
// replace launchRun, so this pins the adapter's own forwarding (codex round 1 on crew#1893).
// Same fake-engine technique as deliver-launch.test.ts: an own property shadows the napi method.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchOptions } from 'wicked-core-ts';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;
let launched: Array<LaunchOptions & { optionalReadRoots?: string[] }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'optional-read-roots-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  launched = [];
  (adapter as unknown as { core: Record<string, unknown> }).core['launchRun'] = (opts: LaunchOptions) => {
    launched.push(opts);
    return Promise.resolve(opts.sessionId);
  };
});

afterEach(() => {
  adapter.close();
  removeScratch(dir);
});

describe('launchRun forwards optionalReadRoots (wicked-core#1463)', () => {
  it('hands the engine the optional roots, exactly as given, beside the read roots they mark', async () => {
    await adapter.launchRun({
      problem: 'p',
      sessionId: 'run-opt',
      clisJson: '[]',
      extraReadRoots: ['/srv/repos/alpha', '/srv/repos/beta', '/chats/c1/attachments'],
      optionalReadRoots: ['/srv/repos/alpha', '/srv/repos/beta'],
    });
    const opts = launched.at(-1)!;
    expect(opts.optionalReadRoots).toEqual(['/srv/repos/alpha', '/srv/repos/beta']);
    expect(opts.extraReadRoots).toEqual(['/srv/repos/alpha', '/srv/repos/beta', '/chats/c1/attachments']);
  });

  it.each([undefined, []])('sends no optionalReadRoots when given %j', async (optional) => {
    await adapter.launchRun({
      problem: 'p',
      sessionId: 'run-none',
      clisJson: '[]',
      extraReadRoots: ['/srv/repos/alpha'],
      ...(optional !== undefined ? { optionalReadRoots: optional } : {}),
    });
    const opts = launched.at(-1)!;
    expect(opts).not.toHaveProperty('optionalReadRoots');
    expect(opts.extraReadRoots).toEqual(['/srv/repos/alpha']);
  });
});
