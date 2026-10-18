import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * prefers-reduced-motion: no page errors, every section visible, and the job demo skips its timing:
 * it reaches the QE decision at once and each choice lands at once.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });

test.describe('reduced motion', () => {
  test('page loads clean and the job demo runs without waiting', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    const job = page.locator('[data-job]');
    await expect(job.locator('[data-qe="PASS"]')).toBeVisible({ timeout: 2_000 });
    await job.locator('[data-qe="PASS"]').click();
    await expect(job.locator('.ln').last()).toContainText('evidence bundle ready', { timeout: 1_000 });
    for (const sel of ['.sandbox', '.gates', '.council', '.durable', '.same-garden', '.install--primary']) {
      const loc = page.locator(sel);
      await bringIntoView(loc);
      await expect(loc).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
});
