import { describe, expect, it, vi } from 'vitest';
import type { CoreAdapter } from '../../src/core/adapter.js';
import { quiesceCampaign, quiesceRun } from './quiesce.js';

describe('engine teardown quiescence (crew#429)', () => {
  it('cancels a campaign and waits for its terminal state before allowing teardown', async () => {
    const cancelCampaign = vi.fn().mockResolvedValue('cancelled');
    const campaignDetail = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'cancelled' });
    const adapter = { cancelCampaign, campaignDetail } as unknown as CoreAdapter;

    await quiesceCampaign(adapter, 'fan-1', 1_000);

    expect(cancelCampaign).toHaveBeenCalledWith('fan-1');
    expect(campaignDetail).toHaveBeenCalledTimes(2);
  });

  it('rejects instead of silently deleting scratch while a run remains active', async () => {
    const adapter = {
      cancelRun: vi.fn().mockResolvedValue('running'),
      sessionsDetail: vi.fn().mockResolvedValue([{ session: { id: 'run-1', status: 'executing' } }]),
    } as unknown as CoreAdapter;

    await expect(quiesceRun(adapter, 'run-1', 0)).rejects.toThrow(
      'run run-1 did not reach a terminal state',
    );
  });

  it('does not mistake an unreadable campaign status for a terminal campaign', async () => {
    const adapter = {
      cancelCampaign: vi.fn().mockResolvedValue('running'),
      campaignDetail: vi.fn().mockRejectedValue(new Error('actor is busy')),
    } as unknown as CoreAdapter;

    await expect(quiesceCampaign(adapter, 'fan-1', 0)).rejects.toThrow(
      'campaign fan-1 did not reach a terminal state',
    );
  });
});
