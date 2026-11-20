import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { deliverPrScript } from '../src/core/deliver.js';

const engine = vi.hoisted(() => ({ Core: { checkRunTree: undefined as ((...args: string[]) => Promise<string>) | undefined } }));
vi.mock('wicked-core-ts', () => engine);

it('T7 pins deliverPrScript byte for byte across resolver extraction', () => {
  const text = deliverPrScript('redeliver extraction pin', { originUrl: 'https://github.com/o/r.git', nonce: '0123456789abcdef' }).split(process.execPath).join('<node>');
  expect(createHash('sha256').update(text).digest('hex')).toBe('bb44bfdc9ea7fe7c12bc6a15008652789a85f612ff5b11607befec0e05eb1241');
});
it('exports the single shared CHANGELOG rebase mechanism', async () => {
  const deliver = await import('../src/core/deliver.js');
  expect(deliver).toHaveProperty('CHANGELOG_REBASE_LINES');
});

it('reads Core.checkRunTree at call time and names an unsupported engine addon', async () => {
  const { checkRunTreeViaCore } = await import('../src/api/redeliver.js');
  await expect(checkRunTreeViaCore('run', '/tree', '/repo', 'a'.repeat(40))).rejects.toMatchObject({ status: 501, message: expect.stringContaining('unsupported') });
  engine.Core.checkRunTree = async () => JSON.stringify({ passed: true, head: 'checked' });
  await expect(checkRunTreeViaCore('run', '/tree', '/repo', 'a'.repeat(40))).resolves.toMatchObject({ passed: true, head: 'checked' });
});
