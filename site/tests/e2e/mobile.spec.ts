import { test, expect, devices } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * Phones (390x844): the job demo is the same working demo, laid out for a phone (a 3-line ticker and a
 * fixed receipt panel, so nothing grows while it runs). The explorables become tappable lists, What's
 * new is a carousel, the four-plane map renders, and the page never scrolls sideways.
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

  test('the demo card is laid out for a thumb: title first, Run and Kill side by side, 24px gate chips', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    const title = await job.locator('.job-t').boundingBox();
    const run = await job.locator('[data-job-run]').boundingBox();
    const kill = await job.locator('[data-job-kill]').boundingBox();
    expect(title!.y).toBeLessThan(run!.y);
    expect(Math.abs(run!.y - kill!.y), 'Run and Kill are not on one row').toBeLessThanOrEqual(1);
    expect(Math.abs(run!.width - kill!.width)).toBeLessThanOrEqual(2);
    for (const k of [0, 1, 2, 3, 4]) {
      const g = await job.locator(`[data-gate="${k}"]`).boundingBox();
      expect(g!.height, `gate chip ${k} is under the 24px target size`).toBeGreaterThanOrEqual(24);
    }
  });

  test('the demo never changes the hero height on a phone (fixed ticker and receipt panel)', async ({ page }) => {
    await page.goto('/');
    const job = page.locator('[data-job]');
    const heroH = () => page.evaluate(() => Math.round(document.querySelector('.hero')!.getBoundingClientRect().height));
    const h0 = await heroH();
    await job.locator('[data-qe="CONDITIONAL"]').click({ timeout: 30_000 });
    await expect(job.locator('.ask-again')).toBeVisible();
    expect(await heroH(), 'the refused-delivery receipt grew the hero').toBe(h0);
    await job.locator('.ask-again [data-qe="PASS"]').click();
    await expect(job.locator('[data-panel]')).toContainText('DELIVERED', { timeout: 10_000 });
    expect(await heroH()).toBe(h0);
  });

  test('workflow names never wrap, and What’s new is a carousel', async ({ page }) => {
    await page.goto('/');
    const lines = await page.locator('.wf-tab code').evaluateAll((els) => els.map((e) => e.getClientRects().length));
    expect(lines.every((n) => n === 1), `a workflow name broke across lines: ${lines}`).toBe(true);
    const news = page.locator('#news');
    await bringIntoView(news);
    await expect(news.locator('[data-car-count]')).toHaveText('1 of 6');
    await news.locator('[data-car-next]').click();
    await expect(news.locator('[data-car-count]')).toHaveText('2 of 6');
    const overflow = await news.locator('.news-list').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(true);
  });

  test('the proofs and the four-plane map render on a phone', async ({ page }) => {
    await page.goto('/');
    for (const sel of ['.sbx-map', '.disp-steps', '.rcx-card', '.wf-stage', '.install--primary']) {
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
