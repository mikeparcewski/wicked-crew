import { test, expect } from '@playwright/test';

/**
 * wicked-web chrome (Topbar) — theme toggle (#themeBtn ↔ data-theme on <html>,
 * persisted under localStorage 'wa-theme') and the ecosystem dropdown
 * (#projectsBtn → #projectsMenu).
 */
test.describe('site chrome (wicked-web topbar)', () => {
  test('theme toggle flips data-theme on <html> and persists across reload', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');

    await page.locator('#themeBtn').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wa-theme')))
      .toBe('dark');

    // Persists: the no-flash init re-applies the stored theme on reload.
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    // And toggles back.
    await page.locator('#themeBtn').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wa-theme')))
      .toBe('light');
  });

  test('ecosystem dropdown opens on click and closes on Escape', async ({ page }) => {
    await page.goto('/');
    const btn = page.locator('#projectsBtn');
    const menu = page.locator('#projectsMenu');

    await expect(menu).toBeHidden();
    await btn.click();
    await expect(menu).toBeVisible();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('link', { name: /garden/ })).toBeVisible();
    await expect(menu.getByRole('link', { name: /estate/ })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});
