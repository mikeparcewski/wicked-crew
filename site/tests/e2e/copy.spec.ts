import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * The two install copy buttons — click → "Copied" feedback + the command lands
 * on the clipboard (permissions granted; 127.0.0.1 is a secure context).
 */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('install copy buttons', () => {
  test('family installer copy button copies the command and shows feedback', async ({ page }) => {
    await page.goto('/');
    const btn = page.getByRole('button', { name: 'Copy family installer command' });
    await bringIntoView(btn);
    await btn.click();

    await expect(btn).toHaveText('Copied');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('npx wicked-installer');

    // Feedback resets after ~1.4s.
    await expect(btn).toHaveText('Copy');
  });

  test('direct install copy button copies both commands', async ({ page }) => {
    await page.goto('/');
    const btn = page.getByRole('button', { name: 'Copy direct install commands' });
    await bringIntoView(btn);
    await btn.click();

    await expect(btn).toHaveText('Copied');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('npm install -g wicked-crew\nwicked-crew serve');

    await expect(btn).toHaveText('Copy');
  });
});
