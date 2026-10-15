import { describe, expect, it, vi } from 'vitest';
import { CoreAdapter } from '../src/core/adapter.js';
import { AskError, AskUnsupportedError } from '../src/core/types.js';

const unit = { runId: 'run-1', ord: 2, attempt: 1, seat: 'codex', timeoutSecs: 600 };
const request = { token: 'wmt_test', question: 'Which?', choices: ['A', 'B'], recommended: 1 };

function fixture() {
  const core = {
    askUnit: vi.fn(async () => JSON.stringify(unit)),
    openAsk: vi.fn(async () => JSON.stringify({ ...unit, elicitationId: 'ask-1' })),
    closeAsk: vi.fn(async () => true),
  };
  // No actor is needed to check this JSON/NAPI boundary.
  const adapter = Object.create(CoreAdapter.prototype) as CoreAdapter;
  Object.assign(adapter, { core });
  return { core, adapter };
}

describe('ask adapter bindings', () => {
  it('passes the token without recording or opening a prompt', async () => {
    const { core, adapter } = fixture();
    expect(await adapter.askUnit('wmt_test')).toEqual(unit);
    expect(core.askUnit).toHaveBeenCalledExactlyOnceWith('wmt_test');
    expect(core.openAsk).not.toHaveBeenCalled();
  });

  it('parses the open ticket and forwards close with the flat NAPI signature', async () => {
    const { core, adapter } = fixture();
    expect(await adapter.openAsk(request)).toEqual({ ...unit, elicitationId: 'ask-1' });
    expect(core.openAsk).toHaveBeenCalledExactlyOnceWith(JSON.stringify(request));
    expect(await adapter.closeAsk('ask-1', 'timeout')).toBe(true);
    expect(core.closeAsk).toHaveBeenCalledExactlyOnceWith('ask-1', 'timeout');
    core.closeAsk.mockResolvedValue(false);
    expect(await adapter.closeAsk('ask-1', 'teardown')).toBe(false);
  });

  it.each(['invalid_token', 'bad_request', 'run_ended'] as const)('maps %s to a typed error', async (code) => {
    const { core, adapter } = fixture();
    core.openAsk.mockRejectedValue(new Error(`${code}: refused`));
    await expect(adapter.openAsk(request)).rejects.toEqual(new AskError(code, `${code}: refused`));
    core.askUnit.mockRejectedValue(new Error(`${code}: refused`));
    await expect(adapter.askUnit('wmt_test')).rejects.toMatchObject({ name: 'AskError', code });
  });

  it('preserves unexpected binding failures', async () => {
    const { core, adapter } = fixture();
    const error = new Error('actor unavailable');
    core.openAsk.mockRejectedValue(error);
    await expect(adapter.openAsk(request)).rejects.toBe(error);
  });

  it.each(['askUnit', 'openAsk', 'closeAsk'] as const)('feature-detects missing %s', async (method) => {
    const { core, adapter } = fixture();
    expect(adapter.askSupported()).toBe(true);
    Object.assign(core, { [method]: undefined });
    expect(adapter.askSupported()).toBe(false);
    const call = method === 'askUnit' ? adapter.askUnit('wmt_test')
      : method === 'openAsk' ? adapter.openAsk(request) : adapter.closeAsk('ask-1', 'timeout');
    await expect(call).rejects.toBeInstanceOf(AskUnsupportedError);
  });
});
