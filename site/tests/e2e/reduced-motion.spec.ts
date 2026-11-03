import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * prefers-reduced-motion: no page errors, every section visible, and every animation shows its end
 * state instead. The job demo shows the finished job and nothing replays on its own; Run goes straight
 * to the QE decision and each choice lands at once. The dispute shows its ruling, the workflow rail
 * shows a finished job, and nothing autoplays.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });

test.describe('reduced motion', () => {
  test('page loads clean and the job demo runs without waiting', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    const job = page.locator('[data-job]');
    await expect(job.locator('[data-panel]')).toContainText('DELIVERED');
    await page.waitForTimeout(2_500);
    // no replay on its own
    await expect(job.locator('[data-panel]')).toContainText('DELIVERED');
    await job.locator('[data-job-run]').click();
    await expect(job.locator('[data-qe="PASS"]')).toBeVisible({ timeout: 1_000 });
    await job.locator('[data-qe="PASS"]').click();
    await expect(job.locator('.ln').last()).toContainText('evidence bundle ready', { timeout: 1_000 });
    for (const sel of ['#build', '#review', '#gate', '#deliver', '#news', '.same-garden', '.install--primary']) {
      const loc = page.locator(sel);
      await bringIntoView(loc);
      await expect(loc).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test('the explorables show their end states', async ({ page }) => {
    await page.goto('/');
    await bringIntoView(page.locator('[data-disp]'));
    await expect(page.locator('[data-dpanel="4"]')).toHaveClass(/is-on/);
    await expect(page.locator('[data-dstep="4"]')).toHaveAttribute('aria-current', 'step');
    await bringIntoView(page.locator('[data-wf]'));
    await expect(page.locator('[data-wf-status]')).toContainText('done');
    await expect(page.locator('[data-wf-panel="0"] .wf-node.is-done')).toHaveCount(6);
    // the What's new tiles are simply there (no stagger)
    await bringIntoView(page.locator('#news'));
    expect(await page.locator('.news-list li').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });
});
