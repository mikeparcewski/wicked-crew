import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * Workflows-as-data [data-wf] — auto-plays the workflow defs on scroll-in;
 * the status button is a play/pause toggle and clicking a def pins it.
 */
test.describe('workflows-as-data [data-wf]', () => {
  test('play/pause toggle works and pinning a def renders its phases', async ({ page }) => {
    await page.goto('/');
    const wf = page.locator('[data-wf]');
    await bringIntoView(wf);

    const toggle = page.locator('[data-wf-toggle]');
    const status = page.locator('[data-wf-status-txt]');

    // Playing state (server-rendered flag; the timer arms on scroll-in).
    await expect(toggle).toHaveClass(/is-playing/);
    await expect(status).toContainText('auto-playing');

    // Pause: pins the current def.
    await toggle.click();
    await expect(toggle).toHaveClass(/is-pinned/);
    await expect(status).toContainText('pinned');

    // Resume.
    await toggle.click();
    await expect(toggle).toHaveClass(/is-playing/);
    await expect(status).toContainText('auto-playing');

    // Pin a specific def: bug.json renders exactly its 4 phases.
    await wf.locator('[data-wf-file]').nth(2).click();
    await expect(page.locator('[data-wf-name]')).toHaveText('bug.json');
    await expect(page.locator('[data-wf-phases] .wf-phase')).toHaveCount(4);
    await expect(page.locator('[data-wf-phases] .wf-phase').first()).toHaveText('reproduce');
    await expect(status).toContainText('pinned bug.json');
    await expect(toggle).toHaveClass(/is-pinned/);
  });
});
