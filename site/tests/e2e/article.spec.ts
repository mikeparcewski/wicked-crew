import { test, expect } from '@playwright/test';

/**
 * /article prose links. The link colour is the monochrome ink (wicked-web v3), so a link inside a
 * paragraph is told apart by its underline, not by colour (WCAG 1.4.1).
 */
test('article prose links are underlined', async ({ page }) => {
  await page.goto('/article/');
  const link = page.locator('.article-wrap :is(p, li) a').first();
  await expect(link).toBeVisible();
  await expect(link).toHaveCSS('text-decoration-line', 'underline');
});
