import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * The shared four-plane map, with crew as "you are here".
 */
test.describe('SameGarden four-plane map (.same-garden)', () => {
  test('all four planes render with crew as "you are here"', async ({ page }) => {
    await page.goto('/');
    const map = page.locator('.same-garden');
    await bringIntoView(map);
    await expect(map).toBeVisible();

    // Four plane bands, three contract seams between them.
    await expect(map.locator('.sg-plane')).toHaveCount(4);
    await expect(map.locator('.sg-contract')).toHaveCount(3);

    // crew's card is the non-link "you are here" marker — the site never
    // promotes itself; every other product card links out.
    const here = map.locator('.sg-card--here');
    await expect(here).toHaveCount(1);
    await expect(here).toContainText('wicked-crew');
    await expect(here.locator('.sg-here-chip')).toHaveText('you are here');

    // The sibling planes stay complete and linked (garden + estate sites).
    await expect(map.getByRole('link', { name: 'Visit wicked-garden' })).toBeVisible();
    await expect(map.getByRole('link', { name: 'Visit wicked-estate' })).toBeVisible();
  });
});
