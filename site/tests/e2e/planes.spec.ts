import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * The four-plane story: the "one public API, no privileged clients" section [data-skins]
 * (studio = the console; wicked-interactive = the DOCUMENT ENGINE, not a second UI — its builder
 * moved into studio, so crew spawns and proxies what remains; governed-generation
 * bus trace, Project-model landing strip) and the shared-chrome SameGarden map
 * (.same-garden) with crew's card as the "you are here" marker.
 */
test.describe('one public API, no privileged clients [data-skins]', () => {
  test('both skins render, the bus trace carries the real vocabulary, the landing strip is honest', async ({ page }) => {
    await page.goto('/');
    const skins = page.locator('[data-skins]');
    await bringIntoView(skins);
    await expect(skins).toBeVisible();

    // Two skin cards: studio (coder) + wicked-interactive (creator).
    const cards = skins.locator('.skin-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('studio');
    await expect(cards.first()).toContainText('/api/v1');
    await expect(cards.last()).toContainText('wicked-interactive');

    // The governed-generation proof: a 4-row bus trace ending in the real
    // draft.completed event (interactive/draft-events.ts vocabulary).
    const rows = skins.locator('.skin-trace-rows li');
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText('wicked.interactive.doc.created');
    await expect(rows.last()).toContainText('wicked.interactive.draft.completed');

    // The Project model is LANDING — a labeled strip, never a shipped claim.
    const landing = skins.locator('.skins-landing');
    await expect(landing.locator('.skins-landing-chip')).toHaveText('landing');
    await expect(landing).toContainText('Project model');
  });
});

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
