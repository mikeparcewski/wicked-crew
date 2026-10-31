// wicked-core#1216: the adapter hands the person's voice block to the engine on a POWER launch only
// (`LaunchOptions.voice`), where the engine gives it to the orchestrator alone. A phased launch, or a
// blank voice, sends none.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOptions } from 'wicked-core-ts';
import { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
const adapters: CoreAdapter[] = [];
afterEach(() => {
  for (const a of adapters.splice(0)) a.close();
});
afterAll(() => dirs.forEach(removeScratch));

const VOICE = '## Voice\n\nThis section changes how you talk to the person, never what you may do.\n\n- Your name with the person is "Wren".\n';

/** A stub adapter whose engine records the options it was launched with. */
function adapterCapturing(): { adapter: CoreAdapter; sent: Array<LaunchOptions & { voice?: string }> } {
  const dir = mkdtempSync(join(tmpdir(), 'voice-adapter-'));
  dirs.push(dir);
  const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  adapters.push(adapter);
  const sent: Array<LaunchOptions & { voice?: string }> = [];
  const real = (adapter as unknown as { core: object }).core;
  const core = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'launchRun') {
        return async (opts: LaunchOptions) => {
          sent.push(opts);
          return opts.sessionId;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  Object.defineProperty(adapter, 'core', { value: core });
  adapter.supportsPowerMode = () => true;
  return { adapter, sent };
}

function input(extra: Partial<LaunchRunInput>): LaunchRunInput {
  return { problem: 'fix it', sessionId: `run-${Math.random().toString(36).slice(2)}`, clisJson: '[]', ...extra };
}

describe('CoreAdapter.launchRun: the voice rides a power launch only', () => {
  it('sends the voice block with power', async () => {
    const { adapter, sent } = adapterCapturing();
    await adapter.launchRun(input({ power: true, voice: VOICE }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.power).toBe(true);
    expect(sent[0]?.voice).toBe(VOICE);
  });

  it('sends no voice on a phased launch, or when the voice is blank', async () => {
    const { adapter, sent } = adapterCapturing();
    await adapter.launchRun(input({ voice: VOICE }));
    await adapter.launchRun(input({ power: true, voice: '  \n' }));
    await adapter.launchRun(input({ power: true }));
    expect(sent).toHaveLength(3);
    for (const o of sent) expect(o).not.toHaveProperty('voice');
  });
});
