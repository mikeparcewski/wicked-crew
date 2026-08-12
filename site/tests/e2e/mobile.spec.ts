import { test, expect, devices } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * Phone-native fallbacks (≤600px): the interactive studio mock and gate
 * console are desktop affordances — a phone gets the documented static
 * panels (.studio-static, .gc-static) instead.
 */
// iPhone 12 geometry/UA only — the full descriptor carries
// defaultBrowserType: 'webkit', which would switch away from the cached Chromium.
const iphone12 = devices['iPhone 12'];
test.use({
  viewport: iphone12.viewport,
  userAgent: iphone12.userAgent,
  deviceScaleFactor: iphone12.deviceScaleFactor,
  isMobile: iphone12.isMobile,
  hasTouch: iphone12.hasTouch,
});

test.describe('mobile (390×844)', () => {
  test('the static studio fallback replaces the interactive console', async ({ page }) => {
    await page.goto('/');

    // Interactive mock hidden, static launch → watch → steer story shown.
    await expect(page.locator('.studio-mock')).toBeHidden();
    const staticStudio = page.locator('.studio-static');
    await expect(staticStudio).toBeVisible();
    await expect(staticStudio.locator('.sts-steps li')).toHaveCount(3);
    await expect(staticStudio).toContainText('Launch');
    await expect(staticStudio).toContainText('Steer');
  });

  test('the static gate verdict replaces the interactive ladder', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.gc[data-gc]')).toBeHidden();
    const gcStatic = page.locator('.gc-static');
    await bringIntoView(gcStatic);
    await expect(gcStatic).toBeVisible();
    await expect(gcStatic.locator('.gcs-stamp')).toHaveText('HELD');
    await expect(gcStatic.locator('.gcs-list li.is-fail')).toHaveCount(1);
    // The ledger line rides the static panel too: CONDITIONAL is a hold.
    await expect(gcStatic.locator('.gcs-ledger')).toContainText('CONDITIONAL');
  });

  test('the skins section and four-plane map render on a phone', async ({ page }) => {
    await page.goto('/');

    // Two-skins story: cards stack single-column but stay fully present.
    const skins = page.locator('[data-skins]');
    await bringIntoView(skins);
    await expect(skins).toBeVisible();
    await expect(skins.locator('.skin-card')).toHaveCount(2);
    await expect(skins.locator('.skin-trace-rows li')).toHaveCount(4);

    // SameGarden is CSS-only and degrades — all four planes visible.
    const map = page.locator('.same-garden');
    await bringIntoView(map);
    await expect(map).toBeVisible();
    await expect(map.locator('.sg-plane')).toHaveCount(4);
    await expect(map.locator('.sg-card--here')).toBeVisible();
  });
});
