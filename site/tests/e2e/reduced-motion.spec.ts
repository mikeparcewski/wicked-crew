import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * prefers-reduced-motion: the page must load with zero pageerror events and
 * every key section visible. The widgets render static (no auto-advance);
 * the gate console settles on its manual deny-dominates scene.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });

test.describe('reduced motion', () => {
  test('page loads clean and every key section renders', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await expect(page.locator('.hero h1')).toBeVisible();

    // Gate console: reduced-motion path hands over control immediately,
    // settled on the deny-dominates scene.
    const gc = page.locator('[data-gc]');
    await bringIntoView(gc);
    await expect(gc).toHaveClass(/is-manual/);
    await expect(gc.locator('[data-stamp]')).toHaveText('DENY');

    // Every key section is present and visible.
    for (const sel of ['[data-studio]', '[data-skins]', '[data-byo]', '[data-wf]', '[data-rail]', '[data-council]', '.same-garden', '.install--primary']) {
      const loc = page.locator(sel);
      await bringIntoView(loc);
      await expect(loc).toBeVisible();
    }

    // The studio's reduced path renders the run statically, ending at the gate.
    await expect(page.locator('[data-studio-gate]')).toBeVisible();

    expect(errors).toEqual([]);
  });
});
