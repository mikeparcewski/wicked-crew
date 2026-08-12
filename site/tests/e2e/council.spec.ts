import { test, expect } from '@playwright/test';
import { bringIntoView } from './utils';

/**
 * Council [data-council] — auto-cycles three ballots on scroll-in; clicking a
 * round pins it (click again to resume), clicking a seat freezes the board.
 */
test.describe('council [data-council]', () => {
  test('clicking a round pins the board; clicking it again resumes the cycle', async ({ page }) => {
    await page.goto('/');
    const council = page.locator('[data-council]');
    await bringIntoView(council);

    const status = page.locator('[data-council-status]');
    const round2 = page.locator('[data-round][data-i="1"]');

    await round2.click();
    await expect(round2).toHaveClass(/is-active/);
    await expect(round2).toHaveAttribute('aria-selected', 'true');
    await expect(status).toContainText('pinned round 2');
    // Round 2 is the converged ballot — all seats on P2, synth = pass.
    await expect(page.locator('[data-cy-line]')).toContainText('100%');
    await expect(page.locator('[data-council-synth]')).toHaveAttribute('data-synth', 'pass');

    // Clicking the pinned round again resumes the auto-cycle.
    await round2.click();
    await expect(status).toContainText('auto-cycling');
  });

  test('clicking a seat pins the current round', async ({ page }) => {
    await page.goto('/');
    const council = page.locator('[data-council]');
    await bringIntoView(council);

    await council.locator('[data-seat]').first().click();
    await expect(page.locator('[data-council-status]')).toContainText(/pinned round [123]/);
  });
});
