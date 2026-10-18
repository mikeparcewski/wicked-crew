import { test, expect, devices } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * Phones (390x844): the job demo is the same working demo, stacked. The proof tables reflow, the
 * four-plane map renders, and the page never scrolls sideways.
 */
// iPhone 12 geometry/UA only: the full descriptor's defaultBrowserType would switch to WebKit.
const iphone12 = devices['iPhone 12'];
test.use({
  viewport: iphone12.viewport,
  userAgent: iphone12.userAgent,
  deviceScaleFactor: iphone12.deviceScaleFactor,
  isMobile: iphone12.isMobile,
  hasTouch: iphone12.hasTouch,
});

test.describe('mobile (390×844)', () => {
  test('the job demo runs to delivery on a phone', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    await bringIntoView(job);
    await job.locator('[data-qe="PASS"]').click({ timeout: 30_000 });
    await expect(job.locator('.ln').last()).toContainText('evidence bundle ready', { timeout: 10_000 });
    await expect(job.locator('[data-gate="4"]')).toBeEnabled();
  });

  test('no horizontal overflow anywhere on the page', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the proofs and the four-plane map render on a phone', async ({ page }) => {
    await page.goto('/');
    for (const sel of ['.sandbox .tbl', '.tbl--layers', '.flow', '.tbl--wf', '.install--primary']) {
      const loc = page.locator(sel);
      await bringIntoView(loc);
      await expect(loc).toBeVisible();
    }
    const map = page.locator('.same-garden');
    await bringIntoView(map);
    await expect(map.locator('.sg-plane')).toHaveCount(4);
  });

  test('the hamburger menu lists crew as a site link', async ({ page }) => {
    await page.goto('/');
    await page.locator('#menuBtn').click();
    const menu = page.locator('#mobileMenu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: /crew/ })).toHaveAttribute('href', 'https://wc.wickedagile.com');
  });
});
